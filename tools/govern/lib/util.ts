// Small helpers shared by the govern modules: errors, args, files, time.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, globSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

/** The hex sha256 of a text (hashed as UTF-8) or of bytes. */
export const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

export class GovernError extends Error {
  code: number;
  constructor(message: string, code = 2) { super(message); this.code = code; }
}
export const fail = (msg: string, code = 2): never => { throw new GovernError(msg, code); };

/** The flags a command takes: switches (`--k`, `--k=true|false`), value flags (`--k V`, `--k=V`; the last one wins)
 *  and repeatable value flags (every occurrence kept). A flag outside the spec is a usage error. */
export interface FlagSpec { bool?: readonly string[]; value?: readonly string[]; multi?: readonly string[] }
export interface Args { _: string[]; opts: Record<string, string | boolean>; multi: Record<string, string[]>; spec: FlagSpec; label: string }

/** The flags of a spec in declaration order (value, multi, then switches), as `--a, --b`, or "" for none. */
export const flagNames = (spec: FlagSpec) => [...(spec.value ?? []), ...(spec.multi ?? []), ...(spec.bool ?? [])].map((f) => `--${f}`).join(", ");

/** A word that reads as a long flag: it cannot be the value of the flag before it (give that one as --k=VALUE). */
const looksLikeFlag = (s: string) => /^--[A-Za-z]/.test(s);

/** Parse argv against `spec`: positionals, `--k v`, `--k=v`, switches, repeatable flags, and `--` (rest kept raw).
 *  `label` names the command in every error. An unknown flag, a switch given a value other than true/false, and a
 *  value flag without its value are usage errors (GovernError, exit 2) naming the flag and the valid ones. */
export function parseArgs(argv: string[], spec: FlagSpec, label: string): Args {
  const bool = new Set(spec.bool ?? []), value = new Set(spec.value ?? []), multi = new Set(spec.multi ?? []);
  const out: Args = { _: [], opts: {}, multi: {}, spec, label };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (bool.has(k)) {
      if (v !== undefined && v !== "true" && v !== "false") fail(`${label}: --${k} is a switch: it takes no value (got ${JSON.stringify(v)})`);
      out.opts[k] = v !== "false";
      continue;
    }
    if (!value.has(k) && !multi.has(k)) {
      const valid = flagNames(spec);
      fail(`${label}: unknown flag ${k ? `--${k}` : a} ${valid ? `(valid: ${valid})` : "(takes no flags)"}`);
    }
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined || v === "--" || looksLikeFlag(v)) fail(`${label}: --${k} needs a value (give --${k}=VALUE when the value starts with --)`);
    }
    if (multi.has(k)) (out.multi[k] ??= []).push(v);
    else out.opts[k] = v;
  }
  return out;
}

/** Reading a flag the command did not declare (or declared as another kind) is a bug in govern, not a usage error. */
function declared(a: Args, k: string, kind: keyof FlagSpec, what: string): void {
  if (!(a.spec[kind] ?? []).includes(k)) throw new Error(`${a.label} reads --${k} as ${what}, but it is not declared as one`);
}
/** A value flag's value, or undefined when not given. */
export const opt = (a: Args, k: string): string | undefined => { declared(a, k, "value", "a value flag"); return a.opts[k] as string | undefined; };
/** Whether a switch is on. */
export const flag = (a: Args, k: string): boolean => { declared(a, k, "bool", "a switch"); return a.opts[k] === true; };
/** Every value of a repeatable flag, in order. */
export const many = (a: Args, k: string): string[] => { declared(a, k, "multi", "a repeatable flag"); return a.multi[k] ?? []; };
/** A `--<k>` count of seconds: digits only, 1 or more, no sign, fraction, exponent or padding. Undefined when not given. */
export function secondsOpt(a: Args, k: string): number | undefined {
  const v = opt(a, k);
  if (v === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(v)) fail(`--${k} must be a whole number of seconds, 1 or more: ${JSON.stringify(v)}`);
  return Number(v);
}

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
