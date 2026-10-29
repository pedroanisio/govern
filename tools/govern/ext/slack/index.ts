// Slack: decisions people make with buttons in Slack, verified by Slack's request signature and recorded as the mapped
// person's own (SLACK.md). A workspace turns this extension on with `govern ext enable slack`.
import { existsSync, readFileSync } from "node:fs";
import { slackServer } from "./slack.ts";
import { slackConfig, configFile } from "../../lib/workspace.ts";
import { fail, usage, opt } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { out, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

/** SLACK_SIGNING_SECRET, else that variable from the config's slack.envFile; undefined when neither has it. */
function signingSecret(envFile: string | undefined): string | undefined {
  if (process.env.SLACK_SIGNING_SECRET) return process.env.SLACK_SIGNING_SECRET;
  if (!envFile) return undefined;
  if (!existsSync(envFile)) fail(`${configFile()}: slack.envFile ${envFile} does not exist`);
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?SLACK_SIGNING_SECRET\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

/** `govern slack serve`: the interactivity server on loopback, once the team and the signing secret are configured. */
function cmdServe(a: Args): void {
  const cfg = slackConfig() ?? fail(`${configFile()} names no slack.team: the Slack team whose requests count`);
  const secret = signingSecret(cfg.envFile)
    ?? fail(`SLACK_SIGNING_SECRET is not set: export it, or name a dotenv file holding it as slack.envFile in ${configFile()}`);
  const server = slackServer(secret);
  const port = Number(opt(a, "port") ?? 5003);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage("--port must be 0..65535");
  server.on("error", (e) => { process.stderr.write(`slack: ${e.message}\n`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => out(`govern slack (team ${cfg.team}) on http://127.0.0.1:${port}/slack/actions`));
}

export const name = "slack";
export const description = "Slack: decisions people make with buttons in Slack, verified by Slack's signature";
export const docs: ExtDoc[] = [{ title: "Slack: decisions from Slack buttons, signature checks, people mapping", path: "SLACK.md" }];
export const manpage = MANPAGE;

export const commands: Cmd[] = [
  { name: "slack", section: 7, noSub: "govern slack serve (the protocol: tools/govern/SLACK.md)",
    subs: {
      serve: { flags: { value: ["port"] },
        lines: [["[--port 5003]", "serve Slack's interactivity requests on loopback (POST /slack/actions); the signing secret comes from\nSLACK_SIGNING_SECRET or the config's slack.envFile, the team from slack.team"]], run: cmdServe },
    } },
];
