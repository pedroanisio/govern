// `govern doctor`'s Slack probes for one workspace (lib/doctor.ts runs them with GOVERN_REPO set to it): the config names a
// team and a channel, the bot token is there and its env file is private, Slack accepts the token for that team, the bot is
// in the channel, and the listener polled recently. Slack's answers are outside input: each field read is type-checked, and
// no answer, token or response body is printed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { slackConfig, configFile } from "../../lib/workspace.ts";
import { clip, GovernError } from "../../lib/util.ts";
import type { DoctorTarget, Finding, Status, Remedy } from "../../lib/doctor.ts";
import { slackCall, SlackError } from "./channel.ts";
import { SLACK_API } from "./notify.ts";
import { botTokenVar, findBotToken } from "./secrets.ts";

/** How old the listener's heartbeat may be when slack.alerts gives no listenStaleSec. */
const LISTEN_STALE_SEC = 300;

const minutes = (ms: number): string => `${Math.round(ms / 60000)} min`;
/** A string field of a Slack answer, or undefined when it is absent or not a string. */
const text = (o: unknown, k: string): string | undefined => {
  const v = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : undefined;
};
/** What may be said of a failed call: SlackError and GovernError messages are already free of tokens and bodies; anything
 *  else is a defect and propagates. */
function reason(e: unknown): string {
  if (e instanceof SlackError || e instanceof GovernError) return e.message;
  throw e;
}

