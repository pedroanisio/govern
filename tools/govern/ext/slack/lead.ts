// The Squad Lead (LEAD.md): a workspace's Claude Code session that the people slack.lead.users name drive from their
// messages in slack.lead.channel. One app and one `govern slack serve` per deployment carry every Lead: serve maps each Lead
// channel to its workspace (its own and slack.serveRepos), keeps one `govern slack lead run` child per Lead workspace, and
// hands it that channel's events. The child is a chat (chat.ts) whose turns all go to one conversation, answered by the
// built-in adapter (lead-adapter.ts), which resumes the Lead's Claude session on the host. A tool use Claude asks to run is
// put to the Lead's people as a card in the Lead channel (lead-approve.ts); serve records the click, and the child posts
// and closes the cards.
//
// State, in the workspace's state folder under slack/lead/: session (the Claude session the Lead continues), mode (the
// permission mode a turn starts in, once someone changed it), cost (the session's running total, for each turn's share),
// audit.jsonl (mode changes and permission decisions, with the Slack request that made them), permissions/ (one request
// per ask, its decision and its card; also one per tool use auto mode's classifier blocked), allow/<session>.json (what
// was allowed for the rest of a session), grants.json (blocked tool uses allowed once, for the turn that runs them),
// turn-modes/ (the mode a turn a blocked card started runs in), activity.json (what the turn under way is doing, while
// one runs), files/<ts>/ (what a message attached, for the Lead to read).
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { configFile, checkConfig, forgetConfigs, inRepo, repo, slackConfig, stateDir, FOLDER_OVERRIDES, LEAD_MODES,
  type LeadConfig, type LeadMode } from "../../lib/workspace.ts";
import { BadRequest, Forbidden, NotFound } from "../../lib/http-errors.ts";
import { GovernError, fail, nowIso } from "../../lib/util.ts";
import { randomUUID } from "node:crypto";
import { ACTIONS_BLOCK, OUTCOME_BLOCK } from "./pending.ts";
import type { SlackSource } from "../../lib/approval.ts";
import * as sessions from "../../lib/conversation.ts";
import { chatBot, mrkdwn, openQuestions, CHOICE_CHARS } from "./chat.ts";
import { slackCall, type Call } from "./channel.ts";
import { forServer, serverOf, type SlackServer } from "./server.ts";
import { answered, answeredKey, claimAnswered } from "./answered.ts";
import { botToken } from "./secrets.ts";

type SlackConfig = NonNullable<ReturnType<typeof slackConfig>>;

/** The journal the Lead's chat keeps in <state>/slack (chat.ts). */
export const LEAD_JOURNAL = "lead-chat";
/** The Lead's conversations are lead-<generation>. */
export const LEAD_CONVERSATION = "lead";
/** A Lead conversation holds a long exchange; the Claude session holds the context, govern's copy is the record. */
export const LEAD_CONTEXT_CHARS = 1_000_000;
/** How long a turn may run unless slack.lead.timeoutSeconds says (4 h). */
export const LEAD_TIMEOUT_SECONDS = 4 * 3600;
/** How long a permission card waits unless slack.lead.permissionTimeoutSeconds says (30 min); no answer is a deny. */
export const PERMISSION_TIMEOUT_SECONDS = 1800;
/** The mode a turn starts in unless slack.lead.permissionMode or a mode change says. */
export const DEFAULT_MODE: LeadMode = "auto";
/** The mailbox the Lead reads (`govern task inbox --as lead`); enable adds it to the config's mailboxes. */
export const LEAD_MAILBOX = "lead";
/** Permission card buttons. */
export const LEAD_ACTION = "govern.lead.";
const ACTIONS = { allow: "govern.lead.allow", session: "govern.lead.allow-session", retry: "govern.lead.retry", deny: "govern.lead.deny" } as const;
/** A card's View full button: it opens the whole input and decides nothing. */
const SHOW = "govern.lead.show";
/** The mode a turn a blocked card started runs in: one where every tool use the settings do not allow gets a card. */
export const BLOCKED_RETRY_MODE: LeadMode = "default";
/** A choices card's buttons (`govern.lead.choose.<n>`) and select menu (`govern.lead.choose`). */
const CHOOSE = "govern.lead.choose";
/** Up to this many choices are buttons; more are a select menu. */
export const CHOICE_BUTTONS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A message that stops the Lead's turn. */
export const STOP = /^\s*(pare|parar|para|stop|cancel(ar|a)?)\s*[.!]*\s*$/i;
const MODE_CMD = /^\s*(?:mode|modo)(?:\s+([a-z-]+))?\s*[.!]*\s*$/i;
const MODE_ALIASES: Record<string, LeadMode> = { default: "default", padrao: "default", "padrão": "default", ask: "default",
  edit: "acceptEdits", edits: "acceptEdits", acceptedits: "acceptEdits", "accept-edits": "acceptEdits", auto: "auto", plan: "plan" };
const KEEP_MS = 7 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Settings and state

/** The workspace's Slack config and its slack.lead; fails when it names no Lead. */
export function leadSettings(): { cfg: SlackConfig; lead: LeadConfig } {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team the Lead's channel is in`);
  const lead = cfg.lead ?? fail(`${configFile()} names no slack.lead: run \`govern slack lead enable --channel C --user U\``);
  if (cfg.channel && cfg.channel === lead.channel) fail(`${configFile()}: slack.lead.channel must be its own channel, not slack.channel`);
  return { cfg, lead };
}

/** The Lead's state folder: its session, mode, cost, audit, permission requests and session rules. */
export const leadDir = (): string => join(stateDir(), "slack", "lead");
const leadFile = (name: string): string => join(leadDir(), name);
const ensure = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });
function writeAtomic(file: string, text: string): void {
  ensure(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}
const readText = (file: string): string | undefined => { try { return readFileSync(file, "utf8").trim(); } catch { return undefined; } };
const readJson = <T>(file: string): T | undefined => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; } };

/** The Claude session the Lead continues: the one it recorded, else slack.lead.session; undefined before its first turn. */
export function leadSession(lead: LeadConfig): string | undefined {
  const s = readText(leadFile("session"));
  return s && UUID.test(s) ? s : lead.session;
}
/** Keep `id` as the session the next turn resumes (a UUID only). */
export const recordSession = (id: string): void => { if (UUID.test(id)) writeAtomic(leadFile("session"), `${id}\n`); };

/** The permission mode the next turn starts in. */
export function currentMode(lead: LeadConfig): LeadMode {
  const m = readText(leadFile("mode"));
  return m && (LEAD_MODES as readonly string[]).includes(m) ? m as LeadMode : lead.permissionMode ?? DEFAULT_MODE;
}

/** What the turn under way is doing: written by the adapter as it goes, removed when the turn ends. */
export interface LeadActivity {
  /** The conversation run, and where its question was asked. */
  run?: string; channel?: string; thread?: string;
  /** When the turn started (ISO). */
  since: string;
  /** Tool uses so far. */
  steps: number;
  /** The tool use running now, as a person reads it, and since when (ISO). */
  now?: { what: string; since: string };
  /** The plan's progress (Claude's todo list): "3/7 · what is under way". */
  plan?: string;
  /** The last thing the Lead said in the thread. */
  said?: string;
}
const activityFile = (): string => leadFile("activity.json");
/** The turn under way, if one is. */
export const readActivity = (): LeadActivity | undefined => readJson<LeadActivity>(activityFile());
/** Record what the turn is doing; undefined when it ended. */
export function writeActivity(a: LeadActivity | undefined): void {
  if (a) writeAtomic(activityFile(), JSON.stringify(a) + "\n");
  else rmSync(activityFile(), { force: true });
}
/** A duration as people read it: 45s, 3m07s, 2h05m. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
/** The answer, at once and without the model, to a message that waits behind the turn under way. */
export function busyLine(name: string, a: LeadActivity | undefined, at = Date.now()): string {
  const lines = [`⏳ ${name} is still on an earlier message${a ? ` (${elapsed(at - Date.parse(a.since))}, ${a.steps} step${a.steps === 1 ? "" : "s"})` : ""}. ` +
    "This one is queued and answered when that turn ends; send *stop* to end it now."];
  if (a?.now) lines.push(`▶ Now: ${a.now.what} (${elapsed(at - Date.parse(a.now.since))})`);
  if (a?.plan) lines.push(`📋 Plan: ${a.plan}`);
  if (a?.said) lines.push(`💬 Last said: ${a.said}`);
  return lines.join("\n");
}

