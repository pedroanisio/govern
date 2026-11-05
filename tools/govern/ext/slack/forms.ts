// Slack forms (SLACK.md): with `slack.forms`, Send back opens a modal asking why, and an option with `edit` fields opens
// one with those fields prefilled. The decision server (slack.ts) checks the click, opens the form with views.open and
// records the decision only when the signed view_submission arrives. This module builds the form and reads the
// submission; it decides nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../lib/project.ts";
import type { Scalar } from "../../lib/business-schema.ts";
import { BadRequest, Forbidden } from "../../lib/http-errors.ts";
import { GovernError } from "../../lib/util.ts";
import { stateDir } from "../../lib/workspace.ts";
import type { Form } from "./slack.ts";

export const FORM_ID = "govern.form";
/** The longest text a Slack text input holds. */
export const FORM_TEXT = 3000;
export const REASON_BLOCK = "reason", FIELD_BLOCK = "field.";

/** What the form carries from the click to the submission (the view's private_metadata, which Slack keeps and returns
 *  unchanged): the decision the button named, its label, who clicked, and where the clicked message is. */
export interface FormMeta { v: 1; lane: string; gate: string; digest: string; form: Form; quote: string; user: string;
  /** The option whose fields are edited (an index into the gate's options). */
  option?: number;
  /** The click's response_url and the clicked message's ts, to close the message once decided. */
  url?: string; ts?: string }
const META_KEYS = new Set(["v", "lane", "gate", "digest", "form", "quote", "user", "option", "url", "ts"]);

/** A refusal shown in the form, under input `block`. */
export class FormRefusal extends GovernError {
  block: string;
  constructor(block: string, message: string) { super(message); this.block = block; }
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (m: string): never => { throw new BadRequest(m); };
const plain = (text: string) => ({ type: "plain_text", text });

/** The modal for `meta` on `p`: a required reason, or the option's editable fields prefilled with its values as they
 *  stand. Fails when a value is longer than a Slack text input holds, so a draft is never cut short silently. */
export function formView(p: Project, meta: FormMeta, option?: { label: string; set: Record<string, Scalar>; edit?: string[] }): Record<string, unknown> {
  const input = (block: string, label: string, extra: Record<string, unknown>) => ({ type: "input", block_id: block, label: plain(label.slice(0, 2000)),
    element: { type: "plain_text_input", action_id: "text", multiline: true, ...extra } });
  const fields = meta.form === "edit" ? (option?.edit ?? []).map((f) => {
    const value = String(option!.set[f] ?? "");
    if (value.length > FORM_TEXT) throw new GovernError(`${f} is longer than a Slack form holds (${FORM_TEXT} characters): edit it at the terminal`);
    return input(`${FIELD_BLOCK}${f}`, f, { max_length: FORM_TEXT, ...(value ? { initial_value: value } : {}) });
  }) : [input(REASON_BLOCK, "Why is it sent back?", { min_length: 2, max_length: 2000 })];
  return { type: "modal", callback_id: FORM_ID, private_metadata: JSON.stringify(meta),
    title: plain(meta.form === "edit" ? "Edit and approve" : "Send back"),
    submit: plain(meta.form === "edit" ? "Approve" : "Send back"), close: plain("Cancel"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${p.title}* (\`${p.slug}\`) · ${meta.gate}${option ? ` · ${option.label}` : ""}`.slice(0, 3000) } }, ...fields] };
}

/** A view_submission of a govern form, as Slack signed it: who submitted it, the form's meta, and each input's text. */
export interface Submission { team: string; user: string; meta: FormMeta; values: Record<string, string> }

