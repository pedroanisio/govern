// Small helpers shared by the govern modules: errors, args, files, time.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, globSync } from "node:fs";
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
