import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, childEnv, present, GOVERN } from "./helpers.ts";
import { parseStat, procStat, procTable, sleepSync, stamp } from "../lib/util.ts";
import { signal } from "../lib/jobs.ts";

type E = ReturnType<typeof makeEnv>;
const ledger = (e: E, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const jobsDir = (e: E, slug: string) => join(e.projects, slug, "govern", "jobs");
const jobJson = (e: E, slug: string, id = readdirSync(jobsDir(e, slug)).sort().at(-1)!) =>
  JSON.parse(readFileSync(join(jobsDir(e, slug), id, "job.json"), "utf8"));
/** How long a poll waits for something that must happen: a guard against a hang, never a measure of speed. It is far
 *  beyond what any step here takes on a loaded machine, so only a condition that never comes runs into it. */
const PATIENCE_MS = 120_000;
/** Seconds a test's sleeper runs: longer than any test, so no sleeper ends on its own before the test stops it, and a
 *  govern that waited for one would run into govern()'s own time limit or PATIENCE_MS long before it ended. */
const LONG = 3600;
/** Poll until `f` holds; fail, naming `what`, if it has not within PATIENCE_MS. */
function until(f: () => boolean, what: string): void {
  for (const end = Date.now() + PATIENCE_MS; !f();) {
    if (Date.now() > end) assert.fail(`${what}: still not so after ${PATIENCE_MS / 1000}s`);
    sleepSync(20);
  }
}
/** The latest job's job.json once govern has written its pid: a job's own marker file can appear before that. */
function jobWithPid(e: E, slug: string) {
  let j: ReturnType<typeof jobJson> | undefined;
  until(() => {
    const d = jobsDir(e, slug);
    const id = existsSync(d) ? readdirSync(d).sort().at(-1) : undefined;
    j = id && existsSync(join(d, id, "job.json")) ? jobJson(e, slug, id) : undefined;
    return Boolean(j?.pid);
  }, "govern recorded the job's pid");
  return j;
}
/** Poll for a file to hold `lines` lines; return them as pids. */
function pidsIn(f: string, lines: number): number[] {
  const read = () => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
  until(() => read().length >= lines, `${f} holds ${lines} pid(s)`);
  const got = read();
  assert.equal(got.length, lines, `${f}: ${got}`);
  return got.map(Number);
}
/** The one pid written to `f`. */
const onePid = (f: string): number => present(pidsIn(f, 1)[0], `${f}: a pid`);
const NO_PROC = !existsSync("/proc/self/stat") && "these tests read /proc to see which processes are left";
/** Gone, or a zombie waiting for its reaper. */
const dead = (pid: number) => { const s = procStat(pid); return !s || s.state === "Z" || s.state === "X"; };
/** Poll for every pid to be gone (reaping by init is asynchronous); whether they all are. */
function allGone(pids: number[]): boolean {
  const end = Date.now() + PATIENCE_MS;
  while (!pids.every(dead) && Date.now() < end) sleepSync(20);
  return pids.every(dead);
}
/** The live processes `pid` runs under, its parent first, up to (not including) init. */
function ancestors(pid: number): number[] {
  const out: number[] = [];
  for (let p = procStat(pid)?.ppid; p !== undefined && p > 1 && !out.includes(p); p = procStat(p)?.ppid) out.push(p);
  return out;
}
/** Whether `sh` (by pid) has started its `sleep`: dash -c runs it as a child, or execs it as its last command. */
function sleeping(sh: number): boolean {
  const comm = (pid: number) => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return undefined; } };
  let kids: number[] = [];
  try { kids = readFileSync(`/proc/${sh}/task/${sh}/children`, "utf8").split(/\s+/).filter(Boolean).map(Number); } catch { /* gone */ }
  return [sh, ...kids].some((pid) => comm(pid) === "sleep");
}
/** Every live process started for this test's env: govern and its jobs all carry GOVERN_REPO=<the env's root>. */
function started(e: E): number[] {
  const mark = Buffer.from(`GOVERN_REPO=${e.root}\0`);
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).filter((pid) => {
    try { const env = readFileSync(`/proc/${pid}/environ`); return env.indexOf(mark) === 0 || env.indexOf(Buffer.concat([Buffer.from([0]), mark])) >= 0; } catch { return false; }
  }).filter((pid) => !dead(pid));
}
/** A test's finally: SIGKILL what the test started (the pids it names and every process of its env), then check it is gone. */
function cleanup(e: E, pids: number[] = []): void {
  const mine = [...new Set([...pids, ...started(e)])];
  for (const pid of mine) if (!dead(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  assert.ok(allGone(mine), `left running: ${mine.filter((p) => !dead(p))}`);
}
/** Where govern reads the process table from: /proc, or ps (GOVERN_PROC=ps, as on a system without /proc). */
const SOURCES = [["proc", {}], ["ps", { GOVERN_PROC: "ps" }]] as const;
/** ps -o lstart in the C locale: "Tue Oct 13 17:00:19 2026". */
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
/** Run govern in the background, its output and then its exit code going to `out`; returns the sh that waits on it. */
function governBg(e: E, args: string[], out: string, env: Record<string, string> = {}) {
  const g = spawn("sh", ["-c", `${process.execPath} --disable-warning=ExperimentalWarning ${GOVERN} ${args.join(" ")} > ${out} 2>&1; echo $? >> ${out}`], { env: childEnv(e, env), detached: true, stdio: "ignore" });
  g.unref();
  return g;
}
/** Poll for the background govern to finish; its output, the last line being its exit code. */
function governDone(out: string): string {
  const read = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
  until(() => /^\d+$/m.test(read()), `the background govern finished (${out})`);
  return read();
}
function lane() {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "lane", "--process", "dev", "--title", "L"]).code, 0);
  return { e, slug: "lane" };
}
/** A sleeper this test starts and owns, with a hand-written job.json pointing at it. */
function fakeJob(e: E, slug: string, id: string, extra: Record<string, unknown>) {
  const child = spawn("sleep", [String(LONG)], { detached: true, stdio: "ignore" });
  write(join(jobsDir(e, slug), id, "job.json"), JSON.stringify({ id, slug, name: "x", argv: ["sleep", String(LONG)], cwd: e.root, start: new Date().toISOString(), pid: child.pid, pgid: child.pid, bg: true, ...extra }));
  return child;
}

