import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, tempDir, asSession, typed, present, HERE, setConfig, type Env } from "./helpers.ts";
import { sleepSync } from "../lib/util.ts";
import * as al from "../lib/allowances.ts";

const A = (extra: Record<string, unknown> = {}) => ({ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 10, ...extra });
const parse = (raw: unknown) => al.parseAllowances("allowances.json", raw);
const rejects = (raw: unknown, re: RegExp) => assert.throws(() => parse(raw), (e: Error) => re.test(e.message) && e.message.startsWith("allowances.json: "));
const USD = (n: number) => ({ usd: n });

/** A state dir of its own and a fixed clock, for the in-process tests. */
function state(now = "2026-10-14T10:00:00Z"): string {
  const d = tempDir("allow-state");
  process.env.GOVERN_STATE = d;
  process.env.GOVERN_NOW = now;
  return d;
}
const first = (list: Record<string, al.Allowance>) => present(Object.values(list)[0], "an allowance");
/** A pid that is certainly gone: a child that already exited. */
function deadPid(): number {
  const r = spawnSync("true");
  return present(r.pid, "a pid");
}
const spent = (d: string, name = "budget") => (existsSync(join(d, "allowances", name, "spent.jsonl")) ? jsonl(join(d, "allowances", name, "spent.jsonl")) : []);

// ---------------------------------------------------------------- declaration

test("allowances are typed: consumer, unit, limit, currency, period, owner; refused with the path", () => {
  const all = parse([A({ taskEstimate: 0.5, owner: "pedro" }), A({ name: "hours", consumer: "profile:codex-read", unit: "machine-hours", limit: 2, period: "day" }),
    A({ name: "cash", consumer: "lane:ops", unit: "money", currency: "EUR", limit: 50 })]);
  const b = present(all["budget"], "budget");
  assert.deepEqual([b.consumer, b.unit, b.limit, b.period, b.owner, b.taskEstimate], [{ kind: "lane", name: "film" }, "model-usd", 10, "total", "pedro", 0.5]);
  assert.equal(all["hours"]?.period, "day");
  assert.equal(all["hours"]?.owner, "owner");
  assert.equal(Object.getPrototypeOf(all), null);
  rejects([A({ colour: "red" })], /\$\[0\]\.colour: unknown key/);
  rejects([A({ unit: "tokens" })], /\$\[0\]\.unit/);
  rejects([A({ consumer: "film" })], /\$\[0\]\.consumer: must be "lane:<lane or folder>" or "profile:<name>"/);
  rejects([A({ limit: -1 })], /\$\[0\]\.limit/);
  rejects([A({ unit: "money" })], /\$\[0\]\.currency: a money allowance needs a currency/);
  rejects([A({ currency: "USD" })], /\$\[0\]\.currency: only a money allowance has a currency/);
  rejects([A({ period: "week" })], /\$\[0\]\.period/);
  rejects([A({ taskEstimate: 1, unit: "machine-hours" })], /\$\[0\]\.taskEstimate: only a model-usd allowance/);
  rejects([A(), A()], /\$\[1\]\.name: allowance "budget" is already defined/);
  rejects([A({ name: "__proto__" })], /\$\[0\]\.name/);
  rejects([A({ owner: "Pedro P" })], /\$\[0\]\.owner/);
});

// ---------------------------------------------------------------- reserve, settle, refuse

test("a reservation is held against the allowance, and settling releases the unused part and records the actual", () => {
  const d = state();
  const list = parse([A()]), b = first(list);
  assert.equal(al.reserve(list, { lane: "film" }, { id: "task:1", label: "task 1", ...USD(4) }), undefined);
  let s = al.status(b);
  assert.deepEqual([s.used, s.reserved, s.left], [0, 4, 6]);
  const no = al.reserve(list, { lane: "film" }, { id: "task:2", label: "task 2", ...USD(7) });
  assert.ok(no);
  assert.equal(no.kind, "over");
  assert.match(no.text, /task 2 asked 7 USD of allowance "budget" \(model dollars, in total\); left 6 \(limit 10, used 0, reserved 4\)/);
  assert.match(no.text, /Decision owner: owner\./);
  assert.match(no.text, /govern allow budget --extra 1 --quote "<owner's own words>"/);
  al.settle("task:1", { usd: 1.5 });
  s = al.status(b);
  assert.deepEqual([s.used, s.reserved, s.left], [1.5, 0, 8.5]);
  const rows = spent(d);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].reserved, rows[0].actual], ["task:1", 4, 1.5]);
  assert.equal(al.reserve(list, { lane: "film" }, { id: "task:2", label: "task 2", ...USD(7) }), undefined, "fits once the unused part is released");
});

