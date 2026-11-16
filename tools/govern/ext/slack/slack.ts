// govern slack: decisions people make with buttons in Slack (SLACK.md). Slack signs every interactivity request with the
// app's signing secret; govern checks that signature, the clock and that the request was never received before, maps the
// Slack user to a process person through `people.<id>.slack`, and records the decision as that person's own, with the
// signed request as its source. A button carries a digest of the case it was made for, so a decision on a case that has
// changed since (its data, or a loop that repeated) is refused.
import { createServer, type Server } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, save, appendLedger, stateFile, checkSlug, type Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { transaction } from "../../lib/lifecycle.ts";
import { humanAction, policyVote, rejectRoute, gateApproved, ownerApproval } from "../../lib/business.ts";
import { name as nameShape } from "../../lib/shape.ts";
import { stateDir, slackConfig, repo, inRepo, FOLDER_OVERRIDES } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { BadRequest, Forbidden, NotFound, TooLarge } from "../../lib/http-errors.ts";
import { GovernError, fail, nowIso } from "../../lib/util.ts";
import type { SlackSource } from "../../lib/approval.ts";
import { setData } from "../../lib/business.ts";
import type { Scalar } from "../../lib/business-schema.ts";
import { optionSet, pending, settled, standing } from "./pending.ts";
import { isControl, parseControl, performControl, type Control } from "./controls.ts";
import { FormRefusal, editedSet, firstBlock, formView, parseSubmission, postedMessage, reasonOf, type FormMeta, type Submission } from "./forms.ts";
import type { Call } from "./channel.ts";
import { PUBLISH_ID, approvePublish, parsePublish } from "./publish.ts";
import { allowedUrl, forServer, serverOf, type SlackServer } from "./server.ts";
import { markAnswered } from "./answered.ts";

export { optionSet };

/** How far a request's timestamp may be from the server's clock (Slack's own recommendation), in seconds. */
export const SKEW_SECONDS = 300;
/** How long a received signature is remembered: longer than the clock window, so a replay is refused either way. */
const SEEN_SECONDS = 2 * SKEW_SECONDS;
export const MAX_BODY = 65536;
/** The action_id of every button govern makes (or it followed by `.` and a suffix, which keeps ids unique within a
 *  Slack block); other buttons in the same app are not decisions. */
export const ACTION_ID = "govern.decide";

/** A request whose signature, timestamp or freshness does not prove it came from Slack (401). */
export class Unauthorized extends GovernError {}

/** What a decision applies to: a gate of the lane, or the human task of one of its stages. */
export type Target = { gate: string } | { task: string };
export type Decision = "approve" | "reject" | "complete";
/** The Slack form a button opens instead of deciding: a reason for a rejection, or an option's editable fields. */
export type Form = "reason" | "edit";
/** One verified button click: who clicked it, in which team, the button's typed value and its label (the person's words). */
export interface SlackAction { team: string; user: string; lane: string; target: Target; decision: Decision; digest: string; quote: string;
  /** An approval that also sets case fields: it must be one of the gate's options, rendered from the case as it stands. */
  set?: Record<string, Scalar>;
  /** The click opens this form instead of deciding (forms.ts). */
  form?: Form;
  /** A submitted edit form: the option (an index into the gate's options) whose `edit` fields `set` may change. */
  edit?: number }

/** Fails (Unauthorized) unless `signature` is Slack's v0 HMAC-SHA256 of `v0:<timestamp>:<body>` under `secret` and
 *  `timestamp` (seconds) is within SKEW_SECONDS of `now`. */
export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: Buffer, now: number): void {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) throw new Unauthorized("the request has no valid X-Slack-Request-Timestamp");
  if (!signature || !/^v0=[0-9a-f]{64}$/.test(signature)) throw new Unauthorized("the request has no valid X-Slack-Signature");
  if (Math.abs(now - Number(timestamp)) > SKEW_SECONDS)
    throw new Unauthorized(`the request was signed at ${timestamp}, more than ${SKEW_SECONDS} s from the server's clock (too old, or replayed)`);
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"))) throw new Unauthorized("the signature does not match the signing secret");
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string): string => (typeof v === "string" && v.length > 0 ? v : bad(`${what} is missing or not a string`));
function bad(msg: string): never { throw new BadRequest(msg); }
const stageName = (v: unknown, what: string): string => {
  try { return nameShape(v, what); } catch (e) { return bad((e as Error).message); }
};
const VALUE_KEYS = new Set(["v", "lane", "gate", "task", "decision", "digest", "set", "form"]);

