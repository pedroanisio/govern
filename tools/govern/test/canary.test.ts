// Canary revisions (lib/canary.ts, ext/business/canary.ts; BUSINESS.md "Canary revisions"): a new revision gets a share
// of the new cases by a hash of the lane's name, keeps it for the case's life, and is promoted or reverted by
// `govern canary check` from the two arms' outcomes. A policy change needs a person; a heuristic one does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";
import { parseProcess } from "../lib/process.ts";
import { armOf } from "../lib/canary.ts";
import { changeKind, verdict } from "../ext/business/canary.ts";
import { summarize, type LaneOutcome } from "../lib/outcomes.ts";

const def = (revision: number, o: { body?: string; extra?: Record<string, unknown> } = {}) => ({
  version: 1, name: "contestacao", revision,
  fields: { correto: { type: "boolean" }, clienteImpactado: { type: "boolean" }, decisao: { type: "string" } },
  outcomes: { correct: "correto", customerImpact: "clienteImpactado" },
  people: { gil: { user: userInfo().username, roles: ["gestor"] } },
  stages: [
    { name: "decidir", agent: { to: "codex", task: "decidir", summary: "Decide", body: o.body ?? "Decide the dispute.", outputs: ["decisao"] }, next: [{ to: ["fim"] }] },
    { name: "fim", next: [] },
  ],
  gates: [],
  ...o.extra,
});
const processes = (e: Env) => join(e.root, "PALS-Notes/processes");
const candidateFile = (e: Env) => join(processes(e), "contestacao.candidate.json");
const canaryState = (e: Env) => join(e.root, "PALS-Notes", "govern-state", "canary");
const stateOf = (e: Env, slug: string) => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
const ledgerOf = (e: Env, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));

function setup(candidate: unknown = def(2, { body: "Decide the dispute; check the invoice first." })): Env {
  const e = makeEnv("canary");
  write(join(processes(e), "contestacao.json"), JSON.stringify(def(1)));
  write(candidateFile(e), JSON.stringify(candidate));
  return e;
}
const start = (e: Env, ...more: string[]) => govern(e, ["canary", "start", "contestacao", "--file", candidateFile(e), ...more]);
/** Open case `slug`, set its fields, and take it to its end (decidir, then fim). */
function finished(e: Env, slug: string, data: Record<string, unknown>): void {
  assert.equal(govern(e, ["new", slug, "--process", "contestacao", "--title", slug]).code, 0);
  assert.equal(govern(e, ["data", slug, "--set", JSON.stringify({ decisao: "credito", ...data })]).code, 0);
  for (const n of ["decided", "closed"]) { const r = govern(e, ["advance", slug, "--note", n]); assert.equal(r.code, 0, r.out + r.err); }
}
/** `n` lane names that fall in `arm` of the running canary. */
function namesIn(e: Env, arm: "candidate" | "base", n: number, prefix = "c"): string[] {
  const c = JSON.parse(readFileSync(join(canaryState(e), "contestacao.json"), "utf8"));
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (armOf(c, `${prefix}${i}`) === arm) out.push(`${prefix}${i}`);
  return out;
}

test("what a candidate changes: what an agent is told and how stages retry is heuristic; anything else is policy", () => {
  const p = (d: unknown) => parseProcess("/w/contestacao.json", JSON.stringify(d));
  const h = changeKind(p(def(1)), p(def(2, { body: "New words." })));
  assert.equal(h.kind, "heuristic");
  assert.deepEqual(h.changes, ["$.revision", "$.stages[0].agent.body"]);
  const routed = def(2);
  (routed.stages[0] as { next: unknown }).next = [{ to: ["fim"], when: { field: "decisao", op: "eq", value: "credito" } }, { to: ["fim"] }];
  const pol = changeKind(p(def(1)), p(routed));
  assert.equal(pol.kind, "policy");
  assert.ok(pol.policy.some((x) => x.startsWith("$.stages[0].next")), pol.policy.join());
  const outputs = def(2);
  (outputs.stages[0]!.agent as { outputs: string[] }).outputs = ["decisao", "correto"];
  assert.equal(changeKind(p(def(1)), p(outputs)).kind, "policy");
});

