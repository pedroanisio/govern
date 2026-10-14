import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, childEnv, jsonl, write, present, GOVERN, type Env } from "./helpers.ts";
import { sleepSync } from "../lib/util.ts";

// A fake provider CLI: "instances" are lines "id tag" in $CLOUD, every call is logged to $CALLS, $PROV_MODE picks a failure.
const PROV = `#!/bin/sh
echo "$1 $2 tag=$GOVERN_TAG lane=$GOVERN_LANE res=$GOVERN_RESOURCE count=$GOVERN_COUNT id=$GOVERN_ID" >> "$CALLS"
case "$PROV_MODE:$1" in
  hang:*) exec sleep 30 ;;
  fail:start) echo "i-partial"; echo "i-partial $2" >> "$CLOUD"; echo "quota exceeded" >&2; exit 3 ;;
  failstop:stop) echo "boom" >&2; exit 3 ;;
  fail:*) echo "boom" >&2; exit 3 ;;
  silent:*) exit 0 ;;
  garbage:*) echo "<html>503</html>"; exit 0 ;;
esac
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

// Merges keys into the workspace config makeEnv wrote, so queue, projects and the rest survive.
function setConfig(e: Env, keys: Record<string, unknown>): void {
  const f = join(e.root, "govern.config.json");
  write(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...keys }));
}

interface Rig { e: Env; cloud: string; calls: string; env: Record<string, string>; inst: () => Record<string, any>[] }
function rig(price: Record<string, unknown> = { basis: "per-hour", currency: "USD", amount: 2 }): Rig {
  const e = makeEnv();
  const prov = write(join(e.root, "prov.sh"), PROV);
  chmodSync(prov, 0o755);
  const cloud = write(join(e.root, "cloud"), ""), calls = join(e.root, "calls.log");
  setConfig(e, { resources: [
    { name: "farm", kind: "vm", sharing: "shared", price, commands: { start: ["sh", prov, "start", "{tag}", "{count}"], stop: ["sh", prov, "stop", "{id}"], list: ["sh", prov, "list"] } },
    { name: "plain", kind: "vm", sharing: "shared" },
  ] });
  assert.equal(govern(e, ["new", "lane", "--process", "dev", "--title", "L"]).code, 0);
  const state = join(e.root, "PALS-Notes", "govern-state", "instances");
  const inst = () => (existsSync(state) ? readdirSync(state).sort().map((f) => JSON.parse(readFileSync(join(state, f), "utf8"))) : []);
  return { e, cloud, calls, env: { CLOUD: cloud, CALLS: calls }, inst };
}
const g = (r: Rig, args: string[], env: Record<string, string> = {}) => govern(r.e, args, { ...r.env, ...env });
const cloudLines = (r: Rig) => readFileSync(r.cloud, "utf8").split("\n").filter(Boolean);
const calls = (r: Rig) => (existsSync(r.calls) ? readFileSync(r.calls, "utf8").split("\n").filter(Boolean) : []);
const ledger = (r: Rig) => jsonl(join(r.e.projects, "lane", "govern", "ledger.jsonl"));
const tagOf = (out: string) => present(/tag (\S+)/.exec(out)?.[1], "a tag in the output");
const backdate = (r: Rig, seconds: number) => {
  const state = join(r.e.root, "PALS-Notes", "govern-state", "instances");
  for (const f of readdirSync(state)) { const p = join(state, f), j = JSON.parse(readFileSync(p, "utf8")); j.startedAt = new Date(Date.parse(j.startedAt) - seconds * 1000).toISOString(); writeFileSync(p, JSON.stringify(j)); }
};
const HOLD = (gate: string) => ["sh", "-c", `while [ ! -f ${gate} ]; do sleep 0.1; done`];
const until = (f: () => boolean, ms = 15000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) sleepSync(30); assert.ok(f(), "condition never held"); };

test("up runs the start command with a unique tag (env and placeholder), records ids in state and ledger", () => {
  const r = rig();
  const a = g(r, ["up", "farm", "--lane", "lane", "--count", "2"]);
  assert.equal(a.code, 0, a.err);
  const tag = tagOf(a.out);
  assert.match(tag, /^govern-lane-nojob-[0-9a-f]{6}$/);
  assert.deepEqual(a.out.split("\n").filter((l) => /^i-\d+$/.test(l.trim())).map((l) => l.trim()), ["i-1", "i-2"]);
  assert.deepEqual(calls(r), [`start ${tag} tag=${tag} lane=lane res=farm count=2 id=`]);
  assert.deepEqual(cloudLines(r), [`i-1 ${tag}`, `i-2 ${tag}`], "the placeholder reached the provider");
  const rec = present(r.inst()[0], "state file");
  assert.deepEqual([rec.tag, rec.resource, rec.ids, rec.lane, rec.status], [tag, "farm", ["i-1", "i-2"], "lane", "running"]);
  assert.match(rec.startedAt, /^\d{4}-/);
  assert.deepEqual(rec.price, { basis: "per-hour", currency: "USD", amount: 2 });
  const up = present(ledger(r).find((x) => x.kind === "up"), "up entry");
  assert.deepEqual([up.tag, up.resource, up.ids], [tag, "farm", ["i-1", "i-2"]]);
  const b = tagOf(g(r, ["up", "farm", "--lane", "lane"]).out);
  assert.notEqual(b, tag, "tags are unique");
});

test("up refuses what cannot start: no start command, unknown resource, a dedicated one for another lane, bad count", () => {
  const r = rig();
  assert.match(g(r, ["up", "plain"]).err, /plain has no start command/);
  assert.match(g(r, ["up", "nope"]).err, /no resource "nope"/);
  assert.match(g(r, ["up", "farm", "--count", "0"]).err, /--count must be a whole number, 1 or more/);
  assert.match(g(r, ["up", "farm", "--lane", "ghost"]).err, /ghost/);
  assert.equal(calls(r).length, 0, "nothing ran");
});

test("up takes the lane and the job from the job it runs in", () => {
  const r = rig();
  const gate = join(r.e.root, "gate");
  g(r, ["cmd", "lane", "hold", "--", ...HOLD(gate)]);
  const id = present(/job (\S+)/.exec(g(r, ["run", "lane", "hold", "--bg"]).out)?.[1], "job id");
  const dir = join(r.e.projects, "lane", "govern", "jobs", id);
  const a = g(r, ["up", "farm"], { GOVERN_JOB_DIR: dir });
  writeFileSync(gate, "");
  assert.equal(a.code, 0, a.err);
  const rec = present(r.inst()[0], "state");
  assert.deepEqual([rec.lane, rec.job], ["lane", id]);
  assert.match(rec.tag, /^govern-lane-\d{8}t\d{6}z-hold-[0-9a-f]{6}$/);
  assert.match(calls(r)[0] ?? "", /lane=lane/);
});

test("a start that fails, prints nothing, prints garbage or hangs is reported, and its tag is still recorded for reap", () => {
  for (const [mode, re] of [["fail", /exit 3.*quota exceeded/], ["silent", /printed no instance ids/], ["garbage", /not an instance id/], ["hang", /timed out after 1s/]] as const) {
    const r = rig();
    const a = g(r, ["up", "farm", "--lane", "lane", "--timeout", "1"], { PROV_MODE: mode });
    assert.equal(a.code, 1, `${mode}: ${a.out}${a.err}`);
    assert.match(a.err, re, mode);
    const rec = present(r.inst()[0], `${mode}: state`);
    assert.equal(rec.status, "start-failed", mode);
    assert.equal(present(ledger(r).find((x) => x.kind === "up"), "ledger").status, "failed", mode);
    if (mode === "fail") assert.deepEqual(rec.ids, ["i-partial"], "ids printed before the failure are kept");
  }
});

test("up with --count reports a different number of ids, and still records the ones printed", () => {
  const r = rig();
  g(r, ["cmd", "lane", "x", "--", "true"]);
  const a = g(r, ["up", "farm", "--lane", "lane", "--count", "2"], { });
  assert.equal(a.code, 0);
  write(join(r.e.root, "prov2.sh"), `#!/bin/sh\necho i-only\n`);
  setConfig(r.e, { resources: [{ name: "one", kind: "vm", sharing: "shared", commands: { start: ["sh", join(r.e.root, "prov2.sh")] } }] });
  const b = g(r, ["up", "one", "--count", "3"]);
  assert.equal(b.code, 1);
  assert.match(b.err, /asked for 3, the command printed 1/);
  assert.deepEqual(r.inst().find((x) => x.resource === "one")?.ids, ["i-only"]);
});