/** The decision in a Slack interactivity request body (`payload=<JSON>`): a block_actions payload with exactly one
 *  govern.decide button, whose value is the typed decision govern made it with. Every refusal is a BadRequest. */
export function parseAction(body: Buffer): SlackAction {
  const raw = new URLSearchParams(body.toString("utf8")).get("payload") ?? bad("the body has no payload field (Slack sends payload=<JSON>)");
  let p: unknown;
  try { p = JSON.parse(raw); } catch { return bad("the payload is not JSON"); }
  if (!record(p)) return bad("the payload is not a JSON object");
  if (p.type !== "block_actions") return bad(`only block_actions payloads carry decisions (got ${JSON.stringify(p.type)})`);
  const team = text(record(p.team) ? p.team.id : undefined, "team.id");
  const user = text(record(p.user) ? p.user.id : undefined, "user.id");
  if (!Array.isArray(p.actions) || p.actions.length !== 1) return bad("a decision is exactly one action");
  const action = p.actions[0];
  if (!record(action) || typeof action.action_id !== "string" || !(action.action_id === ACTION_ID || action.action_id.startsWith(`${ACTION_ID}.`)))
    return bad(`the action is not a ${ACTION_ID} button`);
  let v: unknown;
  try { v = JSON.parse(text(action.value, "the button value")); } catch (e) { return e instanceof BadRequest ? bad(e.message) : bad("the button value is not JSON"); }
  if (!record(v)) return bad("the button value is not a JSON object");
  for (const k of Object.keys(v)) if (!VALUE_KEYS.has(k)) bad(`the button value has an unknown field ${k}`);
  if (v.v !== 1) bad("the button value's v must be 1");
  const lane = text(v.lane, "the button value's lane");
  if ((v.gate === undefined) === (v.task === undefined)) bad("the button value names a gate or a task, exactly one");
  const target: Target = v.gate !== undefined ? { gate: stageName(v.gate, "gate") } : { task: stageName(v.task, "task") };
  const decision = v.decision;
  if ("gate" in target ? decision !== "approve" && decision !== "reject" : decision !== "complete")
    bad("gate" in target ? "a gate decision is approve or reject" : "a task decision is complete");
  const digest = typeof v.digest === "string" && /^[0-9a-f]{64}$/.test(v.digest) ? v.digest : bad("the button value's digest must be a SHA-256 hex digest");
  let set: Record<string, Scalar> | undefined;
  if (v.set !== undefined) {
    if (!("gate" in target) || decision !== "approve") bad("only a gate approval can set case data");
    if (!record(v.set) || Object.values(v.set).some((x) => !["string", "number", "boolean"].includes(typeof x))) bad("the button value's set must map fields to scalars");
    set = v.set as Record<string, Scalar>;
  }
  if (v.form !== undefined && !(v.form === "reason" ? decision === "reject" && "gate" in target && !set : v.form === "edit" && !!set))
    bad("a reason form is a gate's rejection, an edit form an approval with an option");
  const label = record(action.text) && typeof action.text.text === "string" ? action.text.text.trim() : "";
  if (label.length < 2 || label.length > 2000) bad("the button's label must be the person's words (2..2000 characters)");
  return { team, user, lane, target, decision: decision as Decision, digest, quote: label, ...(set ? { set } : {}), ...(v.form ? { form: v.form as Form } : {}) };
}

/** The version of `p` a decision is made for: its case data and its loop counters, as a SHA-256 hex digest. A change to
 *  either (new data, a loop that repeated) makes every button made before it refuse. */
export function caseDigest(p: Pick<Project, "data" | "workflow">): string {
  const data = Object.entries(p.data ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const loops = Object.entries(p.workflow?.loops ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ data, loops })).digest("hex");
}

/** The value of a govern.decide button deciding `target` of lane `p` with `decision` (an approval may also `set` case
 *  fields: one of the gate's options), bound to the case as it is now. A `form` makes the click open a Slack form
 *  (forms.ts) instead of deciding: `reason` for a rejection, `edit` for an option with editable fields. */
