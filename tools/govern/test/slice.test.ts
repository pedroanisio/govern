import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, present, setConfig, type Env, childEnv } from "./helpers.ts";
import { sleepSync, readJson } from "../lib/util.ts";
import { parseProcess } from "../lib/process.ts";

// Fake provider (instances are lines "id tag" in $CLOUD; every call is logged to $CALLS) and fake recipe steps (plain sh).
const PROV = `#!/bin/sh
echo "$1 $2 tag=$GOVERN_TAG count=$GOVERN_COUNT id=$GOVERN_ID" >> "$CALLS"
case "$1" in
  start) n=\${3:-1}; i=0
    [ -n "$START_HOOK" ] && eval "$START_HOOK"
    while [ "$i" -lt "$n" ]; do
      s=$(cat "$CLOUD.seq" 2>/dev/null || echo 0); s=$((s + 1)); echo "$s" > "$CLOUD.seq"
      echo "\${ID_PREFIX}i-$s $2" >> "$CLOUD"; echo "\${ID_PREFIX}i-$s"; i=$((i + 1))
    done ;;
  stop) [ -n "$STOP_HOOK" ] && eval "$STOP_HOOK"; [ -n "$STOP_FAIL" ] && exit 3
    grep -v "^$2 " "$CLOUD" > "$CLOUD.new"; mv "$CLOUD.new" "$CLOUD" ;;
  list) cat "$CLOUD" 2>/dev/null ;;
esac
`;
const PROV_SHORT = `#!/bin/sh
echo "$1 $2 tag=$GOVERN_TAG count=$GOVERN_COUNT id=$GOVERN_ID" >> "$CALLS"
case "$1" in start) echo i-only ;; esac
`;
const SPLIT = `#!/bin/sh
echo "split tag=$1" >> "$CALLS"
printf '%s\\n' \${SPLIT_OUT:-p1 p2 p3 p4 p5} | tr ' ' '\\n'
`;
// $1 piece, $2 machine id, $3 out folder. PIECE_MODE: failfirst (p2 fails its first attempt), failall (p2 always fails),
// barrier (each machine's first piece waits until two machines are running one: proves the pieces run concurrently),
// hold (waits for $GATE).
const PIECE = `#!/bin/sh
echo "piece $1 $2" >> "$CALLS"
case "$PIECE_MODE:$1" in
  failfirst:p2) if [ ! -f "$MARK/$1" ]; then touch "$MARK/$1"; exit 1; fi ;;
  failall:p2) exit 1 ;;
  barrier:*) if [ ! -f "$MARK/$2" ]; then touch "$MARK/$2"; n=0
      while [ "$(ls "$MARK" | wc -l)" -lt 2 ]; do n=$((n + 1)); [ "$n" -gt 400000 ] && exit 9; done; fi ;;
  hold:*) while [ ! -f "$GATE" ]; do sleep 0.1; done ;;
  sabotage:p1) while [ ! -f "$MARK/pid-p2" ]; do sleep 0.05; done; rm -rf "$4"/doing/*/p1; exit 0 ;;
  sabotage:*) echo $$ > "$MARK/pid-$1"; sleep 30 ;;
  fork:*) sleep 60 & echo $! > "$MARK/sleeper"; wait ;;
esac
echo "$2" > "$3/$1"
`;
const JOIN = `#!/bin/sh
echo "join" >> "$CALLS"
ls "$1/done" | sort > "$2/joined"
[ "$JOIN_MODE" = fail ] && exit 5
exit 0
`;
const VERIFY = `#!/bin/sh
echo "verify" >> "$CALLS"
[ "$VERIFY_MODE" = fail ] && { echo "totals do not match" >&2; exit 4; }
exit 0
`;

