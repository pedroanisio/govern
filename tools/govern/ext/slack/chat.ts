// `govern slack chat`: the people slack.chat.users names talk to an agent in slack.channel. Each message they post there is
// a turn of a govern conversation (lib/conversation.ts), run by the conversation runtime with slack.chat's profile or
// adapter; the reply is posted where the question was asked. The channel's top-level messages are one conversation, and
// each thread is its own. This is the one place govern posts a model's reply without a person clicking Publish: a
// workspace opts in by naming the people (SLACK.md, "Chat").
//
// Delivery is at least once on both sides: the server may send an event again, and this process may stop between a reply
// and its post. A journal (<state dir>/slack/chat.json) records each question by its channel and ts: a question already
// there is not asked again, and one whose reply was not yet posted is delivered when the chat starts again (resume).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { stateDir } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import * as sessions from "../../lib/conversation.ts";
import { run } from "../conversation/conversation-runtime.ts";
import { uploadFile, wasSent, type Call } from "./channel.ts";

/** What slack.chat configures. */
export interface ChatSettings {
  /** The people whose messages are turns (user ids, as the server sends them). */
  users: string[];
  /** The capability profile that answers (default codex-read), or a configured conversation adapter. */
  profile?: string;
  adapter?: string;
  timeoutSeconds?: number;
  /** The context budget of each conversation (default CONTEXT_CHARS). */
  maxContextChars?: number;
  /** A file whose text opens each new conversation, before its first question: what the agent should know about where it
   *  runs (what it may run, how to ask for more). Read when a conversation starts, so an edit applies to the next one. */
  brief?: string;
  /** Attach each image a reply shows a second time, as a download of the full file under `<name>.original`: a server
   *  whose clients show images only as a preview (Tayet's web client) then still hands over the original. */
  originals?: boolean;
}

/** A chat conversation's context budget unless slack.chat sets one: a channel holds a long exchange. */
export const CONTEXT_CHARS = 400_000;
/** A question's file is fetched up to this size. */
const ASKED_MAX_BYTES = 50 * 1024 * 1024;
/** Reply parts are at most this long (Slack advises 4,000 characters a message). */
export const PART_CHARS = 3500;
/** Delivered questions are forgotten after this long; the server does not resend an event that old. */
export const KEEP_MS = 7 * 24 * 3600 * 1000;
const ERROR_CHARS = 1500;
/** At most this many files are attached to one reply. */
export const ATTACH_MAX = 10;
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** At most this many choices are offered (a select menu's limit). A choice's text is at most CHOICE_TEXT: the card shows
 *  it whole, as text that wraps; a select menu's option label (Slack's limit) is at most CHOICE_CHARS. */
export const CHOICES_MAX = 25, CHOICE_CHARS = 75, CHOICE_TEXT = 500;