test("parseStat reads state, process group and start time even when the command name holds spaces and parentheses", { skip: NO_PROC }, () => {
  const tail = "S 1 4242 4242 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 987654 1000 200";
  assert.deepEqual(parseStat(`42 (node) ${tail}`), { state: "S", ppid: 1, pgrp: 4242, start: "987654" });
  assert.deepEqual(parseStat(`42 (my (odd) name) x) ${tail}`), { state: "S", ppid: 1, pgrp: 4242, start: "987654" });
  assert.equal(parseStat("garbage"), undefined);
  assert.equal(parseStat("42 (short) S 1 2"), undefined);
  const self = readFileSync("/proc/self/stat", "utf8");
  assert.equal(procStat(process.pid)?.start, self.slice(self.lastIndexOf(")") + 1).trim().split(/\s+/)[19]);
});

test("procTable reads the same processes from /proc and from ps: parent, group, a zombie as exited", { skip: NO_PROC }, () => {
  const sleeper = spawn("sleep", [String(LONG)], { stdio: "ignore" });
  const zombie = spawn("true", { stdio: "ignore" });
  const prev = process.env.GOVERN_PROC;
  try {
    // the event loop does not run while sleepSync blocks, so the exited child stays an unreaped zombie
    until(() => procStat(zombie.pid!)?.state === "Z", "the exited child shows as a zombie");
    const tables = SOURCES.map(([src]) => {
      if (src === "ps") process.env.GOVERN_PROC = "ps"; else delete process.env.GOVERN_PROC;
      return procTable();
    });
    for (const t of tables) {
      assert.equal(t.get(process.pid)?.ppid, process.ppid);
      assert.equal(t.get(process.pid)?.pgrp, procStat(process.pid)!.pgrp);
      assert.equal(t.get(sleeper.pid!)?.ppid, process.pid);
      assert.notEqual(t.get(sleeper.pid!)?.state, "Z");
      assert.equal(t.get(zombie.pid!)?.state, "Z");
    }
    const [fromProc, fromPs] = tables;
    assert.equal(fromProc?.get(process.pid)?.start, procStat(process.pid)!.start);
    assert.match(present(fromPs?.get(process.pid), "ps's row for this process").start, LSTART);
  } finally {
    if (prev === undefined) delete process.env.GOVERN_PROC; else process.env.GOVERN_PROC = prev;
    sleeper.kill("SIGKILL");
  }
});

