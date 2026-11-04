// Fixed read-only command views. Post text is never interpreted as argv, a path, a template or executable code.
import { status } from "../../lib/status.ts";
import { brief, load, laneSlugs } from "../../lib/project.ts";
import { pending } from "./pending.ts";
import { LIMIT } from "./channel.ts";

/** Render a fixed read-only workspace view, bounded to Slack’s message limit. */
export function commandText(command: string): string {
  let text: string;
  try {
    if (command === "help") text = "status — lane status\npending — gates and human tasks waiting on people\nlane <slug> — lane brief\nhelp — these commands";
    else if (command === "status") text = status().text;
    else if (command === "pending") text = laneSlugs().flatMap(slug => pending(load(slug)).map(p => `${p.lane}: ${"gate" in p.target ? `gate ${p.target.gate}` : `task ${p.target.task}`} — ${p.people.join(", ") || "nobody eligible"}`)).join("\n") || "Nothing pending.";
    else if (/^lane [a-z0-9][a-z0-9_-]*$/.test(command)) text = brief(load(command.slice(5)));
    else text = "Unknown command. Mention the bot followed by help.";
  } catch { text = "The requested workspace view could not be read; inspect it with govern at the terminal."; }
  return [...text].slice(0, LIMIT - "note: ".length).join("");
}
