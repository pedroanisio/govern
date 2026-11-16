// The Slack-compatible server a workspace talks to (slack.server, slack.api): Slack itself, or a Tayet agent's sidecar,
// which speaks part of Slack's Web API and Socket Mode on loopback (TAYET.md). What differs is fixed here, once:
// the API base, the hosts a response URL or an upload URL may name, how many buttons a message may carry, and whether a
// message's buttons close on its first click (a Tayet approval card answers once).
import type { slackConfig } from "../../lib/workspace.ts";

type SlackConfig = NonNullable<ReturnType<typeof slackConfig>>;

export const SLACK_API = "https://slack.com/api";

/** What the server allows. */
export interface SlackServer {
  /** "slack" or "tayet" (slack.server). */
  kind: "slack" | "tayet";
  /** The Web API base: GOVERN_SLACK_API, else slack.api, else Slack's. */
  api: string;
  /** The most buttons one message may carry (Slack: 25 in an actions block; Tayet: 3 on an approval card). */
  maxButtons: number;
  /** A message's buttons close on the first click, whatever govern records (Tayet's approval card). An edit may not carry
   *  buttons, and a decision that still waits on others needs a new message. */
  singleAnswer: boolean;
  /** Clicks arrive over Socket Mode only (no request URL). */
  socketOnly: boolean;
}

/** The server `cfg` names, with `env` (process.env) first for the API base. */
export function serverOf(cfg: Pick<SlackConfig, "server" | "api"> | undefined, env: NodeJS.ProcessEnv = process.env): SlackServer {
  const api = env.GOVERN_SLACK_API ?? cfg?.api ?? SLACK_API;
  return cfg?.server === "tayet"
    ? { kind: "tayet", api, maxButtons: 3, singleAnswer: true, socketOnly: true }
    : { kind: "slack", api, maxButtons: 25, singleAnswer: false, socketOnly: false };
}

/** True when `url` may be called with what Slack handed out for one click or one upload: an https URL on `slackHost`
 *  (hooks.slack.com, files.slack.com), or a URL on the same origin as the configured API base when that base is not
 *  Slack's (a Tayet sidecar hands out http://127.0.0.1:<port>/slack/… URLs). Credentials and fragments are refused. */
export function allowedUrl(url: URL, slackHost: string, api: string): boolean {
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:" && url.hostname === slackHost && !url.port) return true;
  let base: URL;
  try { base = new URL(api); } catch { return false; }
  if (base.hostname === "slack.com" || base.hostname.endsWith(".slack.com")) return false;
  return (base.protocol === "http:" || base.protocol === "https:") && url.origin === base.origin;
}

/** Slack's text for a message whose blocks say it all: the sections and contexts as mrkdwn, one paragraph each. A Tayet
 *  card reads `text` as its request and drops other blocks when `text` is given, so the request must be the whole message. */
export function blocksText(blocks: unknown[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (typeof b !== "object" || b === null) continue;
    const x = b as { type?: unknown; text?: { text?: unknown }; elements?: unknown };
    if (x.type === "section" && typeof x.text?.text === "string") out.push(x.text.text);
    else if (x.type === "context" && Array.isArray(x.elements))
      out.push(x.elements.map((e) => (typeof e === "object" && e !== null && typeof (e as { text?: unknown }).text === "string" ? (e as { text: string }).text : "")).filter(Boolean).join(" "));
  }
  return out.filter(Boolean).join("\n\n");
}

/** `m` as the server should get it: on a single-answer server a message with blocks carries their text as `text`. */
export function forServer<T extends { text?: string; blocks?: unknown[] }>(s: SlackServer, m: T): T {
  if (!s.singleAnswer || !m.blocks?.length) return m;
  const text = blocksText(m.blocks);
  return text ? { ...m, text } : m;
}
