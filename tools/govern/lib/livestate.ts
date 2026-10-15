// What a host tells the command center about its work: the summary of every lane and the processes those lanes (and the
// workspace) use, by name, revision and hash, plus, on request, one process definition by hash. Both answers are signed by
// lib/peer.ts, closed in shape and small: lane summaries, never raw state; a definition only when asked for by its hash.
import { obj, arr, literal, reject, type Shape } from "./shape.ts";
import { laneSlugs, load } from "./project.ts";
import { processes, freezeProcess } from "./process.ts";
import { LANE_STATE, readLanes, type LaneState, type ProcessRef } from "./lanestate.ts";
import { clip } from "./util.ts";
import { liveSessions, type Session } from "./sessions.ts";
import * as agents from "./agents.ts";

export const LANES_PROTOCOL = "govern-lanes/1", PROCESS_PROTOCOL = "govern-process/1";
/** The most lane-summary bytes one answer carries; a peer response is capped at 256 KiB, so the rest is counted as omitted. */
export const MAX_LANES_BYTES = 180_000, MAX_DEFINITION_BYTES = 200_000;
/** The longest folder path one place carries, and the most places one answer carries. */
export const MAX_CWD = 400, MAX_PLACES = 200;

export interface ProcessInfo extends ProcessRef { description?: string; stages: number; gates: number }
export interface LanesAnswer {
  protocol: typeof LANES_PROTOCOL; host: string; fingerprint: string; at: string;
  lanes: LaneState[]; omitted: number; unreadable: number; processes: ProcessInfo[];
  /** The folder each live session and registered agent works in, so the operator can tell which project it is on. Optional: hosts before it send none. */
  places?: Place[];
}
export interface Place { name: string; cwd: string }
const text = (n: number): Shape<string> => (v, p) => (typeof v === "string" && v.length <= n ? v : reject(p, `must be a string of at most ${n} characters`));
const count: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a whole number, 0 or more"));
const label = text(200);
const PROCESS_INFO = obj({ name: label, revision: count, hash: label, stages: count, gates: count }, { description: text(400) }) as Shape<ProcessInfo>;
const ISO = text(40);
/** The closed shape of a host's lanes answer. */
export const LANES_ANSWER: Shape<LanesAnswer> = obj({
  protocol: literal(LANES_PROTOCOL), host: label, fingerprint: label, at: ISO, lanes: arr(LANE_STATE), omitted: count, unreadable: count, processes: arr(PROCESS_INFO),
}, { places: arr(obj({ name: label, cwd: text(MAX_CWD) })) }) as Shape<LanesAnswer>;
export interface ProcessAnswer { protocol: typeof PROCESS_PROTOCOL; host: string; fingerprint: string; at: string; name: string; hash: string; definition: string }
/** The closed shape of a host's answer to a request for one process definition. */
export const PROCESS_ANSWER: Shape<ProcessAnswer> = obj({
  protocol: literal(PROCESS_PROTOCOL), host: label, fingerprint: label, at: ISO, name: label, hash: label, definition: text(MAX_DEFINITION_BYTES),
}) as Shape<ProcessAnswer>;

/** The workspace's processes and the processes its lanes run, once each by name and hash. */
export function processInfos(lanes: LaneState[]): ProcessInfo[] {
  const out = new Map<string, ProcessInfo>();
  for (const pr of processes().values()) {
    const f = freezeProcess(pr);
    out.set(`${pr.name}@${f.hash}`, { name: pr.name, revision: f.revision, hash: f.hash, stages: pr.stages.length, gates: pr.gates.length, ...(pr.description ? { description: clip(pr.description, 400) } : {}) });
  }
  for (const l of lanes) if (!out.has(`${l.process.name}@${l.process.hash}`)) out.set(`${l.process.name}@${l.process.hash}`, { ...l.process, stages: l.stages.length, gates: l.gates.length });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || b.revision - a.revision);
}

/** Where each live session and registered agent works: a session's own folder from Claude Code's registry, and an agent's
 *  folder through the session that holds it (by pid, else by session name). One entry per name and folder, sorted; a
 *  session the registry records without a folder, and a registration held from a terminal, have no place. */
export function placesOf(known: Pick<Session, "pid" | "name" | "cwd">[], registered: Pick<agents.Agent, "name" | "aliases" | "owner" | "pid">[]): Place[] {
  const out = new Map<string, Place>(), put = (name: string, cwd: string | undefined) => {
    if (typeof cwd === "string" && cwd) { const c = clip(cwd, MAX_CWD); out.set(`${name}\0${c}`, { name, cwd: c }); }
  };
  for (const s of known) put(s.name, s.cwd);
  for (const a of registered) {
    const holders = a.pid !== undefined ? known.filter(s => s.pid === a.pid) : known.filter(s => s.name === a.owner);
    for (const h of holders) for (const n of [a.name, ...a.aliases]) put(n, h.cwd);
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name) || x.cwd.localeCompare(y.cwd)).slice(0, MAX_PLACES);
}

/** This host's lanes answer. Lanes beyond the size budget are dropped (finished and least recently active first) and counted. */
export function lanesAnswer(o: { host: string; fingerprint: string; now: number }): LanesAnswer {
  const { lanes, unreadable } = readLanes({ now: o.now });
  const order = [...lanes].sort((a, b) => Number(!!a.finished) - Number(!!b.finished) || b.lastActivity.localeCompare(a.lastActivity) || a.slug.localeCompare(b.slug));
  const kept: LaneState[] = [];
  let bytes = 0;
  for (const l of order) {
    const n = JSON.stringify(l).length;
    if (bytes + n > MAX_LANES_BYTES) continue;
    kept.push(l); bytes += n;
  }
  kept.sort((a, b) => a.slug.localeCompare(b.slug));
  return { protocol: LANES_PROTOCOL, host: o.host, fingerprint: o.fingerprint, at: new Date(o.now).toISOString(), lanes: kept, omitted: lanes.length - kept.length, unreadable: unreadable.length, processes: processInfos(lanes), places: placesOf(liveSessions(), agents.live(o.now)) };
}

/** The definition text of the process `name` with `hash`: the workspace's current file, else a lane's frozen snapshot; undefined when this host has none. */
export function definitionOf(name: string, hash: string): string | undefined {
  for (const pr of processes().values()) if (pr.name === name) { const f = freezeProcess(pr); if (f.hash === hash) return f.definition; }
  for (const slug of laneSlugs()) {
    try { const s = load(slug).processSnapshot; if (s && s.hash === hash && s.definition.length <= MAX_DEFINITION_BYTES) return s.definition; } catch { /* an unreadable lane holds no definition to offer */ }
  }
  return undefined;
}
