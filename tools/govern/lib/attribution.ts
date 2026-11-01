// Attribution: which lane a Claude Code session's model calls belong to, by where it works and not by a command it
// remembered to run. One function, laneOf, decides; the first rule that matches wins:
//   1. an open work segment for that session (`govern work`, or the SessionStart hook that opened one);
//   2. GOVERN_LANE recorded for the session (the hook records it in <state>/session-lanes.json);
//   3. the session's working directory is the lane's folder or below it, or a folder the lane's govern.json names
//      under {repo} in a command's argv or a file;
//   4. for a queue run, the message's project (the window of the queue ledger's run).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { readJsonl, writeJson, nowIso } from "./util.ts";
import { argvOf, laneSlugs, ledgerFile, ledgerSlugs, load, projectDir, stateFile } from "./project.ts";
import { repo, queueDir, stateDir } from "./workspace.ts";
import { obj, record, literal, name, str, parseFile } from "./shape.ts";

export type Basis = "segment" | "GOVERN_LANE" | "cwd" | "queue";
export interface Attributed { slug: string; basis: Basis }
/** A lane's folder, and (read only when the folder alone decides nothing) the other folders its govern.json names. */
export interface Lane { slug: string; dir: string; extra: () => string[] }
/** The part of a work segment attribution needs. */
export interface SegmentSpan { slug: string; engine: string; session?: string; start: number; end: number }
/** A queue run: the project of the message and the time the run took (ms). */
export interface Window { project: string; start: number; end: number }
export interface Ctx { lanes: Lane[]; segments: SegmentSpan[]; recorded: Map<string, string>; windows: Window[] }
/** What is known of one call: its session and end time, the session's working directory, GOVERN_LANE of the calling process. */
export interface Facts { session?: string; t?: number; cwd?: string; envLane?: string }

/** The label of a basis in the usage report. */
export const basisLabel = (b: Basis): string => (b === "cwd" ? "by cwd" : b === "queue" ? "by queue" : b === "GOVERN_LANE" ? "by GOVERN_LANE" : "by segment");

/** The folders under {repo} a lane names in its commands' argv and its files: a path with a trailing slash or an existing
 *  folder is the folder, any other is a file and gives its folder. The repo itself, and anything outside it, is no folder. */
