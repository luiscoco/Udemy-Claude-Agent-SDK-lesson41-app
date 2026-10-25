import {
  query,
  InMemorySessionStore,
  listSessions,
  getSessionMessages,
  deleteSession,
  type Options,
  type SessionStore,
  type SessionKey,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { FileSessionStore } from "./store.js";
export interface WorkerRequest {
  kind: "query" | "catalog" | "delete" | "memory";
  cwd: string;
  storeRoot: string;
  prompt?: string;
  resume?: string;
  continue?: boolean;
  failAppend?: boolean;
  conflict?: "persist" | "checkpoint";
}
const controller = new AbortController(),
  input = createInterface({ input: process.stdin });
const request = await new Promise<WorkerRequest>((r) =>
  input.once("line", (l) => r(JSON.parse(l))),
);
input.on("line", () => controller.abort());
const send = (type: string, value: unknown) =>
  process.stdout.write(JSON.stringify({ type, value }) + "\n");
const backing =
  request.kind === "memory"
    ? new InMemorySessionStore()
    : new FileSessionStore(request.storeRoot);
const store: SessionStore = {
  async append(key, entries) {
    send("store-append", {
      key,
      count: entries.length,
      failing: !!request.failAppend,
    });
    if (request.failAppend)
      throw new Error("CLASSROOM-41: injected external mirror outage");
    await backing.append(key, entries);
  },
  async load(key) {
    const entries = await backing.load(key);
    send("store-load", { key, count: entries?.length ?? null });
    return entries;
  },
  async listSessions(projectKey) {
    const sessions = await backing.listSessions(projectKey);
    send("store-list", { projectKey, sessions });
    return sessions;
  },
  async listSessionSummaries(projectKey) {
    return backing.listSessionSummaries(projectKey);
  },
  async listSubkeys(key) {
    return backing.listSubkeys(key);
  },
  async delete(key) {
    await backing.delete(key);
    send("store-delete", { key });
  },
};
async function catalog() {
  const sessions = await listSessions({
    dir: request.cwd,
    sessionStore: store,
    limit: 20,
  });
  const messages = [];
  for (const s of sessions)
    messages.push({
      sessionId: s.sessionId,
      messages: await getSessionMessages(s.sessionId, {
        dir: request.cwd,
        sessionStore: store,
        limit: 60,
      }),
    });
  send("catalog", {
    sessions: sessions.map((s) => ({
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
    })),
    messages,
  });
}
async function run(prompt: string, resume?: string) {
  const options: Options = {
    cwd: request.cwd,
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    settingSources: [],
    plugins: [],
    sessionStore: store,
    sessionStoreFlush: "eager",
    loadTimeoutMs: 10000,
    resume,
    continue: request.continue,
    persistSession: request.conflict === "persist" ? false : true,
    enableFileCheckpointing: request.conflict === "checkpoint",
    maxTurns: 3,
    maxBudgetUsd: 0.25,
    effort: "low",
    thinking: { type: "disabled" },
    abortController: controller,
    env: {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init")
        send("init", { pid: process.pid, sessionId: message.session_id });
      if (message.type === "system" && message.subtype === "mirror_error")
        send("mirror-error", message);
      if (message.type === "assistant")
        for (const b of message.message.content)
          if (b.type === "text") send("answer", b.text);
      if (message.type === "result") {
        send("result", {
          pid: process.pid,
          sessionId: message.session_id,
          status: message.subtype,
          text:
            message.subtype === "success"
              ? message.result
              : message.errors.join("\n"),
          costUsd: message.total_cost_usd,
        });
        lastId = message.session_id;
      }
    }
  } catch (e) {
    send("exception", e instanceof Error ? e.message : String(e));
  }
}
let lastId: string | undefined;
try {
  if (request.kind === "catalog") await catalog();
  else if (request.kind === "delete") {
    await deleteSession(request.resume!, {
      dir: request.cwd,
      sessionStore: store,
    });
    await catalog();
  } else if (request.kind === "memory") {
    await run(
      "Remember the classroom word MEMORY-41. Reply exactly MEMORY-41. No tools.",
    );
    if (!lastId) throw new Error("No seed result.");
    await run(
      "What classroom word did I ask you to remember? Reply with that exact word only. No tools.",
      lastId,
    );
    await catalog();
    send("memory-snapshot", {
      sessions: (backing as InMemorySessionStore).size,
      lifetime: "This worker process only",
    });
  } else await run(request.prompt!, request.resume);
} catch (e) {
  send("exception", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  input.close();
  process.stdin.destroy();
}
