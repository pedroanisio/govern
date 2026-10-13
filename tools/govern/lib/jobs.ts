// Jobs: run a project command in the foreground or detached, wait on it without a model in the loop, stop it by identity.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, openSync, closeSync, statSync, readSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fail, readJson, writeJson, stamp, nowIso, sleepSync, shq, changedSince, clip, procStat, hasProc, exited } from "./util.ts";
import { type Project, projectDir, governDir, appendLedger, argvOf, REPO } from "./project.ts";

/** pid, pgid (the job leads its own process group) and procStart (field 22 of /proc/<pid>/stat) identify the job's
 *  process, so a recycled pid is never taken for it. timeout: a foreground job's limit (s). stopped/end: govern stopped it. */
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

const jobsDir = (slug: string) => join(governDir(slug), "jobs");

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
  const dir = join(jobsDir(p.slug), id);
  const f = join(dir, "job.json"), exitF = join(dir, "exit");
  const cwd = projectDir(p.slug);
  const timeout = (Array.isArray(base) ? undefined : base.timeout) ?? DEFAULT_TIMEOUT;
  const job: Job = { id, slug: p.slug, name, argv, cwd, start: nowIso(), bg, ...(bg ? {} : { timeout }) };
  writeJson(f, job);
  const script = `${argv.map(shq).join(" ")} > ${shq(join(dir, "log"))} 2>&1; echo $? > ${shq(exitF)}`;
  // Foreground jobs are detached too and then waited on synchronously: spawnSync can neither make the child a process-group
  // leader (so a timeout reaches its grandchildren) nor give its pid while it runs (so govern kill can find it).
  const child = spawn("sh", ["-c", script], { cwd, detached: true, stdio: "ignore", env: { ...process.env, GOVERN_JOB_ID: id } });
  if (!child.pid) fail(`${p.slug}: could not start sh for command "${name}"`);
  // Read before the event loop runs again: the child cannot have been reaped yet, so its /proc entry is still there.
  const ps = procStat(child.pid!);
  // detached means setsid(): the child leads a new session and process group whose id is its pid.
  Object.assign(job, { pid: child.pid, pgid: child.pid, ...(ps ? { procStart: ps.start } : {}) });
  writeJson(f, job);
  child.unref();
  if (bg) {
    appendLedger(p.slug, { kind: "job", id, name, bg: true, status: "started" });
    return { ...job, status: "running" };
  }
  const running = () => !existsSync(exitF) && alive(job) && !readJson<Job>(f).stopped;
  for (const end = Date.now() + timeout * 1000; running() && Date.now() < end;) sleepSync(POLL_MS);
  if (running()) { stopGroup(job.pgid!); writeJson(f, { ...readJson<Job>(f), stopped: "timeout", end: nowIso() }); }
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

const signal0 = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Whose the job's pid is now: the job's (live), nobody's (gone), a recycled pid (other), or no start time to tell (unverified). */
function owner(job: Job): "live" | "gone" | "other" | "unverified" {
  if (!job.pid) return "gone";
  if (!hasProc()) return signal0(job.pid) ? "unverified" : "gone";
  const s = procStat(job.pid);
  if (!s || exited(s)) return "gone";
  if (!job.procStart) return "unverified";
  return s.start === job.procStart ? "live" : "other";
}
/** The job's process still runs. A job.json without a start time (or no /proc) falls back to "the pid exists". */
const alive = (job: Job) => { const o = owner(job); return o === "live" || o === "unverified"; };

/** Some process of the group still runs (zombies left for govern to reap do not count). */
function groupLive(pgid: number): boolean {
  if (!hasProc()) return signal0(-pgid);
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const s = procStat(Number(d));
    if (s && s.pgrp === pgid && !exited(s)) return true;
  }
  return false;
}
const signalGroup = (pgid: number, sig: NodeJS.Signals) => {
  try { process.kill(-pgid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
};
/** SIGTERM to the whole group, then SIGKILL if anything of it outlives the grace. Called only after owner() said live: the
 *  leader is govern's own unreaped child or a verified process, so its group id cannot belong to anyone else. */
function stopGroup(pgid: number, graceMs = KILL_GRACE_MS): "terminated" | "killed" {
  signalGroup(pgid, "SIGTERM");
  for (const end = Date.now() + graceMs; Date.now() < end; sleepSync(POLL_MS)) if (!groupLive(pgid)) return "terminated";
  if (!groupLive(pgid)) return "terminated";
  signalGroup(pgid, "SIGKILL");
  return "killed";
}

export function state(slug: string, id: string): JobState {
  const dir = join(jobsDir(slug), id);
  const job = readJson<Job>(join(dir, "job.json"));
  if (job.stopped) {
    const seconds = job.end ? Math.round((Date.parse(job.end) - Date.parse(job.start)) / 1000) : undefined;
    return { ...job, status: job.stopped, ...(seconds != null ? { seconds } : {}) };
  }
  const exitF = join(dir, "exit");
  if (existsSync(exitF)) {
    const exit = Number(readFileSync(exitF, "utf8").trim());
    const seconds = Math.round((statSync(exitF).mtimeMs - Date.parse(job.start)) / 1000);
    return { ...job, status: exit === 0 ? "ok" : "failed", exit, seconds };
  }
  // A foreground job runs while its govern waits on it (a check, or another session's govern run).
  return { ...job, status: alive(job) ? "running" : job.bg ? "lost" : "failed" };
}

/** Stop a lane's job (default: its latest running one) by process group, after checking the pid is still the job's. */
export function kill(slug: string, ref?: string): { id: string; outcome: KillOutcome } {
  const ids = list(slug);
  const id = ref ? find(slug, ref) : [...ids].reverse().find((i) => state(slug, i).status === "running")
    ?? fail(`${slug}: no running job (govern jobs ${slug})`);
  const f = join(jobsDir(slug), id, "job.json");
  const job = readJson<Job>(f);
  const who = job.stopped || existsSync(join(jobsDir(slug), id, "exit")) ? "gone" : owner(job);
  const record = (outcome: KillOutcome) => appendLedger(slug, { kind: "kill", job: id, outcome });
  if (who === "gone") { record("already-exited"); return { id, outcome: "already-exited" }; }
  if (who !== "live") {
    record("not-owned");
    return fail(who === "other"
      ? `job ${id}: pid ${job.pid} now belongs to another process: not signalling it (the job is gone)`
      : `job ${id}: ${hasProc() ? "no start time recorded" : "no /proc to read start times from"}: cannot verify pid ${job.pid} is still this job, not signalling it (stop it by hand if you are sure: kill -TERM -${job.pgid ?? job.pid})`);
  }
  const outcome = stopGroup(job.pgid ?? job.pid!);
  const end = nowIso();
  writeJson(f, { ...readJson<Job>(f), stopped: "killed", end });
  record(outcome);
  appendLedger(slug, { kind: "job", id, name: job.name, bg: job.bg, status: "killed", seconds: Math.round((Date.parse(end) - Date.parse(job.start)) / 1000) });
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
