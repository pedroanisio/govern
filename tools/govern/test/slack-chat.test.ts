// `govern slack chat` (ext/slack/chat.ts): people the config names talk to an agent in slack.channel; each message becomes a
// turn of a govern conversation and its reply is posted where it was asked. The model is the fake command adapter
// (fake-conversation.ts): no test calls a paid model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeEnv, childEnv, govern, setConfig, write, type Env } from "./helpers.ts";
import { attachments, ATTACH_MAX, chatBot, chatId, chunks, mrkdwn, type ChatSettings } from "../ext/slack/chat.ts";
import { runSocket } from "../ext/slack/socket.ts";
import type { Call } from "../ext/slack/channel.ts";
import * as sessions from "../lib/conversation.ts";
import { slackConfig } from "../lib/workspace.ts";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

const HERE = dirname(fileURLToPath(import.meta.url));
const ME = "UPEDRO0001", BOT = "UAGENT0001", OTHER = "UOTHER0001", CH = "CCHAT00001";

interface Sent { method: string; body: Record<string, unknown> }
/** A recording Web API: every call is kept; posts get increasing ts values. */
function fakeCall(): { call: Call; sent: Sent[] } {
  const sent: Sent[] = [];
  let n = 0;
  return { sent, call: async (method, body) => {
    sent.push({ method, body });
    return method === "chat.postMessage" ? { ok: true, channel: body.channel, ts: `1795000000.${String(++n).padStart(6, "0")}` } : { ok: true };
  } };
}

/** A workspace whose conversations run the fake adapter, process.env pointed at it while `f` runs. */
async function scenario(f: (e: Env) => Promise<void>): Promise<void> {
  const e = makeEnv("slack-chat"), before = process.env;
  setConfig(e, {
    extensions: ["slack", "conversation"],
    conversationAdapters: Object.fromEntries(["echo", "fail", "oversize"].map((m) => [m, { argv: [process.execPath, join(HERE, "fake-conversation.ts"), m] }])),
    slack: { team: "T0TEAM", channel: CH, chat: { users: [ME], adapter: "echo" } }
  });
  process.env = childEnv(e);
  try { await f(e); } finally { process.env = before; }
}

const message = (text: string, o: { user?: string; ts?: string; thread?: string; channel?: string; subtype?: string; bot?: boolean } = {}) => ({
  type: "event_callback",
  event: { type: "message", channel: o.channel ?? CH, channel_type: "channel", user: o.user ?? ME, text, ts: o.ts ?? "1794000000.000100",
    ...(o.thread ? { thread_ts: o.thread } : {}), ...(o.subtype ? { subtype: o.subtype } : {}), ...(o.bot ? { bot_id: "B0AGENT" } : {}), event_ts: o.ts ?? "1794000000.000100" }
});
const settings = (s: Partial<ChatSettings> = {}): ChatSettings => ({ users: [ME], adapter: "echo", ...s });
const posts = (sent: Sent[]) => sent.filter((s) => s.method === "chat.postMessage").map((s) => s.body);
const reactions = (sent: Sent[]) => sent.filter((s) => s.method.startsWith("reactions.")).map((s) => `${s.method.slice(10)}:${s.body.name}@${s.body.timestamp}`);

test("the config takes slack.chat with the people it answers, and refuses an empty list or both a profile and an adapter", () => scenario(async (e) => {
  assert.deepEqual(slackConfig()?.chat, { users: [ME], adapter: "echo" });
  for (const [chat, why] of [[{ users: [] }, /slack\.chat\.users/], [{ users: [ME], profile: "claude-read", adapter: "echo" }, /profile or a conversation adapter/]] as const) {
    setConfig(e, { extensions: ["slack"], slack: { team: "T0TEAM", channel: CH, chat } });
    const r = govern(e, ["slack", "chat"]);
    assert.notEqual(r.code, 0, r.err);
    assert.match(r.err, why);
  }
}));

