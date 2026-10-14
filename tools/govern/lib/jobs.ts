// Jobs: run a project command in the foreground or detached, wait on it without a model in the loop, stop it by identity.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, openSync, closeSync, statSync, readSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, readJson, writeJson, stamp, nowIso, sleepSync, shq, changedSince, clip, procOf, procTable, procSource, exited, type ProcStat } from "./util.ts";
import { fileURLToPath } from "node:url";
import { type Project, projectDir, governDir, appendLedger, argvOf } from "./project.ts";
import { repo, pathNamed } from "./workspace.ts";
import { place, lockDir, slots, costOf, type Price, type Resource } from "./resources.ts";
import * as locks from "./locks.ts";
import * as allowances from "./allowances.ts";

/** pid and procStart (its start time in the process table: /proc field 22, or ps lstart) identify the job's process, so a recycled pid is never taken for it.
 *  pgid: a background job leads its own process group; a foreground job stays in its caller's, so Ctrl-C reaches it. timeout: a foreground job's limit (s). stopped/end: govern stopped it. */
export interface Job {
  id: string; slug: string; name: string; argv: string[]; cwd: string; start: string; pid?: number; pgid?: number; procStart?: string; bg: boolean;
  timeout?: number; stopped?: "timeout" | "killed"; end?: string;
  /** The resource it runs on and its price then (a later change to the registry does not reprice it); lock: the slot it
   *  takes (its job directory's `acquired` file says when it got it). */
  resource?: string; price?: Price; lock?: { dir: string; id: string; max: number; label: string };
}
export interface JobState extends Job {
  status: "running" | "ok" | "failed" | "lost" | "timeout" | "killed"; exit?: number; seconds?: number;
  /** Set on a job that waits for its resource: how many are ahead of it. */
  queued?: { resource: string; ahead: number };
}
/** What `govern kill` did: its processes exited on SIGTERM, needed SIGKILL, had already exited, or the pid is not provably the job's. */
export type KillOutcome = "terminated" | "killed" | "already-exited" | "not-owned";

/** How long a foreground job (a check, `govern run`) may run when its command sets no --timeout: room for a test suite. */
export const DEFAULT_TIMEOUT = 30 * 60;
/** After SIGTERM, how long a job's process group gets to exit before SIGKILL. */
export const KILL_GRACE_MS = 3000;
const POLL_MS = 100;

// Absolute: a job directory is also the mark in its processes' environment, compared as text.
const jobsDir = (slug: string) => resolve(governDir(slug), "jobs");
const jobDir = (slug: string, id: string) => join(jobsDir(slug), id);

export function expand(p: Project, argv: string[]): string[] {
  const python = process.env.GOVERN_PYTHON ?? "python3";
  return argv.map((a) => a.replaceAll("{repo}", repo()).replaceAll("{dir}", projectDir(p.slug)).replaceAll("{python}", python)
    .replace(/\{paths\.([^{}]+)\}/g, (_, n: string) => pathNamed(n)));
}

/** A new job id, its directory created here: mkdir is atomic, so neither a run of the same command in the same second nor a
 *  concurrent govern can share a directory (and an earlier run's exit file) with this one. */
