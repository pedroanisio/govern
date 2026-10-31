// Write reviewable user units only. Credentials continue to come from slack.envFile at runtime.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo, slackConfig } from "../../lib/workspace.ts";
import { GovernError } from "../../lib/util.ts";
import { workingDirectory } from "../../lib/systemd.ts";

function word(value: string, command = false): string {
  if (/[\r\n\0]/.test(value)) throw new GovernError("cannot write a line break or NUL into a service unit", 1);
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${command ? escaped.replaceAll("$", "$$$$") : escaped}"`;
}

/** Render the same fixed workspace and PATH into independent listener, notifier and daily digest user units. */
export function serviceUnits(bin: string, workspace: string, path: string): Record<string, string> {
  const directory = workingDirectory(workspace);
  const units: Record<string, string> = {};
  for (const [command, args] of [["listen", " --loop --interval 60"], ["notify", " --loop --interval 30"], ["digest", ""]]) {
    units[`govern-slack-${command}.service`] = ["[Unit]", `Description=govern Slack ${command}`, "", "[Service]",
      `Type=${command === "digest" ? "oneshot" : "simple"}`, `WorkingDirectory=${directory}`,
      `ExecStart=${word(bin, true)} slack ${command}${args}`,
      `Environment=${word(`PATH=${path}`)}`, `Environment=${word(`GOVERN_REPO=${workspace}`)}`,
      ...(command === "digest" ? [] : ["Restart=on-failure", "RestartSec=30"]), "UMask=0077", "",
      ...(command === "digest" ? [] : ["[Install]", "WantedBy=default.target", ""])].join("\n");
  }
  units["govern-slack-digest.timer"] = ["[Unit]", "Description=govern Slack daily digest", "", "[Timer]", "OnCalendar=daily",
    "Persistent=true", "Unit=govern-slack-digest.service", "", "[Install]", "WantedBy=timers.target", ""].join("\n");
  return units;
}

/** Install without starting anything. The operator enables the services after stopping any previous reader. */
export function installServices(): string {
  const cfg = slackConfig();
  if (!cfg?.channel || !cfg.inbox) throw new GovernError("slack.channel and slack.inbox are required to install Slack services", 1);
  const d = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
  const units = serviceUnits(fileURLToPath(new URL("../../../../bin/govern", import.meta.url)), repo(), process.env.PATH ?? "");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(units)) {
    const f = join(d, name); writeFileSync(f, text, { mode: 0o600 }); chmodSync(f, 0o600);
  }
  return `${Object.keys(units).map(n => `wrote ${join(d, n)}`).join("\n")}\nStop any previous poller/listener first. Configure slack.envFile; shell token variables are not copied.\nStart explicitly with:\nsystemctl --user daemon-reload\nsystemctl --user enable --now govern-slack-listen.service govern-slack-notify.service govern-slack-digest.timer`;
}