test("start: a heuristic change runs with no person; a policy change, or limits beyond the unattended ones, need --quote", () => {
  const e = setup();
  assert.match(govern(e, ["canary", "start", "contestacao"]).err, /--file F/);
  const ok = start(e);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /revision 1 → 2 \(heuristic change\) on 10% of new cases; judged after 20 finished/);
  assert.match(start(e).err, /a canary of contestacao is running/);

  const same = setup(def(1, { body: "x" }));
  assert.match(start(same).err, /revision 1 is not above the current revision/);
  const nothing = setup(def(2));
  assert.match(start(nothing).err, /changes nothing but the revision/);

  const policy = def(2, { extra: { gates: [{ name: "alcada", stage: "fim", policy: { role: "gestor", quorum: 1 } }] } });
  const p = setup(policy);
  const refused = start(p);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /changes policy \(\$\.gates.*a person starts this canary, with --quote/);
  const wide = setup();
  assert.match(start(wide, "--fraction", "0.9").err, /--fraction above 0\.5: beyond what a canary may do with no person/);
  assert.match(start(wide, "--tolerance", "0.3").err, /--tolerance above 0\.1/);
  const quoted = start(p, "--quote", "pode testar a nova alcada");
  assert.equal(quoted.code, 0, quoted.out + quoted.err);
  assert.match(quoted.out, /policy change/);
  const state = JSON.parse(readFileSync(join(canaryState(p), "contestacao.json"), "utf8"));
  assert.equal(state.source.kind, "terminal");
  assert.equal(state.source.quote, "pode testar a nova alcada");
});