/** `s` cut to `max` characters, an ellipsis marking the cut. */
const clip = (s: string, max: number) => s.length > max ? `${s.slice(0, max - 1)}…` : s;
const clipChoice = (o: string) => clip(o, CHOICE_TEXT);
const offer = (options: string[]) => { const u = [...new Set(options.map(clipChoice))].slice(0, CHOICES_MAX); return u.length >= 2 ? u : []; };
/** A line that heads a list of alternatives: "Opções:", "**Options:**", "## Alternativas", "Escolha uma:" and the like. */
const OPTIONS_HEAD = /^\s*(?:#{1,4}\s*)?(?:\*\*|__)?\s*(?:op[çc](?:õ|o)es|alternativas|options|choices|escolhas?|caminhos)\b[^\n*_]{0,40}?(?:\*\*|__)?\s*[:?]?\s*(?:\*\*|__)?\s*$/i;
/** After the list, at most this much may follow (a recommendation) for it to be what the reply asks the people. */
const AFTER_LIST_LINES = 3, AFTER_LIST_CHARS = 500;

/** A numbered item's label: its bold lead ("**Fix the text.** Why…" is "Fix the text"), else its first sentence. */
function itemLabel(n: string, item: string): string {
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(item);
  const plain = (bold ? bold[1]! : item.split(/(?<=[.!?])\s|\s[—–-]\s/)[0]!).replace(/[*_`~]/g, "").replace(/[.:;,\s]+$/, "").trim();
  return `${n}. ${plain || item.replace(/[*_`~]/g, "").trim()}`;
}

/** A reply's choices, and the reply as it is posted. A fenced block whose info string is `choices` names them, one a line (a
 *  leading "- " or "* " dropped), and is not posted (the last block counts when there are several). Without one, a numbered
 *  list headed "Opções:" / "Options:" (and the like) near the end of the reply is offered too, each item by its bold lead
 *  or first sentence, the text posted as it is: the person need not wait for the model to remember the block. Fewer than
 *  two choices are none. */
export function choicesOf(md: string): { text: string; options: string[] } {
  const re = /(^|\n)[ \t]*```choices[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*(?=\n|$)/g;
  let options: string[] = [];
  const text = md.replace(re, (_all, lead: string, body: string) => {
    options = body.split("\n").map((l) => l.trim().replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
    return lead;
  });
  if (text !== md) return { text: text.replace(/\n{3,}/g, "\n\n").trimEnd(), options: offer(options) };
  return { text: md, options: offer(listedChoices(md)) };
}

/** The numbered list after the last options heading, when it ends the reply (but for a short recommendation). */
function listedChoices(md: string): string[] {
  const lines = md.split("\n");
  let fence = false;
  const heads: number[] = [];
  lines.forEach((l, i) => { if (/^\s*```/.test(l)) fence = !fence; else if (!fence && OPTIONS_HEAD.test(l)) heads.push(i); });
  for (const h of heads.reverse()) {
    const items: string[] = [];
    let i = h + 1;
    for (; i < lines.length; i++) {
      const l = lines[i]!, m = /^\s{0,3}(\d{1,2})[.)]\s+(.+)$/.exec(l);
      if (m && Number(m[1]) === items.length + 1) { items.push(itemLabel(m[1]!, m[2]!.trim())); continue; }
      if (!l.trim() || (items.length && /^\s{2,}\S/.test(l))) continue;
      break;
    }
    const rest = lines.slice(i).filter((l) => l.trim());
    if (items.length >= 2 && rest.length <= AFTER_LIST_LINES && rest.join("\n").length <= AFTER_LIST_CHARS) return items;
  }
  return [];
}

/** The conversation of `channel`'s top-level messages in generation `where`, or of the thread whose parent is at `where`. */
export const chatId = (channel: string, where: number | string): string =>
  typeof where === "number" ? `chat-${channel.toLowerCase()}-${where}` : `chat-${channel.toLowerCase()}-t-${where}`;

/** The local files a reply shows as Markdown images (`![title](path)`, a path and not a URL, outside code), relative
 *  paths resolved against `cwd`; each image becomes a 📎 line naming it, since the file is attached instead. */
export function attachments(md: string, cwd: string): { text: string; files: { path: string; title: string }[] } {
  const files: { path: string; title: string }[] = [];
  let fence = false;
  const lines = md.split("\n").map((line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.split(/(`[^`\n]+`)/).map((part, i) => i % 2 ? part : part.replace(/!\[([^\]\n]*)\]\(<?([^)\s>]+)>?\)/g, (all, title: string, target: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || files.length >= ATTACH_MAX) return all;
      const path = isAbsolute(target) ? target : resolve(cwd, target), name = title.trim() || basename(path);
      files.push({ path, title: name });
      return `📎 ${name}`;
    })).join("");
  });
  return { text: lines.join("\n"), files };
}

/** `text` in parts of at most `limit` characters, split at line ends; a line longer than the limit is cut. */
export function chunks(text: string, limit = PART_CHARS): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  for (const line of text.split("\n")) {
    const pieces = line.length <= limit ? [line] : line.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g"))!;
    for (const piece of pieces) {
      if (cur !== undefined && cur.length + 1 + piece.length <= limit) cur += "\n" + piece;
      else { if (cur !== undefined) out.push(cur); cur = piece; }
    }
  }
  if (cur !== undefined) out.push(cur);
  return out;
}

/** Emphasis, links and strikethrough of one line's text outside code spans, in mrkdwn. */
function inline(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part, i) => i % 2 ? part : part
    .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/g, "<$2|$1>")
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "\u0001$1\u0001")
    .replace(/__(?=\S)(.+?)__/g, "\u0001$1\u0001")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~(?=\S)(.+?)~~/g, "~$1~")
    .replace(/\u0001/g, "*")).join("");
}

/** The model's Markdown as Slack mrkdwn, which Slack and Tayet's Slack layer render: **bold** is *bold*, *italic* is _italic_,
 *  ~~struck~~ is ~struck~, [text](url) is <url|text>, a heading is a bold line, a list item starts with •, a table is a
 *  code block. Code blocks lose their language tag; code is left as it is. */
export function mrkdwn(md: string): string {
  const out: string[] = [];
  let fence = false, table = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (table) { out.push("```"); table = false; }
      fence = !fence;
      out.push(fence ? line.replace(/```.*$/, "```") : line);
      continue;
    }
    if (fence) { out.push(line); continue; }
    const row = /^\s*\|.*\|\s*$/.test(line);
    if (row !== table) { out.push("```"); table = row; }
    if (row) { out.push(line); continue; }
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { out.push(`*${inline(heading[1]!).replace(/^\*(.*)\*$/, "$1")}*`); continue; }
    const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    out.push(item ? `${item[1]}• ${inline(item[2]!)}` : inline(line));
  }
  if (table) out.push("```");
  return out.join("\n");
}

/** One question: where it was asked, the conversation and run answering it, and how much of the answer is posted. */
interface Entry {
  channel: string;
  ts: string;
  thread?: string;
  /** The generation a top-level question was asked in. */
  gen?: number;
  conv: string;
  runId: string;
  text: string;
  /** Reply parts already posted, and the first one's ts (the thread its files go to). */
  posted?: number;
  replyTs?: string;
  /** The reply's files already attached or reported as not attached. */
  attached?: number;
  /** The server refused a part of the reply, and a notice saying so was posted instead. */
  refused?: boolean;
  /** The reply's choices card is posted (or was not, and a notice said so). */
  choices?: boolean;
  /** Moved to a new conversation once already (its context budget). */
  moved?: boolean;
  done?: number;
  at: number;
}
interface Journal { generations: Record<string, number>; requests: Record<string, Entry> }

const dir = () => join(stateDir(), "slack");
/** The journal `name` (chat: `govern slack chat`'s; lead-chat: the Squad Lead's) in the workspace's state folder. */
const file = (name: string) => join(dir(), `${name}.json`);
function readJournal(name: string): Journal {
  try {
    const v = JSON.parse(readFileSync(file(name), "utf8")) as Partial<Journal>;
    return { generations: v.generations ?? {}, requests: v.requests ?? {} };
  } catch { return { generations: {}, requests: {} }; }
}
function journalOf(name: string) {
  return <T>(f: (j: Journal) => T): T => {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    return withLaneLock(join(dir(), `${name}.lock`), () => {
      const j = readJournal(name), result = f(j);
      const tmp = `${file(name)}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
      renameSync(tmp, file(name));
      return result;
    });
  };
}

/** The question run `runId` answers, from journal `name`: where it was asked (a command adapter finds its Slack message). */
export function questionOfRun(name: string, runId: string): { channel: string; ts: string; thread?: string; text: string } | undefined {
  const e = Object.values(readJournal(name).requests).find((x) => x.runId === runId);
  return e && { channel: e.channel, ts: e.ts, ...(e.thread ? { thread: e.thread } : {}), text: e.text };
}

/** The questions in journal `name` not yet answered: their conversation and run (a control has neither). */
export function openQuestions(name: string): { conv: string; runId: string; channel: string; ts: string }[] {
  return Object.values(readJournal(name).requests).filter((e) => !e.done).map((e) => ({ conv: e.conv, runId: e.runId, channel: e.channel, ts: e.ts }));
}

/** A file attached to a question: Slack's id, name and type, and the URL its bytes are fetched from with the bot token. */
export interface AskedFile { id: string; name: string; mimetype?: string; url?: string }
/** What a person wrote: a plain message, one with files (file_share), or a thread reply also sent to the channel. */
const ASKED = new Set([undefined, "file_share", "thread_broadcast"]);
/** Message kinds that are not something a person asked (edits, deletes, joins, topics, pins): never answered. */
const NOT_ASKED = new Set(["message_changed", "message_deleted", "message_replied", "channel_join", "channel_leave", "group_join",
  "group_leave", "channel_topic", "channel_purpose", "channel_name", "group_topic", "group_purpose", "group_name", "pinned_item",
  "unpinned_item", "channel_archive", "group_archive", "bot_message", "tombstone"]);

/** A question as the server sends it, when it is one this chat answers. */
export function question(payload: unknown, o: { channel: string; self: string; users: string[] }): { channel: string; ts: string; thread?: string; text: string; user: string; files?: AskedFile[] } | undefined {
  const e = (payload as { event?: Record<string, unknown> } | null)?.event;
  // Only `message`: the server sends a mention as both message and app_mention.
  if (typeof e !== "object" || e === null || e.type !== "message" || !ASKED.has(e.subtype as string | undefined) || e.bot_id !== undefined) return undefined;
  const { user, channel, ts, text, thread_ts: thread } = e;
  if (typeof user !== "string" || user === o.self || !o.users.includes(user) || channel !== o.channel) return undefined;
  if (typeof ts !== "string") return undefined;
  const asked = (typeof text === "string" ? text : "").replace(new RegExp(`<@${o.self}(\\|[^>]*)?>`, "g"), "").trim();
  const files = (Array.isArray(e.files) ? e.files as Record<string, unknown>[] : []).filter((f) => typeof f?.id === "string").map((f): AskedFile => ({
    id: f.id as string, name: typeof f.name === "string" && f.name ? f.name : f.id as string,
    ...(typeof f.mimetype === "string" ? { mimetype: f.mimetype } : {}),
    ...(typeof f.url_private_download === "string" ? { url: f.url_private_download } : typeof f.url_private === "string" ? { url: f.url_private } : {}) }));
  if (!asked && !files.length) return undefined;
  return { channel, ts, user, text: asked, ...(typeof thread === "string" && thread !== ts ? { thread } : {}), ...(files.length ? { files } : {}) };
}

/** A message from one of the chat's people that it does not take as a question, with why: it is answered with a notice, so
 *  no one waits for a reply that will not come. Edits, deletes, joins and the like are not messages anyone waits on. */
export function notTaken(payload: unknown, o: { channel: string; self: string; users: string[] }): { channel: string; ts: string; thread?: string; why: string } | undefined {
  const e = (payload as { event?: Record<string, unknown> } | null)?.event;
  if (typeof e !== "object" || e === null || e.type !== "message" || e.bot_id !== undefined || e.channel !== o.channel) return undefined;
  if (typeof e.user !== "string" || e.user === o.self || !o.users.includes(e.user) || typeof e.ts !== "string") return undefined;
  if (typeof e.subtype === "string" && NOT_ASKED.has(e.subtype)) return undefined;
  if (question(payload, o)) return undefined;
  const why = typeof e.subtype === "string" && !ASKED.has(e.subtype) ? `a message of kind ${e.subtype} is not one I can take` : "it has no text and no file";
  return { channel: e.channel, ts: e.ts, ...(typeof e.thread_ts === "string" && e.thread_ts !== e.ts ? { thread: e.thread_ts } : {}), why };
}

/** Save a question's file under `dir` with the bot token: at most `maxBytes`, refused when Slack answers with a page (no
 *  files:read) instead of the file. */
export async function fetchAsked(f: AskedFile, dir: string, token: string, maxBytes: number, request: typeof fetch = fetch): Promise<string> {
  if (!f.url) throw new Error("Slack gave no URL for it");
  const r = await request(f.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (/text\/html/.test(r.headers.get("content-type") ?? "") && !/html/.test(f.mimetype ?? ""))
    throw new Error("Slack answered with a page, not the file: the app needs the files:read scope");
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`it is ${bytes.length} bytes, more than ${maxBytes}`);
  const safe = basename(f.name).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "") || f.id;
  const path = join(dir, `${f.id}-${safe}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

export interface ChatOptions {
  /** The Web API under the bot token. */
  call: Call;
  channel: string;
  /** The agent's own user id (auth.test): its messages are not questions, and a mention of it is not part of one. */
  self: string;
  chat: ChatSettings;
  /** Where the files a reply shows go through (slack.inbox journals them; slack.upload limits them); without it a reply's
   *  files are named as not attached. */
  upload?: { inbox: string; roots: string[]; maxBytes: number; api?: string; token?: string };
  log?: (line: string) => void;
  /** The journal's name in <state>/slack (default "chat"). */
  journal?: string;
  /** Every question, top-level or in a thread, is a turn of one conversation `<single>-<generation>` (the Squad Lead): the
   *  thread only says where the reply goes. A full conversation moves on to the next generation without a notice. */
  single?: string;
  /** Create conversation `conv` (instead of slack.chat's profile or adapter, and its brief). */
  create?: (conv: string) => void;
  /** A message that is a command to the chat itself, not a turn (stop, mode): the line to answer it with, or undefined
   *  for a turn. It runs before the question is journaled; a throw is answered as a refusal. */
  control?: (q: { channel: string; ts: string; thread?: string; text: string; user: string }) => string | undefined;
  /** The line posted at once in a question's thread when it waits behind a turn already under way (what that turn is
   *  doing, say); undefined posts nothing. */
  busy?: () => string | undefined;
  /** Fetch the files a question attaches into `dir`/<question ts>/ with the bot token, and name their paths in the turn
   *  (an agent on this host reads them, images too). Without it, the turn is told they were not passed on. */
  files?: { dir: string; token: string; maxBytes?: number; request?: typeof fetch };
  /** The message offering a reply's choices (its ```choices block, choicesOf) where the reply was posted, whose click comes
   *  back as the next question; without it the block is posted as it was written. */
  choices?: (options: string[], where: { channel: string; thread?: string }) => { text: string; blocks: unknown[] };
}

export interface ChatBot {
  /** Take one events_api payload; what it starts runs on its own (see idle). */
  onEvent(payload: unknown): void;
  /** Deliver what was answered but not posted, and run what was asked but not answered (a restart). */
  resume(): void;
  /** Resolves when nothing started is still running or being delivered. */
  idle(): Promise<void>;
}

/** slack.chat.brief's text, trimmed; a brief that cannot be read stops the question, which is answered with why. */
function readBrief(file: string): string {
  try { return readFileSync(file, "utf8").trim(); }
  catch (e) { throw new Error(`slack.chat.brief ${file} cannot be read: ${(e as Error).message}`); }
}

/** The chat for one channel: questions from `o.chat.users` become turns of the channel's or the thread's conversation,
 *  and each answer, or the reason a turn failed, is posted where the question was asked. */
export function chatBot(o: ChatOptions): ChatBot {
  const name = o.journal ?? "chat", journal = journalOf(name), readJ = () => readJournal(name);
  const convOf = (channel: string, where: number | string) => o.single && typeof where === "number" ? `${o.single}-${where}` : chatId(channel, where);
  const log = o.log ?? (() => undefined), pending = new Set<Promise<void>>(), seen = new Set<string>(), chains = new Map<string, Promise<void>>();
  const track = (p: Promise<void>) => {
    const q = p.catch((e: unknown) => log(`slack chat: ${(e as Error).message}`)).finally(() => pending.delete(q));
    pending.add(q);
  };
  const react = async (add: boolean, name: string, ts: string) => {
    try { await o.call(add ? "reactions.add" : "reactions.remove", { channel: o.channel, timestamp: ts, name }); }
    catch (e) { log(`slack chat: reaction ${name} on ${ts}: ${(e as Error).message}`); }
  };
  const settings = () => ({
    ...(o.chat.adapter ? { adapter: o.chat.adapter } : { profile: o.chat.profile }),
    ...(o.chat.timeoutSeconds ? { timeoutSeconds: o.chat.timeoutSeconds } : {}),
    maxContextChars: o.chat.maxContextChars ?? CONTEXT_CHARS
  });
  /** Queue `text` in the question's conversation, creating it the first time. */
  const ask = (conv: string, text: string, requestId: string): string => {
    if (o.create && !existsSync(join(sessions.directory(conv), "session.json"))) o.create(conv);
    else if (!existsSync(join(sessions.directory(conv), "session.json"))) {
      const brief = o.chat.brief === undefined ? undefined : readBrief(o.chat.brief);
      sessions.create(conv, { ...settings(), title: `chat in ${o.channel}` });
      if (brief) text = `${brief}\n\n---\n\n${text}`;
    }
    return sessions.send(conv, text, { requestId }).run.id;
  };
  const post = (e: Entry, text: string) => o.call("chat.postMessage", { channel: e.channel, text, ...(e.thread ? { thread_ts: e.thread } : {}) });
  /** Attach the reply's files to its thread (the question's, or the reply's own), each once: a key per file, and one per
   *  image's original (slack.chat.originals). */
  const attach = async (key: string, e: Entry, files: { path: string; title: string }[]) => {
    for (let i = e.attached ?? 0; i < files.length; i++) {
      const f = files[i]!, fileKey = `${key}:file:${i + 1}`;
      const copies: { key: string; title: string; name?: string }[] = [{ key: fileKey, title: f.title }];
      if (o.chat.originals && IMAGES.has(extname(f.path).toLowerCase())) {
        copies.push({ key: `${fileKey}:original`, title: `${f.title} (full size)`, name: `${basename(f.path)}.original` });
      }
      for (const c of copies) {
        try {
          if (!o.upload) throw new Error("this chat has no slack.upload and slack.inbox");
          if (!wasSent(o.upload.inbox, c.key)) {
            await uploadFile(o.call, o.upload.inbox, e.channel, { roots: o.upload.roots, maxBytes: o.upload.maxBytes },
              { file: f.path, thread: e.thread ?? e.replyTs ?? e.ts, title: c.title, key: c.key, ...(c.name ? { name: c.name } : {}),
                ...(o.upload.api ? { api: o.upload.api } : {}), ...(o.upload.token ? { token: o.upload.token } : {}) });
          }
        } catch (err) {
          log(`slack chat: ${key}: ${f.path}: ${(err as Error).message}`);
          await post(e, `⚠️ ${c.title} not attached (${f.path}): ${(err as Error).message.slice(0, ERROR_CHARS)}`);
          // A file that failed once is not tried again as its original: one notice per file.
          break;
        }
      }
      save(key, (x) => { x.attached = i + 1; });
    }
  };
  const save = (key: string, f: (e: Entry) => void) => journal((j) => { const e = j.requests[key]; if (e) f(e); });

  /** Post what the question's run ended with, once its run has ended; true when the question needs nothing more. */
  const deliver = async (key: string, failure?: string): Promise<boolean> => {
    const e = readJ().requests[key];
    if (!e || e.done) return true;
    const s = sessions.inspect(e.conv), r = s.runs.find((x) => x.id === e.runId);
    if (!r) throw new Error(`${e.conv} has no run ${e.runId}`);
    if (r.state === "queued" && failure) {
      // The runtime would not take the turn (an interrupted turn before it, a changed profile): say so, and cancel it so
      // the conversation goes on.
      sessions.cancel(e.conv, r.id, failure);
      return deliver(key);
    }
    if (r.state === "queued" || r.state === "running") return false;
    if (r.state === "interrupted" && !r.acknowledgedAt) sessions.recover(e.conv, "cancel", "slack chat: reported in the channel; ask again");
    if (r.state === "failed" && (!e.thread || o.single) && !e.moved && /context budget exceeded/.test(r.error ?? "")) {
      // The channel's conversation is full: the question moves to the next generation, opened by the first to get here.
      const next = journal((j) => {
        const g = j.generations[e.channel] ?? 1, bump = g === e.gen;
        if (bump) j.generations[e.channel] = g + 1;
        return { gen: bump ? g + 1 : g, bump };
      });
      if (next.bump && !o.single) await post(e, `_The conversation in this channel is past its context budget (${s.maxContextChars} characters): this question starts a new conversation, which does not see the earlier ones._`);
      const conv = convOf(e.channel, next.gen), runId = ask(conv, e.text, `${key}:moved`);
      save(key, (x) => { x.conv = conv; x.gen = next.gen; x.runId = runId; x.moved = true; });
      drain(conv);
      return true;
    }
    if (r.state === "completed") {
      const reply = s.messages.find((m) => m.runId === r.id && m.role === "assistant")!.content;
      const offered = o.choices ? choicesOf(reply) : { text: reply, options: [] };
      const { text, files } = attachments(offered.text, s.cwd), parts = chunks(mrkdwn(text));
      let refused: string | undefined;
      for (let i = e.posted ?? 0; i < parts.length && !refused; i++) {
        let sent: Record<string, unknown>;
        try { sent = await post(e, parts[i]!); }
        catch (err) {
          // The server would not take this part (a Tayet leak filter, say). If it takes a short notice, the reply is
          // reported as not posted; if it takes nothing, it is down, and the delivery is tried again later.
          refused = (err as Error).message;
          await post(e, `❌ The reply could not be posted${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}: ${refused.slice(0, ERROR_CHARS)}. It is in the conversation ${e.conv}; ask for it again, worded differently.`);
          log(`slack chat: ${key}: part ${i + 1} refused: ${refused}`);
          save(key, (x) => { x.posted = parts.length; x.refused = true; });
          break;
        }
        const ts = typeof sent.ts === "string" ? sent.ts : undefined;
        save(key, (x) => { x.posted = i + 1; if (i === 0 && ts) x.replyTs = ts; });
        if (i === 0 && ts) e.replyTs = ts;
      }
      if (refused) e.refused = true;
      if (!e.refused) await attach(key, e, files);
      if (!e.refused && !e.choices && offered.options.length && o.choices) {
        try {
          const card = o.choices(offered.options, { channel: e.channel, ...(e.thread ? { thread: e.thread } : {}) });
          await o.call("chat.postMessage", { channel: e.channel, ...card, ...(e.thread ? { thread_ts: e.thread } : {}) });
        } catch (err) {
          log(`slack chat: ${key}: choices: ${(err as Error).message}`);
          await post(e, `⚠️ The choices could not be shown as buttons (${(err as Error).message.slice(0, ERROR_CHARS)}): answer in words.\n${offered.options.map((x) => `• ${x}`).join("\n")}`);
        }
        save(key, (x) => { x.choices = true; });
      }
    } else {
      const why = (r.error ?? r.reason ?? r.state).slice(0, ERROR_CHARS);
      if (!e.posted) await post(e, `❌ The turn ${r.state === "failed" ? "failed" : `was ${r.state}`}: ${why}`);
      save(key, (x) => { x.posted = 1; });
    }
    await react(false, "eyes", e.ts);
    await react(true, r.state === "completed" && !e.refused ? "white_check_mark" : "x", e.ts);
    save(key, (x) => { x.done = Date.now(); });
    return true;
  };

  /** Run conversation `conv`'s queued turns and deliver what they answer, after whatever this conversation already has
   *  under way: one conversation answers in order, different ones at once. */
  const drain = (conv: string): void => {
    const step = async () => {
      let failure: string | undefined;
      try { await run(conv); } catch (e) { failure = (e as Error).message; log(`slack chat: ${conv}: ${failure}`); }
      const keys = Object.entries(readJ().requests).filter(([, e]) => e.conv === conv && !e.done).map(([k]) => k);
      for (const key of keys) {
        try { await deliver(key, failure); } catch (e) { log(`slack chat: delivering ${key}: ${(e as Error).message}`); }
      }
    };
    const next = (chains.get(conv) ?? Promise.resolve()).then(step);
    chains.set(conv, next);
    track(next.finally(() => { if (chains.get(conv) === next) chains.delete(conv); }));
  };

  /** What the turn is told about a question's files: where each was saved, or why it was not. */
  const filesNote = async (files: AskedFile[], ts: string): Promise<string> => {
    if (!o.files) return `[${files.length} file${files.length === 1 ? "" : "s"} attached in Slack (${files.map((f) => f.name).join(", ")}) not passed on: this chat does not fetch files.]`;
    const lines = ["[Files attached to this Slack message, saved on this host; read them (images too) with your file reading tool:]"];
    for (const f of files) {
      try { lines.push(`- ${await fetchAsked(f, join(o.files.dir, ts.replace(/[^\d.]/g, "")), o.files.token, o.files.maxBytes ?? ASKED_MAX_BYTES, o.files.request)}${f.mimetype ? ` (${f.mimetype})` : ""}`); }
      catch (e) { log(`slack chat: file ${f.id} of ${ts}: ${(e as Error).message}`); lines.push(`- ${f.name}: not fetched (${(e as Error).message})`); }
    }
    return lines.join("\n");
  };
  const take = async (q: { channel: string; ts: string; thread?: string; text: string; user: string; files?: AskedFile[] }, key: string) => {
    const answer = o.control?.(q);
    if (answer !== undefined) {
      journal((j) => {
        j.requests[key] = { channel: q.channel, ts: q.ts, ...(q.thread ? { thread: q.thread } : {}), conv: "", runId: "", text: q.text, at: Date.now(), posted: 1, done: Date.now() };
      });
      await post({ channel: q.channel, ts: q.ts, ...(q.thread ? { thread: q.thread } : {}) } as Entry, answer);
      await react(true, "white_check_mark", q.ts);
      return;
    }
    await react(true, "eyes", q.ts);
    if (q.files?.length) q = { ...q, text: [q.text, await filesNote(q.files, q.ts)].filter(Boolean).join("\n\n") };
    const gen = q.thread && !o.single ? undefined : journal((j) => j.generations[q.channel] ?? 1);
    const conv = q.thread && !o.single ? chatId(q.channel, q.thread) : convOf(q.channel, gen!);
    const runId = ask(conv, q.text, key);
    journal((j) => {
      j.requests[key] = { channel: q.channel, ts: q.ts, ...(q.thread ? { thread: q.thread } : {}), ...(gen !== undefined ? { gen } : {}), conv, runId, text: q.text, at: Date.now() };
    });
    if (o.busy && sessions.inspect(conv).runs.some((r) => r.id !== runId && (r.state === "running" || r.state === "queued"))) {
      const line = o.busy();
      if (line) {
        try { await o.call("chat.postMessage", { channel: q.channel, text: line, thread_ts: q.thread ?? q.ts }); }
        catch (e) { log(`slack chat: ${key}: busy line: ${(e as Error).message}`); }
      }
    }
    drain(conv);
  };

  return {
    onEvent(payload) {
      const who = { channel: o.channel, self: o.self, users: o.chat.users }, q = question(payload, who);
      if (!q) {
        const n = notTaken(payload, who), key = n && `slack:${n.channel}:${n.ts}`;
        if (!n || !key || seen.has(key)) return;
        seen.add(key);
        log(`slack chat: ${key} not taken: ${n.why}`);
        track(o.call("chat.postMessage", { channel: n.channel, thread_ts: n.thread ?? n.ts,
          text: `⚠️ Not taken: ${n.why}. Send it again as a plain message (text, with files attached if you need them).` }).then(() => undefined));
        return;
      }
      const key = `slack:${q.channel}:${q.ts}`;
      if (seen.has(key) || readJ().requests[key]) return;
      seen.add(key);
      track(take(q, key).catch(async (e: unknown) => {
        // Not asked (the profile is refused, the conversation is unreadable): the person sees why.
        log(`slack chat: ${key}: ${(e as Error).message}`);
        await o.call("chat.postMessage", { channel: q.channel, text: `❌ Not asked: ${(e as Error).message.slice(0, ERROR_CHARS)}`, ...(q.thread ? { thread_ts: q.thread } : {}) });
        await react(false, "eyes", q.ts);
        await react(true, "x", q.ts);
      }));
    },
    resume() {
      const now = Date.now();
      const open = journal((j) => {
        for (const [k, e] of Object.entries(j.requests)) if (e.done && now - e.done > KEEP_MS) delete j.requests[k];
        return Object.values(j.requests).filter((e) => !e.done);
      });
      for (const conv of new Set(open.map((e) => e.conv))) drain(conv);
    },
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    }
  };
}
