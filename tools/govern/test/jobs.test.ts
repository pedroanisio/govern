import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, childEnv, GOVERN } from "./helpers.ts";
import { parseStat, procStat, sleepSync, stamp } from "../lib/util.ts";

const ledger = (e: ReturnType<typeof makeEnv>, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const jobsDir = (e: ReturnType<typeof makeEnv>, slug: string) => join(e.projects, slug, "govern", "jobs");
const jobJson = (e: ReturnType<typeof makeEnv>, slug: string, id = readdirSync(jobsDir(e, slug)).sort().at(-1)!) =>
  JSON.parse(readFileSync(join(jobsDir(e, slug), id, "job.json"), "utf8"));
/** Gone, or a zombie waiting for its reaper. */
const dead = (pid: number) => { const s = procStat(pid); return !s || s.state === "Z" || s.state === "X"; };
/** Poll up to `ms` for every pid to be gone (reaping by init is asynchronous). */
function allGone(pids: number[], ms = 3000): boolean {
  const end = Date.now() + ms;
  while (!pids.every(dead) && Date.now() < end) sleepSync(20);
  return pids.every(dead);
}
function lane() {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "lane", "--process", "dev", "--title", "L"]).code, 0);
  return { e, slug: "lane" };
}
/** A sleeper this test starts and owns, with a hand-written job.json pointing at it. */
function fakeJob(e: ReturnType<typeof makeEnv>, slug: string, id: string, extra: Record<string, unknown>) {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  write(join(jobsDir(e, slug), id, "job.json"), JSON.stringify({ id, slug, name: "x", argv: ["sleep", "30"], cwd: e.root, start: new Date().toISOString(), pid: child.pid, pgid: child.pid, bg: true, ...extra }));
  return child;
}

test("parseStat reads state, process group and start time even when the command name holds spaces and parentheses", () => {
  const tail = "S 1 4242 4242 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 987654 1000 200";
  assert.deepEqual(parseStat(`42 (node) ${tail}`), { state: "S", ppid: 1, pgrp: 4242, start: "987654" });
  assert.deepEqual(parseStat(`42 (my (odd) name) x) ${tail}`), { state: "S", ppid: 1, pgrp: 4242, start: "987654" });
  assert.equal(parseStat("garbage"), undefined);
  assert.equal(parseStat("42 (short) S 1 2"), undefined);
  const self = readFileSync("/proc/self/stat", "utf8");
  assert.equal(procStat(process.pid)?.start, self.slice(self.lastIndexOf(")") + 1).trim().split(/\s+/)[19]);
});

test("every job records its pid and start time, and sees GOVERN_JOB_ID; a foreground job has no group of its own", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "who", "--", "sh", "-c", "echo id=$GOVERN_JOB_ID"]);
  const r = govern(e, ["run", slug, "who"]);
  assert.equal(r.code, 0, r.err);
  const j = jobJson(e, slug);
  assert.match(r.out, new RegExp(`id=${j.id}`));
  assert.ok(Number.isInteger(j.pid));
  assert.equal(j.pgid, undefined, "a foreground job stays in govern's process group");
  assert.match(j.procStart, /^\d+$/);
});

test("a foreground job past its timeout has its whole process tree stopped and fails the check as timed out", () => {
  const { e, slug } = lane();
  const c = govern(e, ["cmd", slug, "hang", "--timeout", "1", "--", "sh", "-c", "echo $$ > kids; sleep 30 & echo $! >> kids; sleep 30"]);
  assert.equal(c.code, 0, c.err);
  govern(e, ["check", slug, "--set", "hang", "--stage", "plan"]);
  const t0 = Date.now();
  const r = govern(e, ["check", slug]);
  assert.ok(Date.now() - t0 < 15000, "the check must not wait for the children");
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /check hang: failed \(timed out after 1s\)/);
  const j = jobJson(e, slug);
  assert.equal(j.stopped, "timeout");
  const kids = readFileSync(join(e.projects, slug, "kids"), "utf8").trim().split("\n").map(Number);
  assert.equal(kids.length, 2);
  assert.ok(allGone([j.pid, ...kids]), `child and grandchild must be gone: ${kids}`);
  assert.equal(ledger(e, slug).filter((x) => x.kind === "job").at(-1).status, "timeout");
  assert.match(govern(e, ["jobs", slug]).out, /-hang timeout/);
  const a = govern(e, ["advance", slug]);
  assert.equal(a.code, 2);
  assert.match(a.err, /check hang failed \(timed out after 1s\)/);
});

