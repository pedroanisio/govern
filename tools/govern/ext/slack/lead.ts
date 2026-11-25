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
// per ask, its decision and its card), allow/<session>.json (what was allowed for the rest of a session), activity.json
// (what the turn under way is doing, while one runs).
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { configFile, checkConfig, forgetConfigs, inRepo, repo, slackConfig, stateDir, FOLDER_OVERRIDES, LEAD_MODES,
  type LeadConfig, type LeadMode } from "../../lib/workspace.ts";
import { BadRequest, Forbidden, NotFound } from "../../lib/http-errors.ts";
import { GovernError, fail, nowIso } from "../../lib/util.ts";
import type { SlackSource } from "../../lib/approval.ts";
import * as sessions from "../../lib/conversation.ts";
import { chatBot, openQuestions } from "./chat.ts";
import { slackCall, type Call } from "./channel.ts";
import { serverOf } from "./server.ts";
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
const ACTIONS = { allow: "govern.lead.allow", session: "govern.lead.allow-session", deny: "govern.lead.deny" } as const;
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
  /** Where the turn was asked, linked from the card. */ channel?: string; thread?: string; at: string; expires: string }
export interface PermissionDecision { behavior: "allow" | "deny"; scope?: "once" | "session"; by: string;
  via: "slack" | "rule" | "timeout" | "cancelled"; at: string }
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

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** What a tool use asks for, short enough for a card. */
export function describe(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "Bash" && typeof i.command === "string")
    return `${typeof i.description === "string" ? `${i.description}\n` : ""}\`\`\`${clip(i.command, 2500)}\`\`\``;
  if (typeof i.file_path === "string") return `\`${i.file_path}\``;
  return `\`\`\`${clip(JSON.stringify(input, null, 1) ?? "", 2500)}\`\`\``;
}

/** The card for request `r`. */
export function cardOf(r: PermissionRequest, lead: LeadConfig): { text: string; blocks: unknown[] } {
  const name = lead.name ?? "Squad Lead", who = lead.users.map((u) => `<@${u}>`).join(" ");
  const link = r.channel && r.thread ? ` (<https://slack.com/archives/${r.channel}/p${r.thread.replace(".", "")}|asked here>)` : "";
  const rule = ruleOf(r.tool, r.input), minutes = Math.round((Date.parse(r.expires) - Date.parse(r.at)) / 60000);
  const value = JSON.stringify({ v: 1, req: r.req });
  const head = `🔐 *${name}* asks to run *${r.tool}*${link}`;
  return {
    text: `${head}: ${who}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${head}\n${describe(r.tool, r.input)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${who} · no answer in ${minutes} min is a deny` }] },
      { type: "actions", elements: [
        { type: "button", action_id: ACTIONS.allow, text: { type: "plain_text", text: "Allow once" }, style: "primary", value },
        { type: "button", action_id: ACTIONS.session, text: { type: "plain_text", text: rule.startsWith("Bash(") ? "Allow this command for the session" : `Allow ${clip(rule, 40)} for the session` }, value },
        { type: "button", action_id: ACTIONS.deny, text: { type: "plain_text", text: "Deny" }, style: "danger", value }] }
    ]
  };
}