test("a candidate file in the processes folder is not a process of its own", () => {
  const e = setup();
  const r = govern(e, ["process", "show", "contestacao"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /revision 1/);
});

test("new cases fall in an arm by the hash of their name and keep that arm's definition; the ledger says which", () => {
  const e = setup();
  assert.equal(start(e, "--fraction", "0.5").code, 0);
  const [cand] = namesIn(e, "candidate", 1), [base] = namesIn(e, "base", 1);
  for (const s of [cand!, base!]) assert.equal(govern(e, ["new", s, "--process", "contestacao", "--title", s]).code, 0);
  const c = stateOf(e, cand!), b = stateOf(e, base!);
  assert.equal(c.canary.arm, "candidate");
  assert.equal(c.processSnapshot.revision, 2);
  assert.match(c.processSnapshot.definition, /check the invoice first/);
  assert.equal(b.canary.arm, "base");
  assert.equal(b.processSnapshot.revision, 1);
  assert.ok(ledgerOf(e, cand!).some((x) => x.kind === "canary" && x.arm === "candidate" && x.revision === 2));
  const arms = JSON.parse(govern(e, ["metrics", "contestacao", "--by", "arm", "--json"]).out).groups.map((g: { key: string }) => g.key).sort();
  assert.equal(arms.length, 2);
  assert.match(arms[0], /:base$/);
});

test("check waits (75) until enough candidate cases finished and were judged, then promotes (0): the candidate becomes the process file", () => {
  const e = setup();
  assert.equal(start(e, "--fraction", "0.5", "--min", "10").code, 0);
  const cands = namesIn(e, "candidate", 10), bases = namesIn(e, "base", 3);
  for (const s of cands.slice(0, 9)) finished(e, s, { correto: true });
  const wait = govern(e, ["canary", "check", "contestacao"]);
  assert.equal(wait.code, 75, wait.out + wait.err);
  assert.match(wait.out, /continues: 9 of 10 candidate cases finished/);
  finished(e, cands[9]!, {});
  assert.match(govern(e, ["canary", "check", "contestacao"]).out, /9 of 10 candidate cases judged/);
  assert.equal(govern(e, ["outcome", cands[9]!, "--correct", "yes"]).code, 0);
  for (const s of bases) finished(e, s, { correto: true });
  const status = govern(e, ["canary", "status", "contestacao"]);
  assert.match(status.out, /candidate: 10 cases, 10 finished, correct 100% of 10/);
  assert.match(status.out, /verdict: promote/);
  const done = govern(e, ["canary", "check", "contestacao"]);
  assert.equal(done.code, 0, done.out + done.err);
  assert.match(done.out, /revision 2 promoted/);

  const file = JSON.parse(readFileSync(join(processes(e), "contestacao.json"), "utf8"));
  assert.equal(file.revision, 2);
  assert.match(file.stages[0].agent.body, /check the invoice first/);
  assert.ok(existsSync(join(canaryState(e), "contestacao.r1.json")), "the old file is kept");
  assert.ok(!existsSync(candidateFile(e)), "the candidate file is moved out of the processes folder");
  assert.equal(govern(e, ["canary", "check", "contestacao"]).code, 0, "a promoted canary stays promoted");
  assert.equal(govern(e, ["new", "after", "--process", "contestacao", "--title", "after"]).code, 0);
  const after = stateOf(e, "after");
  assert.equal(after.canary, undefined);
  assert.equal(after.processSnapshot.revision, 2);
  assert.ok(readFileSync(join(canaryState(e), "canary.jsonl"), "utf8").includes('"kind":"promoted"'));
});

test("a candidate case that harmed its customer reverts the canary at once (65); new cases go back to the current revision", () => {
  const e = setup();
  assert.equal(start(e, "--fraction", "0.5").code, 0);
  const [s] = namesIn(e, "candidate", 1);
  finished(e, s!, { correto: true, clienteImpactado: true });
  const r = govern(e, ["canary", "check", "contestacao"]);
  assert.equal(r.code, 65, r.out + r.err);
  assert.match(r.out, /reverted: 1 candidate case harmed the customer/);
  assert.equal(JSON.parse(readFileSync(join(processes(e), "contestacao.json"), "utf8")).revision, 1);
  const [next] = namesIn(e, "candidate", 1, "n");
  assert.equal(govern(e, ["new", next!, "--process", "contestacao", "--title", "n"]).code, 0);
  assert.equal(stateOf(e, next!).processSnapshot.revision, 1);
  assert.equal(stateOf(e, next!).canary, undefined);
  assert.equal(govern(e, ["canary", "check", "contestacao"]).code, 65);
});

test("the verdict: correct rate and exceptions against the base arm, within the tolerance", () => {
  const row = (o: Partial<LaneOutcome>): LaneOutcome => ({ slug: "x", process: "p", revision: 1, created: "", finished: "f", exceptions: 0, unrouted: 0, humanTouches: 0, agentTasks: 0, moved: {}, ...o });
  const many = (n: number, o: Partial<LaneOutcome>) => Array.from({ length: n }, () => row(o));
  const c = { process: "p", min: 10, tolerance: 0.05 } as Parameters<typeof verdict>[0];
  const base = summarize("base", [...many(18, { correct: true }), ...many(2, { correct: false })]); // 90%
  const v = (cand: LaneOutcome[], b = base, judges = true) => verdict(c, summarize("candidate", cand), b, { judgesCorrect: judges, baseChanged: false });
  assert.equal(v([...many(9, { correct: true }), ...many(1, { correct: false })]).decision, "promote"); // 90%
  assert.equal(v([...many(8, { correct: true }), ...many(2, { correct: false })]).decision, "revert"); // 80% < 85%
  assert.match(v([...many(8, { correct: true }), ...many(2, { correct: false })]).reason, /below 85%/);
  assert.equal(v(many(10, { correct: true, exceptions: 1, unrouted: 0 })).decision, "revert");
  assert.equal(v(many(10, { exceptions: 0 }), base, false).decision, "promote");
  assert.equal(v([...many(9, { correct: true }), row({ correct: true, unrouted: 1, exceptions: 1, finished: undefined })]).decision, "revert");
  const none = summarize("base", []);
  assert.equal(v([...many(9, { correct: true }), ...many(1, { correct: false })], none).decision, "revert"); // 90% < 95% with no base
  assert.equal(verdict(c, summarize("candidate", []), base, { judgesCorrect: true, baseChanged: true }).decision, "revert");
});

test("a process file edited under a running canary reverts it; a person can stop one in their own words", () => {
  const e = setup();
  assert.equal(start(e).code, 0);
  write(join(processes(e), "contestacao.json"), JSON.stringify(def(1, { body: "Edited by hand." })));
  const r = govern(e, ["canary", "check", "contestacao"]);
  assert.equal(r.code, 65);
  assert.match(r.out, /process file changed while the canary ran/);

  const s = setup();
  assert.equal(start(s).code, 0);
  assert.equal(govern(s, ["canary", "stop", "contestacao"]).code, 2);
  const stop = govern(s, ["canary", "stop", "contestacao", "--quote", "pare o canario"]);
  assert.equal(stop.code, 0, stop.out + stop.err);
  assert.match(govern(s, ["canary", "status", "contestacao"]).out, /reverted: stopped by .*pare o canario/);
  assert.match(govern(s, ["canary", "stop", "contestacao", "--quote", "de novo"]).err, /no running canary/);
});

test("a polling service: exit 75 is 'not yet', asked again after poll seconds without using an attempt", () => {
  const e = makeEnv("canary-poll");
  write(join(processes(e), "espera.json"), JSON.stringify({
    version: 1, name: "espera", fields: {},
    stages: [{ name: "esperar", service: { command: "olhar", attempts: 1, poll: 1 }, next: [{ to: ["fim"] }] }, { name: "fim", next: [] }], gates: [],
  }));
  assert.equal(govern(e, ["new", "w1", "--process", "espera", "--title", "w"]).code, 0);
  const counter = join(e.root, "count");
  writeFileSync(counter, "0");
  const script = `const fs=require('fs');const n=+fs.readFileSync(${JSON.stringify(counter)},'utf8')+1;fs.writeFileSync(${JSON.stringify(counter)},String(n));console.log('round '+n);process.exit(n<3?75:0)`;
  assert.equal(govern(e, ["cmd", "w1", "olhar", "--", process.execPath, "-e", script]).code, 0);
  const editRun = () => { const f = join(e.root, "PALS-Notes", "govern-state", "drive", "state.json"), s = JSON.parse(readFileSync(f, "utf8")); delete s["w1:esperar"].notBefore; writeFileSync(f, JSON.stringify(s)); };
  const first = govern(e, ["drive"]);
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, /w1 esperar: not yet; asked again after 1s .*round 1/);
  assert.match(govern(e, ["drive"]).out, /due at/);
  editRun();
  assert.match(govern(e, ["drive"]).out, /not yet.*round 2/);
  editRun();
  const last = govern(e, ["drive"]);
  assert.match(last.out, /w1 esperar: advanced/);
  assert.equal(stateOf(e, "w1").stage, "fim");
  assert.ok(!ledgerOf(e, "w1").some((x) => x.kind === "drive-failed" || x.kind === "drive-retry-scheduled"));
});

test("a lane command may pass a case field as {data.FIELD}; one that starts with - is refused", () => {
  const e = makeEnv("canary-data");
  write(join(processes(e), "contestacao.json"), JSON.stringify(def(1)));
  assert.equal(govern(e, ["new", "d1", "--process", "contestacao", "--title", "d"]).code, 0);
  assert.equal(govern(e, ["cmd", "d1", "eco", "--", process.execPath, "-e", "console.log('arg=' + process.argv[1])", "{data.decisao}"]).code, 0);
  assert.match(govern(e, ["run", "d1", "eco"]).err + govern(e, ["run", "d1", "eco"]).out, /the case has no decisao/);
  assert.equal(govern(e, ["data", "d1", "--set", JSON.stringify({ decisao: "credito parcial" })]).code, 0);
  assert.match(govern(e, ["run", "d1", "eco"]).out, /arg=credito parcial/);
  assert.equal(govern(e, ["data", "d1", "--set", JSON.stringify({ decisao: "--force" })]).code, 0);
  const bad = govern(e, ["run", "d1", "eco"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out + bad.err, /starts with "-": refused/);
  assert.ok(readdirSync(e.root).length > 0);
});
