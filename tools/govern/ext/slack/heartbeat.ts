// The session heartbeat alert: a file another program touches (a Claude Code hook, the Slack watcher) is an agent session's
// heartbeat, read by its mtime only. When the beat is older than slack.heartbeat.staleSeconds, `slack notify` posts one
// `blocked:` to the channel; once the beat moves again, one `note:`. The open alert lives in slack.inbox's
// session-heartbeat.json, so a restart neither repeats nor loses it; both sends are keyed in sent.jsonl, from which a
// damaged state file is rebuilt. A heartbeat file that was never written raises nothing, so installing the alert is silent.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GovernError } from "../../lib/util.ts";
import { obj, str, parseFile, reject, type Shape } from "../../lib/shape.ts";
import { postMessage, save, sent, type Call } from "./channel.ts";
import type { SlackConfig } from "./route.ts";

/** How old the beat may get before it is stale, when the config does not say: thirty minutes. */
export const STALE_SECONDS = 1800;
/** What the messages call the session's owner when the config gives no name. */
const DEFAULT_NAME = "the agent";
const STATE = "session-heartbeat.json";
const BLOCKED = "heartbeat:blocked:", NOTE = "heartbeat:note:";

/** What the check needs, every path absolute: the beat file, its limit, the name in the messages, and where to send and journal. */
export interface HeartbeatSettings { file: string; staleSeconds: number; name: string; inbox: string; channel: string }
/** An open alert: the last beat before the silence (ISO) and the `blocked:` message's ts. */
export interface Alert { since: string; ts: string }
/** What one check did: the keys it posted (or, dry, would post), repairs worth saying, and refused sends by key. */
export interface HeartbeatRun { posted: string[]; notes: string[]; failed: string[] }
/** The beat as `slack heartbeat` reports it; `error` says why the alert state could not be read. */
export interface HeartbeatStatus { file: string; state: "missing" | "fresh" | "stale"; last: string | null; ageSeconds: number | null;
  staleSeconds: number; alert: Alert | null; error?: string }

/** The alert state file cannot be read as its contract says; `notify` rebuilds it from the send journal. */
export class HeartbeatStateError extends GovernError {
  constructor(message: string) { super(message, 1); }
}

/** The heartbeat settings from slack config (paths already absolute), or undefined when slack.heartbeat is absent.
 *  The alert is sent and journaled through the channel, so it needs slack.inbox and slack.channel. */
export function heartbeatSettings(cfg: SlackConfig): HeartbeatSettings | undefined {
  const h = cfg.heartbeat;
  if (!h) return undefined;
  if (!cfg.inbox) throw new GovernError("slack.heartbeat needs slack.inbox: the alert state and the send journal live there", 1);
  if (!cfg.channel) throw new GovernError("slack.heartbeat needs slack.channel: the channel the alert posts to", 1);
  return { file: h.file, staleSeconds: h.staleSeconds ?? STALE_SECONDS, name: h.name ?? DEFAULT_NAME, inbox: cfg.inbox, channel: cfg.channel };
}

const TS = /^\d{1,12}\.\d{6}$/;
const iso: Shape<string> = (v, p) => {
  const s = str(v, p);
  if (!Number.isFinite(Date.parse(s)) || new Date(Date.parse(s)).toISOString() !== s) reject(p, "must be an ISO time (YYYY-MM-DDTHH:MM:SS.mmmZ)");
  return s;
};
const stamp: Shape<string> = (v, p) => {
  const s = str(v, p);
  if (!TS.test(s)) reject(p, "must be a Slack ts (seconds.micros)");
  return s;
};
const STATE_SHAPE = obj({}, { alert: obj({ since: iso, ts: stamp }) });

/** The open alert in `inbox`'s state file; undefined when none is open or the file does not exist. Anything else in the
 *  file is a HeartbeatStateError naming it. */
export function readAlert(inbox: string): Alert | undefined {
  const f = join(inbox, STATE);
  if (!existsSync(f)) return undefined;
  try { return parseFile(f, readFileSync(f, "utf8"), STATE_SHAPE).alert; }
  catch (e) { throw new HeartbeatStateError(e instanceof GovernError && e.message.startsWith(f) ? e.message : `${f}: ${(e as Error).message}`); }
}

/** The open alert as the send journal shows it: the latest `blocked:` whose `note:` was never sent; undefined when none. */
export function journalAlert(inbox: string): Alert | undefined {
  const rows = sent(inbox), notes = new Set(rows.flatMap((r) => (r.key?.startsWith(NOTE) ? [r.key.slice(NOTE.length)] : [])));
  const open = rows.filter((r) => r.key?.startsWith(BLOCKED) && !notes.has(r.key.slice(BLOCKED.length))).at(-1);
  return open && { since: open.key!.slice(BLOCKED.length), ts: open.ts };
}

