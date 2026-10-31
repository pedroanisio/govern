// Slack channel reader and explicit posting. Disk rows and position match the retired poller; no reference is read at runtime.
import { openSync, closeSync, fstatSync, realpathSync, appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, basename, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { GovernError } from "../../lib/util.ts";
import { obj, str, record, parseFile } from "../../lib/shape.ts";
import type { WorkspaceConfig } from "../../lib/workspace.ts";

export type ChannelConfig = Pick<NonNullable<WorkspaceConfig["slack"]>, "bot" | "requesters" | "tags"> & { channel: string };
// Structured arguments need JSON; scalar-only methods use Slack's form contract.
const ENCODING = {
  "chat.postMessage": "json",
  "chat.update": "json",
  "files.completeUploadExternal": "json",
  "conversations.history": "form",
  "conversations.replies": "form",
  "files.getUploadURLExternal": "form",
} as const satisfies Record<string, "json" | "form">;
export type Call = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface Post { ts: string; thread_ts: string | null; user: string; text: string; files: string[]; tag: string | null; request: boolean; edited: boolean }
interface State { top: string; threads: Record<string, string>; edits: Record<string, string> }
export const LIMIT = 40000;
const TS = /^\d{1,12}\.\d{6}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stamp = (v: unknown): v is string => typeof v === "string" && TS.exec(v)?.[0] === v;
const later = (a: string, b: string) => Number(a) > Number(b);
const error = (s: string): never => { throw new GovernError(s, 1); };
/** An API failure distinguishes a proven refusal from an outcome that may already have reached Slack. */
export class SlackError extends GovernError {
  uncertain: boolean;
  constructor(message: string, uncertain: boolean) { super(message, 1); this.uncertain = uncertain; }
}
const apiError = (s: string, uncertain = false): never => { throw new SlackError(s, uncertain); };

/** API errors carry method and a sanitized reason, never response bodies, request data or native network exceptions. */
export function slackCall(api: string, token: string, request: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))): Call {
  return async (method, body) => {
    if (!Object.hasOwn(ENCODING, method)) return apiError("unsupported Slack method");
    const json = ENCODING[method as keyof typeof ENCODING] === "json";
    const form = new URLSearchParams();
    if (!json) for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
        return apiError(`${method}: form arguments must be scalars`);
      }
      form.set(key, typeof value === "number" ? value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 21 }) : String(value));
    }
    const payload = json ? JSON.stringify(body) : form.toString();
    const contentType = json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded; charset=utf-8";
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await request(`${api.replace(/\/$/, "")}/${method}`, { method: "POST", body: payload,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType }, signal: AbortSignal.timeout(30000) }); }
      catch { return apiError(`${method}: network failure`, true); }
      if (response.status === 429 && (method === "chat.postMessage" || method === "chat.update") && attempt < 2) {
        const raw = response.headers.get("retry-after") ?? "1", delay = Number(raw);
        // Never retry earlier than requested; excessive or malformed waits fail for the next run to retry.
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(delay) || delay > 300) return apiError(`${method}: rate limited`);
        await sleep(delay * 1000); continue;
      }
      if (!response.ok) return apiError(`${method}: HTTP ${response.status}`, response.status >= 500);
      let answer: unknown;
      try { answer = await response.json(); } catch { return apiError(`${method}: invalid JSON`, true); }
      if (!object(answer)) return apiError(`${method}: not an object`, true);
      if (answer.ok !== true) {
        const reason = typeof answer.error === "string" && /^[a-z_]+$/.test(answer.error) ? answer.error.split(token).join("[redacted]") : "refused";
        return apiError(`${method}: ${reason}`);
      }
      return answer;
    }
  };
}

/** Parse a channel post, preserving the poller-compatible inbox fields. */
export function parsePost(raw: unknown, cfg: ChannelConfig, edited = false): Post {
  if (!object(raw)) return error("a post is an object");
  const ts = raw.ts, thread = raw.thread_ts ?? null, text = raw.text === undefined ? "" : raw.text, user = raw.user || raw.bot_id;
  if (!stamp(ts)) return error("a post's ts is seconds.micros");
  if (thread !== null && !stamp(thread)) return error("a post's thread_ts is seconds.micros");
  if (typeof user !== "string" || !user) return error(`post ${ts} names no author`);
  if (typeof text !== "string") return error(`post ${ts}'s text is not text`);
  const files = raw.files === undefined ? [] : raw.files;
  if (!Array.isArray(files) || !files.every(f => object(f) && typeof f.id === "string")) return error(`post ${ts}'s files carry no ids`);
  const match = /^\[([a-z]+)\]/.exec(text)?.[1];
  return { ts, thread_ts: thread, user, text, files: files.map(f => String(f.id)), tag: match && cfg.tags?.includes(match) ? match : null,
    request: Object.hasOwn(cfg.requesters ?? {}, user), edited };
}

