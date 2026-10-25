import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prepareWorkspace } from "./workspace.js";
import { FileSessionStore } from "./store.js";
import { validateConfig } from "./modes.js";
import { runSessionStoreConformance } from "./conformance.js";
const cleanups: (() => Promise<void>)[] = [];
async function make() {
  const w = await prepareWorkspace();
  cleanups.push(w.cleanup);
  return new FileSessionStore(w.storeRoot);
}
after(async () => {
  for (const clean of cleanups) await clean();
});
runSessionStoreConformance(make);
test("UUID retry deduplication retains non-UUID metadata", async () => {
  const s = await make(),
    k = { projectKey: "p", sessionId: "s" };
  const e = [
    { type: "user", uuid: "one", nested: { x: [1, 2] } },
    { type: "tag", tag: "repeat" },
  ];
  await s.append(k, e);
  await s.append(k, e);
  assert.equal((await s.load(k))!.length, 3);
});
test("overlapping append calls keep enqueue order", async () => {
  const s = await make(),
    k = { projectKey: "p", sessionId: "s" };
  await Promise.all([
    s.append(k, [{ type: "a" }]),
    s.append(k, [{ type: "b" }]),
    s.append(k, [{ type: "c" }]),
  ]);
  assert.deepEqual(
    (await s.load(k))!.map((e) => e.type),
    ["a", "b", "c"],
  );
});
test("separate adapter instance reloads durable JSON", async () => {
  const s = await make(),
    k = { projectKey: "p", sessionId: "s" };
  await s.append(k, [
    { type: "user", uuid: "a", message: { role: "user", content: "hello" } },
  ]);
  const other = new FileSessionStore(s.directory);
  assert.deepEqual(await other.load(k), await s.load(k));
  assert.equal((await other.listSessionSummaries("p")).length, 1);
});
test("opaque keys never become filesystem paths", async () => {
  const s = await make(),
    k = {
      projectKey: "../../outside",
      sessionId: "../secret",
      subpath: "../../suffix",
    };
  await s.append(k, [{ type: "opaque", payload: { a: 1 } }]);
  assert.equal((await s.load(k))![0].type, "opaque");
});
test("loaded objects do not alias persisted rows", async () => {
  const s = await make(),
    k = { projectKey: "p", sessionId: "s" };
  await s.append(k, [{ type: "x", nested: { v: 1 } }]);
  const a = await s.load(k);
  (a![0].nested as any).v = 9;
  assert.equal(((await s.load(k))![0].nested as any).v, 1);
});
test("browser cannot choose storage paths or resume IDs", () => {
  assert.deepEqual(validateConfig({ mode: "restart" }), { mode: "restart" });
  for (const x of [
    { mode: "unknown" },
    { mode: "file", storeRoot: "/private" },
    { mode: "file", resume: "other" },
  ])
    assert.throws(() => validateConfig(x));
});