/** Append one record to audit.jsonl. */
export function audit(record: Record<string, unknown>): void {
  ensure(leadDir());
  appendFileSync(leadFile("audit.jsonl"), JSON.stringify({ at: nowIso(), ...record }) + "\n", { mode: 0o600 });
}

/** The mode a `mode …` word names; undefined for none. */
export const modeNamed = (word: string): LeadMode | undefined => MODE_ALIASES[word.toLowerCase()];

/** Set the mode the next turns start in, recorded with who set it and how. */
export function setMode(mode: LeadMode, by: string, via: string): void {
  writeAtomic(leadFile("mode"), `${mode}\n`);
  audit({ kind: "mode", mode, by, via });
}

/** The session's total cost the adapter last saw (NaN before the first turn). */
export const lastCost = (): number => Number(readText(leadFile("cost")) ?? NaN);
/** Keep the session's total cost, to subtract on the next turn. */
export const recordCost = (usd: number): void => writeAtomic(leadFile("cost"), `${usd}\n`);

/** The govern command line this process is: GOVERN_BIN when absolute (an installed release), else this copy's govern.ts
 *  under the same node and flags. */
export function governArgv(): string[] {
  const b = process.env.GOVERN_BIN;
  if (b && isAbsolute(b)) return [b];
  return [process.execPath, ...process.execArgv, resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "govern.ts")];
}

// ---------------------------------------------------------------------------------------------------------------------
// Permission requests: lead-approve.ts writes a request and waits for its decision; the Lead's child posts its card; serve
// records the click. Each is a file under permissions/: <req>.request.json, <req>.decision.json (written once, with wx),
// <req>.card.json.

export interface PermissionRequest { v: 1; req: string; session: string; run?: string; tool: string; input: unknown;
  /** Claude's id for the tool use asked about. */ toolUseId?: string;
  /** Set when auto mode's classifier blocked the tool use: it already failed, and the card offers to run it in a turn of
   *  its own instead of answering an ask. */ blocked?: { reason?: string };
  /** Where the turn was asked, linked from the card. */ channel?: string; thread?: string; at: string; expires: string }
export interface PermissionDecision { behavior: "allow" | "deny"; scope?: "once" | "session" | "retry"; by: string;
  via: "slack" | "rule" | "grant" | "timeout" | "cancelled"; at: string }
const permDir = (): string => leadFile("permissions");
const permFile = (req: string, kind: "request" | "decision" | "card"): string => {
  if (!REQ.test(req)) throw new BadRequest("not a permission request id");
  return join(permDir(), `${req}.${kind}.json`);
};
/** A permission request by id; undefined when there is none. */
export const readRequest = (req: string): PermissionRequest | undefined => readJson(permFile(req, "request"));
/** A permission request's decision; undefined while it waits. */
export const readDecision = (req: string): PermissionDecision | undefined => readJson(permFile(req, "decision"));
/** Write a permission request for the Lead's process to post as a card. */
export function writeRequest(r: PermissionRequest): void { writeAtomic(permFile(r.req, "request"), JSON.stringify(r) + "\n"); }

/** The tool uses (Claude's ids) a permission request was written for: those the people were already asked about. */
export function askedToolUses(): Set<string> {
  const ids = new Set<string>();
  let names: string[];
  try { names = readdirSync(permDir()).filter((n) => n.endsWith(".request.json")); } catch { return ids; }
  for (const n of names) { const r = readJson<PermissionRequest>(join(permDir(), n)); if (r?.toolUseId) ids.add(r.toolUseId); }
  return ids;
}

/** Record `d` as the request's decision unless it already has one; returns the decision that stands. */
export function decide(req: string, d: PermissionDecision): { decision: PermissionDecision; first: boolean } {
  ensure(permDir());
  try {
    writeFileSync(permFile(req, "decision"), JSON.stringify(d) + "\n", { flag: "wx", mode: 0o600 });
    return { decision: d, first: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return { decision: readDecision(req) ?? d, first: false };
  }
}

/** What "allow for this session" covers: a Bash command exactly, any other tool by its name. */
export const ruleOf = (tool: string, input: unknown): string =>
  tool === "Bash" && typeof (input as { command?: unknown })?.command === "string" ? `Bash(${(input as { command: string }).command})` : tool;
const allowFile = (session: string): string => {
  if (!UUID.test(session)) throw new BadRequest("not a session id");
  return join(leadFile("allow"), `${session}.json`);
};
/** The rules the people allowed for the rest of `session` (allow-session clicks). */
export const allowRules = (session: string): string[] => readJson<string[]>(allowFile(session)) ?? [];
/** Add `rule` to the session's allowed rules, once. */
export function addAllowRule(session: string, rule: string): void {
  const rules = allowRules(session);
  if (!rules.includes(rule)) writeAtomic(allowFile(session), JSON.stringify([...rules, rule]) + "\n");
}

// A blocked tool use allowed once is a grant: the next ask for exactly that rule is allowed without a card, and uses it
// up. A grant nobody used is dropped after the permission timeout.
interface Grant { rule: string; req: string; at: string }
const grantsFile = (): string => leadFile("grants.json");
const liveGrants = (): Grant[] => {
  const ttl = (leadSettingsOrUndefined()?.permissionTimeoutSeconds ?? PERMISSION_TIMEOUT_SECONDS) * 1000;
  return (readJson<Grant[]>(grantsFile()) ?? []).filter((g) => Date.now() - Date.parse(g.at) < ttl);
};
const leadSettingsOrUndefined = (): LeadConfig | undefined => { try { return slackConfig()?.lead; } catch { return undefined; } };
/** Allow the next ask for `rule` once. */
export function addGrant(rule: string, req: string): void { writeAtomic(grantsFile(), JSON.stringify([...liveGrants(), { rule, req, at: nowIso() }]) + "\n"); }
/** Use up a grant for `rule`: the request it came from, or undefined when there is none. */
export function takeGrant(rule: string): string | undefined {
  const all = liveGrants(), i = all.findIndex((g) => g.rule === rule);
  if (i < 0) return undefined;
  const [g] = all.splice(i, 1);
  writeAtomic(grantsFile(), JSON.stringify(all) + "\n");
  return g!.req;
}

// A blocked card's Allow once or Retry starts a turn with a message of its own; that turn, and only it, runs in
// BLOCKED_RETRY_MODE. The mode is kept under the message's text, and the adapter takes it when that message is the turn's.
const turnModeDir = (): string => leadFile("turn-modes");
/** Run the turn whose message is `text` in `mode`. */
export function setTurnMode(req: string, text: string, mode: LeadMode): void {
  if (!REQ.test(req)) throw new BadRequest("not a permission request id");
  writeAtomic(join(turnModeDir(), `${req}.json`), JSON.stringify({ text, mode, at: nowIso() }) + "\n");
}
/** The mode set for the turn whose message is `text`, used up; undefined for none. */
export function takeTurnMode(text: string): LeadMode | undefined {
  let names: string[];
  try { names = readdirSync(turnModeDir()).filter((n) => n.endsWith(".json")); } catch { return undefined; }
  for (const n of names) {
    const f = join(turnModeDir(), n), t = readJson<{ text: string; mode: LeadMode; at: string }>(f);
    if (!t || Date.now() - Date.parse(t.at) > KEEP_MS) { rmSync(f, { force: true }); continue; }
    if (t.text !== text) continue;
    rmSync(f, { force: true });
    return (LEAD_MODES as readonly string[]).includes(t.mode) ? t.mode : undefined;
  }
  return undefined;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** What a tool use asks for, short enough for a message's text. */
export function describe(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "Bash" && typeof i.command === "string")
    return `${typeof i.description === "string" ? `${i.description}\n` : ""}\`\`\`${clip(i.command, 2500)}\`\`\``;
  if (typeof i.file_path === "string") return `\`${i.file_path}\``;
  return `\`\`\`${clip(JSON.stringify(input, null, 1) ?? "", 2500)}\`\`\``;
}

/** A tool use's input as the people read it: a Bash command, a file's path, else the input as JSON. */
export function inputText(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "Bash" && typeof i.command === "string") return i.command;
  if (typeof i.file_path === "string") return i.file_path;
  return JSON.stringify(input, null, 1) ?? "";
}
/** What a Bash call says it is for; undefined for any other tool use, or a call that does not say. */
const purposeOf = (tool: string, input: unknown): string | undefined => {
  const d = tool === "Bash" ? (input as { description?: unknown } | null)?.description : undefined;
  return typeof d === "string" && d.trim() ? d.replace(/\s+/g, " ").trim() : undefined;
};
/** Text for Slack mrkdwn as it is: no mention, link or entity. */
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A tool use in one line, for a notification: what it is for, else where its input starts. */
const summaryOf = (tool: string, input: unknown): string => esc(clip((purposeOf(tool, input) ?? inputText(tool, input)).replace(/\s+/g, " ").trim(), 80));