test("a message from a named person is a conversation turn; the reply goes to the channel, with 👀 then ✅ on the question", () => scenario(async () => {
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings() });
  bot.onEvent(message(`<@${BOT}> what is the status?`));
  await bot.idle();
  assert.deepEqual(posts(sent), [{ channel: CH, text: "reply:what is the status?:previous=0" }], "the mention of the agent is not part of the question");
  assert.deepEqual(reactions(sent), ["add:eyes@1794000000.000100", "remove:eyes@1794000000.000100", "add:white_check_mark@1794000000.000100"]);
  const conv = sessions.inspect(chatId(CH, 1));
  assert.equal(conv.messages.length, 2);
  assert.equal(conv.runs[0]!.requestId, `slack:${CH}:1794000000.000100`);

  // The channel is one conversation: the next question sees the earlier turn.
  bot.onEvent(message("and now?", { ts: "1794000000.000200" }));
  await bot.idle();
  assert.equal(posts(sent).at(-1)!.text, "reply:and now?:previous=1");
}));

test("redelivery, edits, other people, other channels, bots and the agent itself are not turns", () => scenario(async () => {
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings() });
  const first = message("hello");
  bot.onEvent(first);
  bot.onEvent(first); // the sidecar delivers at least once
  await bot.idle();
  bot.onEvent(first);
  for (const ignored of [message("x", { user: OTHER, ts: "1794000000.000300" }), message("x", { channel: "COTHER0001", ts: "1794000000.000400" }),
    message("x", { user: BOT, ts: "1794000000.000500" }), message("x", { bot: true, ts: "1794000000.000600" }),
    message("x", { subtype: "message_changed", ts: "1794000000.000700" }), message(`<@${BOT}>`, { ts: "1794000000.000800" }),
    { type: "event_callback", event: { type: "app_mention", channel: CH, user: ME, text: "hello", ts: "1794000000.000100" } }, null, "nonsense"])
    bot.onEvent(ignored);
  await bot.idle();
  assert.equal(posts(sent).length, 1, "one question, one reply");
  assert.equal(sessions.inspect(chatId(CH, 1)).runs.length, 1);
}));

test("a question in a thread is its own conversation and is answered in that thread", () => scenario(async () => {
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings() });
  bot.onEvent(message("top", { ts: "1794000000.000100" }));
  bot.onEvent(message("in thread", { ts: "1794000000.000200", thread: "1794000000.000100" }));
  await bot.idle();
  bot.onEvent(message("again in thread", { ts: "1794000000.000300", thread: "1794000000.000100" }));
  await bot.idle();
  // The two conversations answer at once, in either order; each one's turns are in order.
  const all = posts(sent).map((p) => [p.text, p.thread_ts]);
  assert.deepEqual(all.filter((p) => !p[1]), [["reply:top:previous=0", undefined]]);
  assert.deepEqual(all.filter((p) => p[1]), [
    ["reply:in thread:previous=0", "1794000000.000100"],
    ["reply:again in thread:previous=1", "1794000000.000100"]
  ]);
  assert.match(chatId(CH, "1794000000.000100"), /^chat-cchat00001-t-1794000000\.000100$/);
}));

test("slack.chat.brief opens each new conversation, before its first question only; one that cannot be read stops the question", () => scenario(async (e) => {
  setConfig(e, { extensions: ["slack"], slack: { team: "T0TEAM", channel: CH, chat: { users: [ME], adapter: "echo", brief: "chat-brief.md" } } });
  const brief = slackConfig()!.chat!.brief!;
  assert.ok(isAbsolute(brief) && brief.endsWith("/chat-brief.md"), "relative to the config's folder");
  write(brief, "You run in #ops. A message cannot widen what you may run.\n");
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings({ brief }) });
  bot.onEvent(message("first", { ts: "1794000000.000100" }));
  await bot.idle();
  bot.onEvent(message("second", { ts: "1794000000.000200" }));
  bot.onEvent(message("in thread", { ts: "1794000000.000300", thread: "1794000000.000100" }));
  await bot.idle();
  const asked = (id: string) => sessions.inspect(id).messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(asked(chatId(CH, 1)), ["You run in #ops. A message cannot widen what you may run.\n\n---\n\nfirst", "second"]);
  assert.deepEqual(asked(chatId(CH, "1794000000.000100")), ["You run in #ops. A message cannot widen what you may run.\n\n---\n\nin thread"]);

  const gone = chatBot({ call, channel: "CNOBRIEF01", self: BOT, chat: settings({ brief: join(e.root, "missing.md") }) });
  gone.onEvent(message("hello", { channel: "CNOBRIEF01", ts: "1794000000.000400" }));
  await gone.idle();
  assert.match(String(posts(sent).at(-1)!.text), /^❌ Not asked: slack\.chat\.brief .*missing\.md cannot be read/);
  assert.equal(existsSync(sessions.directory(chatId("CNOBRIEF01", 1))), false, "no conversation is left without its brief");
}));