test("every job records its pid and start time, and sees GOVERN_JOB_ID and GOVERN_JOB_DIR; a foreground job has no group of its own", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  try {
    govern(e, ["cmd", slug, "who", "--", "sh", "-c", "echo id=$GOVERN_JOB_ID; echo dir=$GOVERN_JOB_DIR"]);
    const r = govern(e, ["run", slug, "who"]);
    assert.equal(r.code, 0, r.err);
    const j = jobJson(e, slug);
    assert.match(r.out, new RegExp(`id=${j.id}`));
    assert.match(r.out, new RegExp(`^  dir=${join(jobsDir(e, slug), j.id)}$`, "m"));
    assert.ok(Number.isInteger(j.pid));
    assert.equal(j.pgid, undefined, "a foreground job stays in govern's process group");
    assert.match(j.procStart, /^\d+$/);
  } finally { cleanup(e); }
});

for (const [src, env] of SOURCES) test(`a foreground job past its timeout has its whole process tree stopped and fails the check as timed out (${src})`, { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  try {
    const c = govern(e, ["cmd", slug, "hang", "--timeout", "1", "--", "sh", "-c", `echo $$ > kids; sleep ${LONG} & echo $! >> kids; sleep ${LONG}`]);
    assert.equal(c.code, 0, c.err);
    govern(e, ["check", slug, "--set", "hang", "--stage", "plan"]);
    // the children sleep LONG: a check that waited for them would be cut off by govern()'s time limit, with no exit code
    const r = govern(e, ["check", slug], env);
    assert.equal(r.code, 1, `the check must end at the job's timeout, not wait for the children: ${r.err}`);
    assert.match(r.out, /check hang: failed \(timed out after 1s\)/);
    const j = jobJson(e, slug);
    assert.equal(j.stopped, "timeout");
    const kids = pidsIn(join(e.projects, slug, "kids"), 2);
    assert.ok(allGone([j.pid, ...kids]), `child and grandchild must be gone: ${kids}`);
    assert.equal(ledger(e, slug).filter((x) => x.kind === "job").at(-1).status, "timeout");
    assert.match(govern(e, ["jobs", slug], env).out, /-hang timeout/);
    const a = govern(e, ["advance", slug], env);
    assert.equal(a.code, 2);
    assert.match(a.err, /check hang failed \(timed out after 1s\)/);
  } finally { cleanup(e); }
});

test("a foreground job stays in its caller's process group: Ctrl-C to govern stops the job and what it started", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "hang", "--", "sh", "-c", `echo $$ > kids; sleep ${LONG}`]);
    govern(e, ["check", slug, "--set", "hang", "--stage", "plan"]);
    // govern leads a group of its own, as a terminal's foreground job does; the terminal's Ctrl-C goes to that group
    const g = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "check", slug], { env: childEnv(e), detached: true, stdio: "ignore" });
    g.unref();
    pids.push(g.pid!);
    const kids = pidsIn(join(e.projects, slug, "kids"), 1);
    const j = jobWithPid(e, slug);
    pids.push(j.pid, ...kids);
    assert.equal(procStat(j.pid)?.pgrp, g.pid, "the job is in govern's group");
    // The Ctrl-C lands once the job's sleep runs. dash -c catches SIGINT, and one that arrives between `echo $$ > kids`
    // and the sleep's start is held until the sleep ends: the shell would outlive the Ctrl-C, whatever govern does.
    until(() => sleeping(kids[0]!), "the job's sleep has started");
    process.kill(-g.pid!, "SIGINT");
    assert.ok(allGone(pids), `govern, the job and its child must be gone: ${pids}`);
  } finally { cleanup(e, pids); }
});