function claim(slug: string, name: string): string {
  mkdirSync(jobsDir(slug), { recursive: true });
  for (let n = 1; ; n++) {
    const id = `${stamp()}-${name}${n > 1 ? `.${String(n).padStart(3, "0")}` : ""}`;
    try { mkdirSync(join(jobsDir(slug), id)); return id; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}

const LOCKWAIT = fileURLToPath(new URL("./lockwait.ts", import.meta.url));
const acquiredFile = (slug: string, id: string) => join(jobDir(slug, id), "acquired");

/** A job that waits for its resource: how many are ahead of it (a waiting job has no `acquired` file yet). */
export function queuedOf(job: Job): JobState["queued"] {
  if (!job.lock || !job.resource || existsSync(acquiredFile(job.slug, job.id))) return undefined;
  return { resource: job.resource, ahead: locks.ahead(job.lock.dir, job.lock.id) ?? 0 };
}

/** Reserve the job's estimate against the lane's allowances (machine-hours, or money in the resource's currency), or
 *  refuse: the estimate is `estimate` hours, else the command's timeout, else (foreground only) the default limit. A job
 *  on no resource is not metered. A refusal removes the claimed job directory and stops with exit 1. */
function reserveFor(p: Project, name: string, id: string, res: Resource | undefined, timeout: number | undefined, bg: boolean, estimate: number | undefined): string | undefined {
  const list = allowances.allowances();
  const currency = res?.price.basis === "per-second" || res?.price.basis === "per-hour" ? res.price.currency : undefined;
  if (!res || !allowances.meters(list, p.slug, currency)) return undefined;
  const refuse = (why: string): never => { rmSync(jobDir(p.slug, id), { recursive: true, force: true }); return fail(why, 1); };
  const seconds = estimate !== undefined ? estimate * 3600 : timeout ?? (bg ? undefined : DEFAULT_TIMEOUT);
  if (seconds === undefined) refuse(`${p.slug}/${name}: no declared duration to reserve against an allowance: pass --estimate HOURS, or give the command a --timeout`);
  const hours = seconds! / 3600, money = costOf(res, seconds!);
  const rid = `job:${p.slug}:${id}`;
  const no = allowances.reserve(list, { lane: p.slug }, { id: rid, label: `${p.slug}/${name} on ${res.name}`, hours, ...(money ? { money } : {}), job: { slug: p.slug, id } }, settleDead);
  if (no) refuse(`refused: ${no.text}`);
  return rid;
}

/** For the allowance sweep: finish a job whose holder died from its own record (ledger entry, settled reservation); true while it still runs. */
export function settleDead(j: { slug: string; id: string }): boolean {
  if (!existsSync(join(jobDir(j.slug, j.id), "job.json"))) return false;
  recordEnd(j.slug, j.id);
  return state(j.slug, j.id).status === "running";
}

/** Run a command; on = the resource named with --on (else the command's own, else the job runs locally). A shared
 *  resource's slot is taken first: a foreground job waits for it here, a --bg job's sh waits (lib/lockwait.ts).
 *  estimate: the hours to reserve against an allowance (see reserveFor). */
export function start(p: Project, name: string, extra: string[], bg: boolean, on?: string, estimate?: number): JobState {
  const base = p.commands[name];
  if (!base) fail(`${p.slug}: no command "${name}" (have: ${Object.keys(p.commands).join(", ") || "none"}; add with govern cmd ${p.slug} ${name} -- <argv>)`);
  const res = place(p.slug, Array.isArray(base) ? undefined : base.resource, on);
  const argv = expand(p, [...argvOf(base), ...extra]);
  const id = claim(p.slug, name);
  const dir = jobDir(p.slug, id);
  const f = join(dir, "job.json"), exitF = join(dir, "exit");
  const cwd = projectDir(p.slug);
  const declaredTimeout = Array.isArray(base) ? undefined : base.timeout;
  const timeout = declaredTimeout ?? DEFAULT_TIMEOUT;
  const reservation = reserveFor(p, name, id, res, declaredTimeout, bg, estimate);
  const max = res && slots(res);
  const lock = res && max !== undefined ? { dir: lockDir(res.name), id: `${p.slug.replaceAll("/", "~")}~${id}`, max, label: `${p.slug} ${id}` } : undefined;
  const job: Job = { id, slug: p.slug, name, argv, cwd, start: nowIso(), bg, ...(bg ? {} : { timeout }),
    ...(res ? { resource: res.name, price: res.price } : {}), ...(lock ? { lock } : {}) };
  writeJson(f, job);
  const me = procOf(process.pid);
  if (lock) {
    // In line before anything runs, as this govern (a foreground job's wait is here), then handed to the job's sh.
    locks.enqueue(lock.dir, { id: lock.id, label: lock.label, pid: process.pid, ...(me ? { start: me.start } : {}) });
    if (!bg) {
      writeJson(f, { ...job, pid: process.pid, ...(me ? { procStart: me.start } : {}) });
      while (!locks.tryAcquire(lock.dir, lock.id, lock.max)) sleepSync(POLL_MS);
    }
  }
  if (res && (!lock || !bg)) writeFileSync(acquiredFile(p.slug, id), nowIso() + "\n");
  // The exit code goes to exit.tmp and is renamed to exit: a poller never sees an exit file that exists but is not yet written.
  const exitIt = `echo $rc > ${shq(exitF)}.tmp && mv -f ${shq(exitF)}.tmp ${shq(exitF)}`;
  const logF = shq(join(dir, "log"));
  const lockCmd = (verb: string, ...rest: string[]) => [process.execPath, "--disable-warning=ExperimentalWarning", LOCKWAIT, verb, ...rest].map(shq).join(" ");
  const script = lock && bg
    ? `${lockCmd("wait", lock.dir, lock.id, String(lock.max), dir, lock.label)} > ${logF} 2>&1; rc=$?; ` +
      `if [ $rc -eq 0 ]; then ${argv.map(shq).join(" ")} >> ${logF} 2>&1; rc=$?; ${lockCmd("release", lock.dir, lock.id)} >> ${logF} 2>&1; fi; ${exitIt}`
    : `${argv.map(shq).join(" ")} > ${logF} 2>&1; rc=$?; ${exitIt}`;
  // A foreground job is spawned, not spawnSync'd, and then waited on synchronously: spawnSync gives no pid while the child
  // runs, so neither a timeout nor govern kill could find it. It is not detached: it stays in govern's process group, so a
  // terminal's Ctrl-C (or anything else that signals the caller's group) stops it with govern. Its timeout stops its tree.
  // GOVERN_JOB_DIR marks every process the job starts, even one that leaves its tree and group: kill and the timeout find
  // them by it (where /proc shows environments).
  const child = spawn("sh", ["-c", script], { cwd, detached: bg, stdio: "ignore", env: { ...process.env, GOVERN_JOB_ID: id, GOVERN_JOB_DIR: dir } });
  if (!child.pid) { if (reservation) allowances.release(reservation); fail(`${p.slug}: could not start sh for command "${name}"`); }
  // Read before the event loop runs again: the child cannot have been reaped yet, so it is still in the process table.
  const ps = procOf(child.pid!);
  // detached means setsid(): a background child leads a new session and process group whose id is its pid.
  Object.assign(job, { pid: child.pid, ...(bg ? { pgid: child.pid } : {}), ...(ps ? { procStart: ps.start } : {}) });
  writeJson(f, job);
  child.unref();
  if (lock) locks.adopt(lock.dir, lock.id, { pid: child.pid!, ...(ps ? { start: ps.start } : {}) });
  if (reservation && bg) allowances.adopt(reservation, { pid: child.pid!, ...(ps ? { start: ps.start } : {}) });
  if (bg) {
    appendLedger(p.slug, { kind: "job", id, name, bg: true, status: "started", ...(res ? { resource: res.name } : {}) });
    const queued = lock ? queuedOf(job) : undefined;
    return { ...job, status: "running", ...(queued && queued.ahead >= lock!.max ? { queued } : {}) };
  }
  // Waits on the job's own process only: whether someone marked the job stopped is not whether it has stopped.
  const running = () => !readExit(dir) && alive(job);
  for (const end = Date.now() + timeout * 1000; running() && Date.now() < end;) sleepSync(POLL_MS);
  if (running()) {
    // Marked before the signal, as kill does; a kill already under way keeps its reason.
    const cur = readJson<Job>(f);
    writeJson(f, { ...cur, stopped: cur.stopped ?? "timeout" });
    stop(job, dir);
    if (!members(job, dir).size) writeJson(f, { ...readJson<Job>(f), end: nowIso() });
  } else if (readJson<Job>(f).stopped) {
    // A govern kill is stopping it: give that kill its grace, then stop whatever it left.
    for (const end = Date.now() + KILL_GRACE_MS + 1000; state(p.slug, id).status === "running" && Date.now() < end;) sleepSync(POLL_MS);
    if (state(p.slug, id).status === "running") stop(job, dir);
  }
  if (lock) locks.release(lock.dir, lock.id);
  recordEnd(p.slug, id);
  return state(p.slug, id);
}

/** Write the job's one end entry to the ledger, once it has ended: the first of its waiting govern, `govern wait` and
 *  `govern kill` to get here claims it (an exclusive create of <job>/ledgered), and every later call is a no-op. Returns
 *  whether this call wrote it. */
export function recordEnd(slug: string, id: string): boolean {
  const st = state(slug, id);
  if (st.status === "running") return false;
  try { closeSync(openSync(join(jobDir(slug, id), "ledgered"), "wx")); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  const seconds = st.seconds ?? Math.round((Date.now() - Date.parse(st.start)) / 1000);
  const machine = machineOf(st, seconds);
  appendLedger(slug, { kind: "job", id, name: st.name, bg: st.bg, status: st.status, exit: st.exit, seconds, ...machine });
  const used = typeof machine["machineSeconds"] === "number" ? machine["machineSeconds"] : 0;
  allowances.settle(`job:${slug}:${id}`, { hours: used / 3600, ...(typeof machine["cost"] === "number" && typeof machine["currency"] === "string" ? { money: { amount: machine["cost"], currency: machine["currency"] } } : {}) });
  return true;
}

/** Where the job ran and for how long: its resource ("local" when none), the seconds it held it (the wall seconds less
 *  any wait in line; none for a job that never got its slot), and, for a priced resource, the basis, and the money when
 *  that is time-based. */
function machineOf(st: JobState, seconds: number): Record<string, unknown> {
  if (!st.resource) return { resource: "local", machineSeconds: seconds };
  let got: number | undefined;
  try { got = Date.parse(readFileSync(acquiredFile(st.slug, st.id), "utf8").trim()); } catch { got = undefined; }
  const machineSeconds = got === undefined ? 0 : Math.max(0, seconds - Math.round((got - Date.parse(st.start)) / 1000));
  const price = st.price ?? { basis: "free" as const };
  const cost = costOf({ price }, machineSeconds);
  return { resource: st.resource, machineSeconds, basis: price.basis, ...(cost ? { cost: cost.amount, currency: cost.currency } : {}) };
}

export function list(slug: string): string[] {
  const d = jobsDir(slug);
  return existsSync(d) ? readdirSync(d).filter((x) => existsSync(join(d, x, "job.json"))).sort() : [];
}

export function find(slug: string, ref: string | undefined): string {
  const ids = list(slug);
  const last = ids.at(-1);
  if (last === undefined) fail(`${slug}: no jobs yet`);
  if (!ref || ref === "last") return last;
  if (ids.includes(ref)) return ref;
  const hits = ids.filter((i) => i.startsWith(ref));
  const [only, ...others] = hits;
  if (only !== undefined && !others.length) return only;
  const named = hits.length ? undefined : ids.findLast((i) => readJson<Job>(join(jobDir(slug, i), "job.json")).name === ref);
  return named ?? fail(`${slug}: job "${ref}" ${hits.length ? "is ambiguous" : "not found"} (have ${ids.slice(-5).join(", ")})`);
}

/** Whose the job's pid is now: the job's (live), nobody's (gone), a recycled pid (other), or no start time to tell
 *  (unverified). Read from the process table (/proc, or ps without it), where an unreaped zombie counts as gone: a
 *  foreground job's govern never reaps it while it waits, so "the pid exists" would keep a dead job running. */
function owner(job: Job): "live" | "gone" | "other" | "unverified" {
  if (!job.pid) return "gone";
  const s = procOf(job.pid);
  if (!s || exited(s)) return "gone";
  if (!job.procStart) return "unverified";
  return s.start === job.procStart ? "live" : "other";
}
/** The job's process still runs. A job.json without a start time falls back to "the pid runs". */
const alive = (job: Job) => { const o = owner(job); return o === "live" || o === "unverified"; };

/** One reading of the process table: the live processes (zombies left out), and, read once when first asked for, which
 *  job directory each one's environment names. */
interface Snapshot { live: Map<number, ProcStat>; byDir?: Map<string, number[]> }
function snapshot(): Snapshot {
  const live = new Map<number, ProcStat>();
  for (const [pid, s] of procTable()) if (!exited(s)) live.set(pid, s);
  return { live };
}
const ENV_MARK = "GOVERN_JOB_DIR=";
/** The live processes whose environment holds GOVERN_JOB_DIR=<dir>: every process a job starts inherits it, wherever it
 *  goes in the process tree and whatever group or session it moves to. Read from /proc/<pid>/environ (NUL-separated
 *  entries), so only where the process table comes from /proc; an environ govern may not read is skipped. */
function marked(snap: Snapshot, dir: string): number[] {
  if (procSource() !== "proc") return [];
  if (!snap.byDir) {
    snap.byDir = new Map();
    for (const pid of snap.live.keys()) {
      let env: string;
      try { env = readFileSync(`/proc/${pid}/environ`, "latin1"); } catch { continue; }
      const entry = env.split("\0").find((x) => x.startsWith(ENV_MARK));
      if (entry) { const d = Buffer.from(entry.slice(ENV_MARK.length), "latin1").toString("utf8"); snap.byDir.set(d, [...(snap.byDir.get(d) ?? []), pid]); }
    }
  }
  return snap.byDir.get(dir) ?? [];
}

/** The job's live processes, from one snapshot: its own process while it is still the job's (by start time), its process
 *  group's members (a background job; also once its leader is gone, since a group id is not reused while the group has
 *  a member), every process marked with its directory, every process in `known` that is still the same process, and
 *  every descendant of those by parent pid. A job whose pid now belongs to another process, or has no start time to
 *  check, contributes neither its pid nor its group. A job whose stop finished (its end is written, which happens only
 *  once none of its processes was left) has none, without reading the process table: nothing of it can have appeared since. */
function members(job: Job, dir: string, snap?: Snapshot, known: Map<number, string> = new Map()): Map<number, string> {
  const out = new Map<number, string>();
  if (job.end) return out;
  snap ??= snapshot();
  const { live } = snap;
  const add = (pid: number) => { const s = live.get(pid); if (s) out.set(pid, s.start); };
  for (const [pid, start] of known) if (live.get(pid)?.start === start) out.set(pid, start);
  const leader = job.pid ? live.get(job.pid) : undefined;
  const o = !leader ? "gone" : job.procStart && leader.start === job.procStart ? "live" : "other";
  if (o === "live") add(job.pid!);
  if (job.bg && job.pgid && o !== "other") for (const [pid, s] of live) if (s.pgrp === job.pgid) add(pid);
  for (const pid of marked(snap, dir)) add(pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, s] of live) if (!out.has(pid) && out.has(s.ppid)) { out.set(pid, s.start); grew = true; }
  }
  return out;
}
/** Send `sig` to one pid; whether it was sent. A pid that is gone (ESRCH) or not this user's to signal (EPERM) is skipped,
 *  never thrown: a stop goes on to the job's other processes either way. */
export const signal = (pid: number, sig: NodeJS.Signals | 0): boolean => {
  try { process.kill(pid, sig); return true; } catch { return false; }
};
/** This govern and every process it runs under (its parent, theirs, up to init): never signalled, so a job that runs
 *  govern kill (or a timeout's govern inside a job) cannot stop the govern doing the stopping or the job waiting on it. */
function selfAndAncestors(snap: Snapshot): Set<number> {
  const out = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && !out.has(pid); pid = snap.live.get(pid)?.ppid) out.add(pid);
  return out;
}
/** Stop a job: SIGTERM to each of its members, the same to every member that appears during the grace, then SIGKILL to
 *  whatever is left, until nothing is (up to a second more). Each pid is signalled on its own, never a whole group: a
 *  background job's group can hold the govern that is stopping it. This govern and its ancestors are left out. */