interface Rig { e: Env; cloud: string; calls: string; env: Record<string, string>; state: string }
const recipe = (r: Partial<Record<string, unknown>> = {}) => ({
  resource: "farm", machines: 2,
  prepare: ["sh", "-c", "echo prepare >> \"$CALLS\""],
  split: ["sh", "SPLIT", "{tag}"], piece: ["sh", "PIECE", "{piece}", "{id}", "{out}", "{pieces}"], join: ["sh", "JOIN", "{pieces}", "{out}"], verify: ["sh", "VERIFY"], ...r,
});
function rig(opts: { recipe?: Partial<Record<string, unknown>>; allowances?: unknown[]; farm?: Record<string, unknown>; name?: string } = {}): Rig {
  const e = makeEnv(opts.name);
  const state = join(e.root, "state");
  e.env["GOVERN_STATE"] = state;
  const f = (n: string, body: string) => { const p = write(join(e.root, n), body); chmodSync(p, 0o755); return p; };
  const prov = f("prov.sh", PROV), short = f("prov-short.sh", PROV_SHORT);
  const steps = { SPLIT: f("split.sh", SPLIT), PIECE: f("piece.sh", PIECE), JOIN: f("join.sh", JOIN), VERIFY: f("verify.sh", VERIFY) };
  const sub = (argv: unknown) => (argv as string[]).map((a) => steps[a as keyof typeof steps] ?? a);
  const rc = recipe(opts.recipe);
  const full = { ...rc, split: sub(rc.split), piece: sub(rc.piece), join: sub(rc.join), verify: sub(rc.verify) };
  write(join(e.root, "PALS-Notes", "processes", "batch.json"), JSON.stringify({
    version: 1, name: "batch", stages: [{ name: "work" }], recipes: { batch: full, shorty: { ...full, resource: "shorty" } },
  }));
  setConfig(e, {
    resources: [
      { name: "farm", kind: "vm", sharing: "shared", price: { basis: "per-hour", currency: "USD", amount: 2 }, ...opts.farm,
        commands: { start: ["sh", prov, "start", "{tag}", "{count}"], stop: ["sh", prov, "stop", "{id}"], list: ["sh", prov, "list"] } },
      { name: "shorty", kind: "vm", sharing: "shared", commands: { start: ["sh", short, "start", "{tag}", "{count}"], stop: ["sh", short, "stop", "{id}"] } },
      { name: "theirs", kind: "vm", sharing: "dedicated", to: "other", commands: { start: ["sh", prov, "start", "{tag}", "{count}"], stop: ["sh", prov, "stop", "{id}"] } },
    ],
    ...(opts.allowances ? { allowances: opts.allowances } : {}),
  });
  assert.equal(govern(e, ["new", "lane", "--process", "batch", "--title", "L"]).code, 0);
  const cloud = write(join(e.root, "cloud"), ""), calls = join(e.root, "calls.log");
  const mark = join(e.root, "mark");
  write(join(mark, ".keep"), "");
  return { e, cloud, calls, state, env: { CLOUD: cloud, CALLS: calls, MARK: mark, GATE: join(e.root, "gate") } };
}
const g = (r: Rig, args: string[], env: Record<string, string> = {}) => govern(r.e, args, { ...r.env, ...env });
const calls = (r: Rig) => (existsSync(r.calls) ? readFileSync(r.calls, "utf8").split("\n").filter(Boolean) : []);
const kinds = (r: Rig) => calls(r).map((c) => c.split(" ")[0] ?? "");
const ledger = (r: Rig) => jsonl(join(r.e.projects, "lane", "govern", "ledger.jsonl"));
const jobEntry = (r: Rig) => present(ledger(r).find((x) => x.kind === "job" && x.status !== "started"), "job ledger line");
const jobsDir = (r: Rig) => join(r.e.projects, "lane", "govern", "jobs");
const cloudLines = (r: Rig) => readFileSync(r.cloud, "utf8").split("\n").filter(Boolean);
const until = (f: () => boolean, ms = 20000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) sleepSync(30); assert.ok(f(), "condition never held"); };
const spent = (r: Rig, name = "hours") => { const f = join(r.state, "allowances", name, "spent.jsonl"); return existsSync(f) ? jsonl(f) : []; };

