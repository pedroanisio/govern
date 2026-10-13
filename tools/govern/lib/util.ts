// Small helpers shared by the govern modules: errors, args, files, time.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, globSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";

export class GovernError extends Error {
  code: number;
  constructor(message: string, code = 2) { super(message); this.code = code; }
}
export const fail = (msg: string, code = 2): never => { throw new GovernError(msg, code); };

export interface Args { _: string[]; opts: Record<string, string | boolean>; multi: Record<string, string[]> }

/** Parse argv: positionals, `--k v`, `--k=v`, boolean flags, repeatable flags, and `--` (rest kept raw). */
export function parseArgs(argv: string[], spec: { bool?: string[]; multi?: string[] } = {}): Args {
  const bool = new Set(spec.bool ?? []), multi = new Set(spec.multi ?? []);
  const out: Args = { _: [], opts: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--") || a === "-") { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (bool.has(k)) { out.opts[k] = v === undefined ? true : v !== "false"; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) fail(`--${k} needs a value`); }
    if (multi.has(k)) (out.multi[k] ??= []).push(v);
    else out.opts[k] = v;
  }
  return out;
}
export const opt = (a: Args, k: string): string | undefined => (typeof a.opts[k] === "string" ? (a.opts[k] as string) : undefined);

export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
export function writeJson(p: string, v: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  renameSync(tmp, p);
}
export const readJsonl = (p: string): any[] =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];

export const nowIso = () => new Date().toISOString();
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A process as the process table shows it: state, parent, process group, and a start time that tells a recycled pid
 *  from the process that had it. From /proc/<pid>/stat: fields 3, 4, 5 and 22 (ticks after boot); from ps: stat, ppid,
 *  pgid and lstart (its text, in the C locale and UTC). A start time is only ever compared with one from the same source. */
export interface ProcStat { state: string; ppid: number; pgrp: number; start: string }
/** Parse the text of /proc/<pid>/stat. comm (field 2) may hold spaces and parentheses: fields count from the last ")". */
export function parseStat(stat: string): ProcStat | undefined {
  const i = stat.lastIndexOf(")");
  const f = i < 0 ? [] : stat.slice(i + 1).trim().split(/\s+/);
  return f.length >= 20 && /^\d+$/.test(f[19]) ? { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), start: f[19] } : undefined;
}
/** Whether this system has /proc to read process identities from. */
export const hasProc = () => existsSync("/proc/self/stat");
/** /proc/<pid>/stat parsed, or undefined when the pid does not exist (or there is no /proc). */
export function procStat(pid: number): ProcStat | undefined {
  try { return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return undefined; }
}
/** Where the jobs code reads the process table from: /proc where it exists, ps elsewhere (macOS, the BSDs).
 *  GOVERN_PROC=ps forces ps where /proc exists: a test and diagnostic knob, so the ps path runs on Linux too. */
export const procSource = (): "proc" | "ps" => (process.env.GOVERN_PROC === "ps" || !hasProc() ? "ps" : "proc");
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
/** ps's view of the given pids (all processes when none are given), keyed by pid. */
function psTable(pids?: number[]): Map<number, ProcStat> {
  const sel = pids ? ["-p", pids.join(",")] : ["-A"];
  const r = spawnSync("ps", [...sel, "-o", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  // ps -p exits 1 when none of the pids exists; any other failure is ps not working, which nothing here may guess past
  if (r.error || (r.status !== 0 && !(pids && r.status === 1 && !r.stdout.trim()))) fail(`cannot read the process table: ps ${r.error?.message ?? `exited ${r.status}: ${r.stderr.trim()}`}`);
  const out = new Map<number, ProcStat>();
  for (const line of r.stdout.split("\n")) {
    const m = PS_LINE.exec(line);
    if (m) out.set(Number(m[1]), { state: m[4][0], ppid: Number(m[2]), pgrp: Number(m[3]), start: m[5] });
  }
  return out;
}
/** Every process on the system, keyed by pid, from the one source procSource() names. Zombies are included (state Z). */
export function procTable(): Map<number, ProcStat> {
  if (procSource() === "ps") return psTable();
  const out = new Map<number, ProcStat>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const s = procStat(Number(d));
    if (s) out.set(Number(d), s);
  }
  return out;
}
/** One process, from the same source as procTable(); undefined when the pid does not exist. */
export const procOf = (pid: number): ProcStat | undefined => (procSource() === "ps" ? psTable([pid]).get(pid) : procStat(pid));
/** A zombie (exited, not yet reaped) or dead process no longer runs anything. */
export const exited = (s: ProcStat) => s.state === "Z" || s.state === "X";

/** Single-quote for sh. */
export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Newest file matching a glob (relative to dir), or undefined. */
export function latest(dir: string, pattern: string): string | undefined {
  let best: string | undefined, bestT = -1;
  for (const rel of globSync(pattern, { cwd: dir })) {
    const p = isAbsolute(rel) ? rel : join(dir, rel);
    try { const s = statSync(p); if (s.isFile() && s.mtimeMs > bestT) { best = p; bestT = s.mtimeMs; } } catch { /* vanished */ }
  }
  return best;
}
/** Files matching a glob changed after t (ms). */
export function changedSince(dir: string, pattern: string, t: number): string[] {
  return globSync(pattern, { cwd: dir }).map((r) => (isAbsolute(r) ? r : join(dir, r)))
    .filter((p) => { try { const s = statSync(p); return s.isFile() && s.mtimeMs >= t; } catch { return false; } });
}

/** Markdown links to their text, collapse whitespace. */
export const plain = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "").replace(/\s+/g, " ").trim();
export const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