/** How much of a tool use's input a card shows; the whole of a longer one opens from its View full button. */
export const CARD_LINES = 12, CARD_CHARS = 1200;
/** How much of it that view shows, in blocks of VIEW_CHUNK characters. */
export const VIEW_CHARS = 60_000, VIEW_CHUNK = 2900;
/** How much of it a card shows on a server whose card is its text and that opens no read-only view (Tayet). */
export const TEXT_CARD_CHARS = 20_000;
/** A server that shows a card's text and not its blocks, closes a card on its first click, opens no view without a form
 *  to send and asks nothing again before a click counts (TAYET.md): the card carries everything itself. */
const textOnly = (server?: SlackServer): boolean => server?.kind === "tayet";
/** The start of `text` a card shows, and whether more follows. */
function preview(text: string, whole = false): { shown: string; cut: boolean } {
  if (whole) return { shown: text.length > TEXT_CARD_CHARS ? `${text.slice(0, TEXT_CARD_CHARS)}\n… (${text.length - TEXT_CARD_CHARS} more characters)` : text || "(empty)", cut: false };
  const shown = text.split("\n").slice(0, CARD_LINES).join("\n").slice(0, CARD_CHARS);
  return shown.length < text.length ? { shown: `${shown}\n…`, cut: true } : { shown: shown || "(empty)", cut: false };
}
/** A time each reader sees in their own time zone (UTC where Slack does not format it). */
const clock = (iso: string): string => `${new Date(Date.parse(iso)).toISOString().slice(11, 16)} UTC`;
const stamp = (iso: string): string => `<!date^${Math.floor(Date.parse(iso) / 1000)}^{time}|${clock(iso)}>`;
const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true });
const pre = (text: string) => ({ type: "rich_text_preformatted", elements: [{ type: "text", text }] });

/** What a card says of request `r` while it waits and once it is decided: what it is for as the header, who asks for
 *  which tool, the classifier's reason when it blocked the tool use, and the start of the input as it would run. */
function cardBody(r: PermissionRequest, lead: LeadConfig, server?: SlackServer): { blocks: unknown[]; cut: boolean } {
  const name = lead.name ?? "Squad Lead";
  // The link is Slack's own address of a message; another server has none to give.
  const link = r.channel && r.thread && !textOnly(server) ? ` (<https://slack.com/archives/${r.channel}/p${r.thread.replace(".", "")}|asked here>)` : "";
  const title = purposeOf(r.tool, r.input) ?? (r.blocked ? `Auto mode blocked ${r.tool}` : `${name} asks to run ${r.tool}`);
  const { shown, cut } = preview(inputText(r.tool, r.input), textOnly(server));
  const why = r.blocked?.reason ? [{ type: "rich_text_quote", elements: [{ type: "text", text: clip(r.blocked.reason.replace(/\s+/g, " "), 500) }] }] : [];
  return { cut, blocks: [
    { type: "header", text: plain(`${r.blocked ? "🛑" : "🔐"} ${clip(title, 140)}`) },
    { type: "section", text: { type: "mrkdwn", text: r.blocked ? `Auto mode blocked *${esc(name)}*'s *${esc(r.tool)}*${link}` : `*${esc(name)}* asks to run *${esc(r.tool)}*${link}` } },
    { type: "rich_text", elements: [...why, pre(shown)] }] };
}

/** The card for request `r`: its body, who may decide and until when, and the buttons. A button that lets the tool use
 *  run asks once more before it counts, saying what it does. */
export function cardOf(r: PermissionRequest, lead: LeadConfig, server?: SlackServer): { text: string; blocks: unknown[] } {
  const name = lead.name ?? "Squad Lead", who = lead.users.map((u) => `<@${u}>`).join(" ");
  const rule = ruleOf(r.tool, r.input), value = JSON.stringify({ v: 1, req: r.req });
  const { blocks, cut } = cardBody(r, lead, server), bash = rule.startsWith("Bash("), bare = textOnly(server);
  const what = clip(`${r.tool}: ${(purposeOf(r.tool, r.input) ?? inputText(r.tool, r.input)).replace(/\s+/g, " ").trim()}`, 120);
  // Where nothing asks again, a button carries no dialog, and the line above the buttons says what each one does.
  const confirm = (title: string, text: string, ok: string) =>
    (bare ? {} : { confirm: { title: plain(title), text: { type: "plain_text", text: clip(text, 299) }, confirm: plain(ok), deny: plain("Cancel") } });
  const said = !bare ? "" : r.blocked
    ? ` · *Allow once* runs exactly this in a new turn, in mode ${BLOCKED_RETRY_MODE}; *Retry, ask me* has the ${esc(name)} try again there, a card for each step it needs`
    : ` · *Allow for session* also allows ${bash ? "this same command" : `any ${esc(r.tool)} use`} for the rest of the session, without a card`;
  const button = (action: keyof typeof ACTIONS, label: string, more: Record<string, unknown> = {}) =>
    ({ type: "button", action_id: ACTIONS[action], text: plain(label), value, ...more });
  const view = cut ? [{ type: "button", action_id: SHOW, text: plain(bash ? "View full command" : "View full input"), value }] : [];
  const buttons = r.blocked
    ? [button("allow", "Allow once", { style: "primary", ...confirm("Allow it once?",
        `A new turn in mode ${BLOCKED_RETRY_MODE} runs exactly this, once. ${what}`, "Allow once") }),
      button("retry", "Retry, ask me", { ...confirm("Retry, asking you?",
        `${name} tries again in a new turn in mode ${BLOCKED_RETRY_MODE}: each step the settings do not allow gets a card here.`, "Retry") }),
      button("deny", "Deny", { style: "danger" })]
    : [button("allow", "Allow once", { style: "primary", ...confirm("Allow it once?", `${name} runs this once. ${what}`, "Allow once") }),
      button("session", "Allow for session", { ...confirm("Allow it for the session?",
        bash ? `${name} runs this command now, and the same command again for the rest of the session without a card. ${what}`
          : `${name} runs this now, and any other ${r.tool} use for the rest of the session without a card.`, "Allow for session") }),
      button("deny", "Deny", { style: "danger" })];
  return {
    text: `${r.blocked ? `🛑 Auto mode blocked ${esc(name)}'s ${esc(r.tool)}` : `🔐 ${esc(name)} asks to run ${esc(r.tool)}`}: ${summaryOf(r.tool, r.input)}` +
      ` · expires ${clock(r.expires)} · ${who}`,
    blocks: [...blocks,
      { type: "context", elements: [{ type: "mrkdwn", text: `Only ${who} can decide · expires ${stamp(r.expires)}, and no answer is a deny${said}` }] },
      { type: "actions", block_id: ACTIONS_BLOCK, elements: [...buttons, ...view] }]
  };
}

