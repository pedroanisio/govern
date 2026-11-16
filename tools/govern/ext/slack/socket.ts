// Socket Mode for `govern slack serve` (slack.transport "socket"): govern opens the connection, so nothing has to reach it
// from outside: no request URL, no tunnel. Slack, and a Tayet sidecar (TAYET.md), send clicks as `interactive` envelopes
// on it; each is decided as a signed request is (slack.ts handleSocketInteraction) and acked. Events (events_api) are
// acked at once and passed to `onEvent` when there is one (`govern slack chat`, chat.ts); slash commands, and anything a
// client has no handler for, are acked and left alone: `govern slack listen` reads the channel itself.
//
// The wire, as Slack documents it and Tayet's sidecar implements it: apps.connections.open (app-level token) answers a
// one-use ws(s):// URL; the server sends {type: "hello"}, then envelopes {envelope_id, type, payload,
// accepts_response_payload}; the client acks each with {envelope_id, payload?} within 3 s or it is sent again; a
// {type: "disconnect"} asks the client to reconnect with a new URL. WebSocket pings are answered by the runtime.
import { allowedUrl } from "./server.ts";
import { slackCall, SlackError, type Call } from "./channel.ts";
import { GovernError } from "../../lib/util.ts";

/** How long a click may take to decide before its ack goes out anyway (the server sends it again after 3 s). */
export const ACK_WITHIN_MS = 2500;
/** A connection is replaced after this long, so a connection that died without a close never stays in use for long. */
export const REFRESH_MS = 30 * 60 * 1000;
/** Waits between attempts to connect, in milliseconds: doubled from the first up to the last. */
export const BACKOFF_MS = [1000, 30_000] as const;

/** What the client needs of a WebSocket: the standard (browser and Node) interface. */
export interface SocketLike {
  addEventListener(type: "open" | "close" | "error" | "message", listener: (e: { data?: unknown; code?: number }) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export interface SocketOptions {
  /** The Web API base apps.connections.open is called on. */
  api: string;
  /** The app-level token (Slack: xapp-…; Tayet: the sidecar's local token). */
  token: string;
  /** Decide one interactive payload; `reply` goes back in the ack (a form submission's response_action). Without it,
   *  clicks are acked and ignored. */
  handle?: (payload: unknown, envelope: string) => Promise<{ reply?: unknown }>;
  /** Take one events_api payload ({event, …}). The envelope is acked before it is called, so a slow handler never gets
   *  the event sent again; it must not throw, and what it starts it finishes on its own. */
  onEvent?: (payload: unknown, envelope: string) => void;
  /** Open a WebSocket (default: the runtime's). */
  connect?: (url: string) => SocketLike;
  request?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Stops the loop: the open connection closes and runSocket returns. */
  signal?: AbortSignal;
  refreshMs?: number;
}

/** The connection URL apps.connections.open answers: wss:// on Slack, or a ws(s):// URL on the API's own address. */
export function socketUrl(raw: unknown, api: string): string {
  let url: URL;
  try { url = new URL(typeof raw === "string" ? raw : ""); } catch { throw new GovernError("apps.connections.open: the answer has no connection URL", 1); }
  const slack = url.protocol === "wss:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) && !url.username && !url.password;
  const asHttp = new URL(url.href.replace(/^ws/, "http"));
  if (!slack && !((url.protocol === "ws:" || url.protocol === "wss:") && allowedUrl(asHttp, "", api)))
    throw new GovernError("apps.connections.open: the connection URL is neither Slack's nor on the configured API's address", 1);
  return url.href;
}

/** Answers apps.connections.open gives when the token can never connect: stop instead of retrying. */
const FATAL = /: (invalid_auth|not_authed|token_revoked|account_inactive|not_allowed_token_type|missing_scope)$/;

/** One connection: resolves when it closes (or `refreshMs` passes, or `signal` aborts). */
function session(url: string, o: SocketOptions): Promise<"closed" | "refresh" | "aborted"> {
  const ws = (o.connect ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(url), log = o.log ?? (() => undefined);
  return new Promise((resolve) => {
    let done = false;
    const finish = (why: "closed" | "refresh" | "aborted") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      try { ws.close(1000); } catch { /* already closed */ }
      resolve(why);
    };
    const timer = setTimeout(() => finish("refresh"), o.refreshMs ?? REFRESH_MS);
    const abort = () => finish("aborted");
    o.signal?.addEventListener("abort", abort);
    ws.addEventListener("close", () => finish("closed"));
    ws.addEventListener("error", () => finish("closed"));
    ws.addEventListener("message", (e) => {
      let frame: unknown;
      try { frame = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); } catch { log("slack socket: a frame that is not JSON, ignored"); return; }
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as { type?: unknown; envelope_id?: unknown; payload?: unknown; reason?: unknown };
      if (f.type === "hello") { log("slack socket: connected"); return; }
      if (f.type === "disconnect") { log(`slack socket: the server asked to reconnect (${typeof f.reason === "string" ? f.reason : "no reason"})`); finish("closed"); return; }
      if (typeof f.envelope_id !== "string" || !f.envelope_id) return;
      const envelope = f.envelope_id, ack = (payload?: unknown) => {
        if (done) return;
        try { ws.send(JSON.stringify({ envelope_id: envelope, ...(payload !== undefined ? { payload } : {}) })); } catch { /* closed: the server sends it again */ }
      };
      if (f.type === "events_api" && o.onEvent) {
        ack();
        try { o.onEvent(f.payload, envelope); } catch (err) { log(`slack socket: an event failed (${(err as Error).message})`); }
        return;
      }
      const handle = o.handle;
      if (f.type !== "interactive" || !handle) { ack(); return; }
      // Ack once the click is decided (a repeat is refused by its identity), or after ACK_WITHIN_MS whatever happens.
      let acked = false;
      const once = (payload?: unknown) => { if (!acked) { acked = true; ack(payload); } };
      const late = setTimeout(() => once(), ACK_WITHIN_MS);
      handle(f.payload, envelope).then((r) => { clearTimeout(late); once(r.reply); },
        (err: unknown) => { clearTimeout(late); once(); log(`slack socket: a click failed (${(err as Error).message})`); });
    });
  });
}

/** Keep a Socket Mode connection open until `signal` aborts: connect, serve, reconnect with backoff. Fails when the token
 *  can never connect (invalid, revoked, not an app-level token). */
export async function runSocket(o: SocketOptions): Promise<void> {
  const call: Call = slackCall(o.api, o.token, o.request ?? fetch);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), log = o.log ?? (() => undefined);
  let wait: number = BACKOFF_MS[0];
  while (!o.signal?.aborted) {
    let url: string;
    try { url = socketUrl((await call("apps.connections.open", {})).url, o.api); }
    catch (e) {
      if (e instanceof SlackError && FATAL.test(e.message)) throw e;
      log(`slack socket: cannot connect (${(e as Error).message}); retrying in ${wait / 1000} s`);
      await sleep(wait);
      wait = Math.min(wait * 2, BACKOFF_MS[1]);
      continue;
    }
    const opened = Date.now(), why = await session(url, o);
    if (why === "aborted") return;
    // A connection that lasted resets the backoff; one that closed at once waits before the next.
    if (Date.now() - opened > BACKOFF_MS[1]) wait = BACKOFF_MS[0];
    else { await sleep(wait); wait = Math.min(wait * 2, BACKOFF_MS[1]); }
  }
}