/** The submission in payload `raw`, refusing (BadRequest) any other shape. */
export function parseSubmission(raw: Record<string, unknown>): Submission {
  const team = record(raw.team) && typeof raw.team.id === "string" && raw.team.id ? raw.team.id : bad("team.id is missing");
  const user = record(raw.user) && typeof raw.user.id === "string" && raw.user.id ? raw.user.id : bad("user.id is missing");
  const view = record(raw.view) ? raw.view : bad("the submission has no view");
  if (view.callback_id !== FORM_ID) bad(`the view is not a ${FORM_ID} form`);
  let m: unknown;
  try { m = JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : ""); } catch { return bad("the form's metadata is not JSON"); }
  if (!record(m) || m.v !== 1) return bad("the form's metadata is not a version 1 object");
  for (const k of Object.keys(m)) if (!META_KEYS.has(k)) bad(`the form's metadata has an unknown field ${k}`);
  const str = (k: string) => (typeof m[k] === "string" && m[k] ? m[k] : bad(`the form's metadata has no ${k}`)) as string;
  if (m.form !== "reason" && m.form !== "edit") bad("the form is reason or edit");
  if (m.form === "edit" && (typeof m.option !== "number" || !Number.isSafeInteger(m.option) || m.option < 0)) bad("an edit form names its option");
  const meta: FormMeta = { v: 1, lane: str("lane"), gate: str("gate"), digest: str("digest"), form: m.form as Form, quote: str("quote"), user: str("user"),
    ...(m.form === "edit" ? { option: m.option as number } : {}), ...(m.url !== undefined ? { url: str("url") } : {}), ...(m.ts !== undefined ? { ts: str("ts") } : {}) };
  const state = record(view.state) && record(view.state.values) ? view.state.values : bad("the submission has no values");
  const values: Record<string, string> = {};
  for (const [block, actions] of Object.entries(state)) {
    const a = record(actions) && record(actions.text) ? actions.text : bad(`input ${block} is not a govern text input`);
    values[block] = typeof a.value === "string" ? a.value : a.value === null || a.value === undefined ? "" : bad(`input ${block} is not text`);
  }
  return { team, user, meta, values };
}

/** The reason a reason form gives, trimmed; refused under its input when it is not 2..2000 characters. */
export function reasonOf(s: Submission): string {
  if (s.user !== s.meta.user) throw new Forbidden("this form was opened by someone else");
  const keys = Object.keys(s.values);
  if (keys.length !== 1 || keys[0] !== REASON_BLOCK) bad("a reason form has exactly its reason");
  const reason = s.values[REASON_BLOCK]!.trim();
  if (reason.length < 2 || reason.length > 2000) throw new FormRefusal(REASON_BLOCK, "a reason is 2 to 2000 characters");
  return reason;
}

/** `base` (the option's fields as the case stands) with the fields `edit` names replaced by the submitted text. Refused
 *  when the submission is not exactly those fields. */
export function editedSet(s: Submission, base: Record<string, Scalar>, edit: string[]): Record<string, Scalar> {
  if (s.user !== s.meta.user) throw new Forbidden("this form was opened by someone else");
  const want = edit.map((f) => `${FIELD_BLOCK}${f}`).sort(), got = Object.keys(s.values).sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) bad("the form's fields are not the option's editable fields");
  const set = { ...base };
  for (const f of edit) {
    const v = s.values[`${FIELD_BLOCK}${f}`]!;
    if (v.length > FORM_TEXT) throw new FormRefusal(`${FIELD_BLOCK}${f}`, `at most ${FORM_TEXT} characters`);
    set[f] = v;
  }
  return set;
}

/** The first input of a submission (where a refusal not tied to one input is shown). */
export const firstBlock = (raw: unknown): string | undefined => {
  const v = record(raw) && record(raw.view) && record(raw.view.state) && record(raw.view.state.values) ? Object.keys(raw.view.state.values) : [];
  return v[0];
};

/** The message `govern slack notify` posted for `key` at `ts`, as it posted it, or undefined when it has no record of it. */
export function postedMessage(key: string, ts: string | undefined): { text?: string; blocks?: unknown } | undefined {
  const f = join(stateDir(), "slack", "posted.json");
  if (!ts || !existsSync(f)) return undefined;
  try {
    const r = (JSON.parse(readFileSync(f, "utf8")) as { posted?: Record<string, { ts?: string; text?: string; blocks?: unknown }> }).posted?.[key];
    return r && r.ts === ts ? { ...(r.text ? { text: r.text } : {}), ...(r.blocks ? { blocks: r.blocks } : {}) } : undefined;
  } catch { return undefined; }
}