/** Create or tighten the private channel journal directory to mode 700. */
export function directory(d: string): void { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); }
/** Atomically replace a private JSON journal inside the inbox. */
export function save(d: string, name: string, value: unknown): void {
  const path = join(d, name), tmp = `${path}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 }); renameSync(tmp, path);
}
function append(d: string, name: string, value: unknown[]): void {
  const p = join(d, name); appendFileSync(p, value.map(v => JSON.stringify(v) + "\n").join(""), { mode: 0o600 }); chmodSync(p, 0o600);
}
function messages(answer: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(answer.messages) || !answer.messages.every(object)) return error("Slack messages must be objects");
  return answer.messages;
}
const stateShape = obj({ top: str, threads: record(str), edits: record(str) });

/** Accept only an exact fixed command from a configured requester addressing our bot. */
export function parseCommand(p: Post, cfg: ChannelConfig): string | undefined {
  if (!p.request) return undefined;
  const match = /^<@([A-Z0-9]+)> (status|pending|help|lane [a-z0-9][a-z0-9_-]*)$/.exec(p.text);
  return match && match[0] === p.text && cfg.bot?.includes(match[1]!) ? match[2] : undefined;
}

/** Exactly one history call, at most twenty changed thread reads; first run only seeds existing position. */
export async function poll(call: Call, d: string, cfg: ChannelConfig,
  answer?: (post: Post, command: string) => Promise<void>): Promise<number> {
  directory(d);
  const file = join(d, "state.json");
  const before: State | undefined = existsSync(file) ? parseFile(file, readFileSync(file, "utf8"), stateShape) : undefined;
  if (before && ((before.top !== "0" && !stamp(before.top)) || Object.values(before.threads).some(v => !stamp(v)) || Object.values(before.edits).some(v => !stamp(v)))) return error("state.json: invalid timestamp");
  const page = await call("conversations.history", { channel: cfg.channel, limit: 100 });
  const hasMore = page.has_more === true;
  if (hasMore) process.stderr.write("slack listen: conversations.history has_more; posts beyond this page may be missed; run more frequently\n");
  const history = messages(page);
  // Invalid timestamps cannot safely advance position, so refuse the run rather than silently discard data.
  if (history.some(m => !stamp(m.ts))) return error("conversations.history: invalid post ts");
  const state: State = before ? { top: before.top, threads: { ...before.threads }, edits: { ...before.edits } } : { top: "0", threads: {}, edits: {} };
  const found: { raw: unknown; edited: boolean }[] = [];
  for (const m of history) {
    const ts = m.ts as string, edit = object(m.edited) ? m.edited.ts : undefined;
    if (later(ts, state.top)) state.top = ts;
    if (before && later(ts, before.top)) found.push({ raw: m, edited: false });
    if (edit !== undefined) {
      if (!stamp(edit)) return error("conversations.history: invalid edit ts");
      if (before && later(edit, state.edits[ts] ?? "0") && !later(ts, before.top)) found.push({ raw: m, edited: true });
      if (!before || later(edit, state.edits[ts] ?? "0")) state.edits[ts] = edit;
    }
    if (!before && m.latest_reply) { if (!stamp(m.latest_reply)) return error("invalid latest_reply"); state.threads[ts] = m.latest_reply; }
  }
  if (before) {
    let followed = 0;
    for (const m of history) {
      if (!m.latest_reply) continue;
      if (!stamp(m.latest_reply)) return error("invalid latest_reply");
      const ts = m.ts as string, seen = before.threads[ts] ?? "0";
      if (!later(m.latest_reply, seen) || followed >= 20) continue;
      const replies = messages(await call("conversations.replies", { channel: cfg.channel, ts, limit: 200 }));
      found.push(...replies.slice(1).filter(r => later(String(r.ts ?? "0"), seen)).map(raw => ({ raw, edited: false })));
      state.threads[ts] = m.latest_reply; followed++;
    }
  }
  const rows: { order: number; row: Post | { unreadable: string } }[] = [];
  const answeredFile = join(d, "commands.json"), answered = existsSync(answeredFile) ? parseFile(answeredFile, readFileSync(answeredFile, "utf8"), record(str)) : Object.create(null) as Record<string, string>;
  for (const { raw, edited } of found) {
    let p: Post;
    try { p = parsePost(raw, cfg, edited); }
    catch (e) { rows.push({ order: 0, row: { unreadable: (e as Error).message } }); continue; }
    if (cfg.bot?.includes(p.user)) {
      const f = join(d, "bot-replies.json");
      const replies = existsSync(f) ? parseFile(f, readFileSync(f, "utf8"), record(str)) : Object.create(null) as Record<string, string>;
      replies[p.thread_ts ?? p.ts] = p.ts; save(d, "bot-replies.json", replies); continue;
    }
    const command = parseCommand(p, cfg);
    if (command && answer) {
      if (!Object.hasOwn(answered, p.ts)) { await answer(p, command); answered[p.ts] = command; save(d, "commands.json", answered); }
    } else rows.push({ order: Number(p.ts), row: p });
  }
  if (rows.length) append(d, "inbox.jsonl", rows.sort((a, b) => a.order - b.order).map(r => r.row));
  save(d, "state.json", state); save(d, "heartbeat.json", { lastSuccess: new Date().toISOString(), hasMore });
  return rows.length;
}

export interface Send { kind: string; text: string; thread?: string; key?: string;
  /** Listener-only: a parsed post already names its parent, so answering it needs no extra thread read. */
  threadIsParent?: boolean }
interface Sent { ts: string; thread: string | null; kind: string; key: string | null }
const sentShape = obj({ ts: str, thread: (v, p) => v === null ? null : str(v, p), kind: str, key: (v, p) => v === null ? null : str(v, p) });
/** Read the private send journal, rejecting rows outside its typed contract. */
export function sent(d: string): Sent[] {
  const f = join(d, "sent.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(line => parseFile(f, line, sentShape)) : [];
}
/** Whether a successful send already consumed this durable key. */
export function wasSent(d: string, key: string): boolean { return sent(d).some(r => r.key === key); }
function intents(d: string): Record<string, string> {
  const f = join(d, "send-intents.json");
  return existsSync(f) ? parseFile(f, readFileSync(f, "utf8"), record(str)) : Object.create(null) as Record<string, string>;
}
/** A pending send may already exist at Slack. Never send it again automatically after a crash or lost response. */
export function wasAttempted(d: string, key: string): boolean { return Object.hasOwn(intents(d), key); }

/** Resolve Slack's reply timestamp to the parent, refusing an unrelated or ambiguous response. */
export async function parentThread(call: Call, channel: string, ts: string): Promise<string> {
  if (!stamp(ts)) return error("--thread must be seconds.micros");
  const reply = messages(await call("conversations.replies", { channel, ts, limit: 200 }));
  const match = reply.find(m => m.ts === ts);
  const parent = match?.thread_ts ?? match?.ts;
  if (!stamp(parent)) return error("conversations.replies: no parent thread");
  return parent;
}

/** Explicit sends journal their key, timestamp and resolved thread; no token is persisted. Run one writer per inbox. */
export async function postMessage(call: Call, d: string, channel: string, o: Send): Promise<Sent> {
  if (!["ack", "blocked", "delivered", "question", "note"].includes(o.kind)) return error("--kind must be ack|blocked|delivered|question|note");
  return sendMessage(call, d, channel, o);
}

/** The sole automatic route receipt contains only a queue task id, never model output. */
export async function seenMessage(call: Call, d: string, channel: string, post: Post, task: string): Promise<void> {
  const key = `route:${post.ts}`;
  if (wasSent(d, key)) return;
  await sendMessage(call, d, channel, { kind: "seen", text: `queued task ${task}`, thread: post.thread_ts ?? post.ts, threadIsParent: true, key });
}

async function sendMessage(call: Call, d: string, channel: string, o: Send): Promise<Sent> {
  const text = `${o.kind}: ${o.text}`;
  if (!o.text.trim() || [...text].length > LIMIT) return error(`text must be nonempty and at most ${LIMIT} characters including kind`);
  if (o.thread !== undefined && !stamp(o.thread)) return error("--thread must be seconds.micros");
  directory(d);
  if (o.key !== undefined && (!o.key || wasSent(d, o.key))) return error("key is empty or already sent");
  if (o.key && wasAttempted(d, o.key)) return error("key has an uncertain send; inspect Slack before reconciling send-intents.json");
  const thread = o.thread ? o.threadIsParent ? o.thread : await parentThread(call, channel, o.thread) : null;
  if (o.key) { const pending = intents(d); pending[o.key] = "sending"; save(d, "send-intents.json", pending); }
  try {
    const result = await call("chat.postMessage", { channel, text, ...(thread ? { thread_ts: thread } : {}),
      ...(o.key ? { client_msg_id: createHash("sha256").update(`${channel}:${o.key}`).digest("hex").slice(0, 32).replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5") } : {}) });
    if (!stamp(result.ts)) throw new SlackError("chat.postMessage: no valid ts", true);
    const row = { ts: result.ts, thread, kind: o.kind, key: o.key ?? null };
    append(d, "sent.jsonl", [row]);
    if (o.key) { const pending = intents(d); delete pending[o.key]; save(d, "send-intents.json", pending); }
    return row;
  } catch (e) {
    if (o.key && e instanceof SlackError && !e.uncertain) { const pending = intents(d); delete pending[o.key]; save(d, "send-intents.json", pending); }
    throw e;
  }
}


export interface Upload { file: string; thread: string; title?: string; text?: string; key?: string }
const MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4" };

/** Upload an allowed local image/video using Slack's external upload protocol. One writer owns this inbox.
 * The upload receipt uses Slack's file id as ts; it does not assume a chat message timestamp. */
export async function uploadFile(call: Call, d: string, channel: string, policy: SlackConfigUpload | undefined,
  o: Upload, request: typeof fetch = fetch): Promise<Sent> {
  if (!policy) return error("slack.upload is required (roots and maxBytes)");
  if (!stamp(o.thread)) return error("--thread must be seconds.micros");
  if (o.text !== undefined && (!o.text.trim() || [...o.text].length > LIMIT)) return error(`upload text must be nonempty and at most ${LIMIT} characters`);
  if (o.title !== undefined && (!o.title.trim() || [...o.title].length > 255)) return error("upload title must be 1..255 characters");
  let path: string, roots: string[];
  try { path = realpathSync(o.file); roots = policy.roots.map(r => realpathSync(r)); } catch { return error("upload path or roots could not resolve"); }
  if (!roots.some(root => { const r = relative(root, path); return r === "" || (r !== ".." && !r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(r)); })) return error("upload path must be inside slack.upload.roots");
  let bytes: Buffer;
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return error("upload must be a regular file");
    if (!stat.size || stat.size > policy.maxBytes) return error("upload exceeds maxBytes or is empty");
    bytes = readFileSync(fd);
    if (bytes.length > policy.maxBytes) return error("upload exceeds maxBytes");
  } finally { closeSync(fd); }
  const mime = MEDIA[extname(path).toLowerCase()];
  if (!mime) return error("upload must be a common image or video type (png, jpg, gif, webp, mp4, mov, webm, m4v)");
  directory(d);
  if (o.key !== undefined && (!o.key || wasSent(d, o.key))) return error("key is empty or already sent");
  if (o.key && wasAttempted(d, o.key)) return error("key has an uncertain send; inspect Slack before reconciling send-intents.json");
  const thread = await parentThread(call, channel, o.thread);
  if (o.key) { const pending = intents(d); pending[o.key] = "uploading"; save(d, "send-intents.json", pending); }
  try {
    const upload = await call("files.getUploadURLExternal", { filename: basename(path), length: bytes.length });
    let url: URL;
    try { url = new URL(String(upload.upload_url)); } catch { throw new SlackError("invalid upload URL", false); }
    if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password || url.port || url.hash) throw new SlackError("invalid upload URL", false);
    if (typeof upload.file_id !== "string" || !/^F[A-Z0-9]+$/.test(upload.file_id)) throw new SlackError("invalid upload file id", false);
    let response: Response;
    try { response = await request(url.href, { method: "PUT", body: new Uint8Array(bytes), headers: { "Content-Type": mime }, redirect: "error", signal: AbortSignal.timeout(30000) }); }
    catch { throw new SlackError("file upload: network failure", true); }
    if (!response.ok) throw new SlackError(`file upload: HTTP ${response.status}`, true);
    const result = await call("files.completeUploadExternal", { files: [{ id: upload.file_id, ...(o.title ? { title: o.title } : {}) }], channel_id: channel, thread_ts: thread, ...(o.text ? { initial_comment: o.text } : {}) });
    if (!Array.isArray(result.files) || !result.files.some(f => object(f) && f.id === upload.file_id)) throw new SlackError("invalid upload completion", true);
    const row: Sent = { ts: upload.file_id, thread, kind: "upload", key: o.key ?? null };
    append(d, "sent.jsonl", [row]);
    if (o.key) { const pending = intents(d); delete pending[o.key]; save(d, "send-intents.json", pending); }
    return row;
  } catch (e) {
    if (o.key && e instanceof SlackError && !e.uncertain) { const pending = intents(d); delete pending[o.key]; save(d, "send-intents.json", pending); }
    throw e;
  }
}
type SlackConfigUpload = NonNullable<NonNullable<WorkspaceConfig["slack"]>["upload"]>;
