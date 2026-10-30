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
import { stateDir, slackConfig } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { BadRequest, Forbidden, NotFound, TooLarge } from "../../lib/http-errors.ts";
import { GovernError, fail, nowIso } from "../../lib/util.ts";
import type { Source } from "../../lib/approval.ts";

/** How far a request's timestamp may be from the server's clock (Slack's own recommendation), in seconds. */
export const SKEW_SECONDS = 300;
/** How long a received signature is remembered: longer than the clock window, so a replay is refused either way. */
const SEEN_SECONDS = 2 * SKEW_SECONDS;
export const MAX_BODY = 65536;
/** The action_id of every button govern makes; other buttons in the same app are not decisions. */
export const ACTION_ID = "govern.decide";

/** A request whose signature, timestamp or freshness does not prove it came from Slack (401). */
export class Unauthorized extends GovernError {}

/** What a decision applies to: a gate of the lane, or the human task of one of its stages. */
export type Target = { gate: string } | { task: string };
export type Decision = "approve" | "reject" | "complete";
/** One verified button click: who clicked it, in which team, the button's typed value and its label (the person's words). */
export interface SlackAction { team: string; user: string; lane: string; target: Target; decision: Decision; digest: string; quote: string }

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
const VALUE_KEYS = new Set(["v", "lane", "gate", "task", "decision", "digest"]);

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
  if (!record(action) || action.action_id !== ACTION_ID) return bad(`the action is not a ${ACTION_ID} button`);
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
  const label = record(action.text) && typeof action.text.text === "string" ? action.text.text.trim() : "";
  if (label.length < 2 || label.length > 2000) bad("the button's label must be the person's words (2..2000 characters)");
  return { team, user, lane, target, decision: decision as Decision, digest, quote: label };
}

/** The version of `p` a decision is made for: its case data and its loop counters, as a SHA-256 hex digest. A change to
 *  either (new data, a loop that repeated) makes every button made before it refuse. */
export function caseDigest(p: Pick<Project, "data" | "workflow">): string {
  const data = Object.entries(p.data ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const loops = Object.entries(p.workflow?.loops ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ data, loops })).digest("hex");
}

/** The value of a govern.decide button deciding `target` of lane `p` with `decision`, bound to the case as it is now. */
export function decisionValue(p: Project, target: Target, decision: Decision): string {
  return JSON.stringify({ v: 1, lane: p.slug, ...target, decision, digest: caseDigest(p) });
}

const seenDir = () => join(stateDir(), "slack");
/** Remember `signature` until it can no longer pass the clock check; fails (Unauthorized) when it was already received. */
function remember(signature: string, now: number): void {
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
    seen[key] = now + SEEN_SECONDS;
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(seen) + "\n", { mode: 0o600 });
    renameSync(tmp, f);
  });
}

/** The process person whose Slack user id is `user`; Forbidden when none is. */
function personOf(p: Project, user: string): string {
  const people = processOf(p).people ?? {};
  return Object.keys(people).find((id) => people[id]!.slack === user)
    ?? (() => { throw new Forbidden(`Slack user ${user} is no person of ${p.slug}'s process (map it as people.<id>.slack)`); })();
}

/** Record `a` on its lane as the mapped person's decision, under the lane lock: a policy vote (a reject follows the
 *  policy's rejectTo), the owner's approval of a gate without a policy, or the completion of a human task (claimed first
 *  when nobody holds it). Returns the line the server replies with. */
export function perform(a: SlackAction, source: Extract<Source, { kind: "slack" }>): string {
  const team = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (a.team !== team) throw new Forbidden(`the request comes from Slack team ${a.team}, not ${team}`);
  let slug: string;
  try { slug = checkSlug(a.lane); } catch (e) { return bad((e as Error).message); }
  if (!existsSync(stateFile(slug))) throw new NotFound(`no lane ${slug}`);
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
    if (g.policy) {
      const decision = a.decision === "reject" ? "reject" : "approve";
      const vote = policyVote(p, g, person, decision, a.quote);
      if (decision === "reject") rejectRoute(p, g);
      p.notes.push({ at: vote.at, stage: p.stage, text: `${person} ${decision} ${g.name}: "${a.quote}"` });
      save(p);
      appendLedger(slug, { kind: decision, gate: g.name, ...vote, source });
      return `${slug}: ${g.name} ${decision} by ${person} · ${gateApproved(p, g) ? "approved" : "not approved"}`;
    }
    if (a.decision !== "approve") fail(`${g.name} has no approval policy: it can only be approved`);
    ownerApproval(p, g, person, a.quote, () => source);
    save(p);
    const { by } = p.approvals[g.name]!;
    appendLedger(slug, { kind: "approve", gate: g.name, quote: a.quote, by, source });
    return `${slug}: ${g.name} approved by ${by}`;
  });
}

const STATUS = (e: unknown): number =>
  e instanceof Unauthorized ? 401 : e instanceof BadRequest ? 400 : e instanceof Forbidden ? 403 : e instanceof NotFound ? 404
    : e instanceof TooLarge ? 413 : e instanceof GovernError ? 409 : 500;

/** The Slack interactivity server (not yet listening): POST /slack/actions with Slack's signed form body of at most
 *  MAX_BODY bytes. 200 {ok, text} when the decision is recorded; 401 (signature, clock, replay), 400 (payload), 403 (team,
 *  person), 404 (path, lane), 409 (a refused decision), 413 (size) or 500 otherwise, as {ok: false, error}. `now` is the
 *  clock in seconds. Fails when the secret is shorter than 16 characters. */
export function slackServer(secret: string, o: { now?: () => number } = {}): Server {
  if (secret.length < 16) fail("SLACK_SIGNING_SECRET must contain at least 16 characters");
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
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
      const body = Buffer.concat(chunks);
      try {
        const timestamp = req.headers["x-slack-request-timestamp"], signature = req.headers["x-slack-signature"];
        const ts = typeof timestamp === "string" ? timestamp : undefined, sig = typeof signature === "string" ? signature : undefined;
        const at = now();
        verifySignature(secret, ts, sig, body, at);
        const a = parseAction(body);
        remember(sig!, at);
        const line = perform(a, { kind: "slack", team: a.team, user: a.user, timestamp: ts!, signedBody: body.toString("utf8"), signature: sig! });
        reply(200, { ok: true, text: line });
      } catch (e) {
        const status = STATUS(e);
        reply(status, { ok: false, error: status === 500 ? "decision failed" : (e as Error).message });
        if (status === 500) process.stderr.write(`slack: ${nowIso()} ${(e as Error).stack ?? String(e)}\n`);
      }
    });
    req.on("error", () => reply(400, { ok: false, error: "incomplete request" }));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
