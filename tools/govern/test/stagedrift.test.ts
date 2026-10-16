// Stage drift: a lane whose ledger holds many jobs, notes and asks since its last advance may be recorded at the wrong
// stage. The warning shows in status, the desk and the brief; and a finished lane prints "finished", never "active <stage>".
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeEnv, govern, write, type Env } from "./helpers.ts";

const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const ledger = (e: Env, slug: string, entries: Record<string, unknown>[]) => {
  mkdirSync(join(e.projects, slug, "govern"), { recursive: true });
  for (const x of entries) appendFileSync(join(e.projects, slug, "govern", "ledger.jsonl"), JSON.stringify({ slug, ...x }) + "\n");
};
function lanes(): Env {
  const e = makeEnv("drift");
  e.env.GOVERN_QUEUE = join(e.root, "queue");
  for (const s of ["behind", "recent", "small", "fresh"]) assert.equal(govern(e, ["new", s, "--kind", "ops", "--title", s]).code, 0);
  // behind: 26 h since the advance, 22 jobs (11 background ones record two lines each), 12 notes and 3 asks since
  ledger(e, "behind", [{ kind: "advance", t: ago(30) }, { kind: "job", id: "old", status: "exit", t: ago(29) }]);
  ledger(e, "behind", [{ kind: "advance", t: ago(26) }]);
  for (let i = 0; i < 11; i++) ledger(e, "behind", [{ kind: "job", id: `b${i}`, status: "started", t: ago(20) }, { kind: "job", id: `b${i}`, status: "exit", t: ago(20) }, { kind: "job", id: `f${i}`, status: "exit", t: ago(19) }]);
  for (let i = 0; i < 12; i++) ledger(e, "behind", [{ kind: "note", text: `n${i}`, t: ago(10) }]);
  for (let i = 0; i < 3; i++) ledger(e, "behind", [{ kind: "ask", id: `a${i}`, t: ago(9) }]);
  // recent: just as many entries, but an advance 2 h ago
  ledger(e, "recent", [{ kind: "advance", t: ago(40) }]);
  for (let i = 0; i < 30; i++) ledger(e, "recent", [{ kind: "note", text: `n${i}`, t: ago(5) }]);
  ledger(e, "recent", [{ kind: "advance", t: ago(2) }, { kind: "note", text: "after", t: ago(1) }]);
  // small: 19 entries since an old advance (one short of the threshold)
  ledger(e, "small", [{ kind: "advance", t: ago(50) }]);
  for (let i = 0; i < 19; i++) ledger(e, "small", [{ kind: "note", text: `n${i}`, t: ago(5) }]);
  // fresh: 25 entries and no advance, but created 2 h ago
  for (let i = 0; i < 25; i++) ledger(e, "fresh", [{ kind: "note", text: `n${i}`, t: ago(1) }]);
  return e;
}

test("status, desk and brief warn about a lane with many entries and no advance in a day; a recent advance or a short ledger do not", () => {
  const e = lanes();
  const line = "⚠ stage may be behind: 22 jobs, 12 notes, 3 asks since the last advance 26 h ago";
  const status = govern(e, ["status"]).out;
  assert.ok(status.includes(line), status);
  assert.equal(status.split("stage may be behind").length - 1, 1, "only the lane that drifted is flagged");
  const desk = govern(e, ["desk"]).out;
  assert.ok(desk.includes(line), desk);
  assert.equal(desk.split("stage may be behind").length - 1, 1);
  const brief = govern(e, ["brief", "behind"]).out.split("\n");
  assert.match(brief[1]!, /stage 1\/4 plan/);
  assert.equal(brief[2], line, "under the stage line");
  for (const s of ["recent", "small", "fresh"]) assert.doesNotMatch(govern(e, ["brief", s]).out, /stage may be behind/, s);
});

test("a lane never advanced counts from its creation", () => {
  const e = lanes();
  const f = join(e.projects, "fresh", "govern.json");
  writeFileSync(f, readFileSync(f, "utf8").replace(/"created": "[^"]+"/, `"created": "${ago(49)}"`));
  assert.match(govern(e, ["brief", "fresh"]).out, /⚠ stage may be behind: 25 notes since the lane was created 49 h ago/);
});

test("a finished lane prints finished, not active <stage>, in status, desk and brief; the stage number stays", () => {
  const e = makeEnv("finished");
  e.env.GOVERN_QUEUE = join(e.root, "queue");
  write(join(e.root, "PALS-Notes/processes/two.json"), JSON.stringify({
    version: 1, name: "two", stages: [{ name: "build", next: [{ to: ["final"] }] }, { name: "final", next: [] }], gates: [],
  }));
  assert.equal(govern(e, ["new", "done-lane", "--process", "two"]).code, 0);
  for (let i = 0; i < 2; i++) assert.equal(govern(e, ["advance", "done-lane", "--note", "ok"]).code, 0);
  const row = (text: string) => text.split("\n").find((l) => l.startsWith("done-lane") || l.trimStart().startsWith("done-lane")) ?? "";
  const status = row(govern(e, ["status"]).out), desk = row(govern(e, ["desk"]).out);
  for (const r of [status, desk]) {
    assert.match(r, /2\/2 final/);
    assert.match(r, /finished/);
    assert.doesNotMatch(r, /active/);
  }
  assert.doesNotMatch(govern(e, ["brief", "done-lane"]).out, /active: (?!\(none\))/);
});

test("lanestate computes the drift and applies named thresholds", async () => {
  const ls = await import("../lib/lanestate.ts");
  const p = { created: ago(100), finished: undefined } as any;
  const notes = (n: number) => Array.from({ length: n }, () => ({ kind: "note", t: ago(1) }));
  assert.deepEqual(ls.drift(p, [{ kind: "advance", t: ago(30) }, ...notes(3), { kind: "job", id: "j", t: ago(1) }], NOW), { jobs: 1, notes: 3, asks: 0, hours: 30, since: "advance" });
  assert.equal(ls.driftWarning(p, notes(ls.DRIFT_MIN_ENTRIES - 1), NOW), undefined);
  assert.match(ls.driftWarning(p, notes(ls.DRIFT_MIN_ENTRIES), NOW)!, /20 notes since the lane was created 100 h ago/);
  assert.equal(ls.driftWarning({ ...p, finished: ago(1) }, notes(40), NOW), undefined, "a finished lane is never flagged");
  assert.equal(ls.driftWarning({ ...p, created: ago(ls.DRIFT_MIN_HOURS - 1) }, notes(40), NOW), undefined);
});