test("a foreground job stays in its caller's process group: Ctrl-C to govern stops the job and what it started", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "hang", "--", "sh", "-c", "echo $$ > kids; sleep 30"]);
  govern(e, ["check", slug, "--set", "hang", "--stage", "plan"]);
  // govern leads a group of its own, as a terminal's foreground job does; the terminal's Ctrl-C goes to that group
  const g = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "check", slug], { env: childEnv(e), detached: true, stdio: "ignore" });
  g.unref();
  const kidsF = join(e.projects, slug, "kids");
  for (const end = Date.now() + 10000; !existsSync(kidsF) && Date.now() < end;) sleepSync(20);
  const j = jobJson(e, slug);
  const kids = readFileSync(kidsF, "utf8").trim().split("\n").map(Number);
  assert.equal(procStat(j.pid)?.pgrp, g.pid, "the job is in govern's group");
  process.kill(-g.pid!, "SIGINT");
  assert.ok(allGone([g.pid!, j.pid, ...kids]), `govern, the job and its child must be gone: ${[g.pid, j.pid, ...kids]}`);
});

test("kill stops a foreground job another govern waits on, tree and all, and only that govern records how it ended", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "hang", "--", "sh", "-c", "echo $$ > kids; sleep 30 & echo $! >> kids; sleep 30"]);
  govern(e, ["check", slug, "--set", "hang", "--stage", "plan"]);
  const out = join(e.root, "check.out");
  const g = spawn("sh", ["-c", `${process.execPath} --disable-warning=ExperimentalWarning ${GOVERN} check ${slug} > ${out} 2>&1; echo $? >> ${out}`], { env: childEnv(e), detached: true, stdio: "ignore" });
  g.unref();
  const kidsF = join(e.projects, slug, "kids");
  for (const end = Date.now() + 10000; !(existsSync(kidsF) && readFileSync(kidsF, "utf8").trim().split("\n").length === 2) && Date.now() < end;) sleepSync(20);
  const j = jobJson(e, slug);
  const kids = readFileSync(kidsF, "utf8").trim().split("\n").map(Number);
  const k = govern(e, ["kill", slug]);
  assert.equal(k.code, 0, k.err);
  assert.match(k.out, new RegExp(`job ${j.id} terminated`));
  assert.ok(allGone([j.pid, ...kids]), `the job and its children must be gone: ${[j.pid, ...kids]}`);
  for (const end = Date.now() + 10000; !/^\d+$/m.test(existsSync(out) ? readFileSync(out, "utf8") : "") && Date.now() < end;) sleepSync(20);
  const o = readFileSync(out, "utf8");
  assert.match(o, /check hang: failed \(killed by govern kill\)/);
  assert.match(o, /^1$/m);
  assert.deepEqual(ledger(e, slug).filter((x) => x.kind === "job" && x.id === j.id).map((x) => x.status), ["killed"]);
});

test("a second run of a command in the same second gets its own job, never the earlier one's exit", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "t", "--", "sh", "-c", "exit 0"]);
  // earlier failed runs of "t" holding every id the next run could be given within the next 10 seconds
  const taken = Array.from({ length: 12 }, (_, i) => `${stamp(new Date(Date.now() + (i - 1) * 1000))}-t`);
  for (const id of taken) {
    write(join(jobsDir(e, slug), id, "job.json"), JSON.stringify({ id, slug, name: "t", argv: ["false"], cwd: e.root, start: new Date().toISOString(), bg: false }));
    write(join(jobsDir(e, slug), id, "exit"), "1\n");
  }
  const r = govern(e, ["run", slug, "t"]);
  assert.equal(r.code, 0, r.out + r.err);
  const id = /job (\S+) · ok/.exec(r.out)?.[1];
  assert.ok(id && !taken.includes(id), r.out);
  assert.equal(jobJson(e, slug, id).name, "t");
});

