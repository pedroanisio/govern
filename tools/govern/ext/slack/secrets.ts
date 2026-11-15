// The Slack secrets a workspace names: the bot token and the signing secret, from the environment first, then the dotenv
// file slack.envFile names. Shared by the commands (index.ts) and the doctor's probes (doctor.ts); a value is never printed.
import { existsSync, readFileSync } from "node:fs";
import { configFile, type slackConfig } from "../../lib/workspace.ts";
import { fail } from "../../lib/util.ts";

type SlackConfig = NonNullable<ReturnType<typeof slackConfig>>;

/** `fromEnv` (the variable `name` as the environment has it), else that variable from the config's slack.envFile;
 *  undefined when neither has it. */
export function secret(name: string, fromEnv: string | undefined, envFile: string | undefined): string | undefined {
  if (fromEnv) return fromEnv;
  if (!envFile) return undefined;
  if (!existsSync(envFile)) fail(`${configFile()}: slack.envFile ${envFile} does not exist`);
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

/** The variable that holds the bot token: slack.botTokenVar, else SLACK_BOT_TOKEN. */
export const botTokenVar = (cfg: SlackConfig): string => cfg.botTokenVar ?? "SLACK_BOT_TOKEN";

/** The bot token, or undefined when neither the environment nor the env file has it. */
export function findBotToken(cfg: SlackConfig): string | undefined {
  const variable = botTokenVar(cfg);
  return secret(variable, cfg.botTokenVar ? process.env[variable] : process.env.SLACK_BOT_TOKEN, cfg.envFile);
}

/** Both notification and channel commands use the configured variable, then the same dotenv fallback. */
export function botToken(cfg: SlackConfig): string {
  return findBotToken(cfg)
    ?? fail(`${botTokenVar(cfg)} is not set: export it, or put it in the dotenv file slack.envFile names in ${configFile()}`);
}