test("a consumer with no matching allowance is never asked; a lane folder covers its lanes and not a sibling prefix", () => {
  state();
  const list = parse([A({ consumer: "lane:ops", limit: 1 })]);
  const ask = (lane: string) => al.reserve(list, { lane }, { id: `t:${lane}`, label: lane, ...USD(5) });
  assert.ok(ask("ops/engine"), "ops/engine is inside the folder ops");
  assert.ok(ask("ops"));
  assert.equal(ask("opsx"), undefined);
  assert.equal(al.reserve(list, { profile: "codex-read" }, { id: "p", label: "p", ...USD(5) }), undefined);
});

test("a profile allowance matches the profile, and one request is reserved against every allowance that applies", () => {
  state();
  const list = parse([A({ consumer: "profile:claude-read", limit: 5 }), A({ name: "lane-cap", limit: 3 })]);
  assert.equal(al.reserve(list, { lane: "film", profile: "claude-read" }, { id: "t", label: "t", ...USD(2) }), undefined);
  assert.deepEqual([al.status(present(list["budget"], "b")).reserved, al.status(present(list["lane-cap"], "c")).reserved], [2, 2]);
  const no = al.reserve(list, { lane: "film", profile: "claude-read" }, { id: "u", label: "u", ...USD(2) });
  assert.match(no?.text ?? "", /allowance "lane-cap"/);
  assert.equal(al.status(present(list["budget"], "b")).reserved, 2, "the refused request left nothing reserved on the other allowance");
});

test("a model-usd allowance without a taskEstimate refuses a request that declares no estimate, and says how to give one", () => {
  state();
  const list = parse([A()]);
  const no = al.reserve(list, { lane: "film" }, { id: "t", label: "t" });
  assert.equal(no?.kind, "no-estimate");
  assert.match(no?.text ?? "", /no estimate.*--estimate-usd.*taskEstimate/);
  const withDefault = parse([A({ taskEstimate: 0.25 })]);
  assert.equal(al.reserve(withDefault, { lane: "film" }, { id: "t", label: "t" }), undefined);
  assert.equal(al.status(first(withDefault)).reserved, 0.25);
});

test("a day allowance starts over each UTC day and keeps yesterday's spending out of today", () => {
  state("2026-10-14T23:00:00Z");
  const list = parse([A({ period: "day", limit: 10 })]), b = first(list);
  al.reserve(list, { lane: "film" }, { id: "t", label: "t", ...USD(9) });
  al.settle("t", { usd: 9 });
  assert.equal(al.status(b).left, 1);
  process.env.GOVERN_NOW = "2026-10-15T00:00:01Z";
  assert.equal(al.status(b).left, 10);
  assert.equal(al.reserve(list, { lane: "film" }, { id: "t2", label: "t2", ...USD(9) }), undefined);
});

test("an approved extra raises the limit for its own period only", () => {
  state("2026-10-14T10:00:00Z");
  const list = parse([A({ period: "day", limit: 1 })]), b = first(list);
  al.grant(b, 4, "yes, spend 4 more", { kind: "terminal", user: "u" }, "owner");
  assert.deepEqual([al.status(b).extra, al.status(b).left], [4, 5]);
  process.env.GOVERN_NOW = "2026-10-15T10:00:00Z";
  assert.deepEqual([al.status(b).extra, al.status(b).left], [0, 1]);
});

// ---------------------------------------------------------------- crash safety

test("a reservation whose holder died is swept on the next attempt: the job is settled first when it has one, else released with a note", () => {
  const d = state();
  const list = parse([A()]), b = first(list);
  const gone = { pid: deadPid() };
  assert.equal(al.reserve(list, { lane: "film" }, { id: "task:dead", label: "dead", ...USD(8), holder: gone }), undefined);
  assert.equal(al.status(b).reserved, 0, "a dead holder's reservation is not counted");
  assert.equal(al.reserve(list, { lane: "film" }, { id: "job:x", label: "job", ...USD(1), holder: gone, job: { slug: "film", id: "j1" } }), undefined);
  const seen: string[] = [];
  assert.equal(al.reserve(list, { lane: "film" }, { id: "task:new", label: "new", ...USD(9) }, (j) => { seen.push(`${j.slug}/${j.id}`); return false; }), undefined);
  assert.deepEqual(seen, ["film/j1"]);
  assert.deepEqual(spent(d).map((r) => [r.id, r.actual]), [["task:dead", 0], ["job:x", 0]]);
  assert.match(String(spent(d)[0].note), /holder died/);
  assert.equal(readdirSync(join(d, "allowances", "budget", "reserved")).length, 1, "only the new reservation is left");
});