test("down by tag or by id runs stop per instance and books machine time and money from up to down", () => {
  const r = rig();
  const tag = tagOf(g(r, ["up", "farm", "--lane", "lane", "--count", "2"]).out);
  backdate(r, 3600);
  const d = g(r, ["down", "i-1"]);
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(cloudLines(r), [`i-2 ${tag}`]);
  assert.deepEqual(r.inst()[0]?.status, "running", "one instance still up");
  const d2 = g(r, ["down", tag]);
  assert.equal(d2.code, 0, d2.err);
  assert.deepEqual(cloudLines(r), []);
  assert.equal(r.inst()[0]?.status, "ended");
  assert.ok(calls(r).includes(`stop i-1 tag=${tag} lane=lane res=farm count= id=i-1`), calls(r).join("\n"));
  const downs = ledger(r).filter((x) => x.kind === "down");
  assert.equal(downs.length, 2);
  const total = downs.reduce((s, x) => s + x.machineSeconds, 0);
  assert.ok(total >= 7200 && total < 7260, `machine seconds ${total}`);
  assert.equal(downs[0]?.basis, "per-hour");
  assert.equal(downs[0]?.currency, "USD");
  assert.ok(Math.abs(downs.reduce((s, x) => s + x.cost, 0) - 4) < 0.05, "2 machines x 1 h x 2 USD");
  assert.match(g(r, ["usage", "lane"]).out, /machine time: farm 7\d{3}s/);
  assert.match(g(r, ["usage", "lane"]).out, /machine money: 4\.0\d USD \(farm\)/);
  assert.match(g(r, ["down", tag]).out, /nothing running/);
});

