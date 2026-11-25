// govern slack notify: tells people in Slack what the lanes wait on from them, and nothing else. Each active human task,
// each gate that can be decided now, and each open timer alert is posted once to the configured channel, mentioning the
// people who may decide it; a decision's buttons carry the case digest the decision server checks (slack.ts). When the
// decision is made, or the case changes under the message, the message is updated without its buttons. What was posted
// is kept under the state folder's slack/, so a run posts only what changed since the last one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, laneSlugs, type Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { stateDir, slackConfig } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { GovernError, fail } from "../../lib/util.ts";
import { channelAlerts } from "./route.ts";
import { watched, serviceAlerts } from "../../lib/services.ts";
import { slackCall } from "./channel.ts";
import { SLACK_API, forServer, serverOf, type SlackServer } from "./server.ts";
import { answered, answeredKey, claimAnswered } from "./answered.ts";
import { checkHeartbeat, heartbeatSettings } from "./heartbeat.ts";
import { ACTION_ID, caseDigest, decisionValue, type Decision, type Form, type Target } from "./slack.ts";
import { pending, settled, standing, targetOf, ACTIONS_BLOCK, type Pending } from "./pending.ts";
import { alertButtons, driveButtons, mention } from "./controls.ts";
import { offers, offerMessage, published } from "./publish.ts";
import { ledgerFile } from "../../lib/project.ts";
import { readJsonl } from "../../lib/util.ts";
import type { Scalar } from "../../lib/business-schema.ts";

export { pending, type Pending };

export interface NotifyOptions { api?: string; token: string; channel: string; alertsChannel?: string; lanes?: string[]; dryRun?: boolean;
  labels?: Partial<Record<Decision, string>>;
  /** One card per case, updated in place; what the case waits on and its alerts are posted in the card's thread. */
  threads?: boolean;
  /** slack.cards (implies threads): every open case has a card, posted on the first run that sees it; the card shows who holds the case and its last note, and each new lane note is posted
   *  in the card's thread (a note that came from the thread is not posted back). */
  cards?: boolean;
  /** Send back asks for a reason, and an option with `edit` fields gets an Edit button (Slack forms, forms.ts). */
  forms?: boolean;
  /** The server (server.ts): how many buttons a message may carry, and whether a click closes a message (a Tayet card).
   *  Default: Slack's. */
  server?: SlackServer;
  /** The Squad Lead's channel (slack.lead.channel, LEAD.md): each impediment posted here (a drive failure, a lane alert, a
   *  channel alert) and each decision still waiting after `leadWaitHours` also gets a one-line pointer there, once. */
  leadChannel?: string;
  /** Hours a decision may wait on people before the Lead's channel hears of it (default 8). */
  leadWaitHours?: number }
/** What one run did, by key (`lane:task:stage`, `lane:gate:name`, `lane:alert:id`); failed lines name the key and the reason;
 *  heartbeat lines say what the session heartbeat check posted (heartbeat.ts) and any state it rebuilt. */
export interface NotifyReport { posted: string[]; closed: string[]; superseded: string[]; alerts: string[]; failed: string[]; heartbeat: string[] }

export { SLACK_API };
const LABELS: Record<Decision, string> = { complete: "Done", approve: "Approve", reject: "Send back" };

/** A posted decision message: where it is, the case version its buttons are bound to, and its text and blocks as posted
 *  (records from before blocks were kept have none, and close as text). */
interface Posted { lane: string; channel: string; ts: string; digest: string; text: string; blocks?: unknown[];
  /** The further messages that carry the rest of the buttons, when the server allows fewer than the decision has. */
  parts?: { channel: string; ts: string; text: string; blocks: unknown[] }[] }
/** A case's card (slack.threads): where it is and the text it shows now; with slack.cards, `notes` is how many of the
 *  lane's notes the thread has caught up with (the notes before the card was posted are not posted). */