function stop(job: Job, dir: string, graceMs = KILL_GRACE_MS): "terminated" | "killed" {
  const first = snapshot(), mine = selfAndAncestors(first);
  const targets = (snap: Snapshot, known?: Map<number, string>) => {
    const m = members(job, dir, snap, known);
    for (const p of mine) m.delete(p);
    return m;
  };
  let m = targets(first);
  for (const p of m.keys()) signal(p, "SIGTERM");
  for (const end = Date.now() + graceMs; m.size && Date.now() < end;) {
    sleepSync(POLL_MS);
    const now = targets(snapshot(), m);
    for (const p of now.keys()) if (!m.has(p)) signal(p, "SIGTERM");
    m = now;
  }
  if (!m.size) return "terminated";
  for (const end = Date.now() + 1000; m.size && Date.now() < end; m = targets(snapshot(), m)) {
    for (const p of m.keys()) signal(p, "SIGKILL");
    sleepSync(POLL_MS);
  }
  return "killed";
}

/** The job's exit code and when it was written, once its exit file holds one. The script renames it into place, but an exit
 *  file that is empty or not an integer (an older govern's, or one cut short) is still read as not yet written. */
function readExit(dir: string): { code: number; mtimeMs: number } | undefined {
  const f = join(dir, "exit");
  try {
    const t = readFileSync(f, "utf8").trim();
    return /^\d+$/.test(t) ? { code: Number(t), mtimeMs: statSync(f).mtimeMs } : undefined;
  } catch { return undefined; }
}

