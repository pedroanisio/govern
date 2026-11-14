// Business outcomes (lib/outcomes.ts, BUSINESS.md "Business outcomes"): whether a case was right, read from the boolean
// fields a process names in `outcomes` or from a later `govern outcome` entry, which wins; and `govern metrics`, which sums
// a process's cases per revision or canary arm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, type Env } from "./helpers.ts";
import { appendLedger, create, load, save } from "../lib/project.ts";
import { parseProcess } from "../lib/process.ts";
import { GovernError } from "../lib/util.ts";
import { laneOutcome, metrics, summarize, type LaneOutcome } from "../lib/outcomes.ts";

const def = (revision = 1, extra: Record<string, unknown> = {}) => ({
  version: 1, name: "contestacao", revision,
  fields: { valor: { type: "number" }, correto: { type: "boolean" }, clienteImpactado: { type: "boolean" } },
  outcomes: { correct: "correto", customerImpact: "clienteImpactado" },
  people: { gil: { user: userInfo().username, roles: ["gestor"] } },
  stages: [{ name: "decidir", next: [{ to: ["fim"] }] }, { name: "fim", next: [] }],
  gates: [],
  ...extra,
});
const processFile = (e: Env) => join(e.root, "PALS-Notes/processes/contestacao.json");
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
function lane(e: Env, slug: string, data: Record<string, unknown> = {}, finish = true): void {
  assert.equal(govern(e, ["new", slug, "--process", "contestacao", "--title", slug]).code, 0);
  if (Object.keys(data).length) assert.equal(govern(e, ["data", slug, "--set", JSON.stringify(data)]).code, 0);
  // decidir → fim, then fim, the last stage, finishes the case.
  if (finish) for (const note of ["decided", "closed"]) { const r = govern(e, ["advance", slug, "--note", note]); assert.equal(r.code, 0, r.out + r.err); }
}