interface Card { channel: string; ts: string; text: string; notes?: number }
/** An alert's message while it can still close (its buttons gone once the alert is settled anywhere). */
interface AlertPost { channel: string; ts: string; text: string; blocks: unknown[] }
/** An offer of a routed reply to the publishers (publish.ts), until it is published. */
interface Review { channel: string; ts: string; blocks: unknown[] }
interface State { posted: Record<string, Posted>; alerts: Record<string, string>; cards?: Record<string, Card>; alertPosts?: Record<string, AlertPost>;
  reviews?: Record<string, Review>;
  /** Pointers posted in the Lead's channel, by key, and when each decision was first seen waiting (by its key). */
  lead?: { pointed: Record<string, string>; waiting: Record<string, string> } }
const dir = () => join(stateDir(), "slack");
const file = () => join(dir(), "posted.json");
function readState(): State {
  if (!existsSync(file())) return { posted: {}, alerts: {} };
  try { return JSON.parse(readFileSync(file(), "utf8")) as State; } catch (e) { return fail(`${file()} is not valid JSON (${(e as Error).message})`, 1); }
}
/** The alerts the notifier has open: what the digest needs to keep listing a unit that is mid-rerun. */
export const openAlerts = (): Set<string> => new Set(Object.keys(readState().alerts));
function writeState(s: State): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  withLaneLock(join(dir(), "lock"), () => {
    const tmp = `${file()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file());
  });
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The stages `govern drive` left to the operator (its state under the state folder's drive/), by lane:stage. A file that
 *  is not the driver's JSON is reported, never read as "no failures". */
export function driveFailures(): { key: string; lane: string; stage: string; round: number; attempt: number; reason: string }[] {
  const f = join(stateDir(), "drive", "state.json");
  if (!existsSync(f)) return [];
  let runs: unknown;
  try { runs = JSON.parse(readFileSync(f, "utf8")); } catch (e) { return fail(`${f} is not valid JSON (${(e as Error).message})`, 1); }
  if (!record(runs)) return fail(`${f} is not the driver's state`, 1);
  return Object.entries(runs).flatMap(([k, r]) => {
    if (!record(r) || r.state !== "failed") return [];
    const i = k.lastIndexOf(":"), lane = k.slice(0, i), stage = k.slice(i + 1);
    return [{ key: `${lane}:drive:${stage}:${Number(r.round)}`, lane, stage, round: Number(r.round), attempt: Number(r.attempt), reason: String(r.reason ?? "no reason recorded") }];
  });
}
/** One Slack Web API call: its ts and channel, or a GovernError naming the method and Slack's reason. */
async function call(api: string, token: string, method: string, body: Record<string, unknown>): Promise<{ ts: string; channel: string }> {
  const j = await slackCall(api, token)(method, body);
  if (typeof j.ts !== "string" || typeof j.channel !== "string") throw new GovernError(`${method}: Slack's answer has no ts or channel`);
  return { ts: j.ts, channel: j.channel };
}

const what = (t: Target) => ("task" in t ? `task *${t.task}*` : `decision *${t.gate}*`);
const plain = (t: Target) => ("task" in t ? `task ${t.task}` : `decision ${t.gate}`);
const heading = (p: Project) => `*${p.title}* (\`${p.slug}\`)`;

/** The message asking for `item`: who decides, what the stage or gate says, and one button per decision. A decision with
 *  more buttons than the server allows (`max`) gets further messages, each with the next buttons, under `more`. */
function message(p: Project, item: Pending, labels: Record<Decision, string>, forms = false, max = 25): { text: string; blocks: unknown[]; more: { text: string; blocks: unknown[] }[] } {
  const pr = processOf(p), slack = item.people.map((id) => pr.people?.[id]?.slack).filter((u): u is string => !!u);
  const detail = "task" in item.target ? pr.stages.find((s) => s.name === (item.target as { task: string }).task)?.exit
    : pr.gates.find((g) => g.name === (item.target as { gate: string }).gate)?.message;
  const button = (id: string, label: string, d: Decision, set?: Record<string, Scalar>, form?: Form) => ({ type: "button", action_id: `${ACTION_ID}.${id}`,
    text: { type: "plain_text", text: label.slice(0, 75) }, ...(form === "edit" ? {} : { style: d === "reject" ? "danger" : "primary" }),
    value: decisionValue(p, item.target, d, set, form) });
  const reject = (d: Decision) => button(d, labels[d], d, undefined, forms && d === "reject" ? "reason" : undefined);
  const buttons = item.options
    ? [...item.options.flatMap((o, i) => [button(`option${i + 1}`, o.label, "approve", o.set),
      ...(forms && o.edit ? [button(`edit${i + 1}`, `Edit: ${o.label}`, "approve", o.set, "edit")] : [])]),
      ...item.decisions.filter((d) => d === "reject").map(reject)]
    : item.decisions.map(reject);
  const options = (item.options ?? []).map((o) => `*${o.label}*\n${Object.values(o.set).map((v) => `> ${String(v).replace(/\n/g, "\n> ")}`).join("\n")}`);
  const groups: unknown[][] = [];
  for (let i = 0; i < buttons.length; i += max) groups.push(buttons.slice(i, i + max));
  const text = `${p.title} (${p.slug}): ${plain(item.target)}`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${heading(p)} · ${what(item.target)}${detail ? `\n${detail}` : ""}\n${slack.length ? slack.map((u) => `<@${u}>`).join(" ") : "_nobody with a Slack id may decide this_"}` } },
      ...options.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t.slice(0, 2900) } })),
      { type: "actions", block_id: ACTIONS_BLOCK, elements: groups[0] ?? [] },
    ],
    more: groups.slice(1).map((g, i) => ({ text: `${text} (choices, ${i + 2} of ${groups.length})`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `${heading(p)} · ${what(item.target)} · more choices (${i + 2} of ${groups.length})` } },
        { type: "actions", block_id: ACTIONS_BLOCK, elements: g }] })),
  };
}

/** A case's card: its title and stage (or that it finished), and each thing it waits on with who may decide it. With
 *  slack.cards (`rich`) also who holds its human tasks, its last note, and that a reply in the thread is a note. */
function card(p: Project, items: Pending[], rich = false): { text: string; blocks: unknown[] } {
  const pr = processOf(p), who = (ids: string[]) => ids.map((id) => (pr.people?.[id]?.slack ? `<@${pr.people[id]!.slack}>` : id)).join(" ");
  const where = p.finished ? "Finished" : `stage *${p.stage}*`;
  const waiting = items.map((i) => `• ${what(i.target)} — ${i.people.length ? who(i.people) : "_nobody may decide this_"}`);
  const body = p.finished ? "" : waiting.length ? `\nWaiting on:\n${waiting.join("\n")}` : "\nNothing waits on people now.";
  const text = `${heading(p)} · ${where}${body}`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }];
  if (rich) {
    const held = Object.entries(p.humanTasks ?? {}).filter(([, t]) => t.assignee && !t.completedAt).map(([stage, t]) => `${who([t.assignee!])} (${stage})`);
    const last = p.notes.at(-1);
    const lines = [...(held.length ? [`Held by ${held.join(", ")}`] : []),
      ...(last ? [`Last note${last.by ? ` by ${who([last.by])}` : ""} [${last.stage}]: ${clip(last.text, 300)}`] : [])];
    if (lines.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, 2900) } });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Reply in this thread to add a note to the case." }] });
  }
  return { text: `${p.title} (${p.slug}): ${p.finished ? "finished" : p.stage}`, blocks };
}
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** A lane note as posted in its card's thread. */
const noteText = (n: { stage: string; text: string }) => clip(`note [${n.stage}]: ${n.text}`, 3000);

/** A posted message once its buttons are gone: what it asked, as posted, then one line saying who decided (when `p` says)
 *  and why it closed. A record without its blocks closes as one line of text. */
function closing(rec: Posted, key: string, why: string, p?: Project): { text: string; blocks: unknown[] } {
  const target = p && targetOf(key, rec.lane), decided = p && target ? standing(p, target) : undefined;
  const blocks = settled(rec.blocks, decided ? `${decided} · _${why}_` : `_${why}_`, false);
  return { text: `${rec.text} — ${why}`, blocks: blocks ?? [{ type: "section", text: { type: "mrkdwn", text: `${rec.text} — _${why}_` } }] };
}
/** An alert's message once its condition cleared. */
const cleared = (text: string, why: string) => ({ text: `${text} — ${why}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `${text} — _${why}_` } }] });