for (const [src, env] of SOURCES) test(`kill stops a foreground job another govern waits on, tree and all, and the job's end is ledgered once (${src})`, { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "hang", "--", "sh", "-c", `echo $$ > kids; sleep ${LONG} & echo $! >> kids; sleep ${LONG}`]);
    govern(e, ["check", slug, "--set", "hang", "--stage", "plan"]);
    const out = join(e.root, "check.out");
    const g = governBg(e, ["check", slug], out, env);
    pids.push(g.pid!);
    const kids = pidsIn(join(e.projects, slug, "kids"), 2);
    const j = jobWithPid(e, slug);
    pids.push(j.pid, ...kids);
    const k = govern(e, ["kill", slug], env);
    assert.equal(k.code, 0, k.err);
    assert.match(k.out, new RegExp(`job ${j.id} terminated`));
    assert.ok(allGone([j.pid, ...kids]), `the job and its children must be gone: ${[j.pid, ...kids]}`);
    const o = governDone(out);
    assert.match(o, /check hang: failed \(killed by govern kill\)/);
    assert.match(o, /^1$/m);
    assert.deepEqual(ledger(e, slug).filter((x) => x.kind === "job" && x.id === j.id).map((x) => x.status), ["killed"]);
  } finally { cleanup(e, pids); }
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
  for (const bad of ["soon", "0", "1.5", "-2", "1e3", "0x10", "07", " 5", ""]) {
    const r = govern(e, ["cmd", slug, "u", "--timeout", bad, "--", "echo"]);
    assert.equal(r.code, 2, `--timeout ${JSON.stringify(bad)}`);
    assert.match(r.err, /--timeout must be a whole number of seconds, 1 or more/);
  }
  assert.equal(JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8")).commands.u, undefined);
});

test("wait --timeout takes only a whole number of seconds: anything else is refused, never a wait without end", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "t", "--", "true"]);
  govern(e, ["run", slug, "t"]);
  for (const bad of ["soon", "0", "2.5", "-1", ""]) {
    const w = govern(e, ["wait", slug, "last", "--timeout", bad]);
    assert.equal(w.code, 2, `--timeout ${JSON.stringify(bad)}`);
    assert.match(w.err, /--timeout must be a whole number of seconds, 1 or more/);
  }
  assert.equal(govern(e, ["wait", slug, "last", "--timeout", "3"]).code, 0);
});

test("a job ref is an exact id, else a unique id prefix, else a command name meaning that command's newest job", () => {
  const { e, slug } = lane();
  const mk = (id: string, name: string) => {
    write(join(jobsDir(e, slug), id, "job.json"), JSON.stringify({ id, slug, name, argv: ["true"], cwd: e.root, start: new Date().toISOString(), bg: false }));
    write(join(jobsDir(e, slug), id, "exit"), "0\n");
    write(join(jobsDir(e, slug), id, "log"), `log of ${id}\n`);
  };
  mk("20260101T000000Z-build", "build");
  mk("20260101T000000Z-build.002", "build");
  mk("20260101T000003Z-test", "test");
  mk("20260101T000005Z-build", "build");
  const log = (ref: string) => govern(e, ["log", slug, ref]);
  assert.equal(log("20260101T000000Z-build").out.trim(), "log of 20260101T000000Z-build");
  assert.equal(log("20260101T000003").out.trim(), "log of 20260101T000003Z-test");
  assert.equal(log("build").out.trim(), "log of 20260101T000005Z-build");
  assert.equal(log("test").out.trim(), "log of 20260101T000003Z-test");
  assert.match(log("20260101T000000Z-b").err, /is ambiguous/);
  assert.match(log("deploy").err, /not found/);
});