test("a case's outcome comes from the process's declared fields, and a later govern outcome wins", () => {
  const e = makeEnv("outcomes");
  write(processFile(e), JSON.stringify(def()));
  lane(e, "c1", { correto: true, clienteImpactado: false });
  const before = inWorkspace(e, () => laneOutcome(load("c1")));
  assert.equal(before.correct, true);
  assert.equal(before.customerImpact, false);
  assert.equal(before.revision, 1);
  assert.ok(before.finished && before.seconds !== undefined);

  const r = govern(e, ["outcome", "c1", "--correct", "no", "--customer-impact", "yes", "--note", "credit applied twice"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /c1: correct false, customer harmed true/);
  const after = inWorkspace(e, () => laneOutcome(load("c1")));
  assert.equal(after.correct, false);
  assert.equal(after.customerImpact, true);

  assert.match(govern(e, ["outcome", "c1"]).err, /name at least one/);
  assert.match(govern(e, ["outcome", "c1", "--correct", "maybe"]).err, /yes or no/);
});

test("exceptions, those with no destination, human touches, agent tasks and money are counted from the ledger", () => {
  const e = makeEnv("outcomes-ledger");
  write(processFile(e), JSON.stringify(def()));
  lane(e, "c1", {}, false);
  const o = inWorkspace(e, () => {
    appendLedger("c1", { kind: "drive-failed", stage: "decidir", reason: "x", routed: "fim" });
    appendLedger("c1", { kind: "drive-failed", stage: "decidir", reason: "y" });
    appendLedger("c1", { kind: "approve", gate: "g" });
    appendLedger("c1", { kind: "human-complete", stage: "decidir" });
    appendLedger("c1", { kind: "drive-sent", stage: "decidir" });
    appendLedger("c1", { kind: "drive-money", charged: true, amount: 10.5, currency: "BRL" });
    appendLedger("c1", { kind: "drive-money", charged: false, amount: 99, currency: "BRL" });
    return laneOutcome(load("c1"));
  });
  assert.equal(o.exceptions, 2);
  assert.equal(o.unrouted, 1);
  assert.equal(o.humanTouches, 2);
  assert.equal(o.agentTasks, 1);
  assert.deepEqual(o.moved, { BRL: 10.5 });
  assert.equal(o.correct, undefined);
  assert.equal(o.finished, undefined);
});

test("summaries: the correct rate is over the judged cases; the other rates over every case", () => {
  const row = (o: Partial<LaneOutcome>): LaneOutcome => ({ slug: "x", process: "p", revision: 1, created: "", exceptions: 0, unrouted: 0, humanTouches: 0, agentTasks: 0, moved: {}, ...o });
  const s = summarize("r1", [
    row({ correct: true, finished: "f", seconds: 60 }), row({ correct: false, customerImpact: true, finished: "f", seconds: 120 }),
    row({ exceptions: 1, unrouted: 1, humanTouches: 1 }), row({ seconds: 600, finished: "f" }),
  ]);
  assert.equal(s.lanes, 4);
  assert.equal(s.finished, 3);
  assert.equal(s.judged, 2);
  assert.equal(s.correctRate, 0.5);
  assert.equal(s.impactRate, 0.25);
  assert.equal(s.exceptionRate, 0.25);
  assert.equal(s.unrouted, 1);
  assert.equal(s.touchedRate, 0.25);
  assert.equal(s.p50Seconds, 120);
  assert.equal(s.p90Seconds, 600);
  assert.equal(summarize("none", []).correctRate, undefined);
});

test("govern metrics sums a process's cases per revision, newest first; a lane keeps the revision it was opened under", () => {
  const e = makeEnv("outcomes-metrics");
  write(processFile(e), JSON.stringify(def(1)));
  lane(e, "a1", { correto: true });
  lane(e, "a2", { correto: false, clienteImpactado: true });
  write(processFile(e), JSON.stringify(def(2)));
  lane(e, "b1", { correto: true });
  lane(e, "b2", {}, false);

  const groups = inWorkspace(e, () => metrics("contestacao"));
  assert.deepEqual(groups.map((g) => g.key), ["revision 2", "revision 1"]);
  const [r2, r1] = groups;
  assert.equal(r1!.lanes, 2);
  assert.equal(r1!.correctRate, 0.5);
  assert.equal(r1!.impacted, 1);
  assert.equal(r2!.lanes, 2);
  assert.equal(r2!.finished, 1);
  assert.equal(r2!.correctRate, 1);

  const text = govern(e, ["metrics", "contestacao"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /revision 2: 2 cases, 1 finished; correct 100% of 1 judged/);
  assert.match(text.out, /revision 1: 2 cases, 2 finished; correct 50% of 2 judged; customer harmed 1/);
  const json = JSON.parse(govern(e, ["metrics", "contestacao", "--json"]).out);
  assert.equal(json.process, "contestacao");
  assert.equal(json.groups.length, 2);
  assert.equal(JSON.parse(govern(e, ["metrics", "contestacao", "--since", "2999-01-01T00:00:00Z", "--json"]).out).groups.length, 0);
  assert.match(govern(e, ["metrics", "contestacao", "--by", "day"]).err, /revision or arm/);
  assert.match(govern(e, ["metrics", "nada"]).out, /no cases of nada/);
});

test("metrics --by arm groups canary lanes per canary and arm, and replay lanes are never counted", () => {
  const e = makeEnv("outcomes-arm");
  write(processFile(e), JSON.stringify(def()));
  lane(e, "a1", { correto: true });
  lane(e, "a2", { correto: false });
  lane(e, "a3", { correto: true });
  lane(e, "r1", { correto: true });
  inWorkspace(e, () => {
    for (const [s, arm] of [["a1", "candidate"], ["a2", "base"]] as const) { const p = load(s); p.canary = { id: "k1", arm }; save(p); }
    const r = load("r1"); r.replay = { run: "rp1", of: "a3" }; save(r);
  });
  const keys = inWorkspace(e, () => metrics("contestacao", { by: "arm" })).map((g) => `${g.key}=${g.lanes}`);
  assert.deepEqual(keys.sort(), ["k1:base=1", "k1:candidate=1", "none=1"]);
});

test("a lane created with data keeps it as its intake", () => {
  const e = makeEnv("outcomes-intake");
  write(processFile(e), JSON.stringify(def()));
  const p = inWorkspace(e, () => { create("c1", { process: "contestacao", title: "c1", data: { valor: 120 } }); return load("c1"); });
  assert.deepEqual({ ...p.intake }, { valor: 120 });
});

test("outcomes must name declared boolean fields", () => {
  const refused = (o: Record<string, unknown>, re: RegExp) => {
    try { parseProcess("contestacao.json", JSON.stringify(def(1, { outcomes: o }))); assert.fail("loaded"); }
    catch (err) { assert.ok(err instanceof GovernError, String(err)); assert.match(err.message, re); }
  };
  refused({ correct: "valor" }, /outcomes\.correct.*valor is not a declared boolean field/);
  refused({ customerImpact: "nada" }, /outcomes\.customerImpact.*nada/);
  refused({ wrong: "correto" }, /wrong/);
});