test("cmd --timeout stores the timeout beside the argv; plain commands stay argv arrays", () => {
  const { e, slug } = lane();
  assert.equal(govern(e, ["cmd", slug, "t", "--timeout", "5", "--", "echo", "hi"]).code, 0);
  govern(e, ["cmd", slug, "p", "--", "echo", "plain"]);
  const s = JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
  assert.deepEqual(s.commands.t, { argv: ["echo", "hi"], timeout: 5 });
  assert.deepEqual(s.commands.p, ["echo", "plain"]);
  assert.match(govern(e, ["cmd", slug]).out, /^t: echo hi \(timeout 5s\)$/m);
  assert.match(govern(e, ["run", slug, "t"]).out, /ok \(exit 0\)/);
  assert.match(govern(e, ["cmd", slug, "u", "--timeout", "soon", "--", "echo"]).err, /--timeout must be a number of seconds/);
});

test("kill stops the lane's running background job, group and all, and records the outcome", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "long", "--", "sh", "-c", "echo $$ > kids; sleep 30 & echo $! >> kids; sleep 30"]);
  assert.match(govern(e, ["run", slug, "long", "--bg"]).out, /started in the background/);
  const j = jobJson(e, slug);
  assert.equal(procStat(j.pid)?.start, j.procStart);
  assert.equal(procStat(j.pid)?.pgrp, j.pgid);
  const kidsF = join(e.projects, slug, "kids");
  for (const end = Date.now() + 3000; !(existsSync(kidsF) && readFileSync(kidsF, "utf8").trim().split("\n").length === 2) && Date.now() < end;) sleepSync(20);
  const kids = readFileSync(kidsF, "utf8").trim().split("\n").map(Number);
  const k = govern(e, ["kill", slug]);
  assert.equal(k.code, 0, k.err);
  assert.match(k.out, new RegExp(`job ${j.id} (terminated|killed)`));
  assert.ok(allGone([j.pid, ...kids]));
  assert.equal(jobJson(e, slug).stopped, "killed");
  assert.match(govern(e, ["jobs", slug]).out, /-long killed/);
  assert.match(govern(e, ["status"]).out, /last job long killed/);
  const kl = ledger(e, slug).filter((x) => x.kind === "kill");
  assert.deepEqual(kl.map((x) => [x.job, x.outcome]), [[j.id, "terminated"]]);
  assert.match(govern(e, ["kill", slug, j.id]).out, /already-exited/);
  assert.equal(ledger(e, slug).filter((x) => x.kind === "kill").at(-1).outcome, "already-exited");
  assert.match(govern(e, ["kill", slug]).err, /no running job/);
});

test("a recycled pid is not the job: it reads lost and kill refuses to signal it", () => {
  const { e, slug } = lane();
  const child = fakeJob(e, slug, "20260101T000000Z-x", { procStart: "1" });
  try {
    assert.match(govern(e, ["jobs", slug]).out, /-x lost/);
    const k = govern(e, ["kill", slug, "20260101T000000Z-x"]);
    assert.equal(k.code, 2);
    assert.match(k.err, /now belongs to another process: not signalling it/);
    assert.equal(ledger(e, slug).at(-1).outcome, "not-owned");
    assert.ok(!dead(child.pid!), "the other process must be untouched");
  } finally { child.kill(); }
});

test("a job.json without a start time falls back to the pid, and kill will not signal what it cannot verify", () => {
  const { e, slug } = lane();
  const child = fakeJob(e, slug, "20260101T000000Z-old", {});
  try {
    assert.match(govern(e, ["jobs", slug]).out, /-old running/);
    const k = govern(e, ["kill", slug]);
    assert.equal(k.code, 2);
    assert.match(k.err, /no start time recorded: cannot verify .* not signalling it/);
    assert.equal(ledger(e, slug).at(-1).outcome, "not-owned");
    assert.ok(!dead(child.pid!));
  } finally { child.kill(); }
  assert.ok(allGone([child.pid!]));
  assert.match(govern(e, ["jobs", slug]).out, /-old lost/);
});