for (const [src, env] of SOURCES) test(`kill stops the lane's running background job, group and all, and records the outcome (${src})`, { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  try {
    govern(e, ["cmd", slug, "long", "--", "sh", "-c", `echo $$ > kids; sleep ${LONG} & echo $! >> kids; sleep ${LONG}`]);
    assert.match(govern(e, ["run", slug, "long", "--bg"], env).out, /started in the background/);
    const j = jobJson(e, slug);
    if (src === "proc") assert.equal(procStat(j.pid)?.start, j.procStart); else assert.match(j.procStart, LSTART);
    assert.equal(procStat(j.pid)?.pgrp, j.pgid);
    const kids = pidsIn(join(e.projects, slug, "kids"), 2);
    const k = govern(e, ["kill", slug], env);
    assert.equal(k.code, 0, k.err);
    assert.match(k.out, new RegExp(`job ${j.id} (terminated|killed)`));
    assert.ok(allGone([j.pid, ...kids]));
    assert.equal(jobJson(e, slug).stopped, "killed");
    assert.match(govern(e, ["jobs", slug], env).out, /-long killed/);
    assert.match(govern(e, ["status"], env).out, /last job long killed/);
    const kl = ledger(e, slug).filter((x) => x.kind === "kill");
    assert.deepEqual(kl.map((x) => [x.job, x.outcome]), [[j.id, "terminated"]]);
    assert.match(govern(e, ["kill", slug, j.id], env).out, /already-exited/);
    assert.equal(ledger(e, slug).filter((x) => x.kind === "kill").at(-1).outcome, "already-exited");
    assert.match(govern(e, ["kill", slug], env).err, /no running job/);
  } finally { cleanup(e); }
});

for (const [src, env] of SOURCES) test(`a foreground job killed from outside ends its run at once as failed, not as a timeout (${src})`, { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    // a timeout of LONG: a govern run that waited for it would not finish within governDone's patience
    govern(e, ["cmd", slug, "hang", "--timeout", String(LONG), "--", "sh", "-c", `echo $$ > kids; exec sleep ${LONG}`]);
    const out = join(e.root, "run.out");
    const g = governBg(e, ["run", slug, "hang"], out, env);
    pids.push(g.pid!);
    const kids = pidsIn(join(e.projects, slug, "kids"), 1);
    const j = jobWithPid(e, slug);
    pids.push(j.pid, ...kids);
    // the job's own process (the sh that runs the command and writes its exit file) dies without writing one
    process.kill(j.pid, "SIGKILL");
    const o = governDone(out);
    assert.match(o, new RegExp(`job ${j.id} · failed`));
    assert.doesNotMatch(o, /timeout|timed out/);
    assert.equal(ledger(e, slug).filter((x) => x.kind === "job" && x.id === j.id).at(-1).status, "failed");
  } finally { cleanup(e, pids); }
});

test("a recycled pid is not the job: it reads lost and kill refuses to signal it", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const child = fakeJob(e, slug, "20260101T000000Z-x", { procStart: "1" });
  try {
    assert.match(govern(e, ["jobs", slug]).out, /-x lost/);
    const k = govern(e, ["kill", slug, "20260101T000000Z-x"]);
    assert.equal(k.code, 2);
    assert.match(k.err, /now belongs to another process: not signalling it/);
    assert.equal(ledger(e, slug).at(-1).outcome, "not-owned");
    assert.ok(!dead(child.pid!), "the other process must be untouched");
  } finally { cleanup(e, [child.pid!]); }
});

test("a job.json without a start time falls back to the pid, and kill will not signal what it cannot verify", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const child = fakeJob(e, slug, "20260101T000000Z-old", {});
  try {
    assert.match(govern(e, ["jobs", slug]).out, /-old running/);
    const k = govern(e, ["kill", slug]);
    assert.equal(k.code, 2);
    assert.match(k.err, /no start time recorded: cannot verify .* not signalling it/);
    assert.equal(ledger(e, slug).at(-1).outcome, "not-owned");
    assert.ok(!dead(child.pid!));
  } finally { cleanup(e, [child.pid!]); }
  assert.match(govern(e, ["jobs", slug]).out, /-old lost/);
});

test("an exit file not yet fully written is not an exit: the job still runs, or failed, never ok", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const live = "20260101T000000Z-x";
  const child = fakeJob(e, slug, live, {});
  try {
    write(join(jobsDir(e, slug), live, "job.json"), JSON.stringify({ ...jobJson(e, slug, live), procStart: procStat(child.pid!)!.start }));
    write(join(jobsDir(e, slug), live, "exit"), "");
    const gone = "20260101T000001Z-y";
    write(join(jobsDir(e, slug), gone, "job.json"), JSON.stringify({ id: gone, slug, name: "y", argv: ["true"], cwd: e.root, start: new Date().toISOString(), bg: false }));
    write(join(jobsDir(e, slug), gone, "exit"), " \n");
    const out = govern(e, ["jobs", slug]).out;
    assert.match(out, /-x running/);
    assert.match(out, /-y failed/);
    assert.doesNotMatch(out, / ok/);
    // the job's script writes exit.tmp and renames it: never a partial exit file, nothing left behind
    govern(e, ["cmd", slug, "t", "--", "sh", "-c", "exit 4"]);
    assert.equal(govern(e, ["run", slug, "t"]).code, 4);
    const d = join(jobsDir(e, slug), jobJson(e, slug).id);
    assert.equal(readFileSync(join(d, "exit"), "utf8"), "4\n");
    assert.ok(!existsSync(join(d, "exit.tmp")));
  } finally { cleanup(e, [child.pid!]); }
});