test("down: a stop that fails or times out is reported and the instance stays running; --forget books the time without stopping", () => {
  const r = rig();
  const tag = tagOf(g(r, ["up", "farm", "--lane", "lane"]).out);
  const bad = g(r, ["down", tag], { PROV_MODE: "fail" });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /i-1.*exit 3.*boom/);
  assert.equal(r.inst()[0]?.status, "running");
  assert.equal(ledger(r).filter((x) => x.kind === "down").length, 0, "no money booked for a stop that did not happen");
  const slow = g(r, ["down", tag, "--timeout", "1"], { PROV_MODE: "hang" });
  assert.equal(slow.code, 1);
  assert.match(slow.err, /timed out after 1s/);
  const before = calls(r).length;
  const f = g(r, ["down", tag, "--forget"]);
  assert.equal(f.code, 0, f.err);
  assert.equal(calls(r).length, before, "forget runs no command");
  assert.equal(r.inst()[0]?.status, "ended");
  assert.equal(present(ledger(r).find((x) => x.kind === "down"), "entry").by, "forget");
  assert.match(g(r, ["down", "i-nope"]).err, /no recorded instance "i-nope"/);
});

test("reap lists only: a tagged instance with no live job is shown, nothing is stopped, and a foreign tag or a lookalike name is never touched", () => {
  const r = rig();
  const tag = tagOf(g(r, ["up", "farm", "--lane", "lane"]).out);
  writeFileSync(r.cloud, readFileSync(r.cloud, "utf8") + "i-foreign someone-elses\ni-look govern-lane-nojob-ffffff\ni-nomatch\n");
  const a = g(r, ["reap"]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, new RegExp(`farm: 1 instance running with no job`));
  assert.match(a.out, new RegExp(`i-1 ${tag}`));
  assert.match(a.out, /not stopped: pass --yes/);
  assert.doesNotMatch(a.out, /i-foreign|i-look/);
  assert.match(a.out, /3 listed instances carry no tag govern issued: not touched/);
  assert.equal(cloudLines(r).length, 4);
  assert.deepEqual(calls(r).map((c) => c.split(" ")[0]), ["start", "list"], "no stop call");
  const y = g(r, ["reap", "farm", "--yes"]);
  assert.equal(y.code, 0, y.err);
  assert.deepEqual(cloudLines(r), ["i-foreign someone-elses", "i-look govern-lane-nojob-ffffff", "i-nomatch"], "only the recorded tag was stopped");
});