test("a dead holder whose job still runs keeps its reservation", () => {
  state();
  const list = parse([A()]);
  al.reserve(list, { lane: "film" }, { id: "job:r", label: "job", ...USD(8), holder: { pid: deadPid() }, job: { slug: "film", id: "j2" } });
  const no = al.reserve(list, { lane: "film" }, { id: "t", label: "t", ...USD(5) }, () => true);
  assert.match(no?.text ?? "", /left 2/);
});

// ---------------------------------------------------------------- govern allow

function lane(allowances: unknown[], extra: Record<string, unknown> = {}): { e: Env; state: string } {
  const e = makeEnv();
  const st = join(e.root, "state");
  e.env["GOVERN_STATE"] = st;
  setConfig(e, { allowances, ...extra });
  assert.equal(govern(e, ["new", "lane", "--process", "dev", "--title", "L"]).code, 0);
  return { e, state: st };
}
const extras = (st: string, name = "budget") => (existsSync(join(st, "allowances", name, "extras.jsonl")) ? jsonl(join(st, "allowances", name, "extras.jsonl")) : []);

test("govern allow records an extra from a terminal, with the words and the source, and the limit rises", () => {
  const { e, state: st } = lane([A({ consumer: "lane:lane" })]);
  const r = govern(e, ["allow", "budget", "--extra", "5", "--quote", "go on, 5 more dollars"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /budget: \+5 USD approved by owner · limit 15/);
  const x = present(extras(st)[0], "an extra");
  assert.deepEqual([x.amount, x.quote, x.by, x.source.kind], [5, "go on, 5 more dollars", "owner", "terminal"]);
  assert.match(govern(e, ["usage"]).out, /budget\s.*left 15/);
});

test("govern allow in a session needs the quote in a message the person typed, and refuses a Codex shell, a wrong --by and bad numbers", () => {
  const { e, state: st } = lane([A({ consumer: "lane:lane", owner: "pedro" })]);
  asSession(e, "11111111-1111-1111-1111-111111111111", [typed("fine, give budget 3 more")]);
  const ok = ["allow", "budget", "--extra", "3", "--by", "pedro", "--quote"];
  assert.equal(govern(e, [...ok, "give budget 3 more"]).code, 0);
  assert.equal(present(extras(st)[0], "extra").source.kind, "session");
  let r = govern(e, [...ok, "something nobody typed"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not found in the person's typed messages/);
  r = govern(e, [...ok, "give budget 3 more"], { CODEX_THREAD_ID: "1" });
  assert.equal(r.code, 1);
  assert.match(r.err, /Codex/);
  assert.match(govern(e, ["allow", "budget", "--extra", "3", "--quote", "give budget 3 more"]).err, /decided by pedro: pass --by pedro/);
  assert.match(govern(e, ["allow", "budget", "--extra", "3", "--by", "ana", "--quote", "give budget 3 more"]).err, /decided by pedro, not ana/);
  assert.match(govern(e, [...ok.slice(0, 3), "-2", ...ok.slice(4), "give budget 3 more"]).err, /--extra must be a positive number/);
  assert.match(govern(e, ["allow", "budget", "--extra", "3", "--by", "pedro", "--quote", "x"]).err, /--quote is required/);
  assert.match(govern(e, ["allow", "nope", "--extra", "3", "--quote", "give budget 3 more"]).err, /no allowance "nope"/);
  assert.equal(extras(st).length, 1, "only the accepted one was recorded");
});

// ---------------------------------------------------------------- machine jobs

const LAB = { name: "lab", kind: "vm", sharing: "dedicated", to: "lane", price: { basis: "per-hour", currency: "USD", amount: 3 } };
const ledger = (e: Env) => jsonl(join(e.projects, "lane", "govern", "ledger.jsonl"));
const jobIds = (e: Env) => readdirSync(join(e.projects, "lane", "govern", "jobs")).sort();
const jobJson = (e: Env, id: string) => JSON.parse(readFileSync(join(e.projects, "lane", "govern", "jobs", id, "job.json"), "utf8"));
const killGroup = (e: Env) => { for (const id of jobIds(e)) { const j = jobJson(e, id); if (j.pgid) try { process.kill(-j.pgid, "SIGKILL"); } catch { /* gone */ } } };
const until = (f: () => boolean, ms = 15000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) sleepSync(30); assert.ok(f(), "condition never held"); };
const setCmd = (e: Env, name: string, ...rest: string[]) => assert.equal(govern(e, ["cmd", "lane", name, ...rest]).code, 0);

function machineLane(allowance: Record<string, unknown>) {
  const w = lane([{ name: "hours", consumer: "lane:lane", unit: "machine-hours", limit: 1, ...allowance }], { resources: [LAB] });
  setCmd(w.e, "quick", "--resource", "lab", "--", "true");
  return w;
}

test("a job on a resource reserves its estimate (the command's timeout), then records the machine hours it really took", () => {
  const { e, state: st } = machineLane({});
  setCmd(e, "capped", "--resource", "lab", "--timeout", "600", "--", "true");
  const r = govern(e, ["run", "lane", "capped"]);
  assert.equal(r.code, 0, r.err);
  const rows = spent(st, "hours");
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].reserved - 600 / 3600) < 1e-9, "reserved the 600 s timeout");
  assert.ok(rows[0].actual < 0.01, "a job that took a moment is charged a moment");
  assert.equal(readdirSync(join(st, "allowances", "hours", "reserved")).length, 0);
});