/** The beat's mtime in whole ms (the precision an alert's ISO `since` keeps), or undefined when the file does not exist. */
function lastBeat(file: string): number | undefined {
  const st = statSync(file, { throwIfNoEntry: false });
  return st && Math.floor(st.mtimeMs);
}

/** A local UTC offset as people write it: 180 (getTimezoneOffset's minutes west) is "UTC-3", 0 is "UTC". */
export function zone(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const east = -offsetMinutes, h = Math.floor(Math.abs(east) / 60), m = Math.abs(east) % 60;
  return `UTC${east > 0 ? "+" : "-"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
const two = (n: number) => String(n).padStart(2, "0");
/** `at` as local HH:MM, with its date in front when it is not on `now`'s local day. */
export function clock(at: number, now: number): string {
  const d = new Date(at), n = new Date(now), hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}
const blockedText = (s: HeartbeatSettings, since: number, now: number) =>
  `${s.name}'s session has sent no heartbeat since ${clock(since, now)} (${zone(new Date(since).getTimezoneOffset())}); requests wait until it returns or the headless shift answers`;
const backText = (s: HeartbeatSettings, since: number, back: number) =>
  `${s.name}'s session is back (silent ${clock(since, back)}–${clock(back, back)} ${zone(new Date(back).getTimezoneOffset())})`;

/** One check: close an open alert with `note:` when the beat moved past it, then open one with `blocked:` when the beat
 *  is stale and none is open. A missing beat file neither opens nor closes an alert. A damaged state file is rebuilt from
 *  the send journal and said in `notes`. A refused send is in `failed` and leaves its state for the next run; a key the
 *  journal already holds is recorded without sending again. With dryRun nothing is sent or written. */
export async function checkHeartbeat(call: Call, s: HeartbeatSettings, o: { now?: number; dryRun?: boolean } = {}): Promise<HeartbeatRun> {
  const now = o.now ?? Date.now(), run: HeartbeatRun = { posted: [], notes: [], failed: [] };
  let alert: Alert | undefined, changed = false;
  try { alert = readAlert(s.inbox); }
  catch (e) {
    if (!(e instanceof HeartbeatStateError)) throw e;
    alert = journalAlert(s.inbox); changed = true;
    run.notes.push(`${e.message}; rebuilt from sent.jsonl: ${alert ? `alerted since ${alert.since}` : "no open alert"}`);
  }
  const persist = () => { if (changed && !o.dryRun) save(s.inbox, STATE, alert ? { alert } : {}); };
  /** Send one keyed message, or find it already journaled; its ts, or undefined when Slack refused it. */
  const send = async (kind: "blocked" | "note", key: string, text: string): Promise<string | undefined> => {
    if (o.dryRun) { run.posted.push(key); return "dry-run"; }
    const done = sent(s.inbox).find((r) => r.key === key);
    if (done) return done.ts;
    try { const row = await postMessage(call, s.inbox, s.channel, { kind, text, key }); run.posted.push(key); return row.ts; }
    catch (e) { run.failed.push(`${key}: ${(e as Error).message}`); return undefined; }
  };
  const last = lastBeat(s.file);
  if (alert && last !== undefined && last > Date.parse(alert.since)) {
    if (await send("note", `${NOTE}${alert.since}`, backText(s, Date.parse(alert.since), last)) === undefined) { persist(); return run; }
    alert = undefined; changed = true;
  }
  if (!alert && last !== undefined && now - last > s.staleSeconds * 1000) {
    const since = new Date(last).toISOString(), ts = await send("blocked", `${BLOCKED}${since}`, blockedText(s, last, now));
    if (ts !== undefined) { alert = { since, ts }; changed = true; }
  }
  persist();
  return run;
}

/** The beat's state for `govern slack heartbeat`: missing, fresh or stale, its age, and the open alert (read, never repaired). */
export function heartbeatStatus(s: HeartbeatSettings, now = Date.now()): HeartbeatStatus {
  const last = lastBeat(s.file);
  let alert: Alert | undefined, error: string | undefined;
  try { alert = readAlert(s.inbox); } catch (e) { if (!(e instanceof HeartbeatStateError)) throw e; error = e.message; }
  const age = last === undefined ? null : Math.max(0, Math.floor((now - last) / 1000));
  return { file: s.file, state: last === undefined ? "missing" : now - last > s.staleSeconds * 1000 ? "stale" : "fresh", last: last === undefined ? null : new Date(last).toISOString(),
    ageSeconds: age, staleSeconds: s.staleSeconds, alert: alert ?? null, ...(error ? { error } : {}) };
}
