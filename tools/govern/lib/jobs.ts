// Jobs: run a project command in the foreground or detached, wait on it without a model in the loop, stop it by identity.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, openSync, closeSync, statSync, readSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, readJson, writeJson, stamp, nowIso, sleepSync, shq, changedSince, clip, procOf, procTable, procSource, exited, type ProcStat } from "./util.ts";
import { type Project, projectDir, governDir, appendLedger, argvOf, REPO } from "./project.ts";

/** pid and procStart (its start time in the process table: /proc field 22, or ps lstart) identify the job's process, so a recycled pid is never taken for it.
 *  pgid: a background job leads its own process group; a foreground job stays in its caller's, so Ctrl-C reaches it. timeout: a foreground job's limit (s). stopped/end: govern stopped it. */
export interface Job {
  id: string; slug: string; name: string; argv: string[]; cwd: string; start: string; pid?: number; pgid?: number; procStart?: string; bg: boolean;
  timeout?: number; stopped?: "timeout" | "killed"; end?: string;
}
export interface JobState extends Job { status: "running" | "ok" | "failed" | "lost" | "timeout" | "killed"; exit?: number; seconds?: number }
/** What `govern kill` did: the group exited on SIGTERM, needed SIGKILL, had already exited, or the pid is not provably the job's. */
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
  return argv.map((a) => a.replaceAll("{repo}", REPO).replaceAll("{dir}", projectDir(p.slug)).replaceAll("{python}", python));
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

export function start(p: Project, name: string, extra: string[], bg: boolean): JobState {
  const base = p.commands[name];
  if (!base) fail(`${p.slug}: no command "${name}" (have: ${Object.keys(p.commands).join(", ") || "none"}; add with govern cmd ${p.slug} ${name} -- <argv>)`);
  const argv = expand(p, [...argvOf(base), ...extra]);
  const id = claim(p.slug, name);
  const dir = jobDir(p.slug, id);
  const f = join(dir, "job.json"), exitF = join(dir, "exit");
  const cwd = projectDir(p.slug);
  const timeout = (Array.isArray(base) ? undefined : base.timeout) ?? DEFAULT_TIMEOUT;
  const job: Job = { id, slug: p.slug, name, argv, cwd, start: nowIso(), bg, ...(bg ? {} : { timeout }) };
  writeJson(f, job);
  // The exit code goes to exit.tmp and is renamed to exit: a poller never sees an exit file that exists but is not yet written.
  const script = `${argv.map(shq).join(" ")} > ${shq(join(dir, "log"))} 2>&1; echo $? > ${shq(exitF)}.tmp && mv -f ${shq(exitF)}.tmp ${shq(exitF)}`;
  // A foreground job is spawned, not spawnSync'd, and then waited on synchronously: spawnSync gives no pid while the child
  // runs, so neither a timeout nor govern kill could find it. It is not detached: it stays in govern's process group, so a
  // terminal's Ctrl-C (or anything else that signals the caller's group) stops it with govern. Its timeout stops its tree.
  // GOVERN_JOB_DIR marks every process the job starts, even one that leaves its tree and group: kill and the timeout find
  // them by it (where /proc shows environments).
  const child = spawn("sh", ["-c", script], { cwd, detached: bg, stdio: "ignore", env: { ...process.env, GOVERN_JOB_ID: id, GOVERN_JOB_DIR: dir } });
  if (!child.pid) fail(`${p.slug}: could not start sh for command "${name}"`);
  // Read before the event loop runs again: the child cannot have been reaped yet, so it is still in the process table.
  const ps = procOf(child.pid!);
  // detached means setsid(): a background child leads a new session and process group whose id is its pid.
  Object.assign(job, { pid: child.pid, ...(bg ? { pgid: child.pid } : {}), ...(ps ? { procStart: ps.start } : {}) });
  writeJson(f, job);
  child.unref();
  if (bg) {
    appendLedger(p.slug, { kind: "job", id, name, bg: true, status: "started" });
    return { ...job, status: "running" };
  }
  const running = () => !readExit(dir) && alive(job) && !readJson<Job>(f).stopped;
  for (const end = Date.now() + timeout * 1000; running() && Date.now() < end;) sleepSync(POLL_MS);
  if (running()) { stop(job, dir); writeJson(f, { ...readJson<Job>(f), stopped: "timeout", end: nowIso() }); }
  const st = state(p.slug, id);
  appendLedger(p.slug, { kind: "job", id, name, bg: false, status: st.status, exit: st.exit, seconds: st.seconds });
  return st;
}

