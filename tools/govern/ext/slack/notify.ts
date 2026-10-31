// govern slack notify: tells people in Slack what the lanes wait on from them, and nothing else. Each active human task,
// each gate that can be decided now, and each open timer alert is posted once to the configured channel, mentioning the
// people who may decide it; a decision's buttons carry the case digest the decision server checks (slack.ts). When the
// decision is made, or the case changes under the message, the message is updated without its buttons. What was posted
// is kept under the state folder's slack/, so a run posts only what changed since the last one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, laneSlugs, type Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { activeStages, eligibleHuman, eligibleApprover, gateApproved } from "../../lib/business.ts";
import { stateDir, slackConfig } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { GovernError, fail } from "../../lib/util.ts";
import { channelAlerts } from "./route.ts";
import { slackCall } from "./channel.ts";
import { ACTION_ID, caseDigest, decisionValue, optionSet, type Decision, type Target } from "./slack.ts";
import type { Scalar } from "../../lib/business-schema.ts";

/** One thing a lane waits on from people: a human task or a gate, who may decide it, and how. */
export interface Pending { key: string; lane: string; target: Target; decisions: Decision[]; people: string[];
  /** A gate's approve options as they stand on the case: each its label and the fields it sets. */
  options?: { label: string; set: Record<string, Scalar> }[] }
export interface NotifyOptions { api?: string; token: string; channel: string; lanes?: string[]; dryRun?: boolean;
  labels?: Partial<Record<Decision, string>> }
/** What one run did, by key (`lane:task:stage`, `lane:gate:name`, `lane:alert:id`); failed lines name the key and the reason. */
export interface NotifyReport { posted: string[]; closed: string[]; superseded: string[]; alerts: string[]; failed: string[] }

export const SLACK_API = "https://slack.com/api";
const LABELS: Record<Decision, string> = { complete: "Done", approve: "Approve", reject: "Send back" };

/** What `p` waits on from people now: its active human tasks not completed (for the assignee, else everyone eligible),
 *  and its gates at an active stage (or with no stage) whose needed gates are approved and which are not approved yet. */
export function pending(p: Project): Pending[] {
  if (p.finished) return [];
  const pr = processOf(p), people = Object.keys(pr.people ?? {}), active = activeStages(p), out: Pending[] = [];
  for (const stage of active) {
    if (!pr.stages.find((s) => s.name === stage)?.human) continue;
    const task = p.humanTasks?.[stage];
    if (task?.completedAt) continue;
    out.push({ key: `${p.slug}:task:${stage}`, lane: p.slug, target: { task: stage }, decisions: ["complete"],
      people: task?.assignee ? [task.assignee] : people.filter((id) => eligibleHuman(pr, stage, id)) });
  }
  for (const g of pr.gates) {
    if ((g.stage && !active.includes(g.stage)) || gateApproved(p, g)) continue;
    if ((g.needs ?? []).some((n) => !gateApproved(p, pr.gates.find((x) => x.name === n)))) continue;
    const excluded = new Set((g.policy?.excludeFields ?? []).map((f) => String(p.data?.[f])));
    const owner = g.owner ?? "owner";
    out.push({ key: `${p.slug}:gate:${g.name}`, lane: p.slug, target: { gate: g.name },
      decisions: g.policy ? ["approve", "reject"] : ["approve"],
      ...(g.options ? { options: g.options.map((o) => ({ label: o.label, set: optionSet(o, p) })) } : {}),
      people: g.policy ? people.filter((id) => eligibleApprover(pr, g, id) && !excluded.has(id)) : people.includes(owner) ? [owner] : [] });
  }
  return out;
}

interface Posted { lane: string; channel: string; ts: string; digest: string; text: string }
interface State { posted: Record<string, Posted>; alerts: Record<string, string> }
const dir = () => join(stateDir(), "slack");
const file = () => join(dir(), "posted.json");
function readState(): State {
  if (!existsSync(file())) return { posted: {}, alerts: {} };
  try { return JSON.parse(readFileSync(file(), "utf8")) as State; } catch (e) { return fail(`${file()} is not valid JSON (${(e as Error).message})`, 1); }
}
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

/** The message asking for `item`: who decides, what the stage or gate says, and one button per decision. */
function message(p: Project, item: Pending, labels: Record<Decision, string>): { text: string; blocks: unknown[] } {
  const pr = processOf(p), slack = item.people.map((id) => pr.people?.[id]?.slack).filter((u): u is string => !!u);
  const detail = "task" in item.target ? pr.stages.find((s) => s.name === (item.target as { task: string }).task)?.exit
    : pr.gates.find((g) => g.name === (item.target as { gate: string }).gate)?.message;
  const button = (id: string, label: string, d: Decision, set?: Record<string, Scalar>) => ({ type: "button", action_id: `${ACTION_ID}.${id}`,
    text: { type: "plain_text", text: label.slice(0, 75) }, style: d === "reject" ? "danger" : "primary", value: decisionValue(p, item.target, d, set) });
  const buttons = item.options
    ? [...item.options.map((o, i) => button(`option${i + 1}`, o.label, "approve", o.set)), ...item.decisions.filter((d) => d === "reject").map((d) => button(d, labels[d], d))]
    : item.decisions.map((d) => button(d, labels[d], d));
  const options = (item.options ?? []).map((o) => `*${o.label}*\n${Object.values(o.set).map((v) => `> ${String(v).replace(/\n/g, "\n> ")}`).join("\n")}`);
  return {
    text: `${p.title} (${p.slug}): ${plain(item.target)}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${heading(p)} · ${what(item.target)}${detail ? `\n${detail}` : ""}\n${slack.length ? slack.map((u) => `<@${u}>`).join(" ") : "_nobody with a Slack id may decide this_"}` } },
      ...options.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t.slice(0, 2900) } })),
      { type: "actions", block_id: "govern", elements: buttons },
    ],
  };
}

