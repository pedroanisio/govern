// The Claude Code session registry (~/.claude/sessions/<pid>.json): who is alive, and who the caller is.
// Only pid, name, cwd, kind, status and procStart are read. The directory also holds *.key files: never opened, never printed.
import { readdirSync, readFileSync } from "node:fs";
import { LEGACY_PROFILES } from "./caps.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, findRepo } from "./workspace.ts";
import { fail, usage, procStat, hasProc, exited } from "./util.ts";

/** procStart: the session process's start time as Claude Code recorded it (field 22 of /proc/<pid>/stat). */
export interface Session { pid: number; name: string; sessionId?: string; cwd?: string; kind?: string; status?: string; procStart?: string }

/** Claude Code's session registry folder: GOVERN_SESSIONS_DIR, else ~/.claude/sessions. */
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
        out.push({ pid: o.pid, name: o.name, ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}), cwd: o.cwd, kind: o.kind, status: o.status, ...(typeof o.procStart === "string" ? { procStart: o.procStart } : {}) });
    } catch { /* not a session file */ }
  }
  return out;
}
/** The sessions in the registry at `dir` whose process still runs (the same process, where its start time is recorded). */
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
export interface Caller { name: string; session?: string }
/** Who is calling, with the session id behind the name when one is known: the id does not change when the session is renamed. */
export function resolveCaller(o: { as?: string; env?: NodeJS.ProcessEnv; dir?: string; chain?: () => number[] } = {}): Caller | undefined {
  const name = resolveAs(o);
  if (name === undefined) return undefined;
  const live = liveSessions(o.dir);
  const self = o.as || (o.env ?? process.env).GOVERN_AS ? live.filter((s) => s.name === name) : (o.chain ?? (() => pidChain()))().flatMap((p) => live.filter((s) => s.pid === p)).slice(0, 1);
  return { name, ...(self.length === 1 && self[0]!.sessionId ? { session: self[0]!.sessionId } : {}) };
}

/** Who is calling, as resolveAs finds it from `as`, GOVERN_AS or the parent process chain; a GovernError when none of them names a session. */
export const requireAs = (as?: string): string =>
  resolveAs({ as }) ?? fail("cannot tell which session this is (no parent process is a registered Claude Code session): pass --as NAME or set GOVERN_AS");

/** The recipient check of `task send`/`forward`: a runner, auto, owner, configured mailbox, a live session or a former name of
 *  one (`former` reads the queue, so only a name nothing else accepts pays for it). Returns whether it is a session. */
export function checkRecipient(to: string, runners: readonly string[], former: () => string[] = () => []): { session: boolean } {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(to)) usage(`--to must be lowercase letters, digits, dots and dashes: ${to}`);
  const mailboxes = findRepo() ? config().mailboxes ?? [] : [];
  if ([...runners, "auto", "owner", ...mailboxes].includes(to)) return { session: false };
  const live = liveSessions();
  if (live.some((s) => s.name === to) || former().includes(to)) return { session: true };
  if ((LEGACY_PROFILES as readonly string[]).includes(to)) {
    const engine = to.slice(0, to.lastIndexOf("-"));
    return fail(`--to ${to}: ${to} is a profile, not a --to target; use --to ${engine}${to.endsWith("-write") ? " --write" : ""} (or --to ${engine} --profile ${to})`);
  }
  const names = [...new Set(live.map((s) => s.name))].sort();
  return fail(`--to ${to}: no live session "${to}" (valid: ${[...runners, "auto", "owner", ...mailboxes, ...names].join(", ")})`);
}

/** The Claude Code session that is the caller: the first live registry entry (named or not) up the parent chain. Its
 *  `sessionId` is the registry's, absent when the file does not carry one. Never reads *.key files. */
export function callingSession(o: { dir?: string; chain?: () => number[] } = {}): { pid: number; sessionId?: string } | undefined {
  const dir = o.dir ?? SESSIONS_DIR();
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return undefined; }
  const live: { pid: number; sessionId?: string }[] = [];
  for (const f of files) {
    try {
      const x = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (Number.isInteger(x?.pid) && isAlive(x.pid, typeof x.procStart === "string" ? x.procStart : undefined))
        live.push({ pid: x.pid, ...(typeof x.sessionId === "string" ? { sessionId: x.sessionId } : {}) });
    } catch { /* not a session file */ }
  }
  return (o.chain ?? (() => pidChain()))().map((p) => live.find((s) => s.pid === p)).find(Boolean);
}
