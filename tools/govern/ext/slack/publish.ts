// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
// Publishing a routed reply (SLACK.md): only a reply to a routed Slack request whose content check passed ("checked") is
// offered, to the configured publishers in a review channel. Nothing reaches the requester's channel until a publisher's
// signed click approves that exact text (its digest), and `govern slack listen`, the inbox's one writer, checks it again
// before posting it once, keyed, in the request's thread. Unverified, unchecked and BLOCKED replies are never offered.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as queue from "../../lib/queue.ts";
import type { Source } from "../../lib/approval.ts";
import { BadRequest } from "../../lib/http-errors.ts";
import { fail, nowIso } from "../../lib/util.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { directory, save, postMessage, wasSent, wasAttempted, LIMIT, type Call } from "./channel.ts";
import { ACTIONS_BLOCK } from "./pending.ts";

export const PUBLISH_ID = "govern.publish";
/** How much of a reply one review section shows, and how many sections an offer may use: a longer reply is not offered,
 *  so a publisher always sees the whole text they publish. */
const SECTION = 2900, SECTIONS = 12;
const KIND = "delivered";
export const publishKey = (reply: string): string => `publish:${reply}`;

/** A reply that may be offered: the routed request it answers (its ts and thread), its text and the text's digest. */
export interface Offer { reply: queue.Message; request: string; thread: string; text: string; digest: string }
interface Approval { digest: string; by: string; at: string; source: Extract<Source, { kind: "slack" }> }

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TS = /^\d{1,12}\.\d{6}$/;
function json(d: string, name: string): Record<string, unknown> {
  const f = join(d, name);
  if (!existsSync(f)) return {};
  const v: unknown = JSON.parse(readFileSync(f, "utf8"));
  return object(v) ? v : fail(`${f}: expected an object`);
}

/** Each routed task (routes.json) with the request it came from and that request's thread (inbox.jsonl). */
function routedRequests(d: string): Map<string, { request: string; thread: string }> {
  const threads = new Map<string, string>(), f = join(d, "inbox.jsonl");
  if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    try { const r: unknown = JSON.parse(line);
      if (object(r) && typeof r.ts === "string" && TS.test(r.ts) && !threads.has(r.ts)) threads.set(r.ts, typeof r.thread_ts === "string" && TS.test(r.thread_ts) ? r.thread_ts : r.ts);
    } catch { /* an unreadable row routes nothing (route.ts), so it answers nothing */ }
  }
  const out = new Map<string, { request: string; thread: string }>();
  for (const [ts, r] of Object.entries(json(d, "routes.json")))
    if (TS.test(ts) && object(r) && typeof r.task === "string") out.set(r.task, { request: ts, thread: threads.get(ts) ?? ts });
  return out;
}

const textOf = (m: queue.Message): string => (m.body.trim() ? m.body : m.summary).trim();
const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");
/** Slack's control characters escaped, so a published reply can neither mention anyone nor make a link. */
const inert = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The replies that may be offered now: to a routed request, not BLOCKED, content check passed, short enough to show in
 *  full and to post. */
export function offers(d: string): Offer[] {
  const routed = routedRequests(d), out: Offer[] = [];
  for (const { state, m } of queue.all()) {
    if (state === "failed" || m.project !== "slack" || m.to !== "owner" || m.kind === "TASK" || m.kind === "BLOCKED") continue;
    const r = m.replyTo ? routed.get(m.replyTo) : undefined;
    if (!r || m.verification?.state !== "checked") continue;
    const text = textOf(m);
    if (!text || text.length > SECTION * SECTIONS || [...`${KIND}: ${inert(text)}`].length > LIMIT) continue;
    out.push({ reply: m, ...r, text, digest: digestOf(text) });
  }
  return out;
}