test("a slice runs its pieces over the machines it started, joins and verifies, brings the machines down once, and ledgers the job", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "barrier" });
  assert.equal(a.code, 0, a.out + a.err);
  const k = kinds(r);
  assert.deepEqual(k.filter((x) => ["prepare", "start", "split", "join", "verify"].includes(x)), ["prepare", "start", "split", "join", "verify"]);
  assert.equal(k.filter((x) => x === "piece").length, 5);
  assert.ok(k.indexOf("start") < k.indexOf("split") && k.lastIndexOf("piece") < k.indexOf("join") && k.indexOf("join") < k.indexOf("verify") && k.indexOf("verify") < k.indexOf("stop"), k.join(" "));
  assert.match(calls(r).find((c) => c.startsWith("start")) ?? "", /count=2/);
  const machines = new Set(calls(r).filter((c) => c.startsWith("piece")).map((c) => c.split(" ")[2]));
  assert.deepEqual([...machines].sort(), ["i-1", "i-2"], "both machines ran pieces");
  assert.equal(k.filter((x) => x === "stop").length, 2, "one stop per machine, none twice");
  assert.deepEqual(cloudLines(r), [], "nothing left running");
  assert.equal(ledger(r).filter((x) => x.kind === "down").length, 1, "down booked once");
  const job = jobEntry(r);
  assert.deepEqual([job.name, job.status, job.exit, job.piecesTotal, job.piecesDone, job.piecesFailed, job.machines], ["slice-batch", "ok", 0, 5, 5, 0, 2]);
  assert.match(job.tag, /^govern-lane-.*-[0-9a-f]{6}$/);
  assert.equal(job.machineSeconds, undefined, "machine time is booked by down, not again on the job line");
  assert.equal(job.cost, undefined);
  const dir = join(jobsDir(r), present(readdirSync(jobsDir(r))[0], "job dir"));
  assert.deepEqual(readFileSync(join(dir, "out", "joined"), "utf8").trim().split("\n"), ["p1", "p2", "p3", "p4", "p5"]);
  assert.equal(g(r, ["jobs", "lane"]).out.includes("slice-batch ok") || /slice-batch/.test(g(r, ["jobs", "lane"]).out), true);
});

test("a piece that fails is tried again on a machine other than the one that failed it, and the slice still succeeds", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "failfirst", SPLIT_OUT: "p2" });
  assert.equal(a.code, 0, a.out + a.err);
  const tries = calls(r).filter((c) => c.startsWith("piece p2")).map((c) => c.split(" ")[2]);
  assert.equal(tries.length, 2, "p2 ran twice");
  assert.notEqual(tries[0], tries[1], `the retry ran on ${tries[1]}, the machine that failed it`);
  const job = jobEntry(r);
  assert.deepEqual([job.piecesDone, job.piecesFailed], [1, 0]);
  assert.deepEqual(cloudLines(r), []);
});

test("a piece that uses up its attempts fails the job, skips join and verify, and the machines are still brought down", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "failall" });
  assert.equal(a.code, 1, a.out);
  assert.equal(calls(r).filter((c) => c.startsWith("piece p2")).length, 2, "default 2 attempts");
  assert.ok(!kinds(r).includes("join") && !kinds(r).includes("verify"));
  const job = jobEntry(r);
  assert.deepEqual([job.status, job.piecesDone, job.piecesFailed], ["failed", 4, 1]);
  assert.deepEqual(cloudLines(r), [], "machines downed");
  assert.equal(kinds(r).filter((x) => x === "stop").length, 2);
  assert.match(g(r, ["log", "lane"]).out, /p2/);
  const one = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "failall" });
  assert.equal(one.code, 1);
});

test("a recipe's attempts key sets how many tries a piece gets", () => {
  const r = rig({ recipe: { attempts: 3 } });
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "failall" });
  assert.equal(a.code, 1);
  assert.equal(calls(r).filter((c) => c.startsWith("piece p2")).length, 3);
});

test("a verify that fails fails the job, and the machines are brought down", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { VERIFY_MODE: "fail" });
  assert.equal(a.code, 1, a.out);
  assert.deepEqual(kinds(r).filter((x) => x === "join" || x === "verify"), ["join", "verify"]);
  assert.equal(jobEntry(r).status, "failed");
  assert.match(g(r, ["log", "lane"]).out, /totals do not match|verify/);
  assert.deepEqual(cloudLines(r), []);
});