/** How the job stands. `stopped` records that govern set out to stop it, not that it has stopped: while any of its
 *  processes still runs, it is running. A complete exit file is how the job ended, unless govern stopped it and the code is
 *  a signal's (128 and up): then it ended by govern's stop, and reads as that ("timeout", "killed"). */
export function state(slug: string, id: string): JobState {
  const dir = jobDir(slug, id);
  const job = readJson<Job>(join(dir, "job.json"));
  const ex = readExit(dir);
  const ended = job.end ? Date.parse(job.end) : ex?.mtimeMs;
  const took = ended != null ? { seconds: Math.round((ended - Date.parse(job.start)) / 1000) } : {};
  const byExit = ex ? { status: ex.code === 0 ? "ok" as const : "failed" as const, exit: ex.code, ...took } : undefined;
  if (job.stopped) {
    if (members(job, dir).size) return { ...job, status: "running" };
    if (byExit && ex!.code < 128) return { ...job, ...byExit };
    return { ...job, status: job.stopped, ...(ex ? { exit: ex.code } : {}), ...took };
  }
  if (byExit) return { ...job, ...byExit };
  // A foreground job runs while its govern waits on it (a check, or another session's govern run).
  return { ...job, status: alive(job) ? "running" : job.bg ? "lost" : "failed" };
}