test("reap --yes stops the orphans, records the reap with machine time and money, and a second reap finds nothing", () => {
  const r = rig();
  const tag = tagOf(g(r, ["up", "farm", "--lane", "lane", "--count", "2"]).out);
  backdate(r, 1800);
  const y = g(r, ["reap", "--yes"]);
  assert.equal(y.code, 0, y.err);
  assert.match(y.out, /stopped i-1/);
  assert.deepEqual(cloudLines(r), []);
  const e = present(ledger(r).find((x) => x.kind === "reap"), "reap entry");
  assert.deepEqual([e.tag, e.resource, e.ids], [tag, "farm", ["i-1", "i-2"]]);
  assert.ok(e.machineSeconds >= 3600 && e.machineSeconds < 3660, String(e.machineSeconds));
  assert.ok(Math.abs(e.cost - 2) < 0.05 && e.currency === "USD" && e.basis === "per-hour");
  assert.equal(r.inst()[0]?.status, "ended");
  assert.match(g(r, ["reap"]).out, /nothing to reap/);
});

test("reap leaves alone an instance whose job still runs or whose lane has a job running on the resource", () => {
  const r = rig();
  const gate = join(r.e.root, "gate");
  g(r, ["cmd", "lane", "hold", "--", ...HOLD(gate)]);
  g(r, ["cmd", "lane", "onfarm", "--resource", "farm", "--", ...HOLD(gate)]);
  const jid = present(/job (\S+)/.exec(g(r, ["run", "lane", "hold", "--bg"]).out)?.[1], "job");
  const dir = join(r.e.projects, "lane", "govern", "jobs", jid);
  const t1 = tagOf(g(r, ["up", "farm"], { GOVERN_JOB_DIR: dir }).out);
  const t2 = tagOf(g(r, ["up", "farm", "--lane", "lane"]).out);
  let a = g(r, ["reap"]);
  assert.match(a.out, /farm: 1 instance running with no job \(1 in use\)/, "the job's own instance is in use, the lane-only one is not");
  assert.match(a.out, new RegExp(t2));
  assert.doesNotMatch(a.out, new RegExp(t1));
  writeFileSync(gate, "");
  until(() => !g(r, ["jobs", "lane"]).out.includes(" running"));
  a = g(r, ["reap"]);
  assert.match(a.out, /farm: 2 instances running with no job/);
  assert.match(a.out, new RegExp(t1));
  rmSync(gate, { force: true });
  const on = present(/job (\S+)/.exec(g(r, ["run", "lane", "onfarm", "--bg"]).out)?.[1], "job on farm");
  a = g(r, ["reap"]);
  assert.match(a.out, /farm: nothing to reap \(2 in use\)/, "a lane job holding the resource is a lease");
  writeFileSync(gate, "");
  g(r, ["wait", "lane", on]);
});

