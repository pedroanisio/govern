// Replaying past cases (lib/replay.ts, ext/business/replay.ts; BUSINESS.md "Replaying past cases"): finished cases run
// again on a candidate as replay/<run>/… lanes that govern drive moves on with no effect outside the lane (a command is
// never run; its outputs are the original's), stopping where a person or a sub-case would be needed, and the report
// compares them with the originals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";
import * as queue from "../lib/queue.ts";

const def = (o: { revision?: number; extra?: Record<string, unknown>; marker?: string } = {}) => ({
  version: 1, name: "contestacao", revision: o.revision ?? 1,
  fields: { cliente: { type: "string" }, valor: { type: "number" }, decisao: { type: "string" }, protocolo: { type: "string" } },
  people: { gil: { user: userInfo().username, roles: ["gestor"] } },
  ...(o.marker ? { setup: [{ commands: { registrar: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(o.marker)}, 'ran')`] } }] } : {}),
  stages: [
    { name: "decidir", agent: { to: "codex", task: "decidir", summary: "Decide {data.cliente}", body: "Decide the dispute.", outputs: ["decisao"] }, next: [{ to: ["registrar"] }] },
    { name: "registrar", service: { command: "registrar", outputs: ["protocolo"] }, next: [{ to: ["fim"] }] },
    { name: "fim", next: [] },
  ],
  gates: [],
  ...o.extra,
});
const processes = (e: Env) => join(e.root, "PALS-Notes/processes");
const ledgerOf = (e: Env, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const stateOf = (e: Env, slug: string) => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));

function setup(o: Parameters<typeof def>[0] = {}): Env {
  const e = makeEnv("replay");
  write(join(processes(e), "contestacao.json"), JSON.stringify(def(o)));
  return e;
}
/** A past case taken to its end by hand: `data` set, then each stage advanced. */
function original(e: Env, slug: string, data: Record<string, unknown>): void {
  assert.equal(govern(e, ["new", slug, "--process", "contestacao", "--title", slug]).code, 0);
  assert.equal(govern(e, ["data", slug, "--set", JSON.stringify(data)]).code, 0);
  for (const n of ["decided", "registered", "closed"]) { const r = govern(e, ["advance", slug, "--note", n]); assert.equal(r.code, 0, r.out + r.err); }
}
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
/** The agent's answer to every open task of a replay lane: `decide(slug)` is its decisao. */
function answerAll(e: Env, decide: (lane: string) => string): number {
  return inWorkspace(e, () => {
    const open = queue.all().filter((x) => x.state === "open" && x.m.kind === "TASK" && String(x.m.lane).startsWith("replay/"));
    for (const t of open) {
      const r = queue.reply(t.m.id, "codex", { kind: "HANDOFF", summary: "done", body: JSON.stringify({ decisao: decide(String(t.m.lane)) }) });
      r.verification = { state: "shape only" };
      queue.save(r, "open");
    }
    return open.length;
  });
}
const driveAll = (e: Env) => { for (let i = 0; i < 4; i++) govern(e, ["drive"]); };
const start = (e: Env, ...more: string[]) => govern(e, ["replay", "start", "contestacao", ...more]);

test("replay start makes a replay lane per finished case, from the data it was opened with, left out of status", () => {
  const e = setup();
  original(e, "o1", { cliente: "ACME", valor: 10, decisao: "credito", protocolo: "P-1" });
  original(e, "o2", { cliente: "Beta", valor: 99, decisao: "negar", protocolo: "P-2" });
  assert.equal(govern(e, ["new", "aberto", "--process", "contestacao"]).code, 0);
  const r = start(e);
  assert.equal(r.code, 0, r.out + r.err);
  const id = r.out.trim();
  assert.match(id, /^contestacao-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.match(r.err, /2 cases started/);
  const lane = `replay/${id}/o1`, s = stateOf(e, lane);
  assert.deepEqual(s.replay, { run: id, of: "o1" });
  assert.deepEqual(s.data, { cliente: "ACME", valor: 10 }, "outputs of the original are not given to the replay");
  assert.ok(!existsSync(join(e.projects, "replay", id, "aberto")), "an unfinished case is not replayed");
  const st = govern(e, ["status"]);
  assert.doesNotMatch(st.out + st.err, /replay\//);
  assert.match(govern(e, ["new", "replay/x/y", "--process", "contestacao"]).err, /only govern replay makes them/);
  assert.match(start(e, "--lane", "aberto").err, /has not finished/);
  assert.match(govern(e, ["replay", "start", "contestacao", "--since", "2999-01-01T00:00:00Z"]).err, /no finished case of contestacao to replay/);
});

test("drive: agents work, the command is never run (its outputs are the original's), and the report compares", () => {
  const marker = join(makeEnv("marker").root, "ran");
  const e = setup({ marker });
  original(e, "o1", { cliente: "ACME", valor: 10, decisao: "credito", protocolo: "P-1" });
  original(e, "o2", { cliente: "Beta", valor: 99, decisao: "negar", protocolo: "P-2" });
  const id = start(e).out.trim();
  govern(e, ["drive"]);
  const running = govern(e, ["replay", "report", id]);
  assert.equal(running.code, 75, running.out + running.err);
  assert.match(running.out, /: running/);
  assert.equal(answerAll(e, () => "credito"), 2);
  driveAll(e);
  assert.ok(!existsSync(marker), "a replay never runs a command");
  const s = stateOf(e, `replay/${id}/o1`);
  assert.ok(s.finished, JSON.stringify(s));
  assert.equal(s.data.protocolo, "P-1");
  assert.ok(ledgerOf(e, `replay/${id}/o1`).some((x) => x.kind === "data" && x.replayOf === "o1"));
  const rep = govern(e, ["replay", "report", id]);
  assert.equal(rep.code, 65, rep.out + rep.err);
  assert.match(rep.out, /agreement 50% of 2 decided \(at least 90%\) on decisao/);
  assert.match(rep.out, /o2: finished \(decisao "negar" → "credito"\)/);
  const j = JSON.parse(govern(e, ["replay", "report", id, "--json", "--min", "0.5"]).out);
  assert.equal(j.verdict, "pass");
  assert.equal(j.agreement, 0.5);
  assert.equal(govern(e, ["replay", "report", id, "--min", "0.5"]).code, 0);
  assert.equal(govern(e, ["metrics", "contestacao", "--json"]).out.includes("replay/"), false);
  const m = JSON.parse(govern(e, ["metrics", "contestacao", "--json"]).out);
  assert.equal(m.groups[0].lanes, 2, "metrics count the originals only");
});

test("a command whose output the original lacks is a divergence; the report fails", () => {
  const e = setup();
  original(e, "o1", { cliente: "ACME", decisao: "credito" });
  const id = start(e).out.trim();
  govern(e, ["drive"]);
  answerAll(e, () => "credito");
  driveAll(e);
  const stop = ledgerOf(e, `replay/${id}/o1`).find((x) => x.kind === "replay-stopped");
  assert.equal(stop?.diverged, true);
  assert.equal(stop?.stage, "registrar");
  const rep = govern(e, ["replay", "report", id]);
  assert.equal(rep.code, 65);
  assert.match(rep.out, /o1: diverged at registrar: the original \(o1\) has no protocolo/);
  const d = govern(e, ["drive"]);
  assert.equal(d.code, 0, "a replay's divergence is not the operator's failure");
  assert.doesNotMatch(d.out, /replay\//, "a stopped replay is not driven again");
});

test("a candidate that needs a gate the original did not stops there: escalated more", () => {
  const e = setup();
  original(e, "o1", { cliente: "ACME", decisao: "credito", protocolo: "P-1" });
  const cand = join(processes(e), "contestacao.candidate.json");
  write(cand, JSON.stringify(def({ revision: 2, extra: { gates: [{ name: "alcada", stage: "fim", policy: { role: "gestor", quorum: 1 } }] } })));
  const st = start(e, "--file", cand);
  assert.equal(st.code, 0, st.out + st.err);
  const id = st.out.trim();
  govern(e, ["drive"]);
  answerAll(e, () => "credito");
  driveAll(e);
  const rep = JSON.parse(govern(e, ["replay", "report", id, "--json"]).out);
  assert.equal(rep.revision, 2);
  assert.equal(rep.cases[0].status, "escalated");
  assert.match(rep.cases[0].why, /waits for the alcada gate/);
  assert.equal(rep.moreEscalated, 1);
  assert.equal(rep.verdict, "fail", "nothing decided");
});

test("a person's task stops a replay; a writing agent too", () => {
  const two = (decidir: Record<string, unknown>, revision = 1) => ({ revision, extra: { stages: [{ name: "decidir", ...decidir, next: [{ to: ["fim"] }] }, { name: "fim", next: [] }] } });
  const e = setup(two({}));
  original2(e);
  const cand = join(processes(e), "contestacao.candidate.json");
  write(cand, JSON.stringify(def(two({ human: { role: "gestor" } }, 2))));
  const st = start(e, "--lane", "o1", "--file", cand);
  assert.equal(st.code, 0, st.out + st.err);
  const id = st.out.trim();
  assert.match(govern(e, ["drive"]).out, new RegExp(`replay/${id}/o1 decidir: replay stopped: a person's task`));
  assert.ok(stateOf(e, "o1").finished);
  const w = setup(two({ agent: { to: "codex", task: "decidir", summary: "s", body: "b", write: true } }));
  original2(w);
  const wid = start(w).out.trim();
  assert.match(govern(w, ["drive"]).out, new RegExp(`replay/${wid}/o1 decidir: replay stopped: its agent may write`));
  assert.equal(inWorkspace(w, () => queue.all().filter((x) => x.m.kind === "TASK").length), 0);
});
function original2(e: Env): void {
  assert.equal(govern(e, ["new", "o1", "--process", "contestacao"]).code, 0);
  for (const n of ["decided", "closed"]) assert.equal(govern(e, ["advance", "o1", "--note", n]).code, 0);
}

test("as a service stage, replay start writes its run to $GOVERN_OUTPUTS and starts one run per idempotency key", () => {
  const e = setup();
  original(e, "o1", { cliente: "ACME", decisao: "credito", protocolo: "P-1" });
  const outs = join(e.root, "outputs.json"), env = { GOVERN_OUTPUTS: outs, GOVERN_IDEMPOTENCY_KEY: "ops-1:replay:0" };
  const a = govern(e, ["replay", "start", "contestacao"], env), b = govern(e, ["replay", "start", "contestacao"], env);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out.trim(), b.out.trim());
  assert.deepEqual(JSON.parse(readFileSync(outs, "utf8")), { replay: a.out.trim() });
  assert.notEqual(govern(e, ["replay", "start", "contestacao"]).out.trim(), a.out.trim());
  assert.match(govern(e, ["replay", "report", "nope"]).err, /no replay run nope/);
});