test("a foreground job's timeout also stops what left its process tree by double-forking", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "hang", "--timeout", "1", "--", "sh", "-c", `(sleep ${LONG} & echo $! > esc); sleep ${LONG}`]);
    const r = govern(e, ["run", slug, "hang"]);
    assert.match(r.out, /· timed out after 1s/);
    assert.doesNotMatch(r.out, /timeout \(timed out/);
    const esc = onePid(join(e.projects, slug, "esc"));
    pids.push(esc);
    assert.ok(allGone([esc]), `the double-forked sleep must be gone: ${esc}`);
  } finally { cleanup(e, pids); }
});

test("kill stops a foreground job's double-forked process too", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "hang", "--", "sh", "-c", `(sleep ${LONG} & echo $! > esc); echo $$ > kids; sleep ${LONG}`]);
    const g = governBg(e, ["run", slug, "hang"], join(e.root, "run.out"));
    pids.push(g.pid!);
    const esc = onePid(join(e.projects, slug, "esc"));
    const kids = pidsIn(join(e.projects, slug, "kids"), 1);
    const j = jobWithPid(e, slug);
    pids.push(esc, j.pid, ...kids);
    // the subshell that started the sleep writes esc before it exits: the sleep has left the job's tree once it has
    until(() => !dead(esc) && !ancestors(esc).some((p) => p === j.pid || kids.includes(p)), "the sleep left the job's tree");
    const k = govern(e, ["kill", slug]);
    assert.equal(k.code, 0, k.err);
    assert.ok(allGone([esc, j.pid, ...kids]), "the job, its child and the double-forked sleep must be gone");
  } finally { cleanup(e, pids); }
});

test("kill stops a background job's grandchild that left its process group with setsid", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "long", "--", "sh", "-c", `(setsid sleep ${LONG} & echo $! > esc); sleep ${LONG}`]);
    govern(e, ["run", slug, "long", "--bg"]);
    const esc = onePid(join(e.projects, slug, "esc"));
    const j = jobWithPid(e, slug);
    pids.push(esc, j.pid);
    until(() => { const s = procStat(esc); return s !== undefined && s.pgrp !== j.pgid; }, "the sleep left the job's group");
    const k = govern(e, ["kill", slug]);
    assert.equal(k.code, 0, k.err);
    assert.ok(allGone([esc, j.pid]), "the job and its setsid grandchild must be gone");
  } finally { cleanup(e, pids); }
});

test("a background job whose own process exited but left one running: kill stops what is left", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "spawner", "--", "sh", "-c", `(sleep ${LONG} & echo $! > esc)`]);
    govern(e, ["run", slug, "spawner", "--bg"]);
    const esc = onePid(join(e.projects, slug, "esc"));
    const j = jobWithPid(e, slug);
    pids.push(esc);
    assert.ok(allGone([j.pid]), "the job's own process exits at once");
    assert.ok(!dead(esc));
    const k = govern(e, ["kill", slug, j.id]);
    assert.equal(k.code, 0, k.err);
    assert.match(k.out, new RegExp(`job ${j.id} terminated`));
    assert.ok(allGone([esc]), "what the job left running must be gone");
  } finally { cleanup(e, pids); }
});

/** The job's end entries in the ledger (a background job's "started" entry is not an end). */
const ends = (e: E, slug: string, id: string) => ledger(e, slug).filter((x) => x.kind === "job" && x.id === id && x.status !== "started");

