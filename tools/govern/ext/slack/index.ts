// Slack: decisions people make with buttons in Slack, verified by Slack's request signature and recorded as the mapped
// person's own (SLACK.md). A workspace turns this extension on with `govern ext enable slack`.
import { existsSync, readFileSync } from "node:fs";
import { slackServer } from "./slack.ts";
import { notify, SLACK_API, type NotifyReport } from "./notify.ts";
import { slackConfig, configFile } from "../../lib/workspace.ts";
import { fail, usage, opt, flag, many } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { out, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { poll, slackCall, postMessage, uploadFile, resolveSend, wasSent, wasAttempted } from "./channel.ts";
import { routePending, startLine } from "./route.ts";
import { digest } from "./digest.ts";
import { commandText } from "./commands.ts";
import { installServices } from "./service.ts";
import { MANPAGE } from "./manpage.ts";

/** `fromEnv` (the variable `name` as the environment has it), else that variable from the config's slack.envFile;
 *  undefined when neither has it. */
function secret(name: string, fromEnv: string | undefined, envFile: string | undefined): string | undefined {
  if (fromEnv) return fromEnv;
  if (!envFile) return undefined;
  if (!existsSync(envFile)) fail(`${configFile()}: slack.envFile ${envFile} does not exist`);
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

/** Both notification and channel commands use the configured variable, then the same dotenv fallback. */
function botToken(cfg: NonNullable<ReturnType<typeof slackConfig>>): string {
  const variable = cfg.botTokenVar ?? "SLACK_BOT_TOKEN";
  return secret(variable, cfg.botTokenVar ? process.env[variable] : process.env.SLACK_BOT_TOKEN, cfg.envFile)
    ?? fail(`${variable} is not set: export it, or put it in the dotenv file slack.envFile names in ${configFile()}`);
}

/** `govern slack serve`: the interactivity server on loopback, once the team and the signing secret are configured. */
function cmdServe(a: Args): void {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team whose requests count`);
  const signing = secret("SLACK_SIGNING_SECRET", process.env.SLACK_SIGNING_SECRET, cfg.envFile)
    ?? fail(`SLACK_SIGNING_SECRET is not set: export it, or name a dotenv file holding it as slack.envFile in ${configFile()}`);
  const server = slackServer(signing);
  const port = Number(opt(a, "port") ?? 5003);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage("--port must be 0..65535");
  server.on("error", (e) => { process.stderr.write(`slack: ${e.message}\n`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => out(`govern slack (team ${cfg.team}) on http://127.0.0.1:${port}/slack/actions`));
}

const summary = (r: NotifyReport): string =>
  [...r.posted.map((k) => `posted ${k}`), ...r.superseded.map((k) => `superseded ${k}`), ...r.closed.map((k) => `closed ${k}`),
    ...r.alerts.map((k) => `alert ${k}`), ...r.failed.map((k) => `failed ${k}`)].join("\n") || "(nothing to post)";

/** `govern slack notify`: post what the lanes wait on from people, once, or every --interval seconds with --loop. */
async function cmdNotify(a: Args): Promise<void> {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team whose requests count`);
  const channel = cfg.channel ?? fail(`${configFile()} names no slack.channel: the channel notify posts to (C…)`);
  const token = botToken(cfg);
  const lanes = many(a, "lane"), interval = Number(opt(a, "interval") ?? 30);
  if (!Number.isInteger(interval) || interval < 5) usage("--interval must be a whole number of seconds, 5 or more");
  const once = async () => {
    const r = await notify({ api: process.env.GOVERN_SLACK_API ?? SLACK_API, token, channel, dryRun: flag(a, "dry-run"),
      ...(lanes.length ? { lanes } : {}), ...(cfg.labels ? { labels: cfg.labels } : {}) });
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
  return { cfg: { ...cfg, channel }, inbox, call: slackCall(process.env.GOVERN_SLACK_API ?? SLACK_API, token) };
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
      await postMessage(call, inbox, cfg.channel, { kind: "note", text: commandText(command), thread: post.thread_ts ?? post.ts, threadIsParent: true, key });
    });
    const routed = await routePending(call, inbox, cfg);
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
  const sent = await postMessage(call, inbox, cfg.channel, { kind, text: file === undefined ? text! : readFileSync(file, "utf8"),
    thread: opt(a, "thread"), key: opt(a, "key") });
  out(`slack post: ${sent.ts}`);
}

/** Explicit binary media upload, constrained by the workspace's resolved upload roots. */
async function cmdUpload(a: Args): Promise<void> {
  const file = opt(a, "file") ?? usage("upload requires --file");
  const thread = opt(a, "thread") ?? usage("upload requires --thread");
  const { cfg, inbox, call } = channelSettings();
  const receipt = await uploadFile(call, inbox, cfg.channel, cfg.upload, { file, thread, title: opt(a, "title"), text: opt(a, "text"), key: opt(a, "key") });
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

export const name = "slack";
export const description = "Slack: decisions people make with buttons in Slack, verified by Slack's signature";
export const docs: ExtDoc[] = [{ title: "Slack: decisions from Slack buttons, signature checks, people mapping", path: "SLACK.md" }];
export const manpage = MANPAGE;

export const commands: Cmd[] = [
  { name: "slack", section: 7, noSub: "govern slack serve|notify|listen|post|upload|resolve|digest|install-service (the protocol: tools/govern/SLACK.md)",
    subs: {
      "install-service": { lines: [["", "write user units for listen, notify and a daily digest timer; print enable instructions without starting them"]], run: () => out(installServices()) },
      upload: { flags: { value: ["thread", "file", "title", "text", "key"] },
        lines: [["--thread TS --file PATH [--title T] [--text T] [--key K]", "upload an allowed image, video or PDF inside slack.upload.roots and maxBytes; resolve the thread and journal the file id"]], run: cmdUpload },
      resolve: { flags: { value: ["key", "ts"], bool: ["delivered", "not-delivered"] },
        lines: [["--key K [--delivered [--ts TS] | --not-delivered]", "settle an uncertain send: an upload never completed is released, one completed is looked up in its thread; posts nothing"]], run: cmdResolve },
      digest: { lines: [["", "post waiting people, failed tasks and open alerts once per local day; stay silent when empty"]], run: cmdDigest },
      listen: { flags: { bool: ["once", "loop"], value: ["interval"] },
        lines: [["[--once | --loop --interval 60]", "record new channel posts in slack.inbox; first run marks existing posts seen; answer configured requesters' fixed commands"]], run: cmdListen },
      post: { flags: { value: ["kind", "text", "file", "thread", "key"] },
        lines: [["--kind ack|blocked|delivered|question|note (--text T | --file F) [--thread TS] [--key K]", "send a prefixed message to slack.channel, resolve a thread parent and journal the send in slack.inbox/sent.jsonl"]], run: cmdPost },
      serve: { flags: { value: ["port"] },
        lines: [["[--port 5003]", "serve Slack's interactivity requests on loopback (POST /slack/actions); the signing secret comes from\nSLACK_SIGNING_SECRET or the config's slack.envFile, the team from slack.team"]], run: cmdServe },
      notify: { flags: { multi: ["lane"], value: ["interval"], bool: ["loop", "dry-run"] },
        lines: [["[--lane S]... [--loop --interval 30] [--dry-run]", "post to slack.channel what the lanes wait on from people (human tasks, gates) and open timer alerts, once each,\nwith buttons bound to the case; update a message when its decision is made or the case changes. The bot token is\nSLACK_BOT_TOKEN or the config's slack.envFile; --dry-run sends no notifications and leaves notification receipts unchanged"]], run: cmdNotify },
    } },
];
