import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mkdirSync, renameSync } from "node:fs";
import * as queue from "../lib/queue.ts";
import { GovernError, writeJson } from "../lib/util.ts";
import { makeEnv, write } from "./helpers.ts";

function setup(t: TestContext) {
  const e = makeEnv("queue-listing"), old = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("GOVERN_")) delete process.env[k];
  Object.assign(process.env, e.env, { GOVERN_QUEUE: join(e.root, "queue") });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); process.env = old; });
  const m = queue.send({ project: "film", task: "check", kind: "TASK", from: "owner", to: "mailbox", summary: "check", body: "BODY", files: [], access: "read-only" });
  return { e, m, file: join(e.root, "queue", "open", `${m.id}.json`) };
}

test("queue listing skips a message moved after the directory snapshot", (t) => {
  const { e, m, file } = setup(t);
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs"), read = fs.readdirSync;
  const open = join(e.root, "queue", "open"), done = join(e.root, "queue", "done");
  mkdirSync(done, { recursive: true });
  let moved = false;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof read>) => {
    const snapshot = (read as Function)(...args);
    if (String(args[0]) === open && !moved) {
      moved = true;
      renameSync(file, join(done, `${m.id}.json`));
    }
    return snapshot;
  });
  syncBuiltinESMExports();
  assert.doesNotThrow(() => assert.deepEqual(queue.all(), [{ state: "done", m }]));
  assert.equal(moved, true, "the transition occurs after listing and before reading");
});

for (const [name, invalid, path] of [
  ["invalid JSON", "{", "not JSON"],
  ["null", "null", "$:"],
  ["missing field", JSON.stringify({ id: "broken" }), "$.project:"],
  ["wrong field type", JSON.stringify({ created: 7 }), "$.created:"],
  ["unknown field", JSON.stringify({ extra: true }), "$.extra:"],
  ["unknown result field", JSON.stringify({ result: { agent: "runner", ok: true, seconds: 0, extra: true } }), "$.result.extra:"],
  ["wrong nested type", JSON.stringify({ claim: { by: "runner", pid: "bad", start: "start", at: "now" } }), "$.claim.pid:"],
] as const) {
  test(`queue listing refuses ${name} with a typed error naming the file`, (t) => {
    const { m, file } = setup(t);
    const text = ["invalid JSON", "null", "missing field"].includes(name) ? invalid : JSON.stringify({ ...m, ...JSON.parse(invalid) });
    write(file, text);
    assert.throws(() => queue.all(), (error: unknown) => {
      assert.ok(error instanceof GovernError, `expected GovernError, got ${String(error)}`);
      assert.equal(error.code, 4);
      assert.ok(error.message.includes(`${file}: ${path}`), error.message);
      return true;
    });
  });
}

test("queue listing preserves every optional message field and nested run detail", (t) => {
  const { m, file } = setup(t);
  const usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };
  const full: queue.Message = { ...m, replyTo: "parent", profile: "codex-read", readOnlyConfirmed: true, lane: "film", estimateUsd: 0, routed: false,
    forwardedFrom: "original", timeoutSec: 1, retryOf: "failed", retryNote: "fixed", retries: [{ id: "retry", note: "fixed", at: "now" }],
    verification: { state: "checked", reason: "ok", label: "pass", argv: ["node"], exit: 0, seconds: 0, log: "ok", source: "task" },
    check: ["refs"], verify: ["node"], repaired: true, claim: { by: "runner", pid: 1, start: "start", at: "now" },
    remote: { peer: "peer", id: "remote" }, relay: { attempts: 0, lastError: "", nextAt: "now" },
    result: { profile: "codex-read", profileHash: "hash", closedBy: "owner", note: "ok", agent: "runner", ok: false, usage, turns: 0, seconds: 0,
      reply: "reply", error: "bad reply", failure: "reply", repaired: true, repair: { engine: "claude", model: "sonnet", seconds: 0, usage, turns: 0 } } };
  writeJson(file, full);
  assert.deepEqual(queue.all(), [{ state: "open", m: full }]);
});

test("queue listing reads a claim recorded without a start time or claim time (an unknown holder)", (t) => {
  const { m, file } = setup(t);
  const holderless: queue.Message = { ...m, claim: { by: "dispatcher", pid: 1 } };
  writeJson(file, holderless);
  assert.deepEqual(queue.all(), [{ state: "open", m: holderless }]);
});