/** Bring the channel up to date with the lanes (all, or `o.lanes`): post what is newly pending, update what was decided
 *  or changed, post each open alert once. A failed call is reported and retried on the next run; with dryRun nothing is
 *  sent or recorded. */
export async function notify(o: NotifyOptions): Promise<NotifyReport> {
  const server = o.server ?? serverOf(undefined, { GOVERN_SLACK_API: o.api }), api = o.api ?? server.api, labels = { ...LABELS, ...o.labels };
  const report: NotifyReport = { posted: [], closed: [], superseded: [], alerts: [], failed: [], heartbeat: [] };
  const state = readState(), slugs = o.lanes ?? laneSlugs(), failures = driveFailures();
  const send = async (key: string, method: string, body: Record<string, unknown>) => {
    if (o.dryRun) return { ts: "dry-run", channel: o.channel };
    try { return await call(api, o.token, method, forServer(server, body as { text?: string; blocks?: unknown[] })); }
    catch (e) { report.failed.push(`${key}: ${(e as Error).message}`); return undefined; }
  };
  /** Close a decision message and the further messages that carried the rest of its buttons; true when all were updated. */
  const closeRecord = async (key: string, rec: Posted, why: string, p?: Project) => {
    let ok = !!(await send(key, "chat.update", { channel: rec.channel, ts: rec.ts, ...closing(rec, key, why, p) }));
    for (const part of rec.parts ?? []) {
      const blocks = settled(part.blocks, `_${why}_`, false);
      ok = !!(await send(key, "chat.update", { channel: part.channel, ts: part.ts, text: `${part.text} — ${why}`, ...(blocks ? { blocks } : {}) })) && ok;
    }
    return ok;
  };
  // A single-answer server closed these messages on a click (answered.ts): what they asked is posted again while it waits.
  const clicked = server.singleAnswer ? answered() : new Set<string>(), claimed: string[] = [];
  /** The marks of `rec`'s messages; claimed (forgotten) only once the record they concern is closed or replaced. */
  const clicksOf = (rec: Posted) => [rec, ...(rec.parts ?? [])].map((m) => answeredKey(m.channel, m.ts)).filter((k) => clicked.has(k));
  const lead = o.leadChannel ? (state.lead ??= { pointed: {}, waiting: {} }) : undefined;
  /** One line in the Lead's channel about `key`, once, linking the message it is about when there is one. */
  const point = async (key: string, text: string, at?: { channel: string; ts: string }) => {
    if (!lead || lead.pointed[key]) return;
    const link = at && at.ts !== "dry-run" ? ` · <https://slack.com/archives/${at.channel}/p${at.ts.replace(".", "")}|see it>` : "";
    const sent = await send(`lead:${key}`, "chat.postMessage", { channel: o.leadChannel!, text: `${text.slice(0, 2800)}${link}`, unfurl_links: false });
    if (sent) { report.posted.push(`lead:${key}`); if (!o.dryRun) lead.pointed[key] = sent.ts; }
  };
  const waitMs = (o.leadWaitHours ?? 8) * 3600_000, seenWaiting = new Set<string>();
  for (const slug of slugs) {
    let p: Project;
    try { p = load(slug); } catch (e) { report.failed.push(`${slug}: ${(e as Error).message}`); continue; }
    const items = pending(p), digest = caseDigest(p), keys = new Set(items.map((i) => i.key));
    for (const [key, rec] of Object.entries(state.posted)) {
      if (rec.lane !== slug || keys.has(key)) continue;
      const why = p.finished ? "decided; the case is finished" : `decided; no longer waiting (now at ${p.stage})`;
      if (await closeRecord(key, rec, why, p)) {
        claimed.push(...clicksOf(rec));
        report.closed.push(key);
        if (!o.dryRun) delete state.posted[key];
      }
    }
    // slack.threads: the case's card, posted once the case needs someone (or has an alert), then kept up to date; with
    // slack.cards, every open case has its card (a finished case that never had one gets none). A card
    // that cannot be posted holds the lane's posts back, so they never land outside its thread.
    let thread: string | undefined;
    if (o.threads || o.cards) {
      const cards = (state.cards ??= {}), c = card(p, items, !!o.cards), had = cards[slug];
      const alerting = failures.some((f) => f.lane === slug && !state.alerts[f.key]) || (p.alerts ?? []).some((a) => !a.acknowledgedAt && !state.alerts[`${slug}:alert:${a.id}`]);
      if (had) {
        if (had.text !== JSON.stringify(c.blocks) && await send(`${slug}:card`, "chat.update", { channel: had.channel, ts: had.ts, ...c }) && !o.dryRun) cards[slug] = { ...had, text: JSON.stringify(c.blocks) };
        thread = had.ts;
      } else if (items.length || alerting || (o.cards && !p.finished)) {
        const sent = await send(`${slug}:card`, "chat.postMessage", { channel: o.channel, ...c });
        if (!sent) continue;
        report.posted.push(`${slug}:card`);
        if (!o.dryRun) cards[slug] = { channel: sent.channel, ts: sent.ts, text: JSON.stringify(c.blocks), ...(o.cards ? { notes: p.notes.length } : {}) };
        thread = sent.ts;
      }
      // slack.cards: the notes added since the thread last caught up, in order; a failed post is tried again next run.
      const kept = cards[slug];
      if (o.cards && kept && thread) {
        let next = Math.min(kept.notes ?? p.notes.length, p.notes.length);
        for (; next < p.notes.length; next++) {
          const n = p.notes[next]!;
          if (n.via === "slack") continue;
          if (!(await send(`${slug}:note:${next}`, "chat.postMessage", { channel: kept.channel, thread_ts: thread, text: noteText(n) }))) break;
          report.posted.push(`${slug}:note:${next}`);
        }
        if (!o.dryRun) kept.notes = next;
      }
    }
    const inThread = thread ? { thread_ts: thread } : {};
    if (lead) for (const item of items) {
      seenWaiting.add(item.key);
      const since = (lead.waiting[item.key] ??= new Date().toISOString());
      if (Date.now() - Date.parse(since) < waitMs) continue;
      const rec = state.posted[item.key];
      await point(`${item.key}:${since}`, `⏳ ${p.title} (${slug}) waits on people for over ${o.leadWaitHours ?? 8} h: ${item.key.slice(slug.length + 1)}`,
        rec ? { channel: rec.channel, ts: rec.ts } : undefined);
    }
    for (const item of items) {
      const rec = state.posted[item.key];
      const reopen = !!rec && clicksOf(rec).length > 0;
      if (rec?.digest === digest && !reopen) continue;
      if (rec) {
        const why = reopen ? "answered here; still waiting: see the newer message" : "the case changed: see the newer message";
        if (!(await closeRecord(item.key, rec, why, p))) continue;
        claimed.push(...clicksOf(rec));
        report.superseded.push(item.key);
        if (!o.dryRun) delete state.posted[item.key];
      }
      const { more, ...m } = message(p, item, labels, !!o.forms, server.maxButtons);
      const sent = await send(item.key, "chat.postMessage", { channel: o.channel, ...inThread, ...m });
      if (!sent) continue;
      const parts: NonNullable<Posted["parts"]> = [];
      for (const x of more) {
        const extra = await send(item.key, "chat.postMessage", { channel: o.channel, ...inThread, ...x });
        if (extra) parts.push({ channel: extra.channel, ts: extra.ts, ...x });
      }
      report.posted.push(item.key);
      if (!o.dryRun) state.posted[item.key] = { lane: slug, channel: sent.channel, ts: sent.ts, digest, text: m.text, blocks: m.blocks, ...(parts.length ? { parts } : {}) };
    }
    /** Post an alert with its buttons, once under `key`; `open` is the key its message is kept under while it can close. */
    const postAlert = async (key: string, open: string, text: string, actions: unknown) => {
      const blocks = [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }, actions];
      const sent = await send(key, "chat.postMessage", { channel: o.channel, ...inThread, text, blocks });
      if (!sent) return;
      report.alerts.push(key);
      if (!o.dryRun) { state.alerts[key] = sent.ts; (state.alertPosts ??= {})[open] = { channel: sent.channel, ts: sent.ts, text, blocks }; }
      await point(key, `🚧 ${text}`, sent);
    };
    /** Close the message kept under `open` with `line`, when there is one. */
    const closeAlert = async (open: string, line: string) => {
      const rec = state.alertPosts?.[open];
      if (!rec) return;
      const blocks = settled(rec.blocks, line, false);
      if (await send(open, "chat.update", { channel: rec.channel, ts: rec.ts, text: `${rec.text} — ${line}`, ...(blocks ? { blocks } : {}) })) {
        report.closed.push(open);
        if (!o.dryRun) delete state.alertPosts![open];
      }
    };
    const ledger = () => readJsonl(ledgerFile(slug));
    const laneFailures = failures.filter((x) => x.lane === slug);
    for (const f of laneFailures) {
      if (state.alerts[f.key]) continue;
      const text = `${p.title} (${slug}): the ${f.stage} stage needs a person — govern drive gave up after ${f.attempt} attempt${f.attempt === 1 ? "" : "s"}: ${f.reason}`;
      await postAlert(f.key, f.key, text, driveButtons(slug, f.stage, f.round));
    }
    // A failure drive no longer reports was retried (here or at the terminal): its message closes, and a later failure of
    // the same stage is a new post.
    for (const key of Object.keys(state.alertPosts ?? {})) {
      if (!key.startsWith(`${slug}:drive:`) || laneFailures.some((f) => f.key === key)) continue;
      const stage = key.slice(slug.length + ":drive:".length).replace(/:\d+$/, "");
      const by = ledger().findLast((x) => x.kind === "drive-retry" && x.stage === stage)?.by;
      await closeAlert(key, `${typeof by === "string" ? `Retry by ${mention(p, by)} · ` : ""}_no longer failed_`);
      if (!o.dryRun && !state.alertPosts?.[key]) delete state.alerts[key];
    }
    for (const alert of p.alerts ?? []) {
      const key = `${slug}:alert:${alert.id}`;
      if (alert.acknowledgedAt) {
        const by = ledger().findLast((x) => x.kind === "alert-ack" && x.id === alert.id)?.by;
        await closeAlert(key, `Acknowledged${typeof by === "string" ? ` by ${mention(p, by)}` : ""}`);
        continue;
      }
      const text = `${p.title} (${slug}): ${alert.kind} at ${alert.stage} — ${alert.message}`;
      if (alert.snoozedUntil) {
        // Snoozed: nothing until the snooze ends, then one new post, under a key the snooze names.
        if (Date.parse(alert.snoozedUntil) > Date.now()) continue;
        const again = `${key}:${alert.snoozedUntil}`;
        if (!state.alerts[again]) await postAlert(again, key, `${text} (still open after a snooze)`, alertButtons(p, alert));
        continue;
      }
      if (!state.alerts[key]) await postAlert(key, key, text, alertButtons(p, alert));
    }
  }
  if (!o.lanes) {
    const known = new Set(slugs);
    for (const [key, rec] of Object.entries(state.posted)) {
      if (known.has(rec.lane)) continue;
      if (await closeRecord(key, rec, "the case no longer exists")) {
        claimed.push(...clicksOf(rec));
        report.closed.push(key);
        if (!o.dryRun) delete state.posted[key];
      }
    }
    for (const [lane, c] of Object.entries(state.cards ?? {})) {
      if (known.has(lane)) continue;
      const gone = { text: `${lane}: the case no longer exists`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `\`${lane}\` · _the case no longer exists_` } }] };
      if (await send(`${lane}:card`, "chat.update", { channel: c.channel, ts: c.ts, ...gone }) && !o.dryRun) delete state.cards![lane];
    }
  }
  const channelCfg = slackConfig();
  const services = serviceAlerts(watched());
  const channelConditions = [...(channelCfg ? channelAlerts(channelCfg) : []), ...services.alerts];
  // A held unit's outcome is not known yet: its open alert stays open, so one failure episode is one post.
  const activeChannelKeys = new Set([...channelConditions.map(a => a.key), ...services.held.keys()]);
  for (const [key, ts] of Object.entries(state.alerts)) {
    if (!key.startsWith("channel:") || activeChannelKeys.has(key)) continue;
    if (await send(key, "chat.update", { channel: o.alertsChannel ?? o.channel, ts, ...cleared(key, "condition cleared") })) {
      report.closed.push(key); if (!o.dryRun) delete state.alerts[key];
    }
  }
  for (const a of channelConditions) {
    if (state.alerts[a.key]) continue;
    const result = await send(a.key, "chat.postMessage", { channel: o.alertsChannel ?? o.channel, text: a.text });
    if (result) { report.alerts.push(a.key); if (!o.dryRun) state.alerts[a.key] = result.ts; await point(a.key, `🚧 ${a.text}`, result); }
  }
  if (lead && !o.lanes && !o.dryRun) {
    // A decision no longer waiting starts its clock again if it waits once more; pointers are forgotten after 30 days.
    for (const k of Object.keys(lead.waiting)) if (!seenWaiting.has(k)) delete lead.waiting[k];
    for (const [k, ts] of Object.entries(lead.pointed)) if (Date.now() - Number(ts.split(".")[0]) * 1000 > 30 * 86400_000) delete lead.pointed[k];
  }
  // Routed replies whose content check passed, offered to the publishers in the review channel (publish.ts), and the
  // offer closed once the listener has published the reply.
  const route = channelCfg?.route;
  if (route?.publishers && !route.review) report.failed.push("slack.route.publishers: name the review channel as slack.route.review");
  if (route?.publishers && route.review && channelCfg?.inbox) {
    const inbox = channelCfg.inbox, reviews = (state.reviews ??= {});
    for (const [id, r] of Object.entries(reviews)) {
      if (!published(inbox, id)) continue;
      const blocks = settled(r.blocks, "Published to the thread", false) ?? [];
      if (await send(`review:${id}`, "chat.update", { channel: r.channel, ts: r.ts, text: "Published to the thread", blocks })) {
        report.closed.push(`review:${id}`); if (!o.dryRun) delete reviews[id];
      }
    }
    for (const offer of offers(inbox)) {
      if (reviews[offer.reply.id] || published(inbox, offer.reply.id)) continue;
      const m = offerMessage(offer), sent = await send(`review:${offer.reply.id}`, "chat.postMessage", { channel: route.review, ...m });
      if (sent) { report.posted.push(`review:${offer.reply.id}`); if (!o.dryRun) reviews[offer.reply.id] = { channel: sent.channel, ts: sent.ts, blocks: m.blocks }; }
    }
  }
  if (!o.dryRun) writeState(state);
  if (!o.dryRun && server.singleAnswer) claimAnswered(claimed);
  // The session heartbeat keeps its own state (heartbeat.ts); a check that cannot run is reported and the rest stands.
  try {
    const beat = channelCfg && heartbeatSettings(channelCfg);
    if (beat) {
      const r = await checkHeartbeat(slackCall(api, o.token), { ...beat, channel: o.channel }, { dryRun: o.dryRun });
      report.heartbeat.push(...r.notes, ...r.posted.map((k) => `posted ${k}`)); report.failed.push(...r.failed);
    }
  } catch (e) { report.failed.push(`heartbeat: ${(e as Error).message}`); }
  return report;
}