/** The review message offering `o`: what it answers, the whole text as plain text, and Publish to thread. */
export function offerMessage(o: Offer): { text: string; blocks: unknown[] } {
  const chunks: string[] = [];
  for (let i = 0; i < o.text.length; i += SECTION) chunks.push(o.text.slice(i, i + SECTION));
  return { text: `Reply to Slack request ${o.request}: publish it?`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Reply to Slack request* \`${o.request}\` · reply \`${o.reply.id}\` · content check passed${o.reply.verification?.reason ? ` (${inert(o.reply.verification.reason).slice(0, 200)})` : ""}\n_Publish posts this text in the request's thread._` } },
      ...chunks.map((t) => ({ type: "section", text: { type: "plain_text", text: t, emoji: false } })),
      { type: "actions", block_id: ACTIONS_BLOCK, elements: [{ type: "button", action_id: PUBLISH_ID, style: "primary",
        text: { type: "plain_text", text: "Publish to thread" }, value: JSON.stringify({ v: 1, reply: o.reply.id, digest: o.digest }) }] }] };
}

/** The reply and digest a Publish button names, refusing (BadRequest) any other shape. */
export function parsePublish(raw: unknown): { reply: string; digest: string } {
  let v: unknown;
  try { v = JSON.parse(typeof raw === "string" ? raw : ""); } catch { return bad("the button value is not JSON"); }
  if (!object(v) || v.v !== 1 || Object.keys(v).some((k) => !["v", "reply", "digest"].includes(k))) return bad("the button value is not a version 1 publish value");
  if (typeof v.reply !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(v.reply)) return bad("the button value names no reply");
  if (typeof v.digest !== "string" || !/^[0-9a-f]{64}$/.test(v.digest)) return bad("the button value's digest must be a SHA-256 hex digest");
  return { reply: v.reply, digest: v.digest };
}
const bad = (m: string): never => { throw new BadRequest(m); };

const approvals = (d: string): Record<string, Approval> => json(d, "publish.json") as unknown as Record<string, Approval>;

/** Record Slack user `by`'s approval to publish `reply` as offered (`digest`), with the signed click as its source.
 *  Refused (GovernError) when the reply is no longer offered as that text, or was approved already. Posts nothing. */
export function approvePublish(d: string, reply: string, digest: string, by: string, source: Extract<Source, { kind: "slack" }>): void {
  directory(d);
  withLaneLock(join(d, "publish.lock"), () => {
    const o = offers(d).find((x) => x.reply.id === reply) ?? fail(`reply ${reply} is not a checked reply to a routed request (any more)`);
    if (o.digest !== digest) fail(`reply ${reply} changed since it was offered: review it again`);
    const all = approvals(d);
    if (Object.hasOwn(all, reply)) fail(`reply ${reply} is already approved by ${all[reply]!.by}`);
    all[reply] = { digest, by, at: nowIso(), source };
    save(d, "publish.json", all);
  });
}

/** Post each approved reply not yet sent in its request's thread, once (key `publish:<reply>`), after checking again that
 *  it is still offered as the approved text. Returns the replies posted. Called by `govern slack listen` only. */
export async function publishApproved(call: Call, d: string, channel: string): Promise<string[]> {
  const out: string[] = [], offered = new Map(offers(d).map((o) => [o.reply.id, o]));
  for (const [reply, a] of Object.entries(approvals(d))) {
    const key = publishKey(reply);
    if (wasSent(d, key)) continue;
    if (wasAttempted(d, key)) { process.stderr.write(`slack publish: ${reply} has an uncertain send; settle it with govern slack resolve --key ${key}\n`); continue; }
    const o = offered.get(reply);
    if (!o || o.digest !== a.digest) { process.stderr.write(`slack publish: ${reply} not posted: it is no longer the checked text that was approved\n`); continue; }
    await postMessage(call, d, channel, { kind: KIND, text: inert(o.text), thread: o.thread, threadIsParent: true, key });
    out.push(reply);
  }
  return out;
}

/** Whether `reply` was published (its keyed send is journaled). */
export const published = (d: string, reply: string): boolean => wasSent(d, publishKey(reply));