/** Stop a lane's job (default: its latest one with a live process) and everything it started: its tree, its group (a
 *  background job) and every process marked with its directory. The job's own pid is signalled only while it is still
 *  that job (by its start time). */
export function kill(slug: string, ref?: string): { id: string; outcome: KillOutcome } {
  const snap = snapshot();
  const id = ref ? find(slug, ref) : [...list(slug)].reverse()
    .find((i) => state(slug, i).status === "running" || members(readJson<Job>(join(jobDir(slug, i), "job.json")), jobDir(slug, i), snap).size)
    ?? fail(`${slug}: no running job (govern jobs ${slug})`);
  const dir = jobDir(slug, id), f = join(dir, "job.json");
  const job = readJson<Job>(f);
  const record = (outcome: KillOutcome) => appendLedger(slug, { kind: "kill", job: id, outcome });
  if (!members(job, dir, snap).size) {
    const who = readExit(dir) ? "gone" : owner(job);
    if (who === "other" || who === "unverified") {
      record("not-owned");
      return fail(who === "other"
        ? `job ${id}: pid ${job.pid} now belongs to another process: not signalling it (the job is gone)`
        : `job ${id}: no start time recorded: cannot verify pid ${job.pid} is still this job, not signalling it (stop it by hand if you are sure: kill -TERM ${job.bg ? "-" : ""}${job.pgid ?? job.pid})`);
    }
    record("already-exited");
    recordEnd(slug, id);
    return { id, outcome: "already-exited" };
  }
  // Marked before the signal: a govern waiting on a foreground job reads it as soon as the job dies. A stop already under
  // way (a timeout, an earlier kill) keeps its reason.
  const cur = readJson<Job>(f);
  writeJson(f, { ...cur, stopped: cur.stopped ?? "killed" });
  const outcome = stop(job, dir);
  if (!members(job, dir).size) writeJson(f, { ...readJson<Job>(f), end: nowIso() });
  record(outcome);
  // The job's end goes into the ledger once, by whichever govern gets there first: its waiting govern (gone, if it died),
  // a govern wait, or this kill.
  recordEnd(slug, id);
  return { id, outcome };
}

