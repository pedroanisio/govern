// Lane state: the summary of a lane from its govern.json, ledger and the queue, and the status derived from them.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, use, fixture, write, type Env } from "./helpers.ts";
import { parseFile } from "../lib/shape.ts";
import { create, load, save, appendLedger } from "../lib/project.ts";
import * as queue from "../lib/queue.ts";
import * as ls from "../lib/lanestate.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function workspace(): Env {
  const e = makeEnv("lanestate");
  e.env.GOVERN_QUEUE = join(e.root, "queue");
  mkdirSync(join(e.root, "PALS-Notes", "processes"), { recursive: true });
  copyFileSync(fixture("pn-process.json"), join(e.root, "PALS-Notes", "processes", "pn.json"));
  use(e);
  return e;
}
const lane = (slug: string, stage?: string) => {
  const p = create(slug, { process: "pn", title: `Lane ${slug}` });
  if (stage) { p.stage = stage; save(p); }
  return load(slug);
};
const ledger = (slug: string, entries: Record<string, unknown>[]) => { for (const e of entries) appendLedger(slug, e); };

test("a fresh lane is at its first stage with the first gate pending and nobody working: waiting on the coordinator", () => {
  workspace(); lane("a");
  const s = ls.readLane("a", { now: NOW });
  assert.equal(s.slug, "a"); assert.equal(s.process.name, "pn"); assert.equal(s.process.revision, 2); assert.match(s.process.hash, /^[0-9a-f]{64}$/);
  assert.equal(s.stage, "plan"); assert.equal(s.stageIndex, 1); assert.equal(s.stageTotal, 4);
  assert.deepEqual(s.stages.map((x) => x.mark), ["current", "todo", "todo", "todo"]);
  assert.deepEqual(s.gates.map((g) => [g.name, g.owner, g.decision]), [["plan-review", "coordinator", "pending"], ["go", "owner", "waiting"], ["ship-ok", "owner", "waiting"]]);
  assert.deepEqual(s.checks, [{ stage: "plan", command: "planned" }, { stage: "build", command: "built" }]);
  assert.equal(s.status, "waiting-on-coordinator"); assert.deepEqual(s.waitingOn, ["coordinator"]);
});

test("an approved gate carries who, when and the quote, and unlocks the gate that needs it", () => {
  workspace(); const p = lane("a");
  p.approvals["plan-review"] = { at: iso(30), quote: "looks right to me", by: "coordinator" }; save(p);
  const s = ls.readLane("a", { now: NOW });
  assert.deepEqual(s.gates[0], { name: "plan-review", stage: "plan", owner: "coordinator", decision: "approved", needs: [], by: "coordinator", at: iso(30), quote: "looks right to me" });
  assert.equal(s.gates[1]!.decision, "pending");
  assert.equal(s.status, "waiting-on-owner");
});

test("a failed check at the current stage blocks the lane and names the first failing line of its log; a later pass clears it", () => {
  const e = workspace(); lane("a", "build");
  write(join(e.projects, "a", "govern", "jobs", "j1", "job.json"), "{}");
  write(join(e.projects, "a", "govern", "jobs", "j1", "log"), "starting\nall fine so far\nFAIL: 3 beats have no media\nsummary line\n");
  ledger("a", [{ kind: "check", stage: "build", name: "built", ok: false, exit: 1, job: "j1" }]);
  let s = ls.readLane("a", { now: NOW });
  assert.deepEqual(s.stages.map((x) => x.mark), ["done", "blocked", "todo", "todo"]);
  assert.equal(s.status, "blocked-by-check");
  const c = s.checks.find((x) => x.stage === "build")!;
  assert.equal(c.ok, false); assert.equal(c.exit, 1); assert.equal(c.failure, "FAIL: 3 beats have no media");
  ledger("a", [{ kind: "check", stage: "build", name: "built", ok: true, exit: 0, job: "j2" }]);
  s = ls.readLane("a", { now: NOW });
  assert.equal(s.checks.find((x) => x.stage === "build")!.ok, true); assert.equal(s.checks.find((x) => x.stage === "build")!.failure, undefined);
  assert.equal(s.stages[1]!.mark, "current");
});

test("an open work segment makes a lane running for two hours, then it is idle again; closing it ends it", () => {
  workspace(); lane("a", "review");
  const at = Date.now();
  ledger("a", [{ kind: "work", stage: "review", engine: "codex", session: "s" }]);
  assert.equal(ls.readLane("a", { now: at }).status, "running");
  assert.equal(ls.readLane("a", { now: at + ls.WORK_FRESH_MS + 60_000 }).status, "idle");
  ledger("a", [{ kind: "done", engine: "codex", session: "s" }]);
  assert.equal(ls.readLane("a", { now: at }).status, "idle");
});

test("an open BLOCKED message for the lane is listed and makes the lane wait on its addressee; a closed one does not", () => {
  workspace(); lane("a", "review"); lane("b", "review");
  const m = queue.send({ project: "a", task: "t", kind: "BLOCKED", from: "codex", to: "owner", summary: "need the licence decision", body: "x", files: [], access: "read-only" });
  const closed = queue.send({ project: "b", task: "t", kind: "BLOCKED", from: "codex", to: "owner", summary: "closed one", body: "x", files: [], access: "read-only" });
  queue.close(closed.id, "owner");
  const all = ls.readLanes({ now: NOW });
  const a = all.lanes.find((x) => x.slug === "a")!, b = all.lanes.find((x) => x.slug === "b")!;
  assert.deepEqual(a.blocked.map((x) => [x.id, x.to, x.summary]), [[m.id, "owner", "need the licence decision"]]);
  assert.equal(a.status, "waiting-on-owner");
  assert.equal(b.blocked.length, 0); assert.equal(b.status, "idle");
});

test("a finished lane is done with every stage done, and its last activity is its latest record", () => {
  workspace(); const p = lane("a", "ship"); p.finished = iso(5); save(p);
  const s = ls.readLane("a", { now: NOW });
  assert.equal(s.status, "done"); assert.deepEqual(s.stages.map((x) => x.mark), ["done", "done", "done", "done"]); assert.equal(s.finished, iso(5));
  assert.ok(Date.parse(s.lastActivity) > 0);
});

test("readLanes reports a lane whose govern.json cannot be read instead of dropping it, and the others still show", () => {
  const e = workspace(); lane("a");
  write(join(e.projects, "broken", "govern.json"), "{ not json");
  const r = ls.readLanes({ now: NOW });
  assert.deepEqual(r.lanes.map((x) => x.slug), ["a"]); assert.equal(r.unreadable.length, 1); assert.equal(r.unreadable[0]!.slug, "broken");
  assert.match(r.unreadable[0]!.error, /not JSON/);
});

test("the wire shape accepts a summary and refuses an unknown field, a bad status and an over-long field", () => {
  workspace(); lane("a");
  const s = ls.readLane("a", { now: NOW }), parse = (v: unknown) => parseFile("lane", JSON.stringify(v), ls.LANE_STATE);
  assert.deepEqual(parse(s), s);
  assert.throws(() => parse({ ...s, extra: 1 }), /extra/);
  assert.throws(() => parse({ ...s, status: "sleeping" }), /status/);
  assert.throws(() => parse({ ...s, title: "x".repeat(201) }), /title/);
});