/** The text a message keeps once its buttons are gone. */
const closing = (text: string, why: string) => ({ text: `${text} — ${why}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `${text} — _${why}_` } }] });

/** Bring the channel up to date with the lanes (all, or `o.lanes`): post what is newly pending, update what was decided
 *  or changed, post each open alert once. A failed call is reported and retried on the next run; with dryRun nothing is
 *  sent or recorded. */
export async function notify(o: NotifyOptions): Promise<NotifyReport> {
  const api = o.api ?? SLACK_API, labels = { ...LABELS, ...o.labels };
  const report: NotifyReport = { posted: [], closed: [], superseded: [], alerts: [], failed: [] };
  const state = readState(), slugs = o.lanes ?? laneSlugs(), failures = driveFailures();
  const send = async (key: string, method: string, body: Record<string, unknown>) => {
    if (o.dryRun) return { ts: "dry-run", channel: o.channel };
    try { return await call(api, o.token, method, body); } catch (e) { report.failed.push(`${key}: ${(e as Error).message}`); return undefined; }
  };
  for (const slug of slugs) {
    let p: Project;
    try { p = load(slug); } catch (e) { report.failed.push(`${slug}: ${(e as Error).message}`); continue; }
    const items = pending(p), digest = caseDigest(p), keys = new Set(items.map((i) => i.key));
    for (const [key, rec] of Object.entries(state.posted)) {
      if (rec.lane !== slug || keys.has(key)) continue;
      const why = p.finished ? "decided; the case is finished" : `decided; no longer waiting (now at ${p.stage})`;
      if (await send(key, "chat.update", { channel: rec.channel, ts: rec.ts, ...closing(rec.text, why) })) {
        report.closed.push(key);
        if (!o.dryRun) delete state.posted[key];
      }
    }
    for (const item of items) {
      const rec = state.posted[item.key];
      if (rec?.digest === digest) continue;
      if (rec) {
        if (!(await send(item.key, "chat.update", { channel: rec.channel, ts: rec.ts, ...closing(rec.text, "the case changed: see the newer message") }))) continue;
        report.superseded.push(item.key);
        if (!o.dryRun) delete state.posted[item.key];
      }
      const m = message(p, item, labels);
      const sent = await send(item.key, "chat.postMessage", { channel: o.channel, ...m });
      if (!sent) continue;
      report.posted.push(item.key);
      if (!o.dryRun) state.posted[item.key] = { lane: slug, channel: sent.channel, ts: sent.ts, digest, text: m.text };
    }
    for (const f of failures.filter((x) => x.lane === slug)) {
      if (state.alerts[f.key]) continue;
      const text = `${p.title} (${slug}): the ${f.stage} stage needs a person — govern drive gave up after ${f.attempt} attempt${f.attempt === 1 ? "" : "s"}: ${f.reason}`;
      const sent = await send(f.key, "chat.postMessage", { channel: o.channel, text });
      if (!sent) continue;
      report.alerts.push(f.key);
      if (!o.dryRun) state.alerts[f.key] = sent.ts;
    }
    for (const alert of p.alerts ?? []) {
      const key = `${slug}:alert:${alert.id}`;
      if (alert.acknowledgedAt || state.alerts[key]) continue;
      const text = `${p.title} (${slug}): ${alert.kind} at ${alert.stage} — ${alert.message}`;
      const sent = await send(key, "chat.postMessage", { channel: o.channel, text });
      if (!sent) continue;
      report.alerts.push(key);
      if (!o.dryRun) state.alerts[key] = sent.ts;
    }
  }
  if (!o.lanes) {
    const known = new Set(slugs);
    for (const [key, rec] of Object.entries(state.posted)) {
      if (known.has(rec.lane)) continue;
      if (await send(key, "chat.update", { channel: rec.channel, ts: rec.ts, ...closing(rec.text, "the case no longer exists") })) {
        report.closed.push(key);
        if (!o.dryRun) delete state.posted[key];
      }
    }
  }
  const channelCfg = slackConfig();
  const channelConditions = channelCfg ? channelAlerts(channelCfg) : [];
  const activeChannelKeys = new Set(channelConditions.map(a => a.key));
  for (const [key, ts] of Object.entries(state.alerts)) {
    if (!key.startsWith("channel:") || activeChannelKeys.has(key)) continue;
    if (await send(key, "chat.update", { channel: o.channel, ts, ...closing(key, "condition cleared") })) {
      report.closed.push(key); if (!o.dryRun) delete state.alerts[key];
    }
  }
  for (const a of channelConditions) {
    if (state.alerts[a.key]) continue;
    const result = await send(a.key, "chat.postMessage", { channel: o.channel, text: a.text });
    if (result) { report.alerts.push(a.key); if (!o.dryRun) state.alerts[a.key] = result.ts; }
  }
  if (!o.dryRun) writeState(state);
  return report;
}