export function decisionValue(p: Project, target: Target, decision: Decision, set?: Record<string, Scalar>, form?: Form): string {
  return JSON.stringify({ v: 1, lane: p.slug, ...target, decision, digest: caseDigest(p), ...(set ? { set } : {}), ...(form ? { form } : {}) });
}

const seenDir = () => join(stateDir(), "slack");
/** Remember `signature` (or a Socket Mode click's identity) for `ttl` seconds, by default until it can no longer pass the
 *  clock check; fails (Unauthorized) when it was already received. */
function remember(signature: string, now: number, ttl = SEEN_SECONDS): void {
  mkdirSync(seenDir(), { recursive: true, mode: 0o700 });
  withLaneLock(join(seenDir(), "lock"), () => {
    const f = join(seenDir(), "seen.json");
    let seen: Record<string, number> = {};
    if (existsSync(f)) {
      try { seen = JSON.parse(readFileSync(f, "utf8")) as Record<string, number>; } catch (e) { fail(`${f} is not valid JSON (${(e as Error).message})`, 1); }
    }
    for (const [k, until] of Object.entries(seen)) if (until < now) delete seen[k];
    const key = createHash("sha256").update(signature).digest("hex");
    if (Object.hasOwn(seen, key)) throw new Unauthorized("this request was already received (replayed)");
    seen[key] = now + ttl;
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(seen) + "\n", { mode: 0o600 });
    renameSync(tmp, f);
  });
}

/** The process person whose Slack user id is `user`; Forbidden when none is. */
export function personOf(p: Project, user: string): string {
  const people = processOf(p).people ?? {};
  return Object.keys(people).find((id) => people[id]!.slack === user)
    ?? (() => { throw new Forbidden(`Slack user ${user} is no person of ${p.slug}'s process (map it as people.<id>.slack)`); })();
}

/** The workspace that holds lane `slug` among the ones this server decides for: its own, then slack.serveRepos. Several
 *  workspaces need each one's own folders, so an environment override of a folder refuses (Forbidden); a lane in none is
 *  NotFound, a lane in more than one is refused. */
function laneRepo(slug: string): string {
  const own = repo(), repos = [...new Set([own, ...(slackConfig()?.serveRepos ?? [])])];
  if (repos.length > 1) {
    const set = FOLDER_OVERRIDES.filter((v) => process.env[v]);
    if (set.length) throw new Forbidden(`slack.serveRepos needs each workspace's own folders: unset ${set.join(", ")} for slack serve`);
  }
  const holders = repos.filter((r) => inRepo(r, () => existsSync(stateFile(slug))));
  if (!holders.length) throw new NotFound(`no lane ${slug}`);
  if (holders.length > 1) fail(`${slug} is a lane of more than one served workspace (${holders.join(", ")}): rename one`);
  return holders[0]!;
}

/** Record `a` on its lane as the mapped person's decision, under the lane lock: a policy vote (a reject follows the
 *  policy's rejectTo), the owner's approval of a gate without a policy, or the completion of a human task (claimed first
 *  when nobody holds it). The lane may live in another workspace this server decides for (slack.serveRepos); there its
 *  own slack.team must be the request's team and its own process's people decide. Returns the line the server replies with. */
export function perform(a: SlackAction, source: SlackSource): string {
  return inLaneWorkspace(a.team, a.lane, (slug) => decide(a, slug, source));
}

/** Run `f` for lane `lane` inside the workspace that holds it (this one or one of slack.serveRepos), once the request's
 *  Slack team is this server's and, in another workspace, that workspace's own slack.team. */
function inLaneWorkspace<T>(team: string, lane: string, f: (slug: string) => T): T {
  const ours = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (team !== ours) throw new Forbidden(`the request comes from Slack team ${team}, not ${ours}`);
  let slug: string;
  try { slug = checkSlug(lane); } catch (e) { return bad((e as Error).message); }
  const at = laneRepo(slug);
  return at === repo() ? f(slug) : inRepo(at, () => {
    const own = slackConfig()?.team;
    if (own !== team) throw new Forbidden(`${slug}'s workspace (${at}) ${own ? `belongs to Slack team ${own}` : "names no Slack team (slack.team)"}, not ${team}`);
    return f(slug);
  });
}