test("a start that gives fewer machines than asked runs nothing, and its tag is still covered by down", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "shorty"]);
  assert.equal(a.code, 1, a.out);
  assert.match(g(r, ["log", "lane"]).out, /asked for 2, the command printed 1/);
  assert.deepEqual(kinds(r).filter((x) => ["split", "piece", "join", "verify"].includes(x)), [], "no recipe step ran");
  const up = present(ledger(r).find((x) => x.kind === "up"), "up entry");
  assert.equal(up.status, "failed");
  const rec = JSON.parse(readFileSync(join(r.state, "instances", `${up.tag}.json`), "utf8"));
  assert.equal(rec.tag, up.tag);
  assert.ok(calls(r).includes(`stop i-only tag=${up.tag} count= id=i-only`), "the machine it did start is stopped");
  assert.equal(rec.status, "ended");
  assert.equal(jobEntry(r).tag, up.tag);
});

test("a slice the allowance cannot cover starts nothing: machines x estimate is what is reserved", () => {
  const r = rig({ allowances: [{ name: "hours", consumer: "lane:lane", unit: "machine-hours", limit: 1 }] });
  const a = g(r, ["slice", "lane", "batch", "--estimate", "1"]);
  assert.equal(a.code, 1);
  assert.match(a.err, /refused/);
  assert.deepEqual(calls(r), [], "nothing started, not even prepare");
  assert.equal(existsSync(jobsDir(r)) ? readdirSync(jobsDir(r)).length : 0, 0);
  const none = g(r, ["slice", "lane", "batch"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /--estimate|timeout/);
  const ok = g(r, ["slice", "lane", "batch", "--estimate", "0.4"]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  const row = present(spent(r)[0], "settled reservation");
  assert.ok(Math.abs(row.reserved - 0.8) < 1e-9, `reserved ${row.reserved}`);
  assert.ok(row.actual < 0.01, "settled with what down booked");
});

test("--machines above the resource's maxMachines is refused before anything starts; so is a dedicated resource of another lane", () => {
  const r = rig({ farm: { allowance: { text: "two at most", maxMachines: 2 } } });
  const a = g(r, ["slice", "lane", "batch", "--machines", "3"]);
  assert.equal(a.code, 1);
  assert.match(a.err, /maxMachines|at most 2 machines/);
  assert.deepEqual(calls(r), []);
  assert.equal(g(r, ["slice", "lane", "batch", "--machines", "0"]).code, 2);
  assert.equal(g(r, ["slice", "lane", "batch", "--machines", "2"], { PIECE_MODE: "x" }).code, 0);
  write(join(r.e.root, "PALS-Notes", "processes", "batch2.json"), JSON.stringify({ version: 1, name: "batch2", stages: [{ name: "work" }],
    recipes: { r: { ...recipe({ resource: "theirs" }), split: ["true"], piece: ["true"], join: ["true"], verify: ["true"] } } }));
  assert.equal(g(r, ["new", "lane2", "--process", "batch2", "--title", "L2"]).code, 0);
  const b = g(r, ["slice", "lane2", "r"]);
  assert.equal(b.code, 2);
  assert.match(b.err, /dedicated to other/);
  assert.match(g(r, ["slice", "lane", "nope"]).err, /no recipe "nope" in process batch \(have: batch, shorty\)/);
});

test("a recipe is typed: unknown keys, bad counts, strings for argv, and placeholders in the wrong step are refused with their path", () => {
  const base = recipe();
  const parse = (rc: unknown) => parseProcess("p.json", JSON.stringify({ version: 1, name: "x", stages: [{ name: "a" }], recipes: { r: rc } }));
  assert.equal(parse(base).recipes?.["r"]?.attempts, undefined);
  const bad = (rc: unknown, re: RegExp) => assert.throws(() => parse(rc), (e: Error) => re.test(e.message) && e.message.startsWith("p.json: "), String(re));
  bad({ ...base, extra: 1 }, /\$\.recipes\.r\.extra: unknown key "extra"/);
  bad({ ...base, machines: 0 }, /\$\.recipes\.r\.machines: must be a whole number, 1 or more/);
  bad({ ...base, attempts: 1.5 }, /\$\.recipes\.r\.attempts/);
  bad({ ...base, split: "sh -c 'ls'" }, /\$\.recipes\.r\.split: must be a non-empty array/);
  bad({ ...base, piece: [] }, /\$\.recipes\.r\.piece: must be a non-empty array/);
  bad({ ...base, verify: undefined }, /\$\.recipes\.r\.verify: missing/);
  bad({ ...base, split: ["ls", "{piece}"] }, /\$\.recipes\.r\.split\[1\]: \{piece\} is not available in the split step/);
  bad({ ...base, join: ["ls", "{id}"] }, /\$\.recipes\.r\.join\[1\]: \{id\} is not available in the join step/);
  bad({ ...base, prepare: ["ls", "{tag}"] }, /\$\.recipes\.r\.prepare\[1\]: \{tag\} is not available in the prepare step/);
  bad({ ...base, resource: "" }, /\$\.recipes\.r\.resource/);
  assert.throws(() => parseProcess("p.json", JSON.stringify({ version: 1, name: "x", stages: [{ name: "a" }], recipes: { "a/b": base } })), /\$\.recipes\["a\/b"\]/);
});

test("piece names must be safe: no path parts, no duplicates, at least one; a refused list runs no piece and still brings the machines down", () => {
  for (const out of ["../x p2", "a/b", "p1 p1", "a..b", ".hidden", " "]) {
    const r = rig();
    const a = g(r, ["slice", "lane", "batch"], { SPLIT_OUT: out });
    assert.equal(a.code, 1, `${JSON.stringify(out)}: ${a.out}`);
    assert.ok(!kinds(r).includes("piece"), `${JSON.stringify(out)}: no piece ran`);
    assert.deepEqual(cloudLines(r), [], `${JSON.stringify(out)}: machines downed`);
    assert.match(g(r, ["log", "lane"]).out, /piece name|no pieces|twice/, out);
  }
});

test("stopping a running slice brings its machines down, and the desk shows its pieces and machines while it runs", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch", "--bg"], { PIECE_MODE: "hold" });
  assert.equal(a.code, 0, a.out + a.err);
  until(() => calls(r).filter((c) => c.startsWith("piece")).length === 2);
  const desk = g(r, ["desk"]).out;
  assert.match(desk, /slice lane\/\S+ batch: 0\/5 pieces done, 2 machines up/);
  assert.equal(cloudLines(r).length, 2);
  assert.equal(g(r, ["kill", "lane"]).code, 0);
  until(() => cloudLines(r).length === 0);
  assert.equal(kinds(r).filter((x) => x === "stop").length, 2);
  assert.ok(!kinds(r).includes("join"));
  assert.doesNotMatch(g(r, ["desk"]).out, /slice lane\//);
  writeFileSync(r.env["GATE"]!, "");
});

// ---- the second review: unclean ends, time bounds, retries, aborts, names, placeholders, process groups

const HOURS = { name: "hours", consumer: "lane:lane", unit: "machine-hours", limit: 10 };
const CASH = { name: "cash", consumer: "lane:lane", unit: "money", currency: "USD", limit: 100 };
const jobDirOf = (r: Rig, n = 0) => join(jobsDir(r), present(readdirSync(jobsDir(r)).sort()[n], "job dir"));
const alive = (pid: number) => {
  try { return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};
const near = (n: number, want: number) => Math.abs(n - want) < 1e-6;

test("a clean slice settles its allowance with the machine time and money that down booked, not the reservation", () => {
  const r = rig({ allowances: [HOURS, CASH] });
  const a = g(r, ["slice", "lane", "batch", "--estimate", "0.4"]);
  assert.equal(a.code, 0, a.out + a.err);
  const h = spent(r), c = spent(r, "cash");
  assert.equal(h.length, 1);
  assert.equal(c.length, 1);
  assert.ok(near(h[0]!.reserved, 0.8) && h[0]!.actual < 0.05, `hours ${JSON.stringify(h[0])}`);
  assert.ok(near(c[0]!.reserved, 1.6) && c[0]!.actual < 0.05, `money ${JSON.stringify(c[0])}`);
});

test("a down that fails settles the allowance as at least reserved, and a later down books no second charge", () => {
  const r = rig({ allowances: [HOURS, CASH] });
  const a = g(r, ["slice", "lane", "batch", "--estimate", "0.4"], { STOP_FAIL: "1" });
  assert.equal(a.code, 1, a.out + a.err);
  assert.equal(cloudLines(r).length, 2, "the machines are still up");
  assert.equal(spent(r).length, 1);
  assert.ok(spent(r)[0]!.actual >= 0.8 - 1e-9, `hours charged ${spent(r)[0]!.actual}`);
  assert.ok(spent(r, "cash")[0]!.actual >= 1.6 - 1e-9, `money charged ${spent(r, "cash")[0]!.actual}`);
  const d = g(r, ["down", jobEntry(r).tag]);
  assert.equal(d.code, 0, d.out + d.err);
  assert.deepEqual(cloudLines(r), []);
  assert.equal(spent(r).length, 1, "the late down did not settle again");
  assert.equal(spent(r, "cash").length, 1);
});

test("a runner that is SIGKILLed settles as reserved, and a later down changes nothing", () => {
  const r = rig({ allowances: [HOURS] });
  const a = g(r, ["slice", "lane", "batch", "--bg", "--estimate", "0.4"], { PIECE_MODE: "hold" });
  assert.equal(a.code, 0, a.out + a.err);
  until(() => calls(r).filter((c) => c.startsWith("piece")).length === 2);
  const dir = jobDirOf(r);
  until(() => existsSync(join(dir, "runner.pid")));
  process.kill(Number(readFileSync(join(dir, "runner.pid"), "utf8").trim()), "SIGKILL");
  g(r, ["wait", "lane", "--timeout", "20"]);
  const tag = jobEntry(r).tag;
  assert.ok(spent(r)[0] && spent(r)[0]!.actual >= 0.8 - 1e-9, JSON.stringify(spent(r)));
  g(r, ["kill", "lane"]);
  const d = g(r, ["down", tag]);
  assert.equal(d.code, 0, d.out + d.err);
  assert.equal(spent(r).length, 1);
  writeFileSync(r.env["GATE"]!, "");
});

test("a foreground slice that outruns its timeout stops its pieces, skips join, and still brings the machines down", () => {
  const r = rig({ recipe: { timeout: 2 } });
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "hold" });
  assert.notEqual(a.code, 0, a.out + a.err);
  const k = kinds(r);
  assert.ok(!k.includes("join") && !k.includes("verify"), k.join(" "));
  assert.equal(k.filter((x) => x === "stop").length, 2, "down ran: " + k.join(" "));
  assert.deepEqual(cloudLines(r), []);
  assert.equal(ledger(r).filter((x) => x.kind === "down").length, 1);
});

test("a background slice with a timeout and no allowance is bound by it too, and brings the machines down", () => {
  const r = rig({ recipe: { timeout: 2 } });
  assert.equal(g(r, ["slice", "lane", "batch", "--bg"], { PIECE_MODE: "hold" }).code, 0);
  until(() => existsSync(join(jobDirOf(r), "exit")), 25000);
  const k = kinds(r);
  assert.ok(!k.includes("join") && !k.includes("verify"), k.join(" "));
  assert.equal(k.filter((x) => x === "stop").length, 2, k.join(" "));
  assert.deepEqual(cloudLines(r), []);
  g(r, ["wait", "lane", "--timeout", "5"]);
  assert.equal(ledger(r).filter((x) => x.kind === "down").length, 1);
});

test("a slice stopped by its reserved estimate (the cap watcher) is not cut off mid-down: both machines are stopped", () => {
  const r = rig({ recipe: { timeout: 600 }, allowances: [HOURS] });
  assert.equal(g(r, ["slice", "lane", "batch", "--bg", "--estimate", "0.0006"], { PIECE_MODE: "hold" }).code, 0);
  until(() => existsSync(join(jobDirOf(r), "exit")), 25000);
  assert.equal(kinds(r).filter((x) => x === "stop").length, 2, kinds(r).join(" "));
  assert.deepEqual(cloudLines(r), []);
  assert.ok(!kinds(r).includes("join"));
  g(r, ["wait", "lane", "--timeout", "5"]);
  assert.equal(ledger(r).filter((x) => x.kind === "down").length, 1);
  assert.equal(spent(r).length, 1);
});

test("a worker that throws aborts the slice: the other pieces are killed, and the machines come down", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "sabotage" });
  assert.equal(a.code, 1, a.out + a.err);
  assert.deepEqual(cloudLines(r), []);
  assert.equal(kinds(r).filter((x) => x === "stop").length, 2);
  assert.ok(!kinds(r).includes("join"));
  const pid = Number(readFileSync(join(r.env["MARK"]!, "pid-p2"), "utf8").trim());
  until(() => !alive(pid), 5000);
  assert.match(g(r, ["log", "lane"]).out, /slice batch failed/);
});

