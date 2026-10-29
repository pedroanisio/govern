import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import * as queue from "../lib/queue.ts";
import { makeEnv } from "./helpers.ts";

function setup(t: TestContext) {
  const e = makeEnv("queue-transactions"), old = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("GOVERN_")) delete process.env[k];
  Object.assign(process.env, e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_STATE: join(e.root, "state") });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); process.env = old; });
  mkdirSync(join(e.root, "queue", "failed"), { recursive: true });
  const make = () => queue.send({ project: "film", task: "check", kind: "TASK", from: "owner", to: "mailbox", summary: "check", body: "BODY", files: [], access: "read-only" });
  return { e, make, guarded: () => existsSync(join(e.root, "queue", ".claims", "mutex")) };
}

/** Let a contender enter after the final folder snapshot, unless the claim guard excludes it. */
function onScan(t: TestContext, path: string, contender: () => void, guarded: () => boolean, scan = 1): () => boolean {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs"), read = fs.readdirSync;
  let reached = false, scans = 0;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof read>) => {
    const snapshot = (read as Function)(...args);
    if (String(args[0]) === path && ++scans === scan && !reached) {
      reached = true;
      if (!guarded()) contender();
    }
    return snapshot;
  });
  syncBuiltinESMExports();
  return () => reached;
}

const actions = {
  close: (id: string) => queue.close(id, "owner", "handled"),
  reply: (id: string) => queue.reply(id, "owner", { kind: "REVIEW", summary: "answer", body: "answer" }),
  forward: (id: string) => queue.forward(id, "owner", "other-mailbox"),
};

for (const [name, action] of Object.entries(actions)) {
  test(`${name} excludes a dispatcher claim between reading and saving the open message`, (t) => {
    const { e, make, guarded } = setup(t), m = make();
    let claimed = false;
    const reached = onScan(t, join(e.root, "queue", "failed"), () => { claimed = queue.claim(m, "dispatcher"); }, guarded);
    let error: unknown;
    try { action(m.id); } catch (e) { error = e; }
    assert.equal(reached(), true, "the read barrier was reached");
    assert.equal(claimed, false, "a dispatcher must not claim the snapshot before the manual transition commits");
    if (error) throw error;
    assert.deepEqual(queue.all().filter((x) => x.m.id === m.id).map((x) => x.state), ["done"], "no duplicate in claimed/ and done/");
    assert.equal(queue.claim(m, "dispatcher"), false, "the original cannot run again");
  });

  test(`${name} refuses a message already claimed and publishes nothing`, (t) => {
    const { make } = setup(t), m = make();
    assert.equal(queue.claim(m, "dispatcher"), true);
    assert.throws(() => action(m.id), /is not open \(it is claimed\)/);
    assert.deepEqual(queue.all().map((x) => [x.state, x.m.id]), [["claimed", m.id]]);
  });
}

test("racing retries with one prior retry create at most one copy and retain both history entries", (t) => {
  const { e, make, guarded } = setup(t), root = make();
  queue.close(root.id, "owner", "retry manually");
  const first = queue.retry(root.id, { note: "first" });
  let competing: queue.Message | undefined;
  const reached = onScan(t, join(e.root, "queue", "failed"), () => { competing = queue.retry(root.id, { note: "contender" }); }, guarded, 2);
  const second = queue.retry(root.id, { note: "second" });
  assert.equal(reached(), true, "the read barrier was reached");
  // When the guard excludes the contender, let it enter after the winner commits.
  if (!competing) assert.throws(() => queue.retry(root.id, { note: "contender" }), /already retried 2 times/);
  const copies = queue.all().filter((x) => x.m.retryOf === root.id);
  assert.equal(copies.length, 2, "a racing retry must not exceed MAX_RETRIES");
  assert.deepEqual(queue.find(root.id)!.m.retries?.map((x) => [x.id, x.note]), [[first.id, "first"], [second.id, "second"]], "retry history retains both committed entries");
});