function extraFolders(slug: string): string[] {
  let p;
  try { p = load(slug); } catch { return []; }
  const root = repo(), out = new Set<string>();
  const args = [...Object.values(p.commands).flatMap(argvOf), ...Object.values(p.files)];
  for (const a of args) for (const m of a.matchAll(/\{repo\}(\/[^\s"':=]*)/g)) {
    const path = resolve(root + m[1]!);
    const isDir = m[1]!.endsWith("/") || (existsSync(path) && statSync(path).isDirectory());
    const folder = isDir ? path : dirname(path);
    if (folder !== root && folder.startsWith(root + sep)) out.add(folder);
  }
  return [...out];
}

/** Every lane with its folder. */
export function lanes(): Lane[] {
  return laneSlugs().map((slug) => {
    let memo: string[] | undefined;
    return { slug, dir: projectDir(slug), extra: () => (memo ??= extraFolders(slug)) };
  });
}

const inside = (cwd: string, folder: string): boolean => cwd === folder || cwd.startsWith(folder + sep);

/** The lane a working directory belongs to: the deepest lane folder holding it; else a folder a lane names under {repo}
 *  (a tie between lanes naming the same folder is no lane: the call is not guessed). */
export function laneByCwd(cwd: string, ls: Lane[] = lanes()): string | undefined {
  const at = resolve(cwd);
  const own = ls.filter((l) => inside(at, resolve(l.dir))).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (own) return own.slug;
  let best = -1, hits: string[] = [];
  for (const l of ls) for (const f of l.extra()) {
    if (!inside(at, f)) continue;
    if (f.length > best) { best = f.length; hits = [l.slug]; } else if (f.length === best && !hits.includes(l.slug)) hits.push(l.slug);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** The lane a call belongs to and why, or undefined (see the rules at the top of this file). */
export function laneOf(f: Facts, ctx: Ctx): Attributed | undefined {
  const known = (slug: string | undefined): slug is string => slug !== undefined && ctx.lanes.some((l) => l.slug === slug);
  if (f.session) {
    const s = ctx.segments.find((x) => x.engine === "claude" && x.session === f.session && (f.t === undefined ? x.end === Infinity : f.t >= x.start && f.t < x.end));
    if (s) return { slug: s.slug, basis: "segment" };
  }
  const named = f.envLane ?? (f.session ? ctx.recorded.get(f.session) : undefined);
  if (known(named)) return { slug: named, basis: "GOVERN_LANE" };
  const byCwd = f.cwd ? laneByCwd(f.cwd, ctx.lanes) : undefined;
  if (byCwd) return { slug: byCwd, basis: "cwd" };
  const run = f.t === undefined ? undefined : ctx.windows.find((w) => f.t! >= w.start && f.t! <= w.end);
  if (run && known(run.project)) return { slug: run.project, basis: "queue" };
  return undefined;
}

// ---------------------------------------------------------------- GOVERN_LANE, recorded per session

/** <state>/session-lanes.json: session id → the lane GOVERN_LANE named when its SessionStart hook ran. */
export const indexFile = (): string => join(stateDir(), "session-lanes.json");
const INDEX = obj({ version: literal(1), sessions: record(obj({ lane: name, at: str })) });
type Index = ReturnType<typeof INDEX>["sessions"];

/** The index rebuilt from the ledgers: a hook-opened work entry (`openedBy: "hook"`) that says it went by GOVERN_LANE. */
function rebuild(): Index {
  const out: Index = Object.create(null);
  for (const slug of ledgerSlugs()) {
    for (const e of readJsonl(ledgerFile(slug))) {
      if (e.kind === "work" && e.openedBy === "hook" && e.via === "GOVERN_LANE" && typeof e.session === "string" && e.session && typeof e.t === "string") out[e.session] = { lane: slug, at: e.t };
    }
  }
  return out;
}

/** The index as the file holds it; a missing, unparsable or wrongly shaped file is not trusted: it is rebuilt from the
 *  ledgers and written back (a failure to write leaves the rebuilt answer in use). */
function readIndex(): Index {
  const f = indexFile();
  if (existsSync(f)) {
    try { return parseFile(f, readFileSync(f, "utf8"), INDEX).sessions; } catch { /* rebuilt below */ }
  }
  const built = rebuild();
  if (existsSync(f) || Object.keys(built).length) { try { writeJson(f, { version: 1, sessions: built }); } catch { /* read-only state: the answer is still right */ } }
  return built;
}

/** The entries whose lane still has its folder: an entry for a folder that is gone names no lane, whoever wrote it. */
const standing = (ix: Index): [string, Index[string]][] => Object.entries(ix).filter(([, x]) => existsSync(stateFile(x.lane)));

/** Session id → the lane GOVERN_LANE named for it. */
export const recordedLanes = (): Map<string, string> => new Map(standing(readIndex()).map(([s, x]) => [s, x.lane]));

/** Record that `session` runs with GOVERN_LANE=`lane`. */
export function recordLane(session: string, lane: string): void {
  const sessions: Index = Object.assign(Object.create(null), Object.fromEntries(standing(readIndex())));
  sessions[session] = { lane, at: nowIso() };
  writeJson(indexFile(), { version: 1, sessions });
}

// ---------------------------------------------------------------- queue runs

/** The windows of the queue's runs that ended at or after `since` (ms): the ledger entry's end time, `seconds` back, with 5 s of slack. */
export function queueWindows(since = 0): Window[] {
  const out: Window[] = [];
  for (const e of readJsonl(join(queueDir(), "ledger.jsonl"))) {
    const end = Date.parse(String(e["t"]));
    if (typeof e["project"] !== "string" || !Number.isFinite(end) || end < since) continue;
    const secs = typeof e["seconds"] === "number" && Number.isFinite(e["seconds"]) && e["seconds"] >= 0 ? e["seconds"] : 0;
    out.push({ project: e["project"], start: end - secs * 1000 - 5000, end: end + 5000 });
  }
  return out;
}