export function list(slug: string): string[] {
  const d = jobsDir(slug);
  return existsSync(d) ? readdirSync(d).filter((x) => existsSync(join(d, x, "job.json"))).sort() : [];
}

export function find(slug: string, ref: string | undefined): string {
  const ids = list(slug);
  if (!ids.length) fail(`${slug}: no jobs yet`);
  if (!ref || ref === "last") return ids[ids.length - 1];
  const hits = ids.filter((i) => i === ref || i.startsWith(ref) || i.endsWith(ref));
  if (hits.length !== 1) fail(`${slug}: job "${ref}" ${hits.length ? "is ambiguous" : "not found"} (have ${ids.slice(-5).join(", ")})`);
  return hits[0];
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
 *  check, contributes neither its pid nor its group. */
function members(job: Job, dir: string, snap = snapshot(), known: Map<number, string> = new Map()): Map<number, string> {
  const { live } = snap, out = new Map<number, string>();
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
const signalPid = (pid: number, sig: NodeJS.Signals) => {
  try { process.kill(pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
};
/** Stop a job: SIGTERM to each of its members, the same to every member that appears during the grace, then SIGKILL to
 *  whatever is left, until nothing is (up to a second more). Each pid is signalled on its own, never a whole group: a
 *  background job's group can hold the govern that is stopping it. */
function stop(job: Job, dir: string, graceMs = KILL_GRACE_MS): "terminated" | "killed" {
  let m = members(job, dir);
  for (const p of m.keys()) signalPid(p, "SIGTERM");
  for (const end = Date.now() + graceMs; m.size && Date.now() < end;) {
    sleepSync(POLL_MS);
    const now = members(job, dir, snapshot(), m);
    for (const p of now.keys()) if (!m.has(p)) signalPid(p, "SIGTERM");
    m = now;
  }
  if (!m.size) return "terminated";
  for (const end = Date.now() + 1000; m.size && Date.now() < end; m = members(job, dir, snapshot(), m)) {
    for (const p of m.keys()) signalPid(p, "SIGKILL");
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

export function state(slug: string, id: string): JobState {
  const dir = join(jobsDir(slug), id);
  const job = readJson<Job>(join(dir, "job.json"));
  if (job.stopped) {
    const seconds = job.end ? Math.round((Date.parse(job.end) - Date.parse(job.start)) / 1000) : undefined;
    return { ...job, status: job.stopped, ...(seconds != null ? { seconds } : {}) };
  }
  const ex = readExit(dir);
  if (ex) return { ...job, status: ex.code === 0 ? "ok" : "failed", exit: ex.code, seconds: Math.round((ex.mtimeMs - Date.parse(job.start)) / 1000) };
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
    return { id, outcome: "already-exited" };
  }
  // Marked before the signal: a govern waiting on a foreground job reads it as soon as the job dies.
  writeJson(f, { ...readJson<Job>(f), stopped: "killed" });
  const outcome = stop(job, dir);
  const end = nowIso();
  writeJson(f, { ...readJson<Job>(f), end });
  record(outcome);
  // A foreground job's own govern, waiting on it, records how it ended; a background job has no one else to.
  if (job.bg) appendLedger(slug, { kind: "job", id, name: job.name, bg: true, status: "killed", seconds: Math.round((Date.parse(end) - Date.parse(job.start)) / 1000) });
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
  const how = st.status === "timeout" || st.status === "killed" ? ` (${ending(st)})` : st.exit != null ? ` (exit ${st.exit})` : "";
  const L = [`job ${st.id} · ${st.status}${how}${st.seconds != null ? ` · ${st.seconds}s` : ""}`];
  if (st.status !== "running") {
    // File mtimes come from the kernel's coarse clock (one tick, a few ms), which can read slightly before the
    // Date.now() taken at start: a file the job wrote can look older than the job. One second of slack covers it.
    const t0 = Date.parse(st.start) - 1000;
    const outs = Object.entries(p.files).flatMap(([k, pat]) => changedSince(projectDir(p.slug), pat, t0).map((f) => `${k}: ${f.replace(REPO + "/", "")}`));
    if (outs.length) L.push(`new files: ${outs.slice(0, 8).join(" · ")}${outs.length > 8 ? ` (+${outs.length - 8})` : ""}`);
  }
  const t = tail(p.slug, st.id, n);
  if (t.length) L.push(`log (last ${t.length}, full: govern log ${p.slug} ${st.id}):`, ...t.map((l) => `  ${l}`));
  return L.join("\n");
}