function decide(a: SlackAction, slug: string, source: SlackSource): string {
  return transaction(slug, () => {
    const p = load(slug), person = personOf(p, a.user);
    if (caseDigest(p) !== a.digest) fail(`${slug} has changed since this button was made (its data or a loop): decide on a new message`);
    if ("task" in a.target) {
      const stage = a.target.task;
      const claim = !p.humanTasks?.[stage]?.assignee;
      if (claim) humanAction(p, stage, "claim", person, a.quote);
      humanAction(p, stage, "complete", person, a.quote);
      save(p);
      if (claim) appendLedger(slug, { kind: "human-claim", stage, by: person, quote: a.quote, source });
      appendLedger(slug, { kind: "human-complete", stage, by: person, quote: a.quote, source });
      return `${slug}: ${stage} complete by ${person}`;
    }
    const gates = processOf(p).gates, name = a.target.gate;
    const g = gates.find((x) => x.name === name) ?? fail(`gate must be one of ${gates.map((x) => x.name).join(", ") || "(none: this process has no gates)"}`);
    let edited: string[] | undefined;
    if (a.set) {
      if (a.edit !== undefined) {
        const o = g.options?.[a.edit] ?? fail(`${g.name} has no option ${a.edit + 1}`), base = optionSet(o, p), may = new Set(o.edit ?? []);
        if (!sameKeys(a.set, base) || Object.keys(base).some((k) => !may.has(k) && a.set![k] !== base[k]))
          fail(`the form's data is not ${g.name}'s option "${o.label}" with only its editable fields changed`);
        edited = Object.keys(base).filter((k) => a.set![k] !== base[k]);
      } else if (!(g.options ?? []).some((o) => sameSet(optionSet(o, p), a.set!)))
        fail(`the button's data is not one of ${g.name}'s options as the case stands`);
      setData(p, a.set);
    }
    const set = a.set ? { set: a.set, ...(edited ? { edited } : {}) } : {};
    if (g.policy) {
      const decision = a.decision === "reject" ? "reject" : "approve";
      const vote = policyVote(p, g, person, decision, a.quote);
      if (decision === "reject") rejectRoute(p, g);
      p.notes.push({ at: vote.at, stage: p.stage, text: `${person} ${decision} ${g.name}: "${a.quote}"` });
      save(p);
      appendLedger(slug, { kind: decision, gate: g.name, ...vote, ...set, source });
      return `${slug}: ${g.name} ${decision} by ${person} · ${gateApproved(p, g) ? "approved" : "not approved"}`;
    }
    if (a.decision !== "approve") fail(`${g.name} has no approval policy: it can only be approved`);
    ownerApproval(p, g, person, a.quote, () => source);
    save(p);
    const { by } = p.approvals[g.name]!;
    appendLedger(slug, { kind: "approve", gate: g.name, quote: a.quote, by, ...set, source });
    return `${slug}: ${g.name} approved by ${by}`;
  });
}

const sorted = (s: Record<string, Scalar>) => JSON.stringify(Object.entries(s).sort(([x], [y]) => (x < y ? -1 : 1)));
const sameSet = (a: Record<string, Scalar>, b: Record<string, Scalar>) => sorted(a) === sorted(b);
const sameKeys = (a: Record<string, Scalar>, b: Record<string, Scalar>) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

/** The lane `a` names, once its team is the config's and the lane exists. */
function laneOf(a: { team: string; lane: string }): string {
  const team = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (a.team !== team) throw new Forbidden(`the request comes from Slack team ${a.team}, not ${team}`);
  let slug: string;
  try { slug = checkSlug(a.lane); } catch (e) { return bad((e as Error).message); }
  if (!existsSync(stateFile(slug))) throw new NotFound(`no lane ${slug}`);
  return slug;
}

/** Open the form a `form` button names, for the person who clicked, once they may decide the gate now on the case
 *  version the button is bound to. Records nothing. */
