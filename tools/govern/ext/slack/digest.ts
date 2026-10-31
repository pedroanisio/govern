// One explicit daily summary; no model output is sent to Slack.
import { GovernError } from "../../lib/util.ts";
import { laneSlugs, load } from "../../lib/project.ts";
import * as queue from "../../lib/queue.ts";
import { pending, driveFailures } from "./notify.ts";
import { channelAlerts, type SlackConfig } from "./route.ts";
import { postMessage, wasSent, LIMIT, type Call } from "./channel.ts";

/** Post what waits on each person, failed tasks and open alerts once per local calendar day; empty means no send. */
export async function digest(call: Call, d: string, cfg: SlackConfig & { channel: string }, now = new Date()): Promise<boolean> {
  const key = `digest:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (wasSent(d, key)) return false;
  const people = new Map<string, string[]>(), alerts = channelAlerts(cfg, now.getTime()).map(a => a.text);
  for (const slug of laneSlugs()) {
    const p = load(slug);
    for (const item of pending(p)) for (const person of item.people.length ? item.people : ["unassigned"]) {
      const rows = people.get(person) ?? []; rows.push(`${slug}: ${"gate" in item.target ? `gate ${item.target.gate}` : `task ${item.target.task}`}`); people.set(person, rows);
    }
    for (const a of p.alerts ?? []) if (!a.acknowledgedAt) alerts.push(`${slug}: ${a.message}`);
  }
  const failed = [...queue.all().filter(x => x.state === "failed").map(x => `${x.m.id}: ${x.m.summary}`), ...driveFailures().map(f => `${f.lane}: ${f.stage} — ${f.reason}`)];
  const lines = [...[...people].sort(([a], [b]) => a.localeCompare(b)).map(([person, rows]) => `${person}:\n${rows.map(r => `  ${r}`).join("\n")}`),
    ...(failed.length ? [`Failed tasks:\n${failed.join("\n")}`] : []), ...(alerts.length ? [`Open alerts:\n${alerts.join("\n")}`] : [])];
  if (!lines.length) return false;
  const text = `Daily digest ${key.slice(7)}\n${lines.join("\n\n")}`;
  // Ordinary code bounds the summary. Refuse oversize rather than silently omit waiting work or alerts.
  if ([...text].length > LIMIT - "note: ".length) throw new GovernError("Slack digest exceeds one message; reduce open work before retrying", 1);
  await postMessage(call, d, cfg.channel, { kind: "note", text, key });
  return true;
}