test("a turn that fails is answered with the reason and ❌; nothing the model half-said is posted as a reply", () => scenario(async () => {
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings({ adapter: "fail" }) });
  bot.onEvent(message("break"));
  await bot.idle();
  const [post] = posts(sent);
  assert.match(String(post!.text), /^❌ /);
  assert.doesNotMatch(String(post!.text), /misleading/);
  assert.deepEqual(reactions(sent).at(-1), "add:x@1794000000.000100");
}));

test("a reply's Markdown is posted as Slack mrkdwn; code is left as it is", () => {
  const md = [
    "# Title", "Escrevi a tela, mas **não consegui** rodar. ~~old~~ and *soft* and __strong__ and _kept_.",
    "- item one", "  * nested `**not bold**`", "+ item three",
    "See [the docs](https://flutter.dev) and ![shot](https://x.test/a.png).",
    "```sh", "docker run **x** - y", "```",
    "| a | b |", "|---|---|", "| 1 | 2 |", "after"
  ].join("\n");
  assert.equal(mrkdwn(md), [
    "*Title*", "Escrevi a tela, mas *não consegui* rodar. ~old~ and _soft_ and *strong* and _kept_.",
    "• item one", "  • nested `**not bold**`", "• item three",
    "See <https://flutter.dev|the docs> and <https://x.test/a.png|shot>.",
    "```", "docker run **x** - y", "```",
    "```", "| a | b |", "|---|---|", "| 1 | 2 |", "```", "after"
  ].join("\n"));
  assert.equal(mrkdwn("2 * 3 * 4 and a*b*c"), "2 * 3 * 4 and a*b*c", "a lone or word-inner asterisk is not emphasis");
});

test("the agent's reply is posted as mrkdwn", () => scenario(async () => {
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings() });
  bot.onEvent(message("**bold**"));
  await bot.idle();
  assert.equal(posts(sent)[0]!.text, "reply:*bold*:previous=0");
}));

test("a reply's local Markdown images are files to attach, named by a 📎 line; URLs and code are left as they are", () => {
  const md = ["Here: ![golden](test/goldens/a.png) and ![](/abs/b.pdf)", "web ![x](https://example.com/x.png) `![c](code.png)`",
    "```", "![f](fenced.png)", "```", "![spaced](<dir/c d.png>)"].join("\n");
  const { text, files } = attachments(md, "/w/squad");
  assert.deepEqual(files, [{ path: "/w/squad/test/goldens/a.png", title: "golden" }, { path: "/abs/b.pdf", title: "b.pdf" }]);
  assert.equal(text, ["Here: 📎 golden and 📎 b.pdf", "web ![x](https://example.com/x.png) `![c](code.png)`", "```", "![f](fenced.png)", "```", "![spaced](<dir/c d.png>)"].join("\n"));
  assert.equal(attachments(Array.from({ length: 12 }, (_, i) => `![${i}](f${i}.png)`).join(" "), "/w").files.length, ATTACH_MAX);
});