async function openForm(a: SlackAction, raw: Record<string, unknown>, url: string | undefined, call: Call | undefined): Promise<string> {
  const slug = laneOf(a), p = load(slug), person = personOf(p, a.user), gate = "gate" in a.target ? a.target.gate : bad("a form is for a gate");
  if (caseDigest(p) !== a.digest) fail(`${slug} has changed since this button was made (its data or a loop): decide on a new message`);
  const item = pending(p).find((i) => i.key === `${slug}:gate:${gate}`) ?? fail(`${slug}'s ${gate} does not wait on a decision now`);
  if (!item.people.includes(person)) fail(`${person} may not decide ${gate}`);
  const option = a.form === "edit" ? (item.options ?? []).findIndex((o) => !!o.edit && sameSet(o.set, a.set!)) : undefined;
  if (option === -1) fail(`the button's data is not an editable option of ${gate} as the case stands`);
  if (!call) fail("govern slack serve has no bot token, so it cannot open the form: give it SLACK_BOT_TOKEN (slack.forms)");
  const trigger = typeof raw.trigger_id === "string" && raw.trigger_id ? raw.trigger_id : bad("the click has no trigger_id");
  const message = record(raw.message) ? raw.message : undefined, container = record(raw.container) ? raw.container : undefined;
  const ts = typeof container?.message_ts === "string" ? container.message_ts : typeof message?.ts === "string" ? message.ts : undefined;
  const meta: FormMeta = { v: 1, lane: slug, gate, digest: a.digest, form: a.form!, quote: a.quote, user: a.user,
    ...(option !== undefined ? { option } : {}), ...(url ? { url } : {}), ...(ts ? { ts } : {}) };
  await call("views.open", { trigger_id: trigger, view: formView(p, meta, option !== undefined ? item.options![option] : undefined) });
  return `${slug}: ${gate} ${a.form} form opened for ${person}`;
}

/** The decision a submitted form makes: a rejection quoting the reason, or the option's approval with its fields edited. */
function submitted(s: Submission): SlackAction {
  const base = { team: s.team, user: s.user, lane: s.meta.lane, target: { gate: s.meta.gate }, digest: s.meta.digest };
  if (s.meta.form === "reason") return { ...base, decision: "reject", quote: reasonOf(s) };
  const p = load(laneOf(base));
  const o = processOf(p).gates.find((g) => g.name === s.meta.gate)?.options?.[s.meta.option!] ?? fail(`${s.meta.gate} has no option ${s.meta.option! + 1}`);
  return { ...base, decision: "approve", quote: s.meta.quote, set: editedSet(s, optionSet(o, p), o.edit ?? []), edit: s.meta.option! };
}

const STATUS = (e: unknown): number =>
  e instanceof Unauthorized ? 401 : e instanceof BadRequest ? 400 : e instanceof Forbidden ? 403 : e instanceof NotFound ? 404
    : e instanceof TooLarge ? 413 : e instanceof GovernError ? 409 : 500;

export interface InteractionOptions { now?: () => number; request?: typeof fetch;
  /** The Slack Web API under the bot token, to open forms (views.open); without it a form button is refused. */
  call?: Call;
  /** The server the workspace talks to (server.ts): its API base names the other host a response URL may be on, and a
   *  single-answer server gets edits without buttons. Default: the workspace's slack.server and slack.api. */
  server?: SlackServer }
/** `reply`, when set, is what the server answers Slack instead of `value` (a form submission's response_action). */
interface InteractionResult { status: number; value: { ok: boolean; text?: string; error?: string }; reply?: unknown }

const payloadOf = (body: Buffer): unknown => JSON.parse(new URLSearchParams(body.toString("utf8")).get("payload") ?? "null");

/** Only an authenticated payload can provide a response capability. Never follow redirects or send an API token. */
function responseUrl(body: Buffer, api: string): string | undefined {
  const raw = payloadOf(body);
  return record(raw) && raw.response_url !== undefined ? safeUrl(raw.response_url, api) : undefined;
}
function safeUrl(v: unknown, api: string): string {
  const refuse = () => new BadRequest("response_url must be an https://hooks.slack.com/ URL, or on the configured API's own address");
  let url: URL;
  try { url = new URL(typeof v === "string" ? v : ""); } catch { throw refuse(); }
  if (!allowedUrl(url, "hooks.slack.com", api)) throw refuse();
  return url.href;
}

/** The clicked message once `a` is recorded: what it asked, as Slack sent it with the click, with one line saying where the
 *  decision stands. Its buttons stay while the same target still waits on others (a gate short of its quorum) on the case
 *  version they are bound to, unless the server closes a message on its first click (`single`); otherwise they go. Without
 *  the clicked message's blocks, the bare `line` replaces it. */
