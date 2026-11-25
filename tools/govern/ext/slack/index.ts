// Slack: decisions people make with buttons in Slack, verified by Slack's request signature and recorded as the mapped
// person's own (SLACK.md). A workspace turns this extension on with `govern ext enable slack`.
import { readFileSync } from "node:fs";
import { slackServer, handleSocketInteraction, handleSocketEvent } from "./slack.ts";
import { runSocket } from "./socket.ts";
import { serverOf } from "./server.ts";
import { notify, type NotifyReport } from "./notify.ts";
import { slackConfig, configFile } from "../../lib/workspace.ts";
import { fail, usage, opt, flag, many } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { out, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { poll, slackCall, postMessage, uploadFile, resolveSend, wasSent, wasAttempted } from "./channel.ts";
import { routePending, startLine } from "./route.ts";
import { publishApproved } from "./publish.ts";
import { digest } from "./digest.ts";
import { commandText } from "./commands.ts";
import { runTrigger } from "./triggers.ts";
import { installServices } from "./service.ts";
import { MANPAGE } from "./manpage.ts";
import { triage, open, dismiss, type Item } from "./triage.ts";
import { heartbeatSettings, heartbeatStatus, clock } from "./heartbeat.ts";
import { secret, botToken } from "./secrets.ts";
import { doctor } from "./doctor.ts";
import { chatBot } from "./chat.ts";
import { userInfo } from "node:os";
import { leadRouter, runLead, enableLead, leadStatus, leadSettings, currentMode, modeNamed, setMode, type LeadRouter } from "./lead.ts";
import { leadAdapter } from "./lead-adapter.ts";
import { approveServer } from "./lead-approve.ts";


/** `govern slack serve`: decide clicks, once the team is configured: an interactivity server on loopback for Slack's signed
 *  requests (slack.transport "http"), or a Socket Mode connection govern opens with the app-level token ("socket"). */
async function cmdServe(a: Args): Promise<void> {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team whose requests count`);
  const server = serverOf(cfg);
  // Forms (slack.forms) open a modal with views.open under the bot token, within the click's 3 s trigger window.
  // slack.cards: a refused thread reply is explained to its author with chat.postEphemeral, under the bot token too.
  const call = cfg.forms || cfg.cards ? slackCall(server.api, botToken(cfg)) : undefined;
  const log = (l: string) => process.stderr.write(`${l}\n`);
  // Messages in the Lead channels of the served workspaces go to each one's Lead process (slack.lead, LEAD.md).
  const leads: LeadRouter = leadRouter({ log });
  const opts = { server, lead: (p: unknown) => leads.route(p), ...(call ? { call } : {}) };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { leads.close(); process.exit(0); });
  if (cfg.transport === "socket") {
    if (opt(a, "port") !== undefined) usage("--port is for slack.transport \"http\"; Socket Mode listens on no port");
    const token = secret("SLACK_APP_TOKEN", process.env.SLACK_APP_TOKEN, cfg.envFile)
      ?? fail(`SLACK_APP_TOKEN is not set: export it, or put it in the dotenv file slack.envFile names in ${configFile()} (Slack: the app-level token xapp-… with connections:write; Tayet: the sidecar's local token)`);
    out(`govern slack (team ${cfg.team}) over Socket Mode at ${server.api}`);
    await runSocket({ api: server.api, token, log,
      handle: async (payload, envelope) => {
        const r = await handleSocketInteraction(payload, envelope, { server, ...(call ? { call } : {}) });
        if (!r.value.ok) process.stderr.write(`slack: click refused (${r.value.error})\n`);
        return r.reply !== undefined ? { reply: r.reply } : {};
      },
      onEvent: (payload: unknown) => { void handleSocketEvent(payload, opts).then((r) => {
        if (!r.value.ok) process.stderr.write(`slack: event refused (${r.value.error})\n`);
      }); } });
    return;
  }
  const signing = secret("SLACK_SIGNING_SECRET", process.env.SLACK_SIGNING_SECRET, cfg.envFile)
    ?? fail(`SLACK_SIGNING_SECRET is not set: export it, or name a dotenv file holding it as slack.envFile in ${configFile()}`);
  const http = slackServer(signing, opts);
  const port = Number(opt(a, "port") ?? 5003);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage("--port must be 0..65535");
  http.on("error", (e) => { process.stderr.write(`slack: ${e.message}\n`); process.exitCode = 1; });
  http.listen(port, "127.0.0.1", () => out(`govern slack (team ${cfg.team}) on http://127.0.0.1:${port}/slack/actions and /slack/events`));
}

/** `govern slack chat`: answer the people slack.chat.users names in slack.channel, over Socket Mode, until stopped. */
async function cmdChat(): Promise<void> {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team whose requests count`);
  const chat = cfg.chat ?? fail(`${configFile()} names no slack.chat: the people (slack.chat.users) whose messages in slack.channel the agent answers`);
  const channel = cfg.channel ?? fail(`${configFile()} names no slack.channel: the channel slack.chat answers in`);
  const server = serverOf(cfg), botKey = botToken(cfg), call = slackCall(server.api, botKey);
  const token = secret("SLACK_APP_TOKEN", process.env.SLACK_APP_TOKEN, cfg.envFile)
    ?? fail(`SLACK_APP_TOKEN is not set: export it, or put it in the dotenv file slack.envFile names in ${configFile()} (Slack: the app-level token xapp-… with connections:write; Tayet: the sidecar's local token)`);
  const self = (await call("auth.test", {})).user_id;
  if (typeof self !== "string" || !self) fail("auth.test answered no user_id: the agent's own id is needed to tell its messages apart");
  const log = (l: string) => process.stderr.write(`${l}\n`), stop = new AbortController();
  // A reply's files go through slack.upload, journaled in slack.inbox as `govern slack upload` journals them.
  const upload = cfg.upload && cfg.inbox ? { inbox: cfg.inbox, ...cfg.upload, api: server.api, token: botKey } : undefined;
  const bot = chatBot({ call, channel, self, chat, log, ...(upload ? { upload } : {}) });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
  out(`govern slack chat in ${channel} as ${self} at ${server.api}, answering ${chat.users.join(", ")}`);
  bot.resume();
  await runSocket({ api: server.api, token, log, signal: stop.signal, onEvent: (p) => bot.onEvent(p) });
  await bot.idle();
}

/** `govern slack lead enable|status|mode|run|adapter|approve-mcp`: the Squad Lead (LEAD.md). */
async function cmdLead(a: Args): Promise<void> {
  const verb = a._[2];
  if (verb === "enable") {
    const users = many(a, "user");
    if (!users.length) usage("lead enable requires --user U… (one per person who may write to the Lead and answer its asks)");
    const s = (k: string) => opt(a, k);
    out(enableLead({ channel: s("channel") ?? usage("lead enable requires --channel C…"), users,
      ...Object.fromEntries((["session", "cwd", "mode", "name", "brief", "model"] as const).flatMap((k) => (s(k) !== undefined ? [[k, s(k)!]] : []))) }));
    return;
  }
  if (verb === "status") { out(leadStatus()); return; }
  if (verb === "mode") {
    const { lead } = leadSettings(), word = a._[3];
    if (word === undefined) { out(currentMode(lead)); return; }
    const mode = modeNamed(word) ?? usage("lead mode takes default, edit (acceptEdits), auto or plan");
    setMode(mode, userInfo().username, "cli");
    out(`mode ${mode}, from the next turn`);
    return;
  }
  if (verb === "run") return runLead();
  if (verb === "adapter") return leadAdapter();
  if (verb === "approve-mcp") return approveServer();
  usage("govern slack lead enable|status|mode [M]|run|adapter|approve-mcp");
}

const summary = (r: NotifyReport): string =>
  [...r.posted.map((k) => `posted ${k}`), ...r.superseded.map((k) => `superseded ${k}`), ...r.closed.map((k) => `closed ${k}`),
    ...r.alerts.map((k) => `alert ${k}`), ...r.heartbeat.map((k) => `heartbeat ${k}`), ...r.failed.map((k) => `failed ${k}`)].join("\n") || "(nothing to post)";

/** `govern slack notify`: post what the lanes wait on from people, once, or every --interval seconds with --loop. */
async function cmdNotify(a: Args): Promise<void> {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team whose requests count`);
  const channel = cfg.channel ?? fail(`${configFile()} names no slack.channel: the channel notify posts to (C…)`);
  const token = botToken(cfg);
  const lanes = many(a, "lane"), interval = Number(opt(a, "interval") ?? 30);
  if (!Number.isInteger(interval) || interval < 5) usage("--interval must be a whole number of seconds, 5 or more");
  const once = async () => {
    const r = await notify({ api: serverOf(cfg).api, server: serverOf(cfg), token, channel, alertsChannel: cfg.alertsChannel, dryRun: flag(a, "dry-run"),
      ...(lanes.length ? { lanes } : {}), ...(cfg.labels ? { labels: cfg.labels } : {}), ...(cfg.threads ? { threads: true } : {}), ...(cfg.cards ? { cards: true } : {}), ...(cfg.forms ? { forms: true } : {}),
      ...(cfg.lead ? { leadChannel: cfg.lead.channel, ...(cfg.lead.waitHours !== undefined ? { leadWaitHours: cfg.lead.waitHours } : {}) } : {}) });
    out(summary(r));
    return r.failed.length === 0;
  };
  if (!flag(a, "loop")) { if (!(await once())) process.exitCode = 1; return; }
  for (;;) {
    try { await once(); } catch (e) { process.stderr.write(`slack notify: ${(e as Error).message}\n`); }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

/** The channel commands stay off until both their destination and private local inbox are named. */
function channelSettings() {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack configuration`);
  const channel = cfg.channel || fail(`${configFile()} names no slack.channel`);
  const inbox = cfg.inbox || fail(`${configFile()} names no slack.inbox`);
  const token = botToken(cfg);
  return { cfg: { ...cfg, channel }, inbox, token, call: slackCall(serverOf(cfg).api, token), api: serverOf(cfg).api };
}

async function cmdListen(a: Args): Promise<void> {
  if (flag(a, "once") && flag(a, "loop")) usage("--once and --loop are mutually exclusive");
  if (opt(a, "interval") !== undefined && !flag(a, "loop")) usage("--interval requires --loop");
  const interval = Number(opt(a, "interval") ?? 60);
  if (!Number.isInteger(interval) || interval < 1) usage("--interval must be a positive whole number of seconds");
  const { cfg, inbox, call } = channelSettings();
  const once = async () => {
    startLine(inbox, cfg);
    const count = await poll(call, inbox, cfg, async (post, command) => {
      const key = `command:${post.ts}`;
      if (wasSent(inbox, key)) return;
      if (wasAttempted(inbox, key)) { process.stderr.write(`slack listen: command ${post.ts} has an uncertain send; settle it with govern slack resolve --key ${key}\n`); return; }
      const text = command.startsWith("run ") ? runTrigger(command.slice(4), cfg.triggers, inbox, new Date())
        : commandText(command, Object.keys(cfg.triggers ?? {}));
      await postMessage(call, inbox, cfg.channel, { kind: "note", text, thread: post.thread_ts ?? post.ts, threadIsParent: true, key });
    });
    const routed = await routePending(call, inbox, cfg);
    for (const id of await publishApproved(call, inbox, cfg.channel)) out(`slack listen: published ${id}`);
    if (routed.waiting.length) process.stderr.write(`slack listen: route limit; ${routed.waiting.length} request(s) remain in inbox\n`);
    if (count) out(`slack listen: ${count} new`);
  };
  if (!flag(a, "loop")) { await once(); return; }
  for (;;) {
    try { await once(); } catch (e) { process.stderr.write(`slack listen: ${(e as Error).message}\n`); }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

async function cmdPost(a: Args): Promise<void> {
  const kind = opt(a, "kind") ?? usage("post requires --kind");
  const text = opt(a, "text"), file = opt(a, "file");
  if ((text === undefined) === (file === undefined)) usage("post requires exactly one of --text or --file");
  const { cfg, inbox, call } = channelSettings();
  const alerts = flag(a, "alerts");
  if (alerts && opt(a, "thread") !== undefined) usage("--alerts posts a top-level line; it cannot take --thread");
  const channel = alerts ? (cfg.alertsChannel || fail(`${configFile()} names no slack.alertsChannel`)) : cfg.channel;
  const sent = await postMessage(call, inbox, channel, { kind, text: file === undefined ? text! : readFileSync(file, "utf8"),
    thread: opt(a, "thread"), key: opt(a, "key") });
  out(`slack post: ${sent.ts}`);
}

/** Explicit binary media upload, constrained by the workspace's resolved upload roots. */
async function cmdUpload(a: Args): Promise<void> {
  const file = opt(a, "file") ?? usage("upload requires --file");
  const thread = opt(a, "thread") ?? usage("upload requires --thread");
  const { cfg, inbox, token, call, api } = channelSettings();
  const receipt = await uploadFile(call, inbox, cfg.channel, cfg.upload, { file, thread, title: opt(a, "title"), text: opt(a, "text"), key: opt(a, "key"), api, token });
  out(`slack upload: ${receipt.ts}`);
}

/** Settle an uncertain send: reads Slack, journals or releases the key, and posts nothing. */
async function cmdResolve(a: Args): Promise<void> {
  const key = opt(a, "key") ?? usage("resolve requires --key");
  const { cfg, inbox, call } = channelSettings();
  out(`slack resolve: ${await resolveSend(call, inbox, cfg.channel, { key, delivered: flag(a, "delivered"), notDelivered: flag(a, "not-delivered"), ts: opt(a, "ts") })}`);
}

/** Explicit daily summary, using the same credentials and durable send keys as post. */
async function cmdDigest(): Promise<void> {
  const { cfg, inbox, call } = channelSettings();
  out(await digest(call, inbox, cfg) ? "slack digest: posted" : "slack digest: nothing to post");
}

/** Triage reads only the local journals: no token, no Slack call. */
function triageSettings() {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack configuration`);
  const channel = cfg.channel || fail(`${configFile()} names no slack.channel`);
  const inbox = cfg.inbox || fail(`${configFile()} names no slack.inbox`);
  return { ...cfg, channel, inbox };
}
const line = (i: Item) => `${i.ts}  ${i.state}${i.rule ? `:${i.rule}` : ""}  ${i.who ?? i.user}  thread ${i.thread}  ${i.text.replace(/\s+/g, " ").slice(0, 100)}`;

/** `govern slack triage`: every post owed a reply or a manual review; --all lists every disposition; --check exits 1 when any is open. */
function cmdTriage(a: Args): void {
  const items = triage(triageSettings()), shown = flag(a, "all") ? items : open(items);
  if (flag(a, "json")) out(JSON.stringify(shown));
  else out(shown.map(line).join("\n") || "slack triage: nothing open");
  if (flag(a, "check") && open(items).length) process.exitCode = 1;
}

/** `govern slack dismiss`: record that one post needs nothing further, with the reason. */
function cmdDismiss(a: Args): void {
  const ts = opt(a, "ts") ?? usage("dismiss requires --ts");
  dismiss(triageSettings(), ts, opt(a, "reason") ?? usage("dismiss requires --reason"));
  out(`slack dismiss: ${ts}`);
}

/** `govern slack heartbeat`: the session heartbeat's age, fresh, stale or missing, and its open alert; reads local files only,
 *  sends nothing. Exits 1 unless the beat is fresh, so a headless shift can tell that nobody is answering. */
function cmdHeartbeat(a: Args): void {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack configuration`);
  const s = heartbeatSettings(cfg) ?? fail(`${configFile()} names no slack.heartbeat: the session heartbeat file to watch`);
  const st = heartbeatStatus(s), now = Date.now();
  if (st.state !== "fresh") process.exitCode = 1;
  if (flag(a, "json")) { out(JSON.stringify(st)); return; }
  const alert = st.error ? `alert state unreadable: ${st.error}; notify rebuilds it from sent.jsonl`
    : st.alert ? `alert open since ${clock(Date.parse(st.alert.since), now)} (blocked: ${st.alert.ts})` : "no alert open";
  out(st.state === "missing" ? `missing: ${st.file} has never been written; ${alert}`
    : `${st.state}: last beat ${st.ageSeconds} s ago (${st.file}), stale after ${st.staleSeconds} s; ${alert}`);
}

export const name = "slack";
export const description = "Slack: decisions people make with buttons in Slack, verified by Slack's signature";
export const docs: ExtDoc[] = [{ title: "Slack: decisions from Slack buttons, signature checks, people mapping", path: "SLACK.md" }];
export const manpage = MANPAGE;
/** `govern doctor`'s Slack probes for this workspace (doctor.ts). */
export { doctor };

export const commands: Cmd[] = [
  { name: "slack", section: 7, noSub: "govern slack serve|chat|lead|notify|listen|post|upload|resolve|digest|triage|dismiss|heartbeat|install-service (the protocol: tools/govern/SLACK.md)",
    subs: {
      "install-service": { lines: [["", "write user units for listen, notify and a daily digest timer; print enable instructions without starting them"]], run: () => out(installServices()) },
      upload: { flags: { value: ["thread", "file", "title", "text", "key"] },
        lines: [["--thread TS --file PATH [--title T] [--text T] [--key K]", "upload an allowed image, video or PDF inside slack.upload.roots and maxBytes; resolve the thread and journal the file id"]], run: cmdUpload },
      resolve: { flags: { value: ["key", "ts"], bool: ["delivered", "not-delivered"] },
        lines: [["--key K [--delivered [--ts TS] | --not-delivered]", "settle an uncertain send: an upload never completed is released, one completed is looked up in its thread; posts nothing"]], run: cmdResolve },
      triage: { flags: { bool: ["json", "check", "all"] },
        lines: [["[--all] [--json] [--check]", "list posts owed a reply (request) or a manual review (review): answered means a send or bot reply in the\nthread later than the post; slack.triage.rules map posts that need none; --check exits 1 while any is open"]], run: cmdTriage },
      dismiss: { flags: { value: ["ts", "reason"] },
        lines: [["--ts TS --reason R", "record in slack.inbox/triage.jsonl that a post needs nothing further, and why; posts nothing"]], run: cmdDismiss },
      heartbeat: { flags: { bool: ["json"] },
        lines: [["[--json]", "the session heartbeat (slack.heartbeat.file): its age, fresh, stale or missing, and the open alert; sends\nnothing; exits 1 unless fresh"]], run: cmdHeartbeat },
      digest: { lines: [["", "post waiting people, failed tasks and open alerts once per local day; stay silent when empty"]], run: cmdDigest },
      listen: { flags: { bool: ["once", "loop"], value: ["interval"] },
        lines: [["[--once | --loop --interval 60]", "record new channel posts in slack.inbox; first run marks existing posts seen; answer configured requesters' fixed commands"]], run: cmdListen },
      post: { flags: { value: ["kind", "text", "file", "thread", "key"], bool: ["alerts"] },
        lines: [["--kind ack|blocked|delivered|question|note (--text T | --file F) [--thread TS | --alerts] [--key K]", "send a prefixed message to slack.channel (or slack.alertsChannel with --alerts), resolve a thread parent and journal the send in slack.inbox/sent.jsonl"]], run: cmdPost },
      serve: { flags: { value: ["port"] },
        lines: [["[--port 5003]", "serve Slack's interactivity requests (POST /slack/actions) and events (POST /slack/events) on loopback, and\nrun the Lead of each served workspace with slack.lead; the signing secret comes from SLACK_SIGNING_SECRET or the\nconfig's slack.envFile, the team from slack.team"]], run: cmdServe },
      lead: { flags: { value: ["channel", "session", "cwd", "mode", "name", "brief", "model"], multi: ["user"] },
        lines: [["enable --channel C --user U [--user U]... [--session ID] [--cwd DIR] [--mode M] [--name N] [--brief F] [--model M]",
          "write slack.lead: the Squad Lead answers these people in its own channel C by continuing a Claude Code session on\nthis host (LEAD.md); slack serve routes the channel's messages to it and decides its permission cards"],
          ["status", "the Lead's channel, people, Claude session, permission mode, open turns and asks waiting on a person"],
          ["mode [default|edit|auto|plan]", "show or set the Lead's permission mode, from its next turn (people in the channel: `mode auto`)"],
          ["run | adapter | approve-mcp", "internal: the Lead's process (started by slack serve), its conversation adapter, its permission prompt tool"]],
        run: cmdLead },
      chat: { lines: [["", "answer the people slack.chat.users names in slack.channel over Socket Mode: each message is a turn of a\ngovern conversation (slack.chat.profile or .adapter), its reply posted in the channel or its thread; runs until stopped"]], run: cmdChat },
      notify: { flags: { multi: ["lane"], value: ["interval"], bool: ["loop", "dry-run"] },
        lines: [["[--lane S]... [--loop --interval 30] [--dry-run]", "post to slack.channel what the lanes wait on from people (human tasks, gates) and open timer alerts, once each,\nwith buttons bound to the case; update a message when its decision is made or the case changes; with\nslack.heartbeat, post blocked: when the session heartbeat goes stale and note: when it returns. The bot token is\nSLACK_BOT_TOKEN or the config's slack.envFile; --dry-run sends no notifications and leaves notification receipts unchanged"]], run: cmdNotify },
    } },
];