test("a listing that fails, times out, prints garbage or prints nothing while govern believes machines run is never 'nothing to reap'", () => {
  for (const [mode, re] of [["fail", /exit 3.*boom/], ["hang", /timed out after 1s/], ["garbage", /line 1 .*not "<id> <tag>"/], ["silent", /printed nothing, but govern started 1 instance/]] as const) {
    const r = rig();
    g(r, ["up", "farm", "--lane", "lane"]);
    const a = g(r, ["reap", "--yes", "--timeout", "1"], { PROV_MODE: mode });
    assert.equal(a.code, 1, `${mode}: ${a.out}`);
    assert.match(a.out + a.err, re, mode);
    assert.doesNotMatch(a.out, /nothing to reap/, mode);
    assert.equal(cloudLines(r).length, 1, `${mode}: nothing stopped`);
  }
  const r = rig();
  assert.match(g(r, ["reap"], { PROV_MODE: "silent" }).out, /nothing to reap/, "empty and nothing believed running is empty");
});

test("reap names its resource: one without a list command is refused, and with none named only those with one are listed", () => {
  const r = rig();
  assert.match(g(r, ["reap", "plain"]).err, /plain has no list command/);
  assert.match(g(r, ["reap"]).out, /farm: nothing to reap/);
  assert.doesNotMatch(g(r, ["reap"]).out, /plain/);
});

test("a stopped instance that the provider still lists is shown for reaping; a failed stop in reap --yes is reported", () => {
  const r = rig();
  const tag = tagOf(g(r, ["up", "farm", "--lane", "lane"]).out);
  g(r, ["down", tag]);
  writeFileSync(r.cloud, `i-1 ${tag}\n`);
  assert.match(g(r, ["reap"]).out, /stopped .* but still listed/);
  const y = g(r, ["reap", "--yes"], { PROV_MODE: "failstop" });
  assert.equal(y.code, 1);
  assert.match(y.err, /could not stop i-1.*boom/);
});

function loop(r: Rig, extra: string[]) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "task", "dispatch", "--loop", "--interval", "1", ...extra], { env: childEnv(r.e, { ...r.env, GOVERN_QUEUE: join(r.e.root, "queue") }) });
  return p;
}

test("the dispatcher lists on a timer only when asked, writes the result, and the desk shows instances with no job; it never stops one", () => {
  const r = rig();
  const tag = tagOf(g(r, ["up", "farm", "--lane", "lane", "--count", "2"]).out);
  const scan = join(r.e.root, "PALS-Notes", "govern-state", "reap-scan.json");
  const off = loop(r, []);
  sleepSync(2500);
  off.kill("SIGTERM");
  assert.equal(existsSync(scan), false, "off by default");
  const p = loop(r, ["--reap-every", "1"]);
  try { until(() => existsSync(scan)); } finally { p.kill("SIGTERM"); }
  const s = JSON.parse(readFileSync(scan, "utf8"));
  assert.equal(s.results[0].resource, "farm");
  assert.equal(s.results[0].orphans.length, 2);
  assert.equal(cloudLines(r).length, 2, "the dispatcher stopped nothing");
  assert.ok(!calls(r).some((c) => c.startsWith("stop")));
  assert.match(g(r, ["desk"], { GOVERN_QUEUE: join(r.e.root, "queue") }).out, /2 instances running with no job/);
  g(r, ["down", tag]);
  g(r, ["reap"]);
  assert.doesNotMatch(g(r, ["desk"], { GOVERN_QUEUE: join(r.e.root, "queue") }).out, /running with no job/, "zero is not shown");
});

test("a failing scheduled listing shows on the desk as a failed listing", () => {
  const r = rig();
  g(r, ["up", "farm", "--lane", "lane"]);
  g(r, ["reap"], { PROV_MODE: "fail" });
  assert.match(g(r, ["desk"], { GOVERN_QUEUE: join(r.e.root, "queue") }).out, /instance listing failed for farm: exit 3/);
});

test("help and the manual describe up, down and reap", () => {
  const r = rig();
  const h = g(r, ["help"]).out;
  for (const w of ["up <resource>", "down <tag|id>", "reap [<resource>]", "--reap-every"]) assert.ok(h.includes(w), w);
  assert.match(g(r, ["manual"]).out, /govern reap/);
});