/** The card of request `r` once `d` stands: what it asked, as it was posted, then who decided what and when. */
export function decidedCard(r: PermissionRequest, lead: LeadConfig, d: PermissionDecision, server?: SlackServer): { text: string; blocks: unknown[] } {
  return { text: `${decisionLine(d)}: ${esc(r.tool)} ${summaryOf(r.tool, r.input)}`,
    blocks: [...cardBody(r, lead, server).blocks, { type: "context", block_id: OUTCOME_BLOCK, elements: [{ type: "mrkdwn", text: `${decisionLine(d)} · ${stamp(d.at)}` }] }] };
}

/** The line a decided card ends with. */
export function decisionLine(d: PermissionDecision): string {
  if (d.via === "timeout") return "⌛ Expired without an answer: denied";
  if (d.via === "cancelled") return "⏹️ The turn ended before an answer";
  if (d.via === "rule") return "✅ Allowed by an earlier allow-for-the-session";
  if (d.via === "grant") return "✅ Allowed by the blocked card's Allow once";
  if (d.scope === "retry") return `🔁 Retrying in mode ${BLOCKED_RETRY_MODE}, asked by <@${d.by}>`;
  return d.behavior === "deny" ? `❌ Denied by <@${d.by}>` : d.scope === "session" ? `✅ Allowed for the session by <@${d.by}>` : `✅ Allowed once by <@${d.by}>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Clicks (slack.ts interact): a permission card's button.

export interface LeadClick { team: string; user: string; channel: string; action: keyof typeof ACTIONS; req: string;
  /** The card's message, and its thread when it is in one. */ ts?: string; thread?: string }
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A permission card click, or undefined for any other payload. */
export function leadClickOf(p: unknown): LeadClick | undefined {
  if (!record(p) || p.type !== "block_actions" || !Array.isArray(p.actions)
    || !p.actions.some((x) => record(x) && typeof x.action_id === "string" && x.action_id.startsWith(LEAD_ACTION) && !x.action_id.startsWith(CHOOSE) && x.action_id !== SHOW)) return undefined;
  if (p.actions.length !== 1) throw new BadRequest("a click is exactly one action");
  const a = p.actions[0] as Record<string, unknown>;
  const action = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).find((k) => ACTIONS[k] === a.action_id) ?? (() => { throw new BadRequest("unknown Lead button"); })();
  const team = record(p.team) && typeof p.team.id === "string" ? p.team.id : undefined;
  const user = record(p.user) && typeof p.user.id === "string" ? p.user.id : undefined;
  const container = record(p.container) ? p.container : {};
  const channel = record(p.channel) && typeof p.channel.id === "string" ? p.channel.id : typeof container.channel_id === "string" ? container.channel_id : undefined;
  if (!team || !user || !channel) throw new BadRequest("the click names no team, user or channel");
  let value: unknown;
  try { value = JSON.parse(typeof a.value === "string" ? a.value : ""); } catch { throw new BadRequest("the button's value is not JSON"); }
  if (!record(value) || value.v !== 1 || typeof value.req !== "string" || !REQ.test(value.req)) throw new BadRequest("the button names no permission request");
  const message = record(p.message) ? p.message : {};
  const ts = typeof container.message_ts === "string" ? container.message_ts : typeof message.ts === "string" ? message.ts : undefined;
  const thread = typeof container.thread_ts === "string" ? container.thread_ts : typeof message.thread_ts === "string" ? message.thread_ts : undefined;
  return { team, user, channel, action, req: value.req, ...(ts ? { ts } : {}), ...(thread && thread !== ts ? { thread } : {}) };
}

/** The workspaces this serve decides for: its own, then slack.serveRepos. Several need each one's own folders. */
export function servedWorkspaces(): string[] {
  const repos = [...new Set([repo(), ...(slackConfig()?.serveRepos ?? [])])];
  if (repos.length > 1) {
    const set = FOLDER_OVERRIDES.filter((v) => process.env[v]);
    if (set.length) throw new Forbidden(`slack.serveRepos needs each workspace's own folders: unset ${set.join(", ")} for slack serve`);
  }
  return repos;
}

/** Each Lead channel and the workspace it belongs to, among `repos`; two workspaces with one Lead channel, or a Lead
 *  channel that is a squad channel, fail. */
export function leadMap(repos: string[] = servedWorkspaces()): Map<string, { ws: string; team: string }> {
  const map = new Map<string, { ws: string; team: string }>(), squad = new Map<string, string>();
  for (const ws of repos) {
    const cfg = inRepo(ws, () => slackConfig());
    if (cfg?.channel) squad.set(cfg.channel, ws);
    if (!cfg?.lead) continue;
    const had = map.get(cfg.lead.channel);
    if (had) fail(`slack.lead.channel ${cfg.lead.channel} is the Lead channel of both ${had.ws} and ${ws}: give each Lead its own channel`);
    map.set(cfg.lead.channel, { ws, team: cfg.team });
  }
  for (const [ch, { ws }] of map) if (squad.has(ch)) fail(`${ch} is ${ws}'s Lead channel and ${squad.get(ch)}'s slack.channel: give the Lead its own channel`);
  return map;
}

/** The message a blocked card's Allow once or Retry hands the Lead, as from the clicker. */
export function blockedTurnText(r: PermissionRequest, action: "allow" | "retry", user: string): string {
  const what = `${r.tool} ${describe(r.tool, r.input)}`;
  return action === "allow"
    ? `[Allowed with a button] Auto mode blocked this tool use; <@${user}> allowed it once. Run it again exactly as it was, ` +
      `then go on with what it was for. This turn runs in mode ${BLOCKED_RETRY_MODE}.\n${what}`
    : `[Retry with a button] Auto mode blocked this tool use; <@${user}> asks you to try again in mode ${BLOCKED_RETRY_MODE}, ` +
      `where each step the settings do not allow gets a card in Slack. Do not reach the same end another way.\n${what}`;
}

/** Record a permission card click as the clicker's decision, in the Lead's own workspace: the line saying what was
 *  decided, the card as it stands from then on, and, for a blocked card's Allow once or Retry, the message the Lead takes
 *  as its next turn (handed to `route`). */
