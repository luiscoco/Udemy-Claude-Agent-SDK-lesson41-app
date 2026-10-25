# Claude Agent SDK · Lesson 41 · Persisting sessions to external storage

Five linked student pages, large text, actual SDK experiments and coloured code in all thirteen UML steps.

## What you will learn

- Understand dual-write storage: The SDK writes locally first and then mirrors transcript batches through append. A store is a mirror, not a replacement for local execution files.
- Use the SDK memory store: Run two actual queries with one InMemorySessionStore instance. The second loads the first conversation. The memory store disappears when that process exits.
- Build an ordered file adapter: Implement append and load, preserve opaque entry payloads and ordering, deduplicate UUID retries, and validate the adapter with Anthropic’s official 13-contract suite.
- Resume after a worker exits: Run a new process with the same working directory, a clean SDK configuration and the shared adapter. The restart test removes the source local config before resuming.
- Inspect and manage stored sessions: Use native listSessions, getSessionMessages and deleteSession helpers with the adapter. Optional summaries speed listing; subkeys preserve transcript namespaces.
- Observe failure and option boundaries: Inspect actual mirror_error events, missing-store fallback and startup conflicts. persistSession false and file checkpointing cannot be combined with a store. This lab simulates hosts locally.

## Configure and run

```powershell
git clone https://github.com/luiscoco/Udemy-Claude-Agent-SDK-lesson41-app.git
cd .\Udemy-Claude-Agent-SDK-lesson41-app
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
npm start
```

From presentations use `cd .\agent-sdk\lesson41-session-storage`. Open http://127.0.0.1:3141 and keep the terminal running. Node.js 24+, API credit and model access are required. Windows may require Git Bash.

## Create your .env file

Preserve an existing file. Enter your own model key, then restart. Existing shell values take precedence.

```dotenv
ANTHROPIC_API_KEY=your_api_key
CLAUDE_MODEL=claude-sonnet-4-6
PORT=3141
# Windows only, if needed:
# CLAUDE_CODE_GIT_BASH_PATH=C:/Program Files/Git/bin/bash.exe

```

No GitHub token or Managed Agents IDs are required. Secrets, dependencies and teaching media stay outside Git.

## Run the experiments

### Compare memory, file and restart

Memory reuses one SDK-provided memory store in one worker. File starts a fresh worker and adapter instance. Restart also removes the source local config before the clean target loads stored history. Both simulated hosts use the SAME working directory.

```powershell
npm run sample:env -- memory
npm run sample:env -- file
npm run sample:env -- restart
```

### Inspect optional store operations

Continue selects the latest stored session. Catalog exposes native session metadata and messages. Delete uses the actual SDK helper against the external store; it does not erase the source local copy.

```powershell
npm run sample:env -- continue
npm run sample:env -- catalog
npm run sample:env -- delete
```

### Observe failures and validate the adapter

Failure injects an external append outage and records actual mirror_error events while the local query can finish. Conflicts exercises two real SDK startup rejections. Missing demonstrates an unknown-store lookup with a clean local config, then a healthy fresh run. Tests include the official 13-contract suite plus retry, ordering and isolation checks.

```powershell
npm run sample:env -- failure
npm run sample:env -- conflicts
npm run sample:env -- missing
npm test
```

## How the app was built

### 1. Validate the storage experiment

Accept only fixed classroom scenarios. A browser request cannot supply arbitrary session IDs, filesystem paths or backend credentials.

Source: `src/modes.ts`, selected lines 3–9. Surrounding code omitted.

```typescript
export function validateConfig(value: unknown): RunConfig {
  const c = value as Record<string, unknown>;
  if (!c || typeof c !== "object" || !MODES.includes(c.mode as never))
    throw new Error("Choose a listed storage experiment.");
  if (Object.keys(c).some((k) => k !== "mode"))
    throw new Error("Only the classroom mode can be configured.");
  return { mode: c.mode as RunConfig["mode"] };
```

### 2. Implement the mirror append contract

The real SDK calls this adapter wrapper after local transcript writes. Record actual batch keys and counts, then pass opaque entries to the selected backing store.

Source: `src/worker.ts`, selected lines 37–45. Surrounding code omitted.

```typescript
async append(key, entries) {
    send("store-append", {
      key,
      count: entries.length,
      failing: !!request.failAppend,
    });
    if (request.failAppend)
      throw new Error("CLASSROOM-41: injected external mirror outage");
    await backing.append(key, entries);
```

### 3. Preserve order and retry identity

Preserve arrival order and use UUIDs as retry identities. Entries without UUIDs remain append-only metadata; do not discard or reinterpret their payloads.

Source: `src/store.ts`, selected lines 57–65. Surrounding code omitted.

```typescript
const seen = new Set(
        row.entries.flatMap((e) =>
          typeof e.uuid === "string" ? [e.uuid] : [],
        ),
      );
      const accepted = snapshot.filter((e) => {
        if (typeof e.uuid !== "string") return true;
        if (seen.has(e.uuid)) return false;
        seen.add(e.uuid);
```

### 4. Load opaque stored entries

Return the complete ordered entry array or null for an unknown key. The SDK materializes the returned history before resuming.

Source: `src/store.ts`, selected lines 77–82. Surrounding code omitted.

```typescript
load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.serial(
      async () =>
        (await this.read()).find((r) => same(r.key, key))?.entries ?? null,
    );
  }
```

### 5. Use the SDK memory store

The quick-start experiment uses the real SDK InMemorySessionStore. File experiments create a new file-backed adapter instance in each worker.

Source: `src/worker.ts`, selected lines 32–36. Surrounding code omitted.

```typescript
const backing =
  request.kind === "memory"
    ? new InMemorySessionStore()
    : new FileSessionStore(request.storeRoot);
const store: SessionStore = {
```