test("stopped is an intent, not an outcome: a job marked stopped whose processes still run reads running, and kill finishes it", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "long", "--", "sh", "-c", `echo $$ > kids; sleep ${LONG}`]);
    govern(e, ["run", slug, "long", "--bg"]);
    const kids = pidsIn(join(e.projects, slug, "kids"), 1);
    const j = jobWithPid(e, slug);
    pids.push(j.pid, ...kids);
    // a kill that marked the job and then died before its signals landed
    write(join(jobsDir(e, slug), j.id, "job.json"), JSON.stringify({ ...jobJson(e, slug, j.id), stopped: "killed" }));
    assert.match(govern(e, ["jobs", slug]).out, new RegExp(`${j.id} running`));
    const k = govern(e, ["kill", slug]);
    assert.equal(k.code, 0, k.err);
    assert.match(k.out, new RegExp(`job ${j.id} terminated`));
    assert.ok(allGone([j.pid, ...kids]));
    assert.match(govern(e, ["jobs", slug]).out, new RegExp(`${j.id} killed`));
    assert.deepEqual(ledger(e, slug).filter((x) => x.kind === "kill").map((x) => x.outcome), ["terminated"]);
    assert.deepEqual(ends(e, slug, j.id).map((x) => x.status), ["killed"]);
  } finally { cleanup(e, pids); }
});

test("a stop that finished (job.json has its end) is final: no process table scan, so a stray process carrying its GOVERN_JOB_DIR neither revives it nor gets picked by kill", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const id = `${stamp()}-x`, dir = join(jobsDir(e, slug), id);
  const stray = spawn("sleep", [String(LONG)], { detached: true, stdio: "ignore", env: { ...process.env, GOVERN_JOB_DIR: dir } });
  try {
    const t = new Date(Date.now() - 5000).toISOString();
    write(join(dir, "job.json"), JSON.stringify({ id, slug, name: "x", argv: ["sleep", String(LONG)], cwd: e.root, start: t, pid: 2 ** 22 + 1, procStart: "1", bg: true, stopped: "killed", end: new Date().toISOString() }));
    until(() => procStat(stray.pid!) !== undefined, "the stray process is in the process table");
    assert.match(govern(e, ["jobs", slug]).out, new RegExp(`${id} killed`));
    const k = govern(e, ["kill", slug]);
    assert.notEqual(k.code, 0);
    assert.match(k.err, /no running job/);
    assert.ok(!dead(stray.pid!), "kill signalled a process of a job whose stop had finished");
  } finally { cleanup(e, [stray.pid!]); }
});

test("a job's end is ledgered once: kill, then wait, then wait again add no second entry", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "long", "--", "sh", "-c", `sleep ${LONG}`]);
    govern(e, ["run", slug, "long", "--bg"]);
    const j = jobWithPid(e, slug);
    pids.push(j.pid);
    assert.equal(govern(e, ["kill", slug]).code, 0);
    for (let i = 0; i < 2; i++) {
      const w = govern(e, ["wait", slug, j.id, "--timeout", "5"]);
      assert.match(w.out, new RegExp(`job ${j.id} · killed by govern kill`));
      assert.doesNotMatch(w.out, /killed \(killed/);
    }
    const got = ends(e, slug, j.id);
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal(got[0].status, "killed");
    assert.equal(got[0].bg, true);
    assert.ok(Number.isInteger(got[0].seconds), JSON.stringify(got[0]));
  } finally { cleanup(e, pids); }
});

test("a background job that ends on its own is ledgered once however many times it is waited on", () => {
  const { e, slug } = lane();
  govern(e, ["cmd", slug, "t", "--", "sh", "-c", "exit 3"]);
  govern(e, ["run", slug, "t", "--bg"]);
  const id = jobJson(e, slug).id;
  for (let i = 0; i < 2; i++) assert.equal(govern(e, ["wait", slug, id, "--timeout", "10"]).code, 3);
  assert.deepEqual(ends(e, slug, id).map((x) => [x.status, x.exit]), [["failed", 3]]);
});