test("a machine id with path parts never makes a folder outside the slice's pieces", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { ID_PREFIX: "x/../../../../escaped-" });
  assert.equal(a.code, 0, a.out + a.err);
  assert.deepEqual(readdirSync(jobsDir(r)).length, 1, `jobs folder holds ${readdirSync(jobsDir(r)).join(", ")}`);
  assert.deepEqual(readdirSync(join(jobDirOf(r), "pieces", "doing")).filter((n) => !/^m\d+$/.test(n)), []);
  assert.equal(calls(r).filter((c) => c.startsWith("piece")).length, 5);
});

test("a recipe step can name the pieces and out folders in its environment, and a root with a space in it works", () => {
  const r = rig({ name: "sp ace", recipe: { join: ["sh", "-c", "ls \"$GOVERN_PIECES/done\" | sort > \"$GOVERN_OUT/joined\""] } });
  const a = g(r, ["slice", "lane", "batch"]);
  assert.equal(a.code, 0, a.out + a.err);
  assert.deepEqual(readFileSync(join(jobDirOf(r), "out", "joined"), "utf8").trim().split("\n"), ["p1", "p2", "p3", "p4", "p5"]);
  assert.deepEqual(cloudLines(r), []);
});

test("a piece that outruns pieceTimeout is killed with everything it started", () => {
  const r = rig({ recipe: { pieceTimeout: 1, attempts: 1 } });
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "fork", SPLIT_OUT: "p1" });
  assert.equal(a.code, 1, a.out + a.err);
  const pid = Number(readFileSync(join(r.env["MARK"]!, "sleeper"), "utf8").trim());
  until(() => !alive(pid), 5000);
  assert.deepEqual(cloudLines(r), []);
});

