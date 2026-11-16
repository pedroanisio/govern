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
import { join } from "node:path";
import { stateDir } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import * as sessions from "../../lib/conversation.ts";
import { run } from "../conversation/conversation-runtime.ts";
import type { Call } from "./channel.ts";

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
}

/** A chat conversation's context budget unless slack.chat sets one: a channel holds a long exchange. */
export const CONTEXT_CHARS = 400_000;
/** Reply parts are at most this long (Slack advises 4,000 characters a message). */
export const PART_CHARS = 3500;
/** Delivered questions are forgotten after this long; the server does not resend an event that old. */
export const KEEP_MS = 7 * 24 * 3600 * 1000;
const ERROR_CHARS = 1500;

/** The conversation of `channel`'s top-level messages in generation `where`, or of the thread whose parent is at `where`. */
export const chatId = (channel: string, where: number | string): string =>
  typeof where === "number" ? `chat-${channel.toLowerCase()}-${where}` : `chat-${channel.toLowerCase()}-t-${where}`;

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
  /** Reply parts already posted. */
  posted?: number;
  /** Moved to a new conversation once already (its context budget). */
  moved?: boolean;
  done?: number;
  at: number;
}
interface Journal { generations: Record<string, number>; requests: Record<string, Entry> }

const dir = () => join(stateDir(), "slack");
const file = () => join(dir(), "chat.json");
function readJournal(): Journal {
  try {
    const v = JSON.parse(readFileSync(file(), "utf8")) as Partial<Journal>;
    return { generations: v.generations ?? {}, requests: v.requests ?? {} };
  } catch { return { generations: {}, requests: {} }; }
}
function journal<T>(f: (j: Journal) => T): T {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  return withLaneLock(join(dir(), "chat.lock"), () => {
    const j = readJournal(), result = f(j);
    const tmp = `${file()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
    renameSync(tmp, file());
    return result;
  });
}

/** A question as the server sends it, when it is one this chat answers. */
function question(payload: unknown, o: { channel: string; self: string; users: string[] }): { channel: string; ts: string; thread?: string; text: string } | undefined {
  const e = (payload as { event?: Record<string, unknown> } | null)?.event;
  // Only `message`: the server sends a mention as both message and app_mention.
  if (typeof e !== "object" || e === null || e.type !== "message" || e.subtype !== undefined || e.bot_id !== undefined) return undefined;
  const { user, channel, ts, text, thread_ts: thread } = e;
  if (typeof user !== "string" || user === o.self || !o.users.includes(user) || channel !== o.channel) return undefined;
  if (typeof ts !== "string" || typeof text !== "string") return undefined;
  const asked = text.replace(new RegExp(`<@${o.self}(\\|[^>]*)?>`, "g"), "").trim();
  if (!asked) return undefined;
  return { channel, ts, text: asked, ...(typeof thread === "string" && thread !== ts ? { thread } : {}) };
}

export interface ChatOptions {
  /** The Web API under the bot token. */
  call: Call;
  channel: string;
  /** The agent's own user id (auth.test): its messages are not questions, and a mention of it is not part of one. */
  self: string;
  chat: ChatSettings;
  log?: (line: string) => void;
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
    if (!existsSync(join(sessions.directory(conv), "session.json"))) {
      const brief = o.chat.brief === undefined ? undefined : readBrief(o.chat.brief);
      sessions.create(conv, { ...settings(), title: `chat in ${o.channel}` });
      if (brief) text = `${brief}\n\n---\n\n${text}`;
    }
    return sessions.send(conv, text, { requestId }).run.id;
  };
  const post = (e: Entry, text: string) => o.call("chat.postMessage", { channel: e.channel, text, ...(e.thread ? { thread_ts: e.thread } : {}) });
  const save = (key: string, f: (e: Entry) => void) => journal((j) => { const e = j.requests[key]; if (e) f(e); });

  /** Post what the question's run ended with, once its run has ended; true when the question needs nothing more. */
  const deliver = async (key: string, failure?: string): Promise<boolean> => {
    const e = readJournal().requests[key];
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
    if (r.state === "failed" && !e.thread && !e.moved && /context budget exceeded/.test(r.error ?? "")) {
      // The channel's conversation is full: the question moves to the next generation, opened by the first to get here.
      const next = journal((j) => {
        const g = j.generations[e.channel] ?? 1, bump = g === e.gen;
        if (bump) j.generations[e.channel] = g + 1;
        return { gen: bump ? g + 1 : g, bump };
      });
      if (next.bump) await post(e, `_The conversation in this channel is past its context budget (${s.maxContextChars} characters): this question starts a new conversation, which does not see the earlier ones._`);
      const conv = chatId(e.channel, next.gen), runId = ask(conv, e.text, `${key}:moved`);
      save(key, (x) => { x.conv = conv; x.gen = next.gen; x.runId = runId; x.moved = true; });
      drain(conv);
      return true;
    }
    if (r.state === "completed") {
      const reply = s.messages.find((m) => m.runId === r.id && m.role === "assistant")!.content, parts = chunks(mrkdwn(reply));
      for (let i = e.posted ?? 0; i < parts.length; i++) {
        await post(e, parts[i]!);
        save(key, (x) => { x.posted = i + 1; });
      }
    } else {
      const why = (r.error ?? r.reason ?? r.state).slice(0, ERROR_CHARS);
      if (!e.posted) await post(e, `❌ The turn ${r.state === "failed" ? "failed" : `was ${r.state}`}: ${why}`);
      save(key, (x) => { x.posted = 1; });
    }
    await react(false, "eyes", e.ts);
    await react(true, r.state === "completed" ? "white_check_mark" : "x", e.ts);
    save(key, (x) => { x.done = Date.now(); });
    return true;
  };

  /** Run conversation `conv`'s queued turns and deliver what they answer, after whatever this conversation already has
   *  under way: one conversation answers in order, different ones at once. */
  const drain = (conv: string): void => {
    const step = async () => {
      let failure: string | undefined;
      try { await run(conv); } catch (e) { failure = (e as Error).message; log(`slack chat: ${conv}: ${failure}`); }
      const keys = Object.entries(readJournal().requests).filter(([, e]) => e.conv === conv && !e.done).map(([k]) => k);
      for (const key of keys) {
        try { await deliver(key, failure); } catch (e) { log(`slack chat: delivering ${key}: ${(e as Error).message}`); }
      }
    };
    const next = (chains.get(conv) ?? Promise.resolve()).then(step);
    chains.set(conv, next);
    track(next.finally(() => { if (chains.get(conv) === next) chains.delete(conv); }));
  };

  const take = async (q: { channel: string; ts: string; thread?: string; text: string }, key: string) => {
    await react(true, "eyes", q.ts);
    const gen = q.thread ? undefined : journal((j) => j.generations[q.channel] ?? 1);
    const conv = chatId(q.channel, q.thread ?? gen!);
    const runId = ask(conv, q.text, key);
    journal((j) => {
      j.requests[key] = { channel: q.channel, ts: q.ts, ...(q.thread ? { thread: q.thread } : { gen }), conv, runId, text: q.text, at: Date.now() };
    });
    drain(conv);
  };

  return {
    onEvent(payload) {
      const q = question(payload, { channel: o.channel, self: o.self, users: o.chat.users });
      if (!q) return;
      const key = `slack:${q.channel}:${q.ts}`;
      if (seen.has(key) || readJournal().requests[key]) return;
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