test("a foreground job whose govern died is still ledgered: kill records its end, with its duration", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    govern(e, ["cmd", slug, "hang", "--", "sh", "-c", `echo $$ > kids; sleep ${LONG}`]);
    const g = governBg(e, ["run", slug, "hang"], join(e.root, "run.out"));
    pids.push(g.pid!);
    const kids = pidsIn(join(e.projects, slug, "kids"), 1);
    const j = jobWithPid(e, slug);
    const waiter = procStat(j.pid)!.ppid;
    pids.push(waiter, j.pid, ...kids);
    process.kill(waiter, "SIGKILL");
    assert.ok(allGone([waiter]));
    assert.match(govern(e, ["jobs", slug]).out, new RegExp(`${j.id} running`));
    const k = govern(e, ["kill", slug]);
    assert.equal(k.code, 0, k.err);
    assert.ok(allGone([j.pid, ...kids]));
    const got = ends(e, slug, j.id);
    assert.deepEqual(got.map((x) => [x.status, x.bg]), [["killed", false]]);
    assert.ok(Number.isInteger(got[0].seconds), JSON.stringify(got[0]));
    assert.match(govern(e, ["wait", slug, j.id]).out, new RegExp(`job ${j.id} · killed`));
    assert.equal(ends(e, slug, j.id).length, 1);
  } finally { cleanup(e, pids); }
});

test("a complete exit file is authoritative unless govern stopped the job and the code is a signal's (128 and up)", () => {
  const { e, slug } = lane();
  const cases: [string, Record<string, unknown>, string, RegExp][] = [
    ["20260101T000000Z-a", { stopped: "timeout" }, "0", /-a ok exit 0/],
    ["20260101T000001Z-b", { stopped: "killed" }, "1", /-b failed exit 1/],
    ["20260101T000002Z-c", { stopped: "timeout" }, "143", /-c timeout exit 143/],
    ["20260101T000003Z-d", { stopped: "killed" }, "137", /-d killed exit 137/],
    ["20260101T000004Z-e", {}, "143", /-e failed exit 143/],
  ];
  for (const [id, extra, code] of cases) {
    write(join(jobsDir(e, slug), id, "job.json"), JSON.stringify({ id, slug, name: "x", argv: ["true"], cwd: e.root, start: new Date().toISOString(), bg: false, ...extra }));
    write(join(jobsDir(e, slug), id, "exit"), `${code}\n`);
  }
  const out = govern(e, ["jobs", slug]).out;
  for (const [, , , re] of cases) assert.match(out, re);
});

test("a job that runs govern kill on its own lane stops what it started, never the govern doing it or that govern's callers", { skip: NO_PROC }, () => {
  const { e, slug } = lane();
  const pids: number[] = [];
  try {
    const kill = `${process.execPath} --disable-warning=ExperimentalWarning ${GOVERN} kill ${slug}`;
    govern(e, ["cmd", slug, "self", "--", "sh", "-c", `sleep ${LONG} & echo $! > kids; ${kill}; echo kill-exit=$?`]);
    const r = govern(e, ["run", slug, "self"]);
    const sib = onePid(join(e.projects, slug, "kids"));
    pids.push(sib);
    const j = jobJson(e, slug);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, new RegExp(`job ${j.id} · ok \\(exit 0\\)`));
    assert.match(r.out, new RegExp(`job ${j.id} terminated`));
    assert.match(r.out, /kill-exit=0/);
    assert.ok(allGone([sib]), "the job's other process must be gone");
    assert.deepEqual(ledger(e, slug).filter((x) => x.kind === "kill").map((x) => [x.job, x.outcome]), [[j.id, "terminated"]]);
    assert.deepEqual(ends(e, slug, j.id).map((x) => [x.status, x.exit]), [["ok", 0]]);
  } finally { cleanup(e, pids); }
});

test("signalling a process that is gone (ESRCH) or not ours to signal (EPERM) is skipped, never thrown", { skip: NO_PROC || (process.getuid?.() === 0 && "as root, no process is out of reach") }, () => {
  // signal 0 delivers nothing: it only asks whether a signal could be sent
  assert.throws(() => process.kill(1, 0), { code: "EPERM" });
  assert.equal(signal(1, 0), false);
  // a child of this test, exited and reaped: its pid names no process
  const gone = spawn("true", { stdio: "ignore" });
  return new Promise<void>((done, reject) => gone.on("exit", () => setImmediate(() => {
    try {
      assert.throws(() => process.kill(gone.pid!, 0), { code: "ESRCH" });
      assert.equal(signal(gone.pid!, 0), false);
      assert.equal(signal(process.pid, 0), true);
      done();
    } catch (err) { reject(err); }
  })));
});
