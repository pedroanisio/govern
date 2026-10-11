// Jobs: run a project command in the foreground or detached, and wait on it without a model in the loop.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, openSync, closeSync, statSync, readSync } from "node:fs";
import { join } from "node:path";
import { fail, readJson, writeJson, stamp, nowIso, sleepSync, shq, changedSince, clip } from "./util.ts";
import { type Project, projectDir, governDir, appendLedger, REPO } from "./project.ts";

export interface Job { id: string; slug: string; name: string; argv: string[]; cwd: string; start: string; pid?: number; bg: boolean }
export interface JobState extends Job { status: "running" | "ok" | "failed" | "lost"; exit?: number; seconds?: number }

const jobsDir = (slug: string) => join(governDir(slug), "jobs");

export function expand(p: Project, argv: string[]): string[] {
  const python = process.env.GOVERN_PYTHON ?? "python3";
  return argv.map((a) => a.replaceAll("{repo}", REPO).replaceAll("{dir}", projectDir(p.slug)).replaceAll("{python}", python));
}

export function start(p: Project, name: string, extra: string[], bg: boolean): JobState {
  const base = p.commands[name];
  if (!base) fail(`${p.slug}: no command "${name}" (have: ${Object.keys(p.commands).join(", ") || "none"}; add with govern cmd ${p.slug} ${name} -- <argv>)`);
  const argv = expand(p, [...base, ...extra]);
  const id = `${stamp()}-${name}`;
  const dir = join(jobsDir(p.slug), id);
  const cwd = projectDir(p.slug);
  const job: Job = { id, slug: p.slug, name, argv, cwd, start: nowIso(), bg };
  writeJson(join(dir, "job.json"), job);
  const script = `${argv.map(shq).join(" ")} > ${shq(join(dir, "log"))} 2>&1; echo $? > ${shq(join(dir, "exit"))}`;
  if (bg) {
    const child = spawn("sh", ["-c", script], { cwd, detached: true, stdio: "ignore" });
    job.pid = child.pid;
    child.unref();
    writeJson(join(dir, "job.json"), job);
    appendLedger(p.slug, { kind: "job", id, name, bg: true, status: "started" });
    return { ...job, status: "running" };
  }
  spawnSync("sh", ["-c", script], { cwd, stdio: "ignore" });
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

const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export function state(slug: string, id: string): JobState {
  const dir = join(jobsDir(slug), id);
  const job = readJson<Job>(join(dir, "job.json"));
  const exitF = join(dir, "exit");
  if (existsSync(exitF)) {
    const exit = Number(readFileSync(exitF, "utf8").trim());
    const seconds = Math.round((statSync(exitF).mtimeMs - Date.parse(job.start)) / 1000);
    return { ...job, status: exit === 0 ? "ok" : "failed", exit, seconds };
  }
  return { ...job, status: job.bg && alive(job.pid) ? "running" : job.bg ? "lost" : "failed" };
}

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
  const L = [`job ${st.id} · ${st.status}${st.exit != null ? ` (exit ${st.exit})` : ""}${st.seconds != null ? ` · ${st.seconds}s` : ""}`];
  if (st.status !== "running") {
    const t0 = Date.parse(st.start);
    const outs = Object.entries(p.files).flatMap(([k, pat]) => changedSince(projectDir(p.slug), pat, t0).map((f) => `${k}: ${f.replace(REPO + "/", "")}`));
    if (outs.length) L.push(`new files: ${outs.slice(0, 8).join(" · ")}${outs.length > 8 ? ` (+${outs.length - 8})` : ""}`);
  }
  const t = tail(p.slug, st.id, n);
  if (t.length) L.push(`log (last ${t.length}, full: govern log ${p.slug} ${st.id}):`, ...t.map((l) => `  ${l}`));
  return L.join("\n");
}
