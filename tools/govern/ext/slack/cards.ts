// slack.cards: the case's card is the lane's place in Slack. notify.ts posts and updates the card and posts each new lane
// note in its thread; here, the reading side: which lane's card a thread belongs to, and a reply in it as a person's note.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../lib/workspace.ts";

/** A person's reply in a thread, as a Slack message event carries it. */
export interface Reply { team: string; channel: string; user: string; ts: string; thread: string; text: string }

/** The longest note a reply becomes; the rest is cut and the note says so. */
export const MAX_NOTE = 4000;

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The reply an Events API `event_callback` carries: a person's message in a thread (also sent to the channel or not),
 *  with text. Anything else (a top-level message, an edit, a deletion, a bot's post, a join) is undefined: ignored. */
export function replyOf(raw: unknown): Reply | undefined {
  if (!record(raw) || raw.type !== "event_callback" || !record(raw.event)) return undefined;
  const ev = raw.event;
  if (ev.type !== "message" || (ev.subtype !== undefined && ev.subtype !== "thread_broadcast") || ev.bot_id !== undefined) return undefined;
  const { channel, user, ts, thread_ts: thread, text } = ev, team = raw.team_id;
  if (!str(team) || !str(channel) || !str(user) || !str(ts) || !str(thread) || thread === ts || typeof text !== "string" || !text.trim()) return undefined;
  return { team, channel, user, ts, thread, text: text.trim() };
}

/** The note text a reply becomes: at most MAX_NOTE characters. */
export const noteOf = (r: Reply): string => (r.text.length > MAX_NOTE ? `${r.text.slice(0, MAX_NOTE)} … (cut: the reply was longer)` : r.text);

/** The lane of this workspace whose card is the message `ts` in `channel`, from what notify recorded; undefined if none. */
export function cardLaneHere(channel: string, ts: string): string | undefined {
  const f = join(stateDir(), "slack", "posted.json");
  if (!existsSync(f)) return undefined;
  let s: unknown;
  try { s = JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; }
  const cards = record(s) && record(s.cards) ? s.cards : {};
  return Object.entries(cards).find(([, c]) => record(c) && c.channel === channel && c.ts === ts)?.[0];
}
