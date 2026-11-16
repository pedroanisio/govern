// Alert buttons (SLACK.md): a timer alert can be acknowledged, snoozed for an hour or taken (its stage's human task
// claimed); a stage govern drive left to the operator can be retried. Like a decision, each click is checked by the
// decision server (slack.ts: signature, clock, replay, team) and recorded as the mapped person's own with the signed
// request as its source. None of them approves a gate or completes a task.
import { appendLedger, checkSlug, load, save, stateFile, type Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { humanAction } from "../../lib/business.ts";
import { transaction } from "../../lib/lifecycle.ts";
import { retryFailed } from "../business/drive.ts";
import type { Alert } from "../../lib/lifecycle-schema.ts";
import type { SlackSource } from "../../lib/approval.ts";
import { BadRequest, NotFound } from "../../lib/http-errors.ts";
import { fail, nowIso } from "../../lib/util.ts";
import { existsSync } from "node:fs";
import { ACTIONS_BLOCK } from "./pending.ts";

export const ALERT_ID = "govern.alert", DRIVE_ID = "govern.drive";
/** How long Snooze hides an alert, in seconds. */
export const SNOOZE_SECONDS = 3600;

export type AlertAction = "ack" | "snooze" | "take";
/** One verified alert button click: an action on a lane's timer alert, or a retry of a stage drive gave up on. */
export type Control =
  | { kind: "alert"; lane: string; alert: string; action: AlertAction }
  | { kind: "drive"; lane: string; stage: string; round: number };

const bad = (m: string): never => { throw new BadRequest(m); };
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ALERT_KEYS = new Set(["v", "lane", "alert", "action"]), DRIVE_KEYS = new Set(["v", "lane", "stage", "round", "action"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Whether a Slack action id is one of these buttons. */
export const isControl = (id: unknown): boolean => typeof id === "string" && (id.startsWith(`${ALERT_ID}.`) || id.startsWith(`${DRIVE_ID}.`));

/** The control a button value names, refusing (BadRequest) anything but the exact shape this module makes. */
export function parseControl(actionId: string, raw: unknown): Control {
  let v: unknown;
  try { v = JSON.parse(typeof raw === "string" ? raw : bad("the button value is missing")); } catch (e) { return e instanceof BadRequest ? bad(e.message) : bad("the button value is not JSON"); }
  if (!record(v) || v.v !== 1) return bad("the button value is not a version 1 object");
  const keys = actionId.startsWith(`${ALERT_ID}.`) ? ALERT_KEYS : DRIVE_KEYS;
  for (const k of Object.keys(v)) if (!keys.has(k)) bad(`the button value has an unknown field ${k}`);
  const lane = typeof v.lane === "string" ? v.lane : bad("the button value names no lane");
  if (keys === ALERT_KEYS) {
    if (v.action !== "ack" && v.action !== "snooze" && v.action !== "take") return bad("an alert action is ack, snooze or take");
    if (actionId !== `${ALERT_ID}.${v.action}`) bad("the button's action_id does not match its value");
    if (typeof v.alert !== "string" || !NAME.test(v.alert)) bad("the button value names no alert");
    return { kind: "alert", lane, alert: v.alert as string, action: v.action };
  }
  if (v.action !== "retry" || actionId !== `${DRIVE_ID}.retry`) return bad("a drive action is retry");
  if (typeof v.stage !== "string" || !NAME.test(v.stage)) bad("the button value names no stage");
  if (typeof v.round !== "number" || !Number.isSafeInteger(v.round) || v.round < 0) bad("the button value's round is not a whole number");
  return { kind: "drive", lane, stage: v.stage as string, round: v.round as number };
}

const button = (action_id: string, label: string, value: unknown, style?: "primary" | "danger") =>
  ({ type: "button", action_id, text: { type: "plain_text", text: label }, value: JSON.stringify(value), ...(style ? { style } : {}) });

/** The buttons of a timer alert: Acknowledge and Snooze 1h, and Take it while its stage's human task is unclaimed. */
export function alertButtons(p: Project, a: Alert): { type: "actions"; block_id: string; elements: unknown[] } {
  const value = (action: AlertAction) => ({ v: 1, lane: p.slug, alert: a.id, action });
  const stage = processOf(p).stages.find((s) => s.name === a.stage), task = p.humanTasks?.[a.stage];
  const take = !!stage?.human && !!task && !task.assignee && !task.completedAt;
  return { type: "actions", block_id: ACTIONS_BLOCK, elements: [button(`${ALERT_ID}.ack`, "Acknowledge", value("ack"), "primary"),
    button(`${ALERT_ID}.snooze`, "Snooze 1h", value("snooze")), ...(take ? [button(`${ALERT_ID}.take`, "Take it", value("take"))] : [])] };
}
/** The button of a stage drive left to the operator: Retry stage. */
export const driveButtons = (lane: string, stage: string, round: number) =>
  ({ type: "actions", block_id: ACTIONS_BLOCK, elements: [button(`${DRIVE_ID}.retry`, "Retry stage", { v: 1, lane, stage, round, action: "retry" }, "primary")] });

/** Slack mrkdwn naming person `id` of `p`'s process: their Slack mention when mapped. */
export const mention = (p: Project, id: string): string => { const u = processOf(p).people?.[id]?.slack; return u ? `<@${u}>` : id; };
/** A time Slack shows in each reader's own time zone. */
export const when = (iso: string): string => `<!date^${Math.floor(Date.parse(iso) / 1000)}^{time} on {date_short}|${iso}>`;

/** Record `c` as `person`'s (`personOf` maps the Slack user, Forbidden otherwise) and return the line saying what was
 *  done. `quote` is the button's label. A retry clears the drive failure before the lane is locked, so it never waits on
 *  the lane while holding the driver's lock (the driver takes them in the other order). */
export function performControl(c: Control, personOf: (p: Project) => string, source: SlackSource,
  quote: string, now: number): string {
  let slug: string;
  try { slug = checkSlug(c.lane); } catch (e) { return bad((e as Error).message); }
  if (!existsSync(stateFile(slug))) throw new NotFound(`no lane ${slug}`);
  if (c.kind === "drive") {
    const person = personOf(load(slug));
    retryFailed(slug, c.stage, c.round);
    transaction(slug, () => appendLedger(slug, { kind: "drive-retry", stage: c.stage, round: c.round, by: person, quote, source }));
    return `Retry by ${mention(load(slug), person)}: govern drive sends the ${c.stage} stage again`;
  }
  return transaction(slug, () => {
    const p = load(slug), person = personOf(p);
    const alert = p.alerts?.find((a) => a.id === c.alert) ?? fail(`${slug} has no alert ${c.alert}`);
    if (alert.acknowledgedAt) fail(`alert ${c.alert} is already acknowledged`);
    if (c.action === "ack") {
      alert.acknowledgedAt = nowIso(); save(p);
      appendLedger(slug, { kind: "alert-ack", id: alert.id, by: person, source });
      return `Acknowledged by ${mention(p, person)}`;
    }
    if (c.action === "snooze") {
      const until = new Date((now + SNOOZE_SECONDS) * 1000).toISOString();
      alert.snoozedUntil = until; save(p);
      appendLedger(slug, { kind: "alert-snooze", id: alert.id, until, by: person, source });
      return `Snoozed until ${when(until)} by ${mention(p, person)}`;
    }
    humanAction(p, alert.stage, "claim", person, quote); save(p);
    appendLedger(slug, { kind: "human-claim", stage: alert.stage, by: person, quote, source });
    return `Taken by ${mention(p, person)}: the ${alert.stage} task is theirs`;
  });
}