/** The line a decided card ends with. */
export function decisionLine(d: PermissionDecision): string {
  if (d.via === "timeout") return "⌛ Expired without an answer: denied";
  if (d.via === "cancelled") return "⏹️ The turn ended before an answer";
  if (d.via === "rule") return "✅ Allowed by an earlier allow-for-the-session";
  return d.behavior === "deny" ? `❌ Denied by <@${d.by}>` : d.scope === "session" ? `✅ Allowed for the session by <@${d.by}>` : `✅ Allowed once by <@${d.by}>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Clicks (slack.ts interact): a permission card's button.

export interface LeadClick { team: string; user: string; channel: string; action: keyof typeof ACTIONS; req: string }
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A permission card click, or undefined for any other payload. */
export function leadClickOf(p: unknown): LeadClick | undefined {
  if (!record(p) || p.type !== "block_actions" || !Array.isArray(p.actions)
    || !p.actions.some((x) => record(x) && typeof x.action_id === "string" && x.action_id.startsWith(LEAD_ACTION))) return undefined;
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
  return { team, user, channel, action, req: value.req };
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

/** Record a permission card click as the clicker's decision, in the Lead's own workspace; the line the card ends with. */
export function performLeadClick(c: LeadClick, source: SlackSource): string {
  const ours = slackConfig()?.team ?? (() => { throw new Forbidden("the workspace config names no slack.team"); })();
  if (c.team !== ours) throw new Forbidden(`the request comes from Slack team ${c.team}, not ${ours}`);
  const at = leadMap().get(c.channel) ?? (() => { throw new NotFound(`${c.channel} is no Lead channel this server serves`); })();
  return inRepo(at.ws, () => {
    const { cfg, lead } = leadSettings();
    if (cfg.team !== c.team) throw new Forbidden(`${at.ws} belongs to Slack team ${cfg.team}, not ${c.team}`);
    if (!lead.users.includes(c.user)) throw new Forbidden(`Slack user ${c.user} is not one of ${at.ws}'s slack.lead.users`);
    const r = readRequest(c.req) ?? (() => { throw new NotFound("no such permission request"); })();
    const d: PermissionDecision = { behavior: c.action === "deny" ? "deny" : "allow", ...(c.action === "session" ? { scope: "session" as const } : { scope: "once" as const }),
      by: c.user, via: "slack", at: nowIso() };
    const { decision, first } = decide(c.req, d);
    if (!first) throw new GovernError(`already decided: ${decisionLine(decision)}`, 1);
    if (c.action === "session") addAllowRule(r.session, ruleOf(r.tool, r.input));
    audit({ kind: "permission", req: c.req, tool: r.tool, rule: ruleOf(r.tool, r.input), session: r.session, decision: d, source });
    return `${decisionLine(d)}: *${r.tool}* ${describe(r.tool, r.input)}`;
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

/** Post the cards of requests that have none, and close those decided without a click (expired, cancelled). */
export async function syncCards(call: Call, lead: LeadConfig, log: (l: string) => void): Promise<void> {
  let names: string[];
  try { names = readdirSync(permDir()); } catch { return; }
  for (const n of names.filter((x) => x.endsWith(".request.json"))) {
    const req = n.slice(0, -".request.json".length);
    try {
      const r = readRequest(req);
      if (!r) continue;
      const card = readJson<{ channel: string; ts: string; closed?: boolean }>(permFile(req, "card"));
      const d = readDecision(req);
      if (!card && !d) {
        const sent = await call("chat.postMessage", { channel: lead.channel, ...cardOf(r, lead), unfurl_links: false });
        writeAtomic(permFile(req, "card"), JSON.stringify({ channel: lead.channel, ts: sent.ts }) + "\n");
      } else if (card && d && !card.closed) {
        if (d.via !== "slack") {
          const head = `*${r.tool}* ${describe(r.tool, r.input)}`;
          await call("chat.update", { channel: card.channel, ts: card.ts, text: `${decisionLine(d)}: ${head}`, blocks: [] });
        }
        writeAtomic(permFile(req, "card"), JSON.stringify({ ...card, closed: true }) + "\n");
      } else if (d && Date.now() - Date.parse(d.at) > KEEP_MS) {
        for (const k of ["request", "decision", "card"] as const) rmSync(permFile(req, k), { force: true });
      }
    } catch (e) { log(`slack lead: permission ${req}: ${(e as Error).message}`); }
  }
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
    busy: () => busyLine(lead.name ?? "Squad Lead", readActivity()) });
  log(`govern slack lead in ${lead.channel} for ${repo()} as ${self}, answering ${lead.users.join(", ")}`);
  bot.resume();
  let syncing = false;
  const cards = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void syncCards(call, lead, log).finally(() => { syncing = false; });
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