function decided(body: Buffer, a: SlackAction, line: string, single = false): { text: string; blocks: unknown[] } {
  const raw = payloadOf(body);
  return decidedMessage(record(raw) && record(raw.message) ? raw.message : undefined, a, line, single);
}
function decidedMessage(message: { text?: unknown; blocks?: unknown } | undefined, a: SlackAction, line: string, single = false): { text: string; blocks: unknown[] } {
  const p = load(checkSlug(a.lane)), key = "task" in a.target ? `task:${a.target.task}` : `gate:${a.target.gate}`;
  const open = !single && caseDigest(p) === a.digest && pending(p).some((i) => i.key === `${p.slug}:${key}`);
  const blocks = settled(blocksOf(message, single), standing(p, a.target) ?? line, open);
  return blocks ? { text: typeof message?.text === "string" && message.text ? message.text : line, blocks } : { text: line, blocks: [] };
}

/** The clicked message's blocks; on a single-answer server, whose reads carry no blocks (Tayet), its text as one section,
 *  so the edit keeps what the message asked. */
function blocksOf(message: { text?: unknown; blocks?: unknown } | undefined, single: boolean): unknown {
  if (message?.blocks !== undefined || !single) return message?.blocks;
  return typeof message?.text === "string" && message.text ? [{ type: "section", text: { type: "mrkdwn", text: message.text } }] : undefined;
}

/** The clicked message with its buttons gone and `line` saying what was done; the bare line without the message's blocks. */
function closed(body: Buffer, line: string, single = false): { text: string; blocks: unknown[] } {
  const raw = payloadOf(body), message = record(raw) && record(raw.message) ? raw.message : undefined;
  const blocks = settled(blocksOf(message, single), line, false);
  return blocks ? { text: typeof message?.text === "string" && message.text ? message.text : line, blocks } : { text: line, blocks: [] };
}

/** A Publish to thread click (publish.ts): its team, user and button value; undefined for any other click. */
function publishOf(p: unknown): { team: string; user: string; value: unknown } | undefined {
  if (!record(p) || p.type !== "block_actions" || !Array.isArray(p.actions) || !p.actions.some((x) => record(x) && x.action_id === PUBLISH_ID)) return undefined;
  if (p.actions.length !== 1) bad("a click is exactly one action");
  const team = text(record(p.team) ? p.team.id : undefined, "team.id"), user = text(record(p.user) ? p.user.id : undefined, "user.id");
  return { team, user, value: (p.actions[0] as Record<string, unknown>).value };
}

/** An alert or drive button click (controls.ts), or undefined when the click is something else (a decision). */
function controlOf(body: Buffer): { team: string; user: string; control: Control; quote: string } | undefined {
  const p = payloadOf(body);
  if (!record(p) || p.type !== "block_actions" || !Array.isArray(p.actions) || !p.actions.some((x) => record(x) && isControl(x.action_id))) return undefined;
  if (p.actions.length !== 1) bad("a click is exactly one action");
  const a = p.actions[0] as Record<string, unknown>;
  const team = text(record(p.team) ? p.team.id : undefined, "team.id"), user = text(record(p.user) ? p.user.id : undefined, "user.id");
  const quote = record(a.text) && typeof a.text.text === "string" ? a.text.text.trim() : "";
  if (quote.length < 2 || quote.length > 2000) bad("the button's label must be the person's words (2..2000 characters)");
  return { team, user, control: parseControl(a.action_id as string, a.value), quote };
}

/** How a click proves where it came from: Slack's signature over the request (HTTP), or the Socket Mode connection
 *  `govern slack serve` opened with the app-level token (nothing signs the payload: the connection is the proof). */
type Proof = { kind: "signed"; secret: string; timestamp: string | undefined; signature: string | undefined }
  | { kind: "socket"; envelope: string };

/** How long a Socket Mode click is remembered: a Tayet sidecar sends a click decided while nobody was connected to the
 *  first connection that opens, however late, so the clock cannot refuse a repeat as it does a signed request's. */
export const SOCKET_SEEN_SECONDS = 7 * 24 * 3600;

/** What makes one Socket Mode click unique: the clicked message, the person, the button and the click's time (a block
 *  action), or the envelope (anything else). A redelivered click has the same identity and is refused as a repeat. */
