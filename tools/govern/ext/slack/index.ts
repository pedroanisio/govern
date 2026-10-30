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
  const token = secret("SLACK_BOT_TOKEN", process.env.SLACK_BOT_TOKEN, cfg.envFile)
    ?? fail(`SLACK_BOT_TOKEN is not set: export it, or put it in the dotenv file slack.envFile names in ${configFile()}`);
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

export const name = "slack";
export const description = "Slack: decisions people make with buttons in Slack, verified by Slack's signature";
export const docs: ExtDoc[] = [{ title: "Slack: decisions from Slack buttons, signature checks, people mapping", path: "SLACK.md" }];
export const manpage = MANPAGE;

export const commands: Cmd[] = [
  { name: "slack", section: 7, noSub: "govern slack serve|notify (the protocol: tools/govern/SLACK.md)",
    subs: {
      serve: { flags: { value: ["port"] },
        lines: [["[--port 5003]", "serve Slack's interactivity requests on loopback (POST /slack/actions); the signing secret comes from\nSLACK_SIGNING_SECRET or the config's slack.envFile, the team from slack.team"]], run: cmdServe },
      notify: { flags: { multi: ["lane"], value: ["interval"], bool: ["loop", "dry-run"] },
        lines: [["[--lane S]... [--loop --interval 30] [--dry-run]", "post to slack.channel what the lanes wait on from people (human tasks, gates) and open timer alerts, once each,\nwith buttons bound to the case; update a message when its decision is made or the case changes. The bot token is\nSLACK_BOT_TOKEN or the config's slack.envFile; --dry-run sends and records nothing"]], run: cmdNotify },
    } },
];