test("with no timeout and no --estimate a foreground job reserves the default limit; one over the allowance is refused with who decides", () => {
  const { e, state: st } = machineLane({ limit: 0.25, owner: "pedro" });
  const r = govern(e, ["run", "lane", "quick"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /refused: lane\/quick .* asked 0\.5 machine-hours of allowance "hours" \(machine-hours, in total\); left 0\.25 \(limit 0\.25, used 0, reserved 0\)\. Decision owner: pedro\./);
  assert.match(r.err, /govern allow hours --extra 0\.25 --quote .* --by pedro/);
  assert.equal(jobIds(e).length, 0, "nothing started, no job directory left");
  assert.equal(spent(st, "hours").length, 0);
  const ok = govern(e, ["run", "lane", "quick", "--estimate", "0.1"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(spent(st, "hours").length, 1);
});

test("within the allowance nobody is asked, and a granted extra lets a refused job through", () => {
  const { e } = machineLane({ limit: 0.25 });
  assert.equal(govern(e, ["run", "lane", "quick"]).code, 1);
  assert.equal(govern(e, ["allow", "hours", "--extra", "0.25", "--quote", "ok, a quarter hour more"]).code, 0);
  assert.equal(govern(e, ["run", "lane", "quick"]).code, 0);
});

test("a money allowance prices the estimate with the resource's rate, in its currency; another currency is not metered", () => {
  const { e, state: st } = lane([{ name: "cash", consumer: "lane:lane", unit: "money", currency: "USD", limit: 1 }], { resources: [LAB] });
  setCmd(e, "quick", "--resource", "lab", "--", "true");
  const r = govern(e, ["run", "lane", "quick", "--estimate", "0.5"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /asked 1\.5 USD of allowance "cash"/);
  assert.equal(govern(e, ["run", "lane", "quick", "--estimate", "0.25"]).code, 0);
  const row = present(spent(st, "cash")[0], "spent row");
  assert.equal(row.reserved, 0.75);
  assert.ok(row.actual < 0.01);
  const eur = lane([{ name: "cash", consumer: "lane:lane", unit: "money", currency: "EUR", limit: 0.01 }], { resources: [LAB] });
  setCmd(eur.e, "quick", "--resource", "lab", "--", "true");
  assert.equal(govern(eur.e, ["run", "lane", "quick"]).code, 0);
});

test("a local job (no resource) is not metered", () => {
  const { e } = machineLane({ limit: 0.001 });
  setCmd(e, "local", "--", "true");
  assert.equal(govern(e, ["run", "lane", "local"]).code, 0);
});

test("a --bg job with no timeout and no --estimate has no declared bound: it is refused and told how to give one", () => {
  const { e } = machineLane({});
  const r = govern(e, ["run", "lane", "quick", "--bg"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no declared duration.*--estimate/);
  assert.equal(jobIds(e).length, 0);
});

test("a --bg job's reservation passes to its process; if that is killed, the next attempt records the job and releases the reservation", () => {
  const { e, state: st } = machineLane({ limit: 1 });
  const gate = join(e.root, "gate");
  setCmd(e, "hold", "--resource", "lab", "--", "sh", "-c", `while [ ! -f ${gate} ]; do sleep 0.1; done`);
  try {
    const r = govern(e, ["run", "lane", "hold", "--bg", "--estimate", "0.4"]);
    assert.equal(r.code, 0, r.err);
    const dirR = join(st, "allowances", "hours", "reserved");
    assert.equal(readdirSync(dirR).length, 1);
    assert.match(govern(e, ["usage"]).out, /reserved 0\.4/);
    killGroup(e);
    until(() => jobIds(e).length === 1 && jobJson(e, jobIds(e)[0]!).pgid !== undefined);
    sleepSync(300);
    const next = govern(e, ["run", "lane", "quick", "--estimate", "0.1"]);
    assert.equal(next.code, 0, next.err);
    const rows = spent(st, "hours");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].reserved, 0.4);
    assert.equal(ledger(e).filter((x) => x.kind === "job" && x.status === "lost").length, 1, "the killed job was recorded");
  } finally { killGroup(e); }
});

// ---------------------------------------------------------------- queued tasks

function queued(allowances: unknown[]) {
  const w = lane(allowances);
  const fake = write(join(w.e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fake, 0o755);
  Object.assign(w.e.env, { GOVERN_QUEUE: join(w.e.root, "queue"), GOVERN_CLAUDE_BIN: fake, FAKE_CLAUDE_ARGV_OUT: join(w.e.root, "claude.log"),
    FAKE_CLAUDE_RESULT: JSON.stringify({ kind: "ACK", summary: "done", body: "ok" }) });
  return w;
}
const SEND = ["task", "send", "--to", "claude", "--project", "film", "--task", "review", "--summary", "review it"];

test("a queued task reserves its estimate, runs, and the actual cost from the usage is recorded", () => {
  const { e, state: st } = queued([A({ consumer: "profile:claude-read", limit: 1 })]);
  assert.equal(govern(e, [...SEND, "--estimate-usd", "0.4"]).code, 0);
  const r = govern(e, ["task", "dispatch"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ claude: ACK/);
  const row = present(spent(st)[0], "spent row");
  assert.deepEqual([row.reserved, row.actual], [0.4, 0.0123]);
  assert.equal(readdirSync(join(st, "allowances", "budget", "reserved")).length, 0);
  assert.match(govern(e, ["usage"]).out, /budget .*used 0\.0123 .*left 0\.9877/);
});

test("a queued task over the allowance is held, not failed; the decision owner is told once; an extra lets it run", () => {
  const { e } = queued([A({ consumer: "profile:claude-read", limit: 0.3, taskEstimate: 0.5 })]);
  assert.equal(govern(e, SEND).code, 0);
  for (let i = 0; i < 2; i++) {
    const r = govern(e, ["task", "dispatch"]);
    assert.match(r.out, /→ claude: held: .*asked 0\.5 USD of allowance "budget".*left 0\.3.*Decision owner: owner/);
  }
  assert.equal(existsSync(join(e.root, "claude.log")), false, "the model was never called");
  const list = govern(e, ["task", "list"]).out;
  assert.match(list, /open\s+TASK\s+owner→claude/);
  assert.equal([...list.matchAll(/BLOCKED\s+dispatcher→owner/g)].length, 1, "one notice, not one per attempt");
  assert.equal(govern(e, ["allow", "budget", "--extra", "0.3", "--quote", "yes, 0.3 more"]).code, 0);
  assert.match(govern(e, ["task", "dispatch"]).out, /→ claude: ACK/);
});

test("a queued task with no estimate anywhere is held with the way to declare one", () => {
  const { e } = queued([A({ consumer: "profile:claude-read" })]);
  govern(e, SEND);
  assert.match(govern(e, ["task", "dispatch"]).out, /held: .*no estimate.*--estimate-usd/);
});

test("a task nobody has an allowance for is dispatched with nobody asked", () => {
  const { e } = queued([A({ consumer: "profile:someone-else", limit: 0.001 })]);
  govern(e, SEND);
  assert.match(govern(e, ["task", "dispatch"]).out, /→ claude: ACK/);
});

// ---------------------------------------------------------------- visibility

test("govern desk and govern usage show each allowance: used, reserved, left", () => {
  const { e } = lane([A({ consumer: "lane:lane", taskEstimate: 1 })]);
  const want = /budget\s+lane:lane\s+model-usd\/total\s+used 0 · reserved 0 · left 10 of 10/;
  assert.match(govern(e, ["desk"]).out, /ALLOWANCES/);
  assert.match(govern(e, ["desk"]).out, want);
  assert.match(govern(e, ["usage"]).out, want);
});