/** The Slack findings of the workspace `t` names, in the order config, token, auth, channel, listener. */
export async function doctor(t: DoctorTarget): Promise<Finding[]> {
  const id = (k: string) => `slack:${t.name}:${k}`, out: Finding[] = [];
  const add = (k: string, status: Status, evidence: string, o: Remedy = {}) =>
    out.push({ id: id(k), group: "slack", status, actor: o.actor ?? "agent", evidence,
      ...(status === "fail" ? { ...(o.fix ? { fix: o.fix } : {}), ...(o.command ? { command: o.command } : {}), ...(o.action ? { action: o.action } : {}) } : {}) });
  const skipRest = (why: string) => { for (const k of ["auth", "channel"]) if (!out.some((f) => f.id === id(k))) add(k, "skip", why); };

  const cfg = slackConfig();
  if (!cfg || !cfg.channel) {
    add("config", "fail", cfg ? "no slack.channel: notify has nowhere to post" : "the workspace enables slack but its config has no slack section",
      { actor: "operator", fix: `Add "slack": {"team": "T…", "channel": "C…", "envFile": "secrets/slack.env"} to ${configFile()} (SLACK-TUTORIAL.md walks through it).` });
    return out;
  }
  add("config", "ok", `team ${cfg.team}, channel ${cfg.channel}`);

  // The token: present, and its env file readable by this account alone.
  const variable = botTokenVar(cfg);
  let token: string | undefined;
  if (cfg.envFile && !existsSync(cfg.envFile) && !process.env[variable]) {
    add("token", "fail", `${cfg.envFile} does not exist yet: no bot token`, { actor: "operator",
      fix: `Paste the Slack bot token (xoxb-…); it is saved as ${variable} in ${cfg.envFile}, readable by this account only.`, action: { kind: "slack-token", file: cfg.envFile, variable } });
    skipRest("no token");
    return out;
  }
  try { token = findBotToken(cfg); } catch (e) { add("token", "fail", reason(e), { actor: "operator", fix: `Create ${cfg.envFile} (mode 600) with ${variable}=xoxb-….` }); skipRest("no token"); }
  if (out.some((f) => f.id === id("token"))) return out;
  if (!token) {
    add("token", "fail", `${variable} is not set and ${cfg.envFile ? `${cfg.envFile} does not hold it` : "the config names no slack.envFile"}`,
      { actor: "operator", fix: `Put ${variable}=xoxb-… (scopes chat:write, and channels:read to check membership) in ${cfg.envFile ?? "a file named by slack.envFile"}, mode 600.`,
        ...(cfg.envFile ? { action: { kind: "slack-token", file: cfg.envFile, variable } as const } : {}) });
    skipRest("no token");
    return out;
  }
  const mode = cfg.envFile && existsSync(cfg.envFile) ? statSync(cfg.envFile).mode & 0o777 : undefined;
  if (mode !== undefined && mode & 0o077)
    add("token", "fail", `${cfg.envFile} is readable by group or others (mode ${mode.toString(8)})`, { fix: "Make the file readable by this account only.", command: `chmod 600 ${cfg.envFile}`, action: { kind: "chmod-private", file: cfg.envFile! } });
  else add("token", "ok", `${variable} from ${mode !== undefined && !process.env[variable] ? cfg.envFile : "the environment"}`);

  // Slack's answer for the token, then for the channel.
  const call = slackCall(process.env.GOVERN_SLACK_API ?? SLACK_API, token, t.request);
  let bot: string | undefined;
  try {
    const a = await call("auth.test", {});
    const team = text(a, "team_id"), user = text(a, "user") ?? text(a, "user_id");
    if (!team) add("auth", "fail", "auth.test answered without a team_id string", { fix: "Check that GOVERN_SLACK_API, when set, points at Slack's API." });
    else if (team !== cfg.team) add("auth", "fail", `the token is of team ${team}; slack.team is ${cfg.team}`, { actor: "operator", fix: `Use the bot token of team ${cfg.team}, or correct slack.team in ${configFile()}.` });
    else { bot = user ?? "the bot"; add("auth", "ok", `${bot} in team ${team}`); }
  } catch (e) {
    add("auth", "fail", clip(reason(e), 200), { actor: "operator", fix: `Reinstall the Slack app to the workspace and put its new bot token in ${cfg.envFile ?? variable}.` });
  }
  if (bot === undefined) add("channel", "skip", "Slack did not accept the token");
  else {
    try {
      const c = await call("conversations.info", { channel: cfg.channel });
      const ch = (c as { channel?: unknown }).channel, member = typeof ch === "object" && ch !== null ? (ch as { is_member?: unknown }).is_member : undefined;
      const label = text(ch, "name") ? `#${text(ch, "name")}` : cfg.channel;
      if (member === true) add("channel", "ok", `${bot} is a member of ${label}`);
      else if (member === false) add("channel", "fail", `${bot} is not a member of ${label}: notify cannot post there`, { actor: "operator", fix: `In Slack, open ${label} and type /invite @${bot}.` });
      else add("channel", "fail", "conversations.info answered without channel.is_member", { fix: "Check that GOVERN_SLACK_API, when set, points at Slack's API." });
    } catch (e) {
      const why = reason(e);
      if (/missing_scope/.test(why)) add("channel", "skip", "the token lacks channels:read (groups:read for a private channel): membership not verified");
      else add("channel", "fail", clip(why, 200), { actor: "operator", fix: `Check that slack.channel ${cfg.channel} exists and the bot can see it.` });
    }
  }

  // The listener: it writes heartbeat.json in the inbox after each successful poll.
  if (!cfg.inbox) add("listener", "skip", "no slack.inbox: this workspace does not read its channel");
  else {
    const file = join(cfg.inbox, "heartbeat.json"), stale = (cfg.alerts?.listenStaleSec ?? LISTEN_STALE_SEC) * 1000;
    let last: number | undefined;
    try { last = Date.parse(text(JSON.parse(readFileSync(file, "utf8")), "lastSuccess") ?? ""); } catch { last = undefined; }
    const fix = { fix: "Start the listener (govern slack install-service writes its unit); if it is running, read its log.", command: "systemctl --user enable --now govern-slack-listen.service" };
    if (last === undefined || !Number.isFinite(last)) add("listener", "fail", `no readable ${file}: the listener has not polled`, fix);
    else if (t.now - last > stale) add("listener", "fail", `last poll ${minutes(t.now - last)} ago (stale after ${minutes(stale)})`, fix);
    else add("listener", "ok", `last poll ${minutes(Math.max(t.now - last, 0))} ago`);
  }
  return out;
}