export function performLeadClick(c: LeadClick, source: SlackSource, route?: (event: Record<string, unknown>) => boolean): { line: string; card: { text: string; blocks: unknown[] } } {
  const ours = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (c.team !== ours) throw new Forbidden(`the request comes from Slack team ${c.team}, not ${ours}`);
  const at = leadMap().get(c.channel) ?? (() => { throw new NotFound(`${c.channel} is no Lead channel this server serves`); })();
  return inRepo(at.ws, () => {
    const { cfg, lead } = leadSettings();
    if (cfg.team !== c.team) throw new Forbidden(`${at.ws} belongs to Slack team ${cfg.team}, not ${c.team}`);
    if (!lead.users.includes(c.user)) throw new Forbidden(`Slack user ${c.user} is not one of ${at.ws}'s slack.lead.users`);
    const r = readRequest(c.req) ?? (() => { throw new NotFound("no such permission request"); })();
    if (r.blocked && c.action === "session") throw new BadRequest("a blocked tool use is allowed once, not for the session");
    if (!r.blocked && c.action === "retry") throw new BadRequest("only a blocked tool use is retried");
    const turn = r.blocked && (c.action === "allow" || c.action === "retry");
    if (turn && (!route || !c.ts)) throw new NotFound("the Lead is not served here: a blocked card's turn goes through govern slack serve");
    const d: PermissionDecision = { behavior: c.action === "deny" ? "deny" : "allow", scope: c.action === "session" ? "session" : c.action === "retry" ? "retry" : "once",
      by: c.user, via: "slack", at: nowIso() };
    const rule = ruleOf(r.tool, r.input);
    if (readDecision(c.req)) throw new GovernError(`already decided: ${decisionLine(readDecision(c.req)!)}`, 1);
    // A blocked card's turn is set up before its decision stands, so a decision never stands without its turn.
    const text = turn ? blockedTurnText(r, c.action as "allow" | "retry", c.user) : "";
    if (turn) setTurnMode(c.req, text, BLOCKED_RETRY_MODE);
    const { decision, first } = decide(c.req, d);
    if (!first) throw new GovernError(`already decided: ${decisionLine(decision)}`, 1);
    if (c.action === "session") addAllowRule(r.session, rule);
    if (turn && c.action === "allow") addGrant(rule, c.req);
    audit({ kind: "permission", req: c.req, tool: r.tool, rule, session: r.session, ...(r.blocked ? { blocked: true } : {}), decision: d, source });
    if (turn) {
      const thread = c.thread ?? r.thread;
      route!({ type: "event_callback", team_id: c.team, event_id: `govern-blocked-${c.req}`,
        event: { type: "message", channel: c.channel, user: c.user, ts: c.ts, ...(thread ? { thread_ts: thread } : {}), text } });
    }
    return { line: `${decisionLine(d)}: *${r.tool}* ${describe(r.tool, r.input)}`, card: decidedCard(r, lead, d, serverOf(cfg)) };
  });
}

/** A View full click: who asked to read which request, and the trigger that opens a view for them. */
export interface LeadShow { team: string; user: string; channel: string; req: string; trigger: string }

/** A card's View full click, or undefined for any other payload. */
export function leadShowOf(p: unknown): LeadShow | undefined {
  if (!record(p) || p.type !== "block_actions" || !Array.isArray(p.actions) || !p.actions.some((x) => record(x) && x.action_id === SHOW)) return undefined;
  if (p.actions.length !== 1) throw new BadRequest("a click is exactly one action");
  const a = p.actions[0] as Record<string, unknown>, container = record(p.container) ? p.container : {};
  const team = record(p.team) && typeof p.team.id === "string" ? p.team.id : undefined;
  const user = record(p.user) && typeof p.user.id === "string" ? p.user.id : undefined;
  const channel = record(p.channel) && typeof p.channel.id === "string" ? p.channel.id : typeof container.channel_id === "string" ? container.channel_id : undefined;
  if (!team || !user || !channel) throw new BadRequest("the click names no team, user or channel");
  if (typeof p.trigger_id !== "string" || !p.trigger_id) throw new BadRequest("the click has no trigger_id");
  let value: unknown;
  try { value = JSON.parse(typeof a.value === "string" ? a.value : ""); } catch { throw new BadRequest("the button's value is not JSON"); }
  if (!record(value) || value.v !== 1 || typeof value.req !== "string" || !REQ.test(value.req)) throw new BadRequest("the button names no permission request");
  return { team, user, channel, req: value.req, trigger: p.trigger_id };
}

/** The view a View full click opens: the request's whole input, for anyone in its Lead channel (the card there already
 *  shows how it starts). It decides nothing and records nothing. */
export function leadShowView(c: LeadShow): Record<string, unknown> {
  const ours = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (c.team !== ours) throw new Forbidden(`the request comes from Slack team ${c.team}, not ${ours}`);
  const at = leadMap().get(c.channel) ?? (() => { throw new NotFound(`${c.channel} is no Lead channel this server serves`); })();
  return inRepo(at.ws, () => {
    const { cfg, lead } = leadSettings();
    if (cfg.team !== c.team) throw new Forbidden(`${at.ws} belongs to Slack team ${cfg.team}, not ${c.team}`);
    const r = readRequest(c.req) ?? (() => { throw new NotFound("no such permission request (older than a week?)"); })();
    const text = inputText(r.tool, r.input), parts: string[] = [];
    // Each block holds whole lines while they fit, so a long script reads as it was written.
    for (let rest = text.slice(0, VIEW_CHARS); rest;) {
      const nl = rest.length > VIEW_CHUNK ? rest.lastIndexOf("\n", VIEW_CHUNK) : -1, n = nl > 0 ? nl + 1 : VIEW_CHUNK;
      parts.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    const purpose = purposeOf(r.tool, r.input), d = readDecision(c.req);
    return { type: "modal", title: plain(r.tool === "Bash" ? "Full command" : "Full input"), close: plain("Close"), blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${esc(lead.name ?? "Squad Lead")}* · *${esc(r.tool)}*${purpose ? ` · ${esc(clip(purpose, 300))}` : ""}` } },
      ...(parts.length ? parts : ["(empty)"]).map((t) => ({ type: "rich_text", elements: [pre(t)] })),
      { type: "context", elements: [{ type: "mrkdwn", text: [d ? decisionLine(d) : `Waits on a decision until ${stamp(r.expires)}`,
        ...(text.length > VIEW_CHARS ? [`the first ${VIEW_CHARS} of ${text.length} characters; all of it is in the request file of ${c.req}`] : [])].join(" · ") }] }] };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Choices: a reply's ```choices block (chat.ts choicesOf) offered as buttons, or a select menu past CHOICE_BUTTONS; the one
// chosen comes back to the Lead as the next message, from the person who chose it.

export interface Choice { id: string; channel: string; thread?: string; options: string[]; at: string;
  /** The card offering it, once posted: what a server that closes a card on any click is asked about (syncChoices). */ ts?: string }
export interface Chosen { index: number; option: string; by: string; at: string }
const choiceDir = (): string => join(leadDir(), "choices");
const choiceFile = (id: string, kind: "offer" | "chosen"): string => join(choiceDir(), kind === "offer" ? `${id}.json` : `${id}.chosen.json`);

/** Keep the choices offered in `where` and the card offering them (one decision: the first click). `sent` records the
 *  card's message once it is posted. */
export function choiceCard(options: string[], where: { channel: string; thread?: string }, lead: LeadConfig, server?: SlackServer):
  { text: string; blocks: unknown[]; sent: (ts: string) => void } {
  ensure(choiceDir());
  for (const f of readdirSync(choiceDir())) {
    try { if (Date.now() - statSync(join(choiceDir(), f)).mtimeMs > KEEP_MS) rmSync(join(choiceDir(), f), { force: true }); } catch { /* gone */ }
  }
  const c: Choice = { id: randomUUID(), channel: where.channel, ...(where.thread ? { thread: where.thread } : {}), options, at: nowIso() };
  writeAtomic(choiceFile(c.id, "offer"), JSON.stringify(c) + "\n");
  return { ...choiceMessage(c, lead, server), sent: (ts) => writeAtomic(choiceFile(c.id, "offer"), JSON.stringify({ ...c, ts }) + "\n") };
}

/** The card offering choice `c`: each alternative whole, then a button for each. Past the buttons a card takes, Slack gets
 *  a select menu; a server with buttons only (Tayet) gets as many as its card holds, and past that the people answer in
 *  words. */
function choiceMessage(c: Choice, lead: LeadConfig, server?: SlackServer): { text: string; blocks: unknown[] } {
  const { options } = c, bare = textOnly(server), buttons = bare ? server!.maxButtons : CHOICE_BUTTONS;
  const value = (i: number) => JSON.stringify({ v: 1, choice: c.id, i });
  const label = (o: string) => ({ type: "plain_text" as const, text: o, emoji: true });
  const who = lead.users.map((u) => `<@${u}>`).join(" ");
  // Slack cuts a long button or menu label short and never wraps it, so each choice is shown whole as text, numbered
  // (its own number when it has one), and the buttons (or the menu past CHOICE_BUTTONS) name the number.
  const numbered = options.map((o, i) => {
    const own = /^(\d{1,2})[.)]\s/.exec(o);
    return { n: own ? own[1]! : String(i + 1), text: own ? o : `${i + 1}. ${o}` };
  });
  const pick = options.length <= buttons
    ? numbered.map((x, i) => ({ type: "button", action_id: `${CHOOSE}.${i}`, text: label(`Choose ${x.n}`), value: value(i) }))
    : bare ? []
    : [{ type: "static_select", action_id: CHOOSE, placeholder: label(`Choose one of ${options.length}`),
        options: numbered.map((x, i) => ({ text: label(clip(x.text, CHOICE_CHARS - 1)), value: value(i) })) }];
  return {
    text: `Choose: ${options.join(" · ")}`.slice(0, 3000),
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: pick.length ? `👉 ${who} choose one, or answer in words` : `👉 ${who} answer in words: more choices than a card has buttons` }] },
      ...numbered.map((x) => ({ type: "section", text: { type: "mrkdwn", text: mrkdwn(x.text).slice(0, 3000) } })),
      ...(pick.length ? [{ type: "actions", block_id: ACTIONS_BLOCK, elements: pick }] : [])
    ]
  };
}