test("a join that fails fails the job, verify does not run, and the machines are brought down", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { JOIN_MODE: "fail" });
  assert.equal(a.code, 1, a.out);
  assert.ok(kinds(r).includes("join") && !kinds(r).includes("verify"));
  assert.match(g(r, ["log", "lane"]).out, /join failed/);
  assert.deepEqual(cloudLines(r), []);
  assert.equal(jobEntry(r).status, "failed");
});

test("an up that fails after start has run still leaves the tag known, so down brings the machines down", () => {
  const r = rig();
  const led = join(r.e.projects, "lane", "govern", "ledger.jsonl");
  const a = g(r, ["slice", "lane", "batch"], {
    LEDGER: led, START_HOOK: 'rm -f "$LEDGER"; mkdir "$LEDGER"',
    STOP_HOOK: 'if [ -d "$LEDGER" ]; then rmdir "$LEDGER"; : > "$LEDGER"; fi',
  });
  assert.equal(a.code, 1, a.out + a.err);
  assert.deepEqual(cloudLines(r), [], "the machines it started were stopped");
  assert.equal(kinds(r).filter((x) => x === "stop").length, 2);
  assert.ok(!kinds(r).includes("split"));
});

test("govern up refuses a count above the resource's maxMachines, as slice does", () => {
  const r = rig({ farm: { allowance: { text: "two at most", maxMachines: 2 } } });
  const a = g(r, ["up", "farm", "--lane", "lane", "--count", "3"]);
  assert.equal(a.code, 1, a.out + a.err);
  assert.match(a.err, /at most 2 machines/);
  assert.deepEqual(calls(r), []);
});