/** How a finished job ended, for check and status lines: "exit 1", "timed out after 60s", "killed". */
export const ending = (st: JobState): string =>
  st.status === "timeout" ? `timed out after ${st.timeout ?? DEFAULT_TIMEOUT}s` : st.status === "killed" ? "killed by govern kill"
    : st.exit != null ? `exit ${st.exit}` : "no exit code";

/** Last n meaningful log lines: progress-bar carriage returns collapsed, long lines clipped. */
export function tail(slug: string, id: string, n = 12, grep?: string): string[] {
  const f = join(jobsDir(slug), id, "log");
  if (!existsSync(f)) return [];
  const size = statSync(f).size, want = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(want);
  const fd = openSync(f, "r");
  try { readSync(fd, buf, 0, want, size - want); } finally { closeSync(fd); }
  let lines = buf.toString("utf8").split("\n").map((l) => l.split("\r").filter(Boolean).pop() ?? "").map((l) => l.trimEnd()).filter(Boolean);
  if (grep) { const re = new RegExp(grep, "i"); lines = lines.filter((l) => re.test(l)); }
  return lines.slice(-n).map((l) => clip(l, 220));
}

/** Block until the job ends or timeout; no model is involved while waiting. */
export function wait(slug: string, id: string, timeoutSec: number, pollMs = 2000): JobState & { timedOut: boolean } {
  const end = Date.now() + timeoutSec * 1000;
  for (;;) {
    const st = state(slug, id);
    if (st.status !== "running") return { ...st, timedOut: false };
    if (Date.now() >= end) return { ...st, timedOut: true };
    sleepSync(Math.min(pollMs, Math.max(50, end - Date.now())));
  }
}

