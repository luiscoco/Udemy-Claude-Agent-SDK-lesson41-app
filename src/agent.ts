import { randomUUID } from "node:crypto";
import { runWorker } from "./host.js";
import { prepareWorkspace } from "./workspace.js";
import { FileSessionStore } from "./store.js";
import { validateConfig, MODES } from "./modes.js";
import type { WorkerRequest } from "./worker.js";
import type {
  RunConfig,
  Mode,
  LabEvent,
  RunResult,
  Observation,
  Catalog,
  Evidence,
} from "./protocol.js";
export { validateConfig, MODES };
export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
export const DEFAULT_CONFIG: RunConfig = { mode: "restart" };
const SEED =
  "Remember the classroom word DURABLE-41. Reply exactly DURABLE-41. No tools.";
const RECALL =
  "What classroom word did I ask you to remember? Reply with the exact word only. No tools.";
export const PROMPTS = Object.fromEntries(
  MODES.map((m) => [m, SEED]),
) as Record<Mode, string>;
export function redact(text: string) {
  for (const s of [
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
  ].filter(Boolean) as string[])
    text = text.split(s).join("[REDACTED]");
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
}
export async function runAgent(
  value: RunConfig,
  emit: (e: LabEvent) => void,
  controller = new AbortController(),
  _scripted = false,
) {
  const c = validateConfig(value),
    w = await prepareWorkspace(),
    started = Date.now();
  const results: RunResult[] = [],
    observations: Observation[] = [],
    exceptions: string[] = [],
    initRecords: { pid: number; sessionId: string }[] = [];
  let catalog: Catalog = { sessions: [], messages: [] },
    memorySnapshot: unknown = null,
    sourceBeforeErase: string[] = [];
  const observe = (kind: string, detail: unknown) => {
    const record = {
      sequence: observations.length + 1,
      atMs: Date.now() - started,
      kind,
      detail,
    };
    observations.push(record);
    emit({ type: "observation", record });
  };
  const call = async (
    label: string,
    extra: Partial<WorkerRequest> = {},
    target = false,
    allowEmpty = false,
  ) => {
    const before = results.length;
    observe("query-options", {
      label,
      cwd: w.cwd,
      config: target ? "clean target configuration" : "source configuration",
      ...extra,
      store: "adapter outside SDK config directories",
    });
    await runWorker(
      {
        kind: "query",
        cwd: w.cwd,
        storeRoot: w.storeRoot,
        prompt: SEED,
        ...extra,
      },
      {
        ...process.env,
        HOME: w.home,
        USERPROFILE: w.home,
        CLAUDE_CONFIG_DIR: target ? w.targetSdk : w.sdkHome,
      },
      controller.signal,
      (type, data) => {
        if (type === "result") {
          const record = { ...data, index: results.length + 1, label };
          results.push(record);
          emit({ type: "result", record });
        }
        if (type === "init") initRecords.push(data);
        if (type === "answer") emit({ type: "answer", text: redact(data) });
        if (type === "exception") exceptions.push(redact(data));
        if (type === "catalog") {
          catalog = data;
          emit({ type: "catalog", catalog });
        }
        if (type === "memory-snapshot") memorySnapshot = data;
        observe(type, type === "exception" ? redact(data) : data);
      },
    );
    if (!allowEmpty && results.length === before)
      throw new Error(
        "The SDK produced no result. Inspect the actual worker events.",
      );
    return results.at(-1)?.sessionId;
  };
  emit({
    type: "options",
    config: c,
    options: {
      model: MODEL,
      sessionStore: true,
      sessionStoreFlush: "eager",
      maxBudgetUsd: 0.25,
      hostBoundary:
        "Two local worker/config directories simulate host changes; no remote cloud backend is provisioned.",
      adapterLimit:
        "One sequential writer. Production backends need transactions/CAS and their own security/retention controls.",
      cleanup:
        "All classroom files and stores are removed after evidence capture.",
    },
  });
  try {
    if (c.mode === "memory")
      await call("In-memory store · two queries", { kind: "memory" });
    else if (c.mode === "conflicts") {
      await call(
        "Invalid persistSession false",
        { conflict: "persist" },
        false,
        true,
      );
      await call(
        "Invalid file checkpointing",
        { conflict: "checkpoint" },
        false,
        true,
      );
      await call("Valid store configuration");
    } else if (c.mode === "missing") {
      await call(
        "Unknown stored session",
        { resume: randomUUID(), prompt: RECALL },
        true,
        true,
      );
      await call("Healthy fresh session");
    } else if (c.mode === "continue" || c.mode === "catalog") {
      await call("First stored session", {
        prompt: SEED.replaceAll("DURABLE-41", "FIRST-41"),
      });
      await call("Second stored session", {
        prompt: SEED.replaceAll("DURABLE-41", "LATEST-41"),
      });
      if (c.mode === "continue")
        await call(
          "Continue from clean config",
          { continue: true, prompt: RECALL },
          true,
        );
    } else {
      const id = await call(
        c.mode === "failure" ? "Injected mirror outage" : "Source worker",
        { failAppend: c.mode === "failure" },
      );
      sourceBeforeErase = (await w.inspect()).source;
      if (c.mode === "restart") {
        await w.eraseSource();
        observe("source-config-erased", {
          sourceAfterErase: (await w.inspect()).source,
        });
      }
      if (c.mode === "file" || c.mode === "restart")
        await call(
          "Resume from external adapter",
          { resume: id, prompt: RECALL },
          true,
        );
      if (c.mode === "delete")
        await call(
          "Delete via SDK helper",
          { kind: "delete", resume: id },
          true,
          true,
        );
      if (c.mode === "failure")
        observe("mirror-outage-boundary", {
          localTranscriptSurvived: sourceBeforeErase.length > 0,
          externalRows: (await new FileSessionStore(w.storeRoot).inspect())
            .length,
        });
    }
    if (c.mode !== "memory")
      await call(
        "Inspect native store catalog",
        { kind: "catalog" },
        true,
        true,
      );
    const evidence: Evidence = {
      mode: c.mode,
      results,
      initRecords,
      exceptions,
      catalog,
      store:
        memorySnapshot ?? (await new FileSessionStore(w.storeRoot).inspect()),
      localFiles: await w.inspect(),
      sourceBeforeErase,
      observations,
      simulatedHosts: true,
    };
    emit({ type: "evidence", ...evidence });
  } finally {
    await w.cleanup();
  }
}