/** On a server that closes a card on its first click, whoever clicked: offer again each choice whose card a click
 *  closed and nobody chose (the click of a person who may not choose, refused). */
export async function syncChoices(call: Call, lead: LeadConfig, log: (l: string) => void): Promise<void> {
  const server = serverOf(leadSettings().cfg);
  if (!server.singleAnswer) return;
  let names: string[];
  try { names = readdirSync(choiceDir()).filter((n) => n.endsWith(".json") && !n.endsWith(".chosen.json")); } catch { return; }
  const clicked = answered(), claimed: string[] = [];
  for (const n of names) {
    try {
      const c = readJson<Choice>(join(choiceDir(), n));
      if (!c?.ts || !clicked.has(answeredKey(c.channel, c.ts))) continue;
      claimed.push(answeredKey(c.channel, c.ts));
      if (existsSync(choiceFile(c.id, "chosen"))) continue;
      const sent = await call("chat.postMessage", { channel: c.channel, ...forServer(server, choiceMessage(c, lead, server)), ...(c.thread ? { thread_ts: c.thread } : {}) });
      writeAtomic(choiceFile(c.id, "offer"), JSON.stringify({ ...c, ts: sent.ts }) + "\n");
    } catch (e) { log(`slack lead: choice ${n}: ${(e as Error).message}`); }
  }
  if (claimed.length) claimAnswered(claimed);
}

export interface LeadChoiceClick { team: string; user: string; channel: string; choice: string; index: number; ts: string; thread?: string }

/** A choices card click (a button, or an option picked in its menu), or undefined for any other payload. */
export function leadChoiceOf(p: unknown): LeadChoiceClick | undefined {
  if (!record(p) || p.type !== "block_actions" || !Array.isArray(p.actions)
    || !p.actions.some((x) => record(x) && typeof x.action_id === "string" && x.action_id.startsWith(CHOOSE))) return undefined;
  if (p.actions.length !== 1) throw new BadRequest("a click is exactly one action");
  const a = p.actions[0] as Record<string, unknown>;
  const team = record(p.team) && typeof p.team.id === "string" ? p.team.id : undefined;
  const user = record(p.user) && typeof p.user.id === "string" ? p.user.id : undefined;
  const container = record(p.container) ? p.container : {}, message = record(p.message) ? p.message : {};
  const channel = record(p.channel) && typeof p.channel.id === "string" ? p.channel.id : typeof container.channel_id === "string" ? container.channel_id : undefined;
  const ts = typeof container.message_ts === "string" ? container.message_ts : typeof message.ts === "string" ? message.ts : undefined;
  if (!team || !user || !channel || !ts) throw new BadRequest("the click names no team, user, channel or message");
  const thread = typeof container.thread_ts === "string" ? container.thread_ts : typeof message.thread_ts === "string" ? message.thread_ts : undefined;
  const raw = record(a.selected_option) ? a.selected_option.value : a.value;
  let value: unknown;
  try { value = JSON.parse(typeof raw === "string" ? raw : ""); } catch { throw new BadRequest("the choice's value is not JSON"); }
  if (!record(value) || value.v !== 1 || typeof value.choice !== "string" || !UUID.test(value.choice) || !Number.isInteger(value.i) || (value.i as number) < 0)
    throw new BadRequest("the click names no choice");
  return { team, user, channel, choice: value.choice, index: value.i as number, ts, ...(thread && thread !== ts ? { thread } : {}) };
}

/** Record a choice as the clicker's, once, in the Lead's own workspace: the line the card ends with, and the message the
 *  Lead takes as its next question (in the card's place: its reactions go on the card, its reply where the card is). */
