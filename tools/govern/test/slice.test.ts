import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, present, setConfig, type Env } from "./helpers.ts";
import { sleepSync } from "../lib/util.ts";
import { parseProcess } from "../lib/process.ts";

// Fake provider (instances are lines "id tag" in $CLOUD; every call is logged to $CALLS) and fake recipe steps (plain sh).
const PROV = `#!/bin/sh
echo "$1 $2 tag=$GOVERN_TAG count=$GOVERN_COUNT id=$GOVERN_ID" >> "$CALLS"
case "$1" in
  start) n=\${3:-1}; i=0
    while [ "$i" -lt "$n" ]; do
      s=$(cat "$CLOUD.seq" 2>/dev/null || echo 0); s=$((s + 1)); echo "$s" > "$CLOUD.seq"
      echo "i-$s $2" >> "$CLOUD"; echo "i-$s"; i=$((i + 1))
    done ;;
  stop) grep -v "^$2 " "$CLOUD" > "$CLOUD.new"; mv "$CLOUD.new" "$CLOUD" ;;
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
esac
echo "$2" > "$3/$1"
`;
const JOIN = `#!/bin/sh
echo "join" >> "$CALLS"
ls "$1/done" | sort > "$2/joined"
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
  split: ["sh", "SPLIT", "{tag}"], piece: ["sh", "PIECE", "{piece}", "{id}", "{out}"], join: ["sh", "JOIN", "{pieces}", "{out}"], verify: ["sh", "VERIFY"], ...r,
});
function rig(opts: { recipe?: Partial<Record<string, unknown>>; allowances?: unknown[]; farm?: Record<string, unknown> } = {}): Rig {
  const e = makeEnv();
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
const spent = (r: Rig) => { const f = join(r.state, "allowances", "hours", "spent.jsonl"); return existsSync(f) ? jsonl(f) : []; };

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

test("a piece that fails is tried again, on any machine, and the slice still succeeds", () => {
  const r = rig();
  const a = g(r, ["slice", "lane", "batch"], { PIECE_MODE: "failfirst" });
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(calls(r).filter((c) => c.startsWith("piece p2")).length, 2, "p2 ran twice");
  const job = jobEntry(r);
  assert.deepEqual([job.piecesDone, job.piecesFailed], [5, 0]);
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