### 6. Attach storage and session selectors

Pass the actual adapter to query. Eager flushing exposes append events; resume or continue selects previously stored history. The working directory must match.

Source: `src/worker.ts`, selected lines 71–77. Surrounding code omitted.

```typescript
sessionStore: store,
    limit: 20,
  });
  const messages = [];
  for (const s of sessions)
    messages.push({
      sessionId: s.sessionId,
```

### 7. Capture the actual native session ID

Capture system/init identifiers and actual result IDs. New worker process IDs make process boundaries distinct from conversation identity.

Source: `src/worker.ts`, selected lines 121–126. Surrounding code omitted.

```typescript
if (message.type === "system" && message.subtype === "init")
        send("init", { pid: process.pid, sessionId: message.session_id });
      if (message.type === "system" && message.subtype === "mirror_error")
        send("mirror-error", message);
      if (message.type === "assistant")
        for (const b of message.message.content)
```

### 8. Remove the source local config

The restart experiment removes only its own temporary source config. The external adapter stays outside that directory and survives until evidence collection finishes.

Source: `src/agent.ts`, selected lines 173–177. Surrounding code omitted.

```typescript
await w.eraseSource();
        observe("source-config-erased", {
          sourceAfterErase: (await w.inspect()).source,
        });
      }
```

### 9. Resume in the clean target worker

Start a new Node worker with a clean config directory, the same project working directory and the stored session ID. Actual load events prove retrieval through the adapter.

Source: `src/agent.ts`, selected lines 180–185. Surrounding code omitted.

```typescript
"Resume from external adapter",
          { resume: id, prompt: RECALL },
          true,
        );
      if (c.mode === "delete")
        await call(
```

### 10. Read the native store catalog

List sessions through the SDK helper with sessionStore attached, then retrieve their messages. No model query is needed for catalog inspection.

Source: `src/worker.ts`, selected lines 69–76. Surrounding code omitted.

```typescript
const sessions = await listSessions({
    dir: request.cwd,
    sessionStore: store,
    limit: 20,
  });
  const messages = [];
  for (const s of sessions)
    messages.push({
```

### 11. Delete through the SDK helper

Delete the external main transcript and its subkeys through the actual SDK helper. The original local transcript is a separate copy.

Source: `src/worker.ts`, selected lines 150–154. Surrounding code omitted.

```typescript
await deleteSession(request.resume!, {
      dir: request.cwd,
      sessionStore: store,
    });
    await catalog();
```

### 12. Surface a mirror outage

Capture native mirror_error system messages after bounded failed append attempts. A successful local result does not imply external durability.

Source: `src/worker.ts`, selected lines 123–127. Surrounding code omitted.

```typescript
if (message.type === "system" && message.subtype === "mirror_error")
        send("mirror-error", message);
      if (message.type === "assistant")
        for (const b of message.message.content)
          if (b.type === "text") send("answer", b.text);
```

### 13. Exercise incompatible options

The conflicts scenario deliberately combines sessionStore with persistSession false or file checkpointing. Actual SDK startup exceptions are shown, followed by a valid run.

Source: `src/worker.ts`, selected lines 106–111. Surrounding code omitted.

```typescript
persistSession: request.conflict === "persist" ? false : true,
    enableFileCheckpointing: request.conflict === "checkpoint",
    maxTurns: 3,
    maxBudgetUsd: 0.25,
    effort: "low",
    thinking: { type: "disabled" },
```

## Reference topics and limits

- Real boundary of this demo: Two worker processes with isolated SDK config directories simulate host changes on one computer, using the same cwd. The backing adapter is a local file store outside those configs. No remote containers or cloud services are claimed.
- Local-first and temporary copies: Fresh queries leave a local JSONL until this lab cleans up. Store-backed resumes materialize history into SDK-managed temporary configuration and clean that materialized copy at run end. External mirroring does not mirror general project files.
- Ordering and retry rules: Persist entries as opaque JSON values, in order. Stable UUIDs are deduplicated to make retries idempotent; metadata without UUIDs stays append-only. This adapter serializes one instance, not concurrent processes.
- Production adapters: S3 reference adapters store ordered JSONL parts. Redis uses lists and a session index. Postgres stores ordered JSONB rows. Copy and adapt official examples; use transactions/CAS for multiple writers, secure credentials, encryption and retention controls.
- Optional methods: listSessions enables continue. listSessionSummaries uses incremental SDK folds to avoid loading every transcript for metadata. delete cascades from the main key to subkeys. listSubkeys discovers subagent namespaces; this lab does not invoke subagents.
- Failure is observable: An injected append outage produces actual native mirror_error messages. The model can still finish using local history. A missing store can fall back to local storage; the missing experiment deliberately has a clean target configuration, then starts a healthy fresh session.
- Validation and lifetime: The file adapter passes Anthropic’s official 13-contract suite adapted only to Node’s test runner. Additional tests cover UUID retries and overlapping calls. In-memory state dies with the process; the file store is durable across workers but deliberately removed after each classroom experiment.

## References

- [Official SDK session storage documentation](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

Regenerate student pages with `python scripts/build-pages.py`. Run `npm test` for offline boundaries, review lifecycle, workspace and startup checks.


## Reference backend integrations

This app runs a single-writer file adapter and two local worker configurations. It does not deploy cloud services. The SDK provides reference adapters to study and adapt:

- [S3: ordered JSONL parts](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/s3)
- [Redis: transcript lists and session index](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/redis)
- [Postgres: ordered JSONB rows](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/postgres)

Use the same working directory/project key across workers. For concurrent writers use backend transactions or compare-and-swap; the classroom file adapter serializes only one instance.