test("two slices that want the same resource take turns: the second starts its machines only after the first has stopped its own", () => {
  const r = rig();
  assert.equal(g(r, ["slice", "lane", "batch", "--bg"], { PIECE_MODE: "hold" }).code, 0);
  until(() => calls(r).filter((c) => c.startsWith("piece")).length === 2);
  assert.equal(g(r, ["slice", "lane", "batch", "--bg"], { PIECE_MODE: "hold" }).code, 0);
  sleepSync(1500);
  assert.equal(kinds(r).filter((x) => x === "start").length, 1, "the second waits for its turn");
  writeFileSync(r.env["GATE"]!, "");
  until(() => readdirSync(jobsDir(r)).length === 2 && readdirSync(jobsDir(r)).every((d) => existsSync(join(jobsDir(r), d, "exit"))), 30000);
  assert.deepEqual(kinds(r).filter((x) => x === "start" || x === "stop"), ["start", "stop", "stop", "start", "stop", "stop"]);
  assert.deepEqual(cloudLines(r), []);
});

test("a recipe step that names an unknown placeholder, or puts one inside an sh -c script, is refused when the process loads", () => {
  const base = recipe();
  const parse = (rc: unknown) => parseProcess("p.json", JSON.stringify({ version: 1, name: "x", stages: [{ name: "a" }], recipes: { r: rc } }));
  const bad = (rc: unknown, re: RegExp) => assert.throws(() => parse(rc), (e: Error) => re.test(e.message), String(re));
  bad({ ...base, piece: ["ls", "{nope}"] }, /\$\.recipes\.r\.piece\[1\]: unknown placeholder \{nope\}/);
  bad({ ...base, join: ["sh", "-c", "cat {pieces}/x > {out}"] }, /\$\.recipes\.r\.join\[2\].*\$GOVERN_PIECES/);
  assert.doesNotThrow(() => parse({ ...base, join: ["ls", "{pieces}", "{out}", "{repo}", "{dir}", "{python}", "{paths.filmBuild}"] }));
});