function clickIdentity(raw: unknown, envelope: string): string {
  if (record(raw) && raw.type === "block_actions" && Array.isArray(raw.actions) && record(raw.actions[0])) {
    const container = record(raw.container) ? raw.container : {}, act = raw.actions[0];
    const parts = [record(raw.channel) ? raw.channel.id : container.channel_id, container.message_ts, record(raw.user) ? raw.user.id : undefined,
      act.action_id, act.action_ts];
    if (parts.every((x) => typeof x === "string" && x)) return `socket:click:${parts.join(":")}`;
  }
  return `socket:envelope:${envelope}`;
}

/** The message a click closed on a single-answer server: its channel and ts, when the payload says. */
function clickedMessage(raw: unknown): { channel: string; ts: string } | undefined {
  if (!record(raw) || raw.type !== "block_actions") return undefined;
  const container = record(raw.container) ? raw.container : {};
  const channel = record(raw.channel) && typeof raw.channel.id === "string" ? raw.channel.id : container.channel_id;
  const ts = container.message_ts ?? (record(raw.message) ? raw.message.ts : undefined);
  return typeof channel === "string" && typeof ts === "string" ? { channel, ts } : undefined;
}

/** Verify, record, then report the outcome through Slack's response URL. Failed feedback never reverses a decision. */
export async function handleInteraction(secret: string, body: Buffer, ts: string | undefined, sig: string | undefined,
  o: InteractionOptions = {}): Promise<InteractionResult> {
  return interact(body, { kind: "signed", secret, timestamp: ts, signature: sig }, o);
}

/** A Socket Mode `interactive` envelope's payload (socket.ts), decided as a signed request is, minus the signature. */
export async function handleSocketInteraction(payload: unknown, envelope: string, o: InteractionOptions = {}): Promise<InteractionResult> {
  return interact(Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "utf8"), { kind: "socket", envelope }, o);
}

