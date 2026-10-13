// The Claude Code session registry (~/.claude/sessions/<pid>.json): who is alive, and who the caller is.
// Only pid, name, cwd, kind, status and procStart are read. The directory also holds *.key files: never opened, never printed.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, procStat, hasProc, exited } from "./util.ts";

/** procStart: the session process's start time as Claude Code recorded it (field 22 of /proc/<pid>/stat). */
export interface Session { pid: number; name: string; cwd?: string; kind?: string; status?: string; procStart?: string }

export const SESSIONS_DIR = () => process.env.GOVERN_SESSIONS_DIR ?? join(homedir(), ".claude", "sessions");

/** The pid runs and, when a start time is recorded and /proc can tell, it is the same process (not a recycled pid). */
export function isAlive(pid: number, procStart?: string): boolean {
  if (procStart && hasProc()) { const s = procStat(pid); return !!s && !exited(s) && s.start === procStart; }
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Every named session in the registry, live or not. Unreadable or malformed files are skipped. */
export function sessions(dir = SESSIONS_DIR()): Session[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out: Session[] = [];
  for (const f of files) {
    try {
      const o = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (Number.isInteger(o?.pid) && typeof o.name === "string" && o.name)
        out.push({ pid: o.pid, name: o.name, cwd: o.cwd, kind: o.kind, status: o.status, ...(typeof o.procStart === "string" ? { procStart: o.procStart } : {}) });
    } catch { /* not a session file */ }
  }
  return out;
}
export const liveSessions = (dir = SESSIONS_DIR()): Session[] => sessions(dir).filter((s) => isAlive(s.pid, s.procStart));

/** Parent pid from the text of /proc/<pid>/stat: "pid (comm) S ppid …", comm may hold parentheses. */
export function parsePpid(stat: string): number | undefined {
  const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const n = Number(rest[1]);
  return stat.includes(")") && Number.isInteger(n) ? n : undefined;
}
/** start, its parent, its grandparent… up to init. */
export function pidChain(start = process.pid, stat = (p: number) => readFileSync(`/proc/${p}/stat`, "utf8")): number[] {
  const chain: number[] = [];
  for (let p: number | undefined = start; p && p > 0 && !chain.includes(p) && chain.length < 64;) {
    chain.push(p);
    try { p = parsePpid(stat(p)); } catch { break; }
  }
  return chain;
}

/** Who is calling: --as, then GOVERN_AS, then the first pid up the parent chain that is a live registered session. */
export function resolveAs(o: { as?: string; env?: NodeJS.ProcessEnv; dir?: string; chain?: () => number[] } = {}): string | undefined {
  if (o.as) return o.as;
  const env = o.env ?? process.env;
  if (env.GOVERN_AS) return env.GOVERN_AS;
  const live = liveSessions(o.dir);
  return (o.chain ?? (() => pidChain()))().map((p) => live.find((s) => s.pid === p)).find(Boolean)?.name;
}
export const requireAs = (as?: string): string =>
  resolveAs({ as }) ?? fail("cannot tell which session this is (no parent process is a registered Claude Code session): pass --as NAME or set GOVERN_AS");

/** The recipient check of `task send`/`forward`: a runner, auto, owner or a live session. Returns whether it is a session. */
export function checkRecipient(to: string, runners: readonly string[]): { session: boolean } {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(to)) fail(`--to must be lowercase letters, digits, dots and dashes: ${to}`);
  if ([...runners, "auto", "owner"].includes(to)) return { session: false };
  const live = liveSessions();
  if (live.some((s) => s.name === to)) return { session: true };
  const names = [...new Set(live.map((s) => s.name))].sort();
  return fail(`--to ${to}: no live session "${to}" (valid: ${[...runners, "auto", "owner", ...names].join(", ")})`);
}