test("sliceRunner: usage, governed refusal and filesystem failures exit with the right codes", () => {
  const r = rig();
  const run = (args: string[]) => spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", new URL("../lib/sliceRunner.ts", import.meta.url).pathname, ...args],
    { env: childEnv(r.e), encoding: "utf8", timeout: 10000 });
  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: sliceRunner/);
  const refused = run(["lane", "missing", "1"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /no recipe/);
  // load reads this path as a file: a directory produces an ordinary filesystem error.
  write(join(r.e.projects, "broken", "govern.json", "child"), "");
  const broken = run(["broken", "batch", "1", "60"]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /EISDIR/);
});

test("sliceRunner: a standalone runner completes and cleans up its machines", () => {
  const r = rig({ recipe: { machines: 1 } });
  const jobDir = join(r.e.root, "standalone-job");
  write(join(jobDir, ".keep"), "");
  const result = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", new URL("../lib/sliceRunner.ts", import.meta.url).pathname, "lane", "batch", "1"],
    { env: childEnv(r.e, { ...r.env, GOVERN_JOB_DIR: jobDir }), encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(cloudLines(r), []);
  assert.equal(JSON.parse(readFileSync(join(jobDir, "slice.json"), "utf8")).phase, "ended");
  assert.deepEqual(readFileSync(join(jobDir, "out", "joined"), "utf8").trim().split("\n"), ["p1", "p2", "p3", "p4", "p5"]);
});