async function interact(body: Buffer, proof: Proof, o: InteractionOptions): Promise<InteractionResult> {
  const server = o.server ?? serverOf(slackConfig());
  let url: string | undefined, update: (() => { text: string; blocks: unknown[] }) | undefined, result: InteractionResult;
  /** Set while a form submission is being decided: a refusal is then shown in the form (under this input). */
  let form: string | undefined;
  let raw: unknown;
  try {
    const at = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (proof.kind === "signed") verifySignature(proof.secret, proof.timestamp, proof.signature, body, at);
    // Extract feedback before action parsing so authenticated payload refusals can explain themselves too.
    try { url = responseUrl(body, server.api); raw = payloadOf(body); } catch (e) {
      if (e instanceof SyntaxError) throw new BadRequest("the payload is not JSON");
      throw e;
    }
    const admit = () => proof.kind === "signed" ? remember(proof.signature!, at) : remember(clickIdentity(raw, proof.envelope), at, SOCKET_SEEN_SECONDS);
    const source = (team: string, user: string): SlackSource => proof.kind === "signed"
      ? { kind: "slack", team, user, timestamp: proof.timestamp!, signedBody: body.toString("utf8"), signature: proof.signature! }
      : { kind: "slack-socket", team, user, envelope: proof.envelope, payload: JSON.stringify(raw) };
    const c = controlOf(body);
    if (record(raw) && raw.type === "view_submission") {
      admit();
      const s = parseSubmission(raw);
      form = firstBlock(raw) ?? "";
      const a = submitted(s);
      const line = perform(a, source(a.team, a.user));
      result = { status: 200, value: { ok: true, text: line }, reply: { response_action: "clear" } };
      try { url = s.meta.url ? safeUrl(s.meta.url, server.api) : undefined; } catch { url = undefined; }
      update = () => decidedMessage(postedMessage(`${a.lane}:gate:${s.meta.gate}`, s.meta.ts), a, line, server.singleAnswer);
      form = undefined;
    } else if (publishOf(raw)) {
      const { team, user, value } = publishOf(raw)!;
      admit();
      const cfg = slackConfig() ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
      if (team !== cfg.team) throw new Forbidden(`the request comes from Slack team ${team}, not ${cfg.team}`);
      if (!cfg.route?.publishers?.includes(user) || !cfg.inbox) throw new Forbidden(`Slack user ${user} is not one of slack.route.publishers`);
      const { reply, digest } = parsePublish(value);
      approvePublish(cfg.inbox, reply, digest, user, source(team, user));
      const line = `Approved by <@${user}> · govern slack listen posts it in the request's thread`;
      result = { status: 200, value: { ok: true, text: line } };
      update = () => closed(body, line, server.singleAnswer);
    } else if (c) {
      admit();
      const line = inLaneWorkspace(c.team, c.control.lane, () => performControl(c.control, (p) => personOf(p, c.user), source(c.team, c.user), c.quote, at));
      result = { status: 200, value: { ok: true, text: line } };
      update = () => closed(body, line, server.singleAnswer);
    } else {
      const a = parseAction(body);
      admit();
      if (a.form) {
        result = { status: 200, value: { ok: true, text: await openForm(a, raw as Record<string, unknown>, url, o.call) } };
        url = undefined;
        return result;
      }
      const line = perform(a, source(a.team, a.user));
      result = { status: 200, value: { ok: true, text: line } };
      update = () => decided(body, a, line, server.singleAnswer);
    }
  } catch (e) {
    const status = STATUS(e), error = status === 500 ? "decision failed" : (e as Error).message;
    result = { status, value: { ok: false, error } };
    if (status === 500) process.stderr.write(`slack: ${nowIso()} decision failed; inspect the lane ledger\n`);
    if (form !== undefined) {
      // Slack shows a form's errors only on a 200 answer naming an input.
      const block = e instanceof FormRefusal ? e.block : form;
      result = { status: 200, value: { ok: false, error }, reply: { response_action: "errors", errors: { [block]: error.slice(0, 300) } } };
      url = undefined;
    }
  }
  // A single-answer server closed the clicked message whatever happened here: notify posts a new one for anything it asked
  // that still waits on people. An unauthenticated request marks nothing.
  const clicked = server.singleAnswer && result.status !== 401 ? clickedMessage(raw) : undefined;
  if (clicked) {
    try { markAnswered(clicked.channel, clicked.ts); } catch { process.stderr.write("slack: could not mark the closed message; notify will not repost it\n"); }
  }
  if (url) {
    // A single-answer server has no ephemeral messages: a refusal replaces the closed message, saying a new one follows.
    const refusal = server.singleAnswer
      ? { replace_original: true, ...forServer(server, closed(body, `Refused: ${result.value.error} · a new message follows if this still waits on someone`, true)) }
      : { replace_original: false, response_type: "ephemeral", text: `Refused: ${result.value.error}` };
    try {
      const response = await (o.request ?? fetch)(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(result.value.ok && update
          ? { replace_original: true, response_type: "in_channel", ...forServer(server, update()) }
          : refusal) });
      if (!response.ok) throw new Error("refused");
    } catch { process.stderr.write("slack: response update failed; decision outcome retained; notify will reconcile\n"); }
  }
  return result;
}

/** The Slack interactivity server (not yet listening): POST /slack/actions with Slack's signed form body of at most
 *  MAX_BODY bytes. 200 {ok, text} when the decision is recorded; 401 (signature, clock, replay), 400 (payload), 403 (team,
 *  person), 404 (path, lane), 409 (a refused decision), 413 (size) or 500 otherwise, as {ok: false, error}. `now` is the
 *  clock in seconds. Fails when the secret is shorter than 16 characters. */
export function slackServer(secret: string, o: InteractionOptions = {}): Server {
  if (secret.length < 16) fail("SLACK_SIGNING_SECRET must contain at least 16 characters");
  const server = createServer((req, res) => {
    const reply = (status: number, value: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || req.url !== "/slack/actions") {
      reply(404, { ok: false, error: "POST /slack/actions required" });
      req.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) reply(413, { ok: false, error: `the request exceeds ${MAX_BODY} bytes` });
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      const timestamp = req.headers["x-slack-request-timestamp"], signature = req.headers["x-slack-signature"];
      void handleInteraction(secret, Buffer.concat(chunks), typeof timestamp === "string" ? timestamp : undefined,
        typeof signature === "string" ? signature : undefined, o).then(r => reply(r.status, r.reply ?? r.value));
    });
    req.on("error", () => reply(400, { ok: false, error: "incomplete request" }));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