export function performLeadChoice(c: LeadChoiceClick, source: SlackSource): { line: string; event: Record<string, unknown> } {
  const ours = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (c.team !== ours) throw new Forbidden(`the request comes from Slack team ${c.team}, not ${ours}`);
  const at = leadMap().get(c.channel) ?? (() => { throw new NotFound(`${c.channel} is no Lead channel this server serves`); })();
  return inRepo(at.ws, () => {
    const { cfg, lead } = leadSettings();
    if (cfg.team !== c.team) throw new Forbidden(`${at.ws} belongs to Slack team ${cfg.team}, not ${c.team}`);
    if (!lead.users.includes(c.user)) throw new Forbidden(`Slack user ${c.user} is not one of ${at.ws}'s slack.lead.users`);
    const offer = readJson<Choice>(choiceFile(c.choice, "offer")) ?? (() => { throw new NotFound("no such choice (older than a week?)"); })();
    if (offer.channel !== c.channel) throw new Forbidden("the choice was offered in another channel");
    const option = offer.options[c.index] ?? (() => { throw new BadRequest("no such option"); })();
    const d: Chosen = { index: c.index, option, by: c.user, at: nowIso() };
    try { writeFileSync(choiceFile(c.choice, "chosen"), JSON.stringify(d) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const had = readJson<Chosen>(choiceFile(c.choice, "chosen"));
      throw new GovernError(`already chosen${had ? `: ${had.option} by <@${had.by}>` : ""}`, 1);
    }
    audit({ kind: "choice", choice: c.choice, index: c.index, option, by: c.user, source });
    const thread = c.thread ?? offer.thread;
    return {
      line: `✅ <@${c.user}> chose: *${option}*`,
      event: { type: "event_callback", team_id: c.team, event_id: `govern-choice-${c.choice}`,
        event: { type: "message", channel: c.channel, user: c.user, ts: c.ts, ...(thread ? { thread_ts: thread } : {}),
          text: `[Chosen with a button] ${option}` } }
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The router (slack serve): one `govern slack lead run` child per Lead workspace, fed its channel's events.

export interface LeadRouter {
  /** Hand an events_api payload to the Lead whose channel it is in; false when it is in none. */
  route(payload: unknown): boolean;
  /** Stop the children. */
  close(): void;
  /** The Lead channels served, and their workspaces. */
  channels(): Map<string, { ws: string; team: string }>;
}

/** Start one child per Lead workspace and keep it running; the map is read again when a served config changes. */
export function leadRouter(o: { log: (line: string) => void; argv?: string[]; minRestartMs?: number }): LeadRouter {
  const argv = o.argv ?? [...governArgv(), "slack", "lead", "run"], repos = servedWorkspaces(), own = repo();
  let map = leadMap(repos), stamp = stamps(repos), closed = false;
  const kids = new Map<string, { proc?: ChildProcess; queue: string[]; backoff: number; timer?: NodeJS.Timeout }>();
  const env = (ws: string): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, GOVERN_REPO: ws };
    if (ws !== own) for (const v of FOLDER_OVERRIDES) delete e[v];
    return e;
  };
  const start = (ws: string) => {
    const k = kids.get(ws) ?? { queue: [], backoff: o.minRestartMs ?? 1000 };
    kids.set(ws, k);
    if (closed || k.proc) return;
    const proc = spawn(argv[0]!, [...argv.slice(1)], { cwd: ws, env: env(ws), stdio: ["pipe", "inherit", "inherit"] });
    k.proc = proc;
    const began = Date.now();
    proc.stdin!.on("error", () => undefined);
    proc.on("error", (e) => o.log(`slack lead: ${ws}: ${e.message}`));
    proc.on("exit", (code, signal) => {
      k.proc = undefined;
      if (closed) return;
      if (Date.now() - began > 60_000) k.backoff = o.minRestartMs ?? 1000;
      o.log(`slack lead: ${ws}: the Lead's process ended (${code ?? signal}); starting it again in ${Math.round(k.backoff / 1000)} s`);
      k.timer = setTimeout(() => { k.timer = undefined; if (stillLead(ws)) start(ws); }, k.backoff);
      k.backoff = Math.min(k.backoff * 2, 60_000);
    });
    for (const line of k.queue.splice(0)) proc.stdin!.write(line);
  };
  const stillLead = (ws: string) => [...map.values()].some((x) => x.ws === ws);
  const sync = () => {
    for (const { ws } of map.values()) start(ws);
    for (const [ws, k] of kids) if (!stillLead(ws)) { if (k.timer) clearTimeout(k.timer); k.proc?.kill("SIGTERM"); kids.delete(ws); }
  };
  const refresh = () => {
    const now = stamps(repos);
    if (now === stamp) return;
    stamp = now;
    forgetConfigs();
    try { map = leadMap(repos); sync(); o.log(`slack lead: serving ${describe_(map)}`); }
    catch (e) { o.log(`slack lead: a served config changed and is refused, keeping the Leads as they were: ${(e as Error).message}`); }
  };
  sync();
  if (map.size) o.log(`slack lead: serving ${describe_(map)}`);
  return {
    route(payload) {
      refresh();
      const p = record(payload) ? payload : {}, e = record(p.event) ? p.event : {};
      const at = typeof e.channel === "string" ? map.get(e.channel) : undefined;
      if (!at) return false;
      if (p.team_id !== undefined && p.team_id !== at.team) { o.log(`slack lead: an event from team ${String(p.team_id)} for ${at.ws} (team ${at.team}) is ignored`); return true; }
      const k = kids.get(at.ws);
      const line = JSON.stringify(payload) + "\n";
      if (k?.proc?.stdin?.writable) k.proc.stdin.write(line);
      else { kids.set(at.ws, { ...(k ?? { backoff: o.minRestartMs ?? 1000 }), queue: [...(k?.queue ?? []), line].slice(-200) }); }
      return true;
    },
    close() {
      closed = true;
      for (const k of kids.values()) { if (k.timer) clearTimeout(k.timer); k.proc?.kill("SIGTERM"); }
    },
    channels: () => map
  };
}
const describe_ = (map: Map<string, { ws: string }>) => [...map].map(([ch, { ws }]) => `${ch} → ${ws}`).join(", ") || "no Lead";
/** The served configs' change times, to see when the map must be read again. */
function stamps(repos: string[]): string {
  return repos.map((ws) => { const f = inRepo(ws, () => configFile()); try { return `${f}:${statSync(f).mtimeMs}`; } catch { return `${f}:-`; } }).join("|");
}

// ---------------------------------------------------------------------------------------------------------------------
// The Lead's process (`govern slack lead run`): a chat fed events on stdin, and the poster of permission cards.

/** Commands to the Lead itself, not turns: stop, and mode. */
export function leadControl(lead: LeadConfig, q: { text: string; user: string; ts: string; channel: string }): string | undefined {
  if (STOP.test(q.text)) {
    const open = openQuestions(LEAD_JOURNAL).filter((e) => e.conv && e.runId);
    let stopped = 0;
    for (const e of open) {
      try {
        const r = sessions.inspect(e.conv).runs.find((x) => x.id === e.runId);
        if (r && (r.state === "queued" || r.state === "running")) { sessions.cancel(e.conv, e.runId, `stopped by <@${q.user}>`); stopped++; }
      } catch { /* a conversation that cannot be read has nothing to stop */ }
    }
    audit({ kind: "stop", by: q.user, stopped, ts: q.ts });
    return stopped ? `⏹️ Stopping ${stopped === 1 ? "the turn" : `${stopped} turns`}.` : "⏹️ Nothing is running.";
  }
  const m = MODE_CMD.exec(q.text);
  if (!m) return undefined;
  if (!m[1]) return `Mode: *${currentMode(lead)}* (change it with \`mode default|edit|auto|plan\`; it applies from the next turn).`;
  const mode = modeNamed(m[1]) ?? fail(`unknown mode ${m[1]}: default, edit (acceptEdits), auto or plan`);
  setMode(mode, q.user, `slack:${q.channel}:${q.ts}`);
  return `Mode is now *${mode}*, from the next turn${openQuestions(LEAD_JOURNAL).some((e) => e.conv) ? " (send `stop` to end the current one)" : ""}.`;
}

/** The conversation `conv`, answered by the built-in Lead adapter. */
export function createLeadConversation(conv: string, lead: LeadConfig): void {
  sessions.create(conv, { command: { name: "lead", argv: [...governArgv(), "slack", "lead", "adapter"] }, title: `${lead.name ?? "Squad Lead"} in ${lead.channel}`,
    timeoutSeconds: lead.timeoutSeconds ?? LEAD_TIMEOUT_SECONDS, maxContextChars: LEAD_CONTEXT_CHARS });
}

/** Post the cards of requests that have none, and close each decided one: what it asked stays, the buttons go, and a line
 *  says who decided what and when (or that it expired, or its turn ended). */
export async function syncCards(call: Call, lead: LeadConfig, log: (l: string) => void): Promise<void> {
  let names: string[];
  try { names = readdirSync(permDir()); } catch { return; }
  // A server that closes a card on its first click, whoever clicked, leaves a request nobody may answer any more when
  // that click was refused: its card is posted again. serve marks every clicked card (answered.ts).
  const server = serverOf(leadSettings().cfg), clicked = server.singleAnswer ? answered() : new Set<string>(), claimed: string[] = [];
  for (const n of names.filter((x) => x.endsWith(".request.json"))) {
    const req = n.slice(0, -".request.json".length);
    try {
      const r = readRequest(req);
      if (!r) continue;
      const card = readJson<{ channel: string; ts: string; closed?: boolean }>(permFile(req, "card"));
      // Nothing waits on a blocked card, so its expiry is recorded here.
      if (r.blocked && !readDecision(req) && Date.now() >= Date.parse(r.expires)) {
        const x = decide(req, { behavior: "deny", by: "govern", via: "timeout", at: nowIso() });
        if (x.first) audit({ kind: "permission", req, tool: r.tool, rule: ruleOf(r.tool, r.input), session: r.session, blocked: true, decision: x.decision });
      }
      const d = readDecision(req);
      const mark = card ? answeredKey(card.channel, card.ts) : "";
      if (card && clicked.has(mark)) claimed.push(mark);
      if (!d && (!card || clicked.has(mark))) {
        const sent = await call("chat.postMessage", { channel: lead.channel, ...forServer(server, cardOf(r, lead, server)), unfurl_links: false });
        writeAtomic(permFile(req, "card"), JSON.stringify({ channel: lead.channel, ts: sent.ts }) + "\n");
      } else if (card && d && !card.closed) {
        // A click's own answer already closed the card; the edit here is the same card, so one that answer missed is closed too.
        await call("chat.update", { channel: card.channel, ts: card.ts, ...forServer(server, decidedCard(r, lead, d, server)) });
        writeAtomic(permFile(req, "card"), JSON.stringify({ ...card, closed: true }) + "\n");
      } else if (d && Date.now() - Date.parse(d.at) > KEEP_MS) {
        for (const k of ["request", "decision", "card"] as const) rmSync(permFile(req, k), { force: true });
      }
    } catch (e) { log(`slack lead: permission ${req}: ${(e as Error).message}`); }
  }
  if (claimed.length) claimAnswered(claimed);
}

/** `govern slack lead run`: the Lead's chat, fed events_api payloads as lines on stdin by slack serve; runs until stdin ends. */
export async function runLead(): Promise<void> {
  const { cfg, lead } = leadSettings();
  const server = serverOf(cfg), call = slackCall(server.api, botToken(cfg));
  const log = (l: string) => process.stderr.write(`${l}\n`);
  const self = (await call("auth.test", {})).user_id;
  if (typeof self !== "string" || !self) fail("auth.test answered no user_id: the agent's own id is needed to tell its messages apart");
  const bot = chatBot({ call, channel: lead.channel, self, log, journal: LEAD_JOURNAL, single: LEAD_CONVERSATION,
    chat: { users: lead.users, timeoutSeconds: lead.timeoutSeconds ?? LEAD_TIMEOUT_SECONDS, maxContextChars: LEAD_CONTEXT_CHARS },
    create: (conv) => createLeadConversation(conv, lead),
    control: (q) => leadControl(lead, q),
    busy: () => busyLine(lead.name ?? "Squad Lead", readActivity()),
    files: { dir: join(leadDir(), "files"), token: botToken(cfg) },
    choices: (options, where) => { const c = choiceCard(options, where, lead, server); return { ...forServer(server, c), sent: c.sent }; } });
  log(`govern slack lead in ${lead.channel} for ${repo()} as ${self}, answering ${lead.users.join(", ")}`);
  bot.resume();
  let syncing = false;
  const cards = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void syncCards(call, lead, log).then(() => syncChoices(call, lead, log)).finally(() => { syncing = false; });
  }, 1000);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try { bot.onEvent(JSON.parse(line)); } catch (e) { log(`slack lead: an event was not read: ${(e as Error).message}`); }
  });
  await new Promise<void>((done) => {
    rl.on("close", done);
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => rl.close());
  });
  clearInterval(cards);
  await bot.idle();
}