export function summary(p: Project, st: JobState, n = 12): string {
  // A stopped job's line says how once ("timed out after 60s", "killed by govern kill"), not its status and then again.
  const stopped = st.status === "timeout" || st.status === "killed";
  const how = `${stopped ? ending(st) : st.status}${st.exit != null ? ` (exit ${st.exit})` : ""}`;
  const L = [`job ${st.id} · ${how}${st.seconds != null ? ` · ${st.seconds}s` : ""}`];
  if (st.status !== "running") {
    // File mtimes come from the kernel's coarse clock (one tick, a few ms), which can read slightly before the
    // Date.now() taken at start: a file the job wrote can look older than the job. One second of slack covers it.
    const t0 = Date.parse(st.start) - 1000;
    const outs = Object.entries(p.files).flatMap(([k, pat]) => changedSince(projectDir(p.slug), pat, t0).map((f) => `${k}: ${f.replace(repo() + "/", "")}`));
    if (outs.length) L.push(`new files: ${outs.slice(0, 8).join(" · ")}${outs.length > 8 ? ` (+${outs.length - 8})` : ""}`);
  }
  const t = tail(p.slug, st.id, n);
  if (t.length) L.push(`log (last ${t.length}, full: govern log ${p.slug} ${st.id}):`, ...t.map((l) => `  ${l}`));
  return L.join("\n");
}