test("a reply's files are attached in the reply's thread, once each; one that cannot be is named in the channel", () => scenario(async (e) => {
  const media = join(e.root, "media"), shot = write(join(media, "shot.png"), "png bytes"), outside = write(join(e.root, "secret.png"), "no");
  const got: { url: string; body: string; auth?: string }[] = [];
  const server = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { got.push({ url: req.url ?? "", body: b, auth: req.headers.authorization }); res.end("OK"); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/slack`;
  try {
    const sent: Sent[] = [];
    let n = 0;
    const call: Call = async (method, body) => {
      sent.push({ method, body });
      if (method === "chat.postMessage") return { ok: true, ts: `1795000000.${String(++n).padStart(6, "0")}` };
      if (method === "conversations.replies") return { ok: true, messages: [{ ts: body.ts }] };
      if (method === "files.getUploadURLExternal") return { ok: true, upload_url: `${base}/upload/F0SHOT0001`, file_id: "F0SHOT0001" };
      if (method === "files.completeUploadExternal") return { ok: true, files: [{ id: "F0SHOT0001" }] };
      return { ok: true };
    };
    const upload = { inbox: join(e.root, "inbox"), roots: [media], maxBytes: 1000, api: `${base}/api`, token: "xoxb-local" };
    const bot = chatBot({ call, channel: CH, self: BOT, chat: settings(), upload });
    bot.onEvent(message(`see ![the shot](${shot}) and ![leak](${outside})`));
    await bot.idle();
    const texts = posts(sent).map((p) => String(p.text));
    assert.equal(texts[0], "reply:see 📎 the shot and 📎 leak:previous=0");
    assert.match(texts[1]!, /^⚠️ leak not attached \(.*secret\.png\): upload path must be inside slack\.upload\.roots/);
    const done = sent.find((s) => s.method === "files.completeUploadExternal")!.body;
    assert.deepEqual(done, { files: [{ id: "F0SHOT0001", title: "the shot" }], channel_id: CH, thread_ts: "1795000000.000001" }, "in the reply's thread");
    assert.equal(got.length, 1);
    assert.ok(got[0]!.body.includes("png bytes"));
    assert.equal(got[0]!.auth, "Bearer xoxb-local", "the sidecar's upload URL gets the bot token");

    // Started again on the same journal, nothing is posted or attached twice.
    const again = chatBot({ call, channel: CH, self: BOT, chat: settings(), upload });
    again.resume();
    await again.idle();
    assert.equal(sent.filter((s) => s.method === "files.completeUploadExternal").length, 1);
    assert.equal(posts(sent).length, 2);

    // A chat without slack.upload names the file instead of attaching it.
    const plain = chatBot({ call, channel: CH, self: BOT, chat: settings() });
    plain.onEvent(message(`![again](${shot})`, { ts: "1794000000.000900" }));
    await plain.idle();
    assert.match(String(posts(sent).at(-1)!.text), /^⚠️ again not attached .*: this chat has no slack\.upload and slack\.inbox/);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
}));

test("a reply the server refuses is reported as not posted, with ❌, and not tried again", () => scenario(async () => {
  const { call: base, sent } = fakeCall();
  // A Tayet sidecar refuses text its leak filter matches; everything else goes through.
  const call: Call = async (method, body) => {
    if (method === "chat.postMessage" && String(body.text).includes("LEAK")) { sent.push({ method: "refused", body }); throw new Error("chat.postMessage: internal_error"); }
    return base(method, body);
  };
  const bot = chatBot({ call, channel: CH, self: BOT, chat: settings() });
  bot.onEvent(message("LEAK"));
  await bot.idle();
  assert.deepEqual(posts(sent).map((p) => p.text), [`❌ The reply could not be posted: chat.postMessage: internal_error. It is in the conversation ${chatId(CH, 1)}; ask for it again, worded differently.`]);
  assert.deepEqual(reactions(sent).at(-1), "add:x@1794000000.000100");
  const again = chatBot({ call, channel: CH, self: BOT, chat: settings() });
  again.resume();
  await again.idle();
  assert.equal(sent.filter((s) => s.method === "refused").length, 1, "not tried again");
}));

test("a long reply goes out in parts, split at line ends, each under the size limit", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const parts = chunks(text, 4000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join("\n"), text);
  assert.deepEqual(chunks("y".repeat(9000), 4000).map((p) => p.length), [4000, 4000, 1000], "a line longer than the limit is cut");
});

test("when the channel conversation outgrows its context budget, the question moves to a new conversation", () => scenario(async () => {
  const { call, sent } = fakeCall(), bot = chatBot({ call, channel: CH, self: BOT, chat: settings({ maxContextChars: 400 }) });
  bot.onEvent(message("a".repeat(150), { ts: "1794000000.000100" }));
  await bot.idle();
  bot.onEvent(message("b".repeat(150), { ts: "1794000000.000200" }));
  await bot.idle();
  const texts = posts(sent).map((p) => String(p.text));
  assert.equal(texts.length, 3, texts.join(" | "));
  assert.match(texts[1]!, /new conversation/);
  assert.equal(texts[2], `reply:${"b".repeat(150)}:previous=0`);
  assert.equal(sessions.inspect(chatId(CH, 2)).runs.length, 1);
}));

test("a reply the chat could not post is posted when it starts again, once", () => scenario(async () => {
  const down: Call = async (method, body) => { if (method === "chat.postMessage") throw new Error("chat.postMessage: fetch failed"); return { ok: true, ...body }; };
  const bot = chatBot({ call: down, channel: CH, self: BOT, chat: settings() });
  bot.onEvent(message("before restart"));
  await bot.idle();
  const again = fakeCall(), restarted = chatBot({ call: again.call, channel: CH, self: BOT, chat: settings() });
  restarted.resume();
  await restarted.idle();
  restarted.onEvent(message("before restart")); // the server sends it again: answered already
  await restarted.idle();
  const third = fakeCall(), once = chatBot({ call: third.call, channel: CH, self: BOT, chat: settings() });
  once.resume();
  await once.idle();
  assert.deepEqual(posts(again.sent).map((p) => p.text), ["reply:before restart:previous=0"]);
  assert.equal(posts(third.sent).length, 0);
  assert.equal(sessions.inspect(chatId(CH, 1)).runs.length, 1, "the question was asked once");
}));

test("runSocket passes events to onEvent, acks them at once, and leaves clicks alone when it has no handler", async () => {
  const sockets: Duplex[] = [], received: unknown[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/slack/socket` }));
    });
  });
  server.on("upgrade", (req, socket: Duplex) => {
    sockets.push(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      // Masked client text frames under 126 bytes; one chunk may hold several.
      for (buf = Buffer.concat([buf, d]); buf.length >= 6 && buf.length >= 6 + (buf[1]! & 0x7f); ) {
        const len = buf[1]! & 0x7f, mask = buf.subarray(2, 6);
        received.push(JSON.parse(Buffer.from(buf.subarray(6, 6 + len)).map((b, i) => b ^ mask[i % 4]!).toString()));
        buf = buf.subarray(6 + len);
      }
    });
    const send = (o: unknown) => { const p = Buffer.from(JSON.stringify(o)); socket.write(Buffer.concat([Buffer.from([0x81, p.length]), p])); };
    send({ type: "hello" });
    send({ envelope_id: "ev-1", type: "events_api", payload: { event: { type: "message" } } });
    send({ envelope_id: "in-1", type: "interactive", payload: { type: "block_actions" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const stop = new AbortController(), events: unknown[] = [];
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/slack/api`;
  try {
    const run = runSocket({ api, token: "local", signal: stop.signal, onEvent: (p) => { events.push(p); } });
    for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await run;
    assert.deepEqual(events, [{ event: { type: "message" } }]);
    assert.deepEqual(received, [{ envelope_id: "ev-1" }, { envelope_id: "in-1" }]);
  } finally { for (const s of sockets) s.destroy(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test("govern slack chat refuses a workspace without slack.chat, naming the setting", () => {
  const e = makeEnv("slack-chat-cli");
  setConfig(e, { extensions: ["slack"], slack: { team: "T0TEAM", channel: CH } });
  write(join(e.root, "slack.env"), "SLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-1\n");
  const r = govern(e, ["slack", "chat"]);
  assert.notEqual(r.code, 0, r.err);
  assert.match(r.err, /slack\.chat/);
});