// ---------------------------------------------------------------------------------------------------------------------
// `govern slack lead enable|status|mode`

/** Write slack.lead (and the Lead's mailbox) into the workspace config, keeping a .bak of the file as it was. */
export function enableLead(o: { channel: string; users: string[]; session?: string; cwd?: string; mode?: string; name?: string; brief?: string; model?: string }): string {
  const file = configFile();
  if (!existsSync(file)) fail(`${file} does not exist: run \`govern init\` first`);
  const text = readFileSync(file, "utf8");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; } catch (e) { return fail(`${file} is not valid JSON (${(e as Error).message})`); }
  const slack = record(raw.slack) ? raw.slack : fail(`${file} has no slack block: set slack.team (and slack.channel) first`);
  if (slack.channel === o.channel) fail(`${o.channel} is slack.channel, the squad's channel: the Lead needs a channel of its own`);
  const mode = o.mode === undefined ? undefined : modeNamed(o.mode) ?? fail(`--mode must be default, edit, auto or plan`);
  const prev = record(slack.lead) ? slack.lead : {};
  slack.lead = { ...prev, channel: o.channel, users: o.users, ...(o.name ? { name: o.name } : {}), ...(o.session ? { session: o.session } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}), ...(mode ? { permissionMode: mode } : {}), ...(o.brief ? { brief: o.brief } : {}), ...(o.model ? { model: o.model } : {}) };
  const boxes = Array.isArray(raw.mailboxes) ? raw.mailboxes as unknown[] : [];
  if (!boxes.includes(LEAD_MAILBOX)) raw.mailboxes = [...boxes, LEAD_MAILBOX];
  const next = JSON.stringify(raw, null, 2) + "\n";
  checkConfig(file, next);
  writeFileSync(`${file}.bak`, text, { mode: 0o600 });
  writeAtomic(file, next);
  forgetConfigs();
  leadSettings();
  return [`slack.lead set in ${file} (the file as it was: ${file}.bak)`,
    "Next:",
    `  1. the Slack app: Event Subscriptions on, Request URL https://<your serve>/slack/events (slack.transport "http"),`,
    `     bot events message.channels and message.groups; or nothing more on Socket Mode`,
    `  2. /invite the app in ${o.channel}`,
    `  3. \`govern slack serve\` must serve ${repo()} (its own workspace, or one naming it in slack.serveRepos); a running serve`,
    `     reads the change on the next event, but naming a new workspace in slack.serveRepos needs a restart`].join("\n");
}

/** Where the Lead stands: its channel, session, mode, open turns and permission requests. */
export function leadStatus(): string {
  const { lead } = leadSettings();
  const open = openQuestions(LEAD_JOURNAL).filter((e) => e.conv);
  let waiting = 0;
  try { waiting = readdirSync(permDir()).filter((n) => n.endsWith(".request.json") && !readDecision(n.slice(0, -".request.json".length))).length; } catch { /* none yet */ }
  return [`channel   ${lead.channel}`, `people    ${lead.users.join(", ")}`, `session   ${leadSession(lead) ?? "(new on the first turn)"}`,
    `mode      ${currentMode(lead)}`, `cwd       ${lead.cwd ?? repo()}`, `turns     ${open.length} open`, `asks      ${waiting} waiting on a person`].join("\n");
}
