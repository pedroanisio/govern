// Tayet (TAYET.md): a Tayet agent's sidecar speaks part of Slack's Web API and Socket Mode on loopback. Clicks arrive over
// Socket Mode (socket.ts) and are decided as signed requests are; a card closes on its first click, carries at most three
// buttons and reads `text` as its request (server.ts), so notify splits, reposts and sends the blocks' text. The payloads
// here follow the sidecar's own code (tayethq/tayet v0.1.0, sidecar/src/api/slack/interactive.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { makeEnv, childEnv, govern, setConfig, write, tempDir, jsonl, type Env } from "./helpers.ts";
import { create, load } from "../lib/project.ts";
import { decisionValue, handleSocketInteraction } from "../ext/slack/slack.ts";
import { notify } from "../ext/slack/notify.ts";
import { serverOf, allowedUrl, blocksText } from "../ext/slack/server.ts";
import { answered, markAnswered } from "../ext/slack/answered.ts";
import { runSocket, socketUrl } from "../ext/slack/socket.ts";
import { uploadFile, type Call } from "../ext/slack/channel.ts";

const SIDECAR = "http://127.0.0.1:7878/slack/api";
const TAYET = serverOf({ server: "tayet", api: SIDECAR }, {});
const CARD_TS = "1793000000.000100";

const PROCESS = {
  version: 1, name: "support",
  fields: { s1: { type: "string" }, s2: { type: "string" }, s3: { type: "string" }, s4: { type: "string" }, final: { type: "string" } },
  people: {
    ana: { user: userInfo().username, roles: ["gestor"], slack: "U0ANA" },
    gil: { user: "govern-test-gil", roles: ["gestor"], slack: "U0GIL" },
  },
  stages: [{ name: "review", next: [{ to: ["pick"] }] }, { name: "pick", next: [{ to: ["send"] }] }, { name: "send", next: [] }],
  gates: [
    // Two people must approve: one click leaves it waiting, and the card that click closed must come back.
    { name: "go", stage: "review", policy: { role: "gestor", quorum: 2, rejectTo: "review" } },
    // Four options and Send back: five buttons, more than a Tayet card takes.
    { name: "choose", stage: "pick", policy: { role: "gestor", quorum: 1, rejectTo: "pick" },
      options: ["s1", "s2", "s3", "s4"].map((f, i) => ({ label: `Option ${i + 1}`, set: { final: `{data.${f}}` } })) },
  ],
};

/** A workspace on a Tayet sidecar with lane t1, process.env pointed at it while `f` runs. */
async function scenario(f: (e: Env) => Promise<void>, slack: Record<string, unknown> = {}): Promise<void> {
  const e = makeEnv("slack-tayet"), before = process.env;
  setConfig(e, { slack: { team: "T0TEAM", channel: "C0SUP", server: "tayet", transport: "socket", api: SIDECAR, ...slack } });
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(PROCESS));
  process.env = childEnv(e);
  try {
    create("t1", { process: "support", title: "Ticket one" });
    await f(e);
  } finally { process.env = before; }
}

/** A click as the sidecar sends it: its card, the person, the button govern made, a loopback response URL. */
function click(value: string, o: { user?: string; label?: string; ts?: string; at?: string; responseUrl?: string } = {}) {
  return {
    type: "block_actions", token: "", api_app_id: "B0AGENT", team: { id: "T0TEAM", domain: "" }, enterprise: null, is_enterprise_install: false,
    user: { id: o.user ?? "U0ANA", username: "Ana", name: "Ana", team_id: "T0TEAM" },
    channel: { id: "C0SUP", name: "support" },
    container: { type: "message", message_ts: o.ts ?? CARD_TS, channel_id: "C0SUP", is_ephemeral: false },
    message: { type: "message", user: "U0AGENT", text: "*Ticket one* (`t1`) · decision *go*\n<@U0ANA> <@U0GIL>", ts: o.ts ?? CARD_TS },
    state: { values: {} }, trigger_id: "0".repeat(32),
    response_url: o.responseUrl ?? "http://127.0.0.1:7878/slack/response/" + "a".repeat(64),
    actions: [{ type: "button", action_id: "govern.decide.approve", block_id: "govern.actions", text: { type: "plain_text", text: o.label ?? "Approve", emoji: true },
      value, action_ts: o.at ?? "1793000001.000000" }],
  };
}

const ledger = (e: Env) => jsonl(join(e.projects, "t1", "govern", "ledger.jsonl"));
const responses = () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const request = (async (url: unknown, init: RequestInit) => { sent.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response("{\"ok\":true}"); }) as typeof fetch;
  return { sent, request };
};

test("the server profile: Tayet takes three buttons, closes a card on its first click and talks over Socket Mode", () => {
  assert.deepEqual(TAYET, { kind: "tayet", api: SIDECAR, maxButtons: 3, singleAnswer: true, socketOnly: true });
  assert.equal(serverOf(undefined, {}).api, "https://slack.com/api");
  assert.equal(serverOf({ server: "tayet", api: SIDECAR }, { GOVERN_SLACK_API: "http://127.0.0.1:9/x" }).api, "http://127.0.0.1:9/x", "the environment wins");
  // A URL Slack hands out is Slack's own host over https, or on the configured non-Slack API's own origin; nothing else.
  assert.ok(allowedUrl(new URL("https://hooks.slack.com/a"), "hooks.slack.com", "https://slack.com/api"));
  assert.ok(allowedUrl(new URL("http://127.0.0.1:7878/slack/response/x"), "hooks.slack.com", SIDECAR));
  for (const [u, api] of [["http://127.0.0.1:7878/slack/response/x", "https://slack.com/api"], ["http://127.0.0.1:7879/x", SIDECAR],
    ["http://localhost:7878/x", SIDECAR], ["http://user@127.0.0.1:7878/x", SIDECAR], ["https://hooks.slack.com:8443/a", "https://slack.com/api"]] as const)
    assert.equal(allowedUrl(new URL(u), "hooks.slack.com", api), false, u);
  assert.equal(blocksText([{ type: "section", text: { type: "mrkdwn", text: "a" } }, { type: "actions", elements: [] },
    { type: "context", elements: [{ type: "mrkdwn", text: "b" }] }]), "a\n\nb");
});

test("the config refuses Tayet with Slack forms or without Socket Mode, and an API that is not an http(s) URL", () => {
  for (const [slack, why] of [
    [{ server: "tayet", transport: "socket", forms: true }, /slack\.forms: must be off/],
    [{ server: "tayet" }, /slack\.transport: must be "socket"/],
    [{ server: "tayet", transport: "http" }, /slack\.transport: must be "socket"/],
    [{ api: "ftp://127.0.0.1/x" }, /slack\.api: must be an http/],
    [{ server: "mattermost" }, /slack\.server/],
  ] as const) {
    const e = makeEnv("slack-tayet-config");
    setConfig(e, { slack: { team: "T0TEAM", ...slack } });
    const r = govern(e, ["slack", "serve"], { SLACK_SIGNING_SECRET: "signing-secret-with-32-characters", SLACK_APP_TOKEN: "local" });
    assert.notEqual(r.code, 0); assert.match(r.err, why);
  }
});

test("a Socket Mode click is recorded with its envelope as the source; the card's edit keeps its request and drops the buttons", async () => scenario(async (e) => {
  const { sent, request } = responses();
  const value = decisionValue(load("t1"), { gate: "go" }, "approve");
  const r = await handleSocketInteraction(click(value), "E1", { server: TAYET, request });
  assert.equal(r.status, 200, JSON.stringify(r.value));
  const vote = ledger(e).find((x) => x.kind === "approve" && x.gate === "go");
  assert.equal(vote?.source.kind, "slack-socket"); assert.equal(vote?.source.envelope, "E1"); assert.equal(vote?.source.user, "U0ANA");
  assert.equal(JSON.parse(vote?.source.payload).container.message_ts, CARD_TS);
  assert.equal(sent.length, 1); assert.equal(sent[0]!.url, "http://127.0.0.1:7878/slack/response/" + "a".repeat(64));
  assert.equal(sent[0]!.body.replace_original, true);
  const blocks = sent[0]!.body.blocks as { type: string }[];
  assert.ok(!blocks.some((b) => b.type === "actions"), "an edit of a Tayet card carries no buttons, even short of the quorum");
  assert.match(String(sent[0]!.body.text), /Ticket one.*decision \*go\*/s); assert.match(String(sent[0]!.body.text), /1\/2 approvals: <@U0ANA>/);
  assert.ok(answered().has(`C0SUP:${CARD_TS}`), "the closed card is marked for notify");
  // The sidecar sends a click again when its ack was late or govern was down: the same click is never counted twice.
  const again = await handleSocketInteraction(click(value), "E2", { server: TAYET, request });
  assert.equal(again.status, 401); assert.match(String(again.value.error), /already received/);
  assert.equal(ledger(e).filter((x) => x.kind === "approve").length, 1);
}));

test("a refused click on a Tayet card replaces the closed card with the reason; nothing is recorded", async () => scenario(async (e) => {
  const { sent, request } = responses();
  const r = await handleSocketInteraction(click(decisionValue(load("t1"), { gate: "go" }, "approve"), { user: "U0STRANGER" }), "E1", { server: TAYET, request });
  assert.equal(r.status, 403);
  assert.equal(sent[0]!.body.replace_original, true, "Tayet has no ephemeral messages");
  assert.match(String(sent[0]!.body.text), /Refused: Slack user U0STRANGER is no person/);
  assert.ok(answered().has(`C0SUP:${CARD_TS}`));
  assert.equal(ledger(e).filter((x) => x.kind === "approve").length, 0);
}));

test("on Slack a loopback response URL is still refused, and an unsigned click never arrives over HTTP", async () => scenario(async (e) => {
  const { sent, request } = responses();
  const r = await handleSocketInteraction(click(decisionValue(load("t1"), { gate: "go" }, "approve")), "E1", { server: serverOf(undefined, {}), request });
  assert.equal(r.status, 400); assert.match(String(r.value.error), /response_url/);
  assert.equal(sent.length, 0); assert.equal(ledger(e).filter((x) => x.kind === "approve").length, 0);
}));

interface Call_ { method: string; body: Record<string, unknown> }
/** A fake Web API (the sidecar's Slack layer) on loopback: answers ok with a new ts per post. */
async function fakeApi(f: (api: string, calls: Call_[]) => Promise<void>): Promise<void> {
  const calls: Call_[] = [];
  let ts = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/slack\/api\//, ""), parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push({ method, body: parsed });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: parsed.channel, ts: method === "chat.update" ? parsed.ts : `1793000000.${String(++ts).padStart(6, "0")}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  try { await f(`http://127.0.0.1:${addr.port}/slack/api`, calls); } finally {
    server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
  }
}
const actionsOf = (body: Record<string, unknown>) => ((body.blocks as { type: string; elements?: unknown[] }[]).find((b) => b.type === "actions")?.elements ?? []);

test("notify on Tayet: the card's text is the whole message, and a card a click closed comes back while the gate still waits", async () => scenario(async () => {
  await fakeApi(async (api, calls) => {
    const server = serverOf({ server: "tayet", api }, {});
    const first = await notify({ api, server, token: "local", channel: "C0SUP" });
    assert.deepEqual(first.posted, ["t1:gate:go"]);
    const post = calls.find((c) => c.method === "chat.postMessage")!;
    assert.match(String(post.body.text), /\*Ticket one\* \(`t1`\) · decision \*go\*/, "Tayet reads text as the card's request");
    assert.match(String(post.body.text), /<@U0ANA> <@U0GIL>/);
    assert.equal(actionsOf(post.body).length, 2);
    const ts = "1793000000.000001";
    // Ana approves on the card; the sidecar closes it; the gate needs Gil too.
    const { request } = responses();
    const r = await handleSocketInteraction(click(decisionValue(load("t1"), { gate: "go" }, "approve"), { ts, responseUrl: `${new URL(api).origin}/slack/response/x` }), "E1", { server, request });
    assert.equal(r.status, 200, JSON.stringify(r.value));
    calls.length = 0;
    const second = await notify({ api, server, token: "local", channel: "C0SUP" });
    assert.deepEqual(second.superseded, ["t1:gate:go"]); assert.deepEqual(second.posted, ["t1:gate:go"]);
    assert.deepEqual(calls.map((c) => c.method), ["chat.update", "chat.postMessage"]);
    assert.equal(calls[0]!.body.ts, ts); assert.match(String(calls[0]!.body.text), /still waiting: see the newer message/);
    assert.equal(answered().size, 0, "the mark is claimed once the card is replaced");
    calls.length = 0;
    const third = await notify({ api, server, token: "local", channel: "C0SUP" });
    assert.deepEqual([third.posted, third.superseded, calls.length], [[], [], 0], "nothing changed: nothing is sent");
  });
}));

test("notify on Tayet: five choices go out as two cards of at most three buttons, and both close when the gate is decided", async () => scenario(async (e) => {
  // Lane t2 starts at the pick stage: its gate has four options and Send back.
  write(join(e.root, "PALS-Notes/processes/choices.json"), JSON.stringify({ ...PROCESS, name: "choices", stages: PROCESS.stages.slice(1), gates: PROCESS.gates.slice(1) }));
  create("t2", { process: "choices", title: "Ticket two" });
  assert.equal(govern(e, ["data", "t2", "--set", JSON.stringify({ s1: "A", s2: "B", s3: "C", s4: "D" })]).code, 0);
  await fakeApi(async (api, calls) => {
    const server = serverOf({ server: "tayet", api }, {});
    const r = await notify({ api, server, token: "local", channel: "C0SUP", lanes: ["t2"] });
    assert.deepEqual(r.failed, []);
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    assert.deepEqual(posts.map((c) => actionsOf(c.body).length), [3, 2]);
    assert.match(String(posts[1]!.body.text), /more choices \(2 of 2\)/);
    // Gil picks option 4, on the second card.
    const { request } = responses();
    const v = decisionValue(load("t2"), { gate: "choose" }, "approve", { final: "D" });
    const c = await handleSocketInteraction({ ...click(v, { user: "U0GIL", label: "Option 4", ts: "1793000000.000002", responseUrl: `${new URL(api).origin}/slack/response/y` }) }, "E9", { server, request });
    assert.equal(c.status, 200, JSON.stringify(c.value));
    assert.equal(load("t2").data?.["final"], "D");
    calls.length = 0;
    const done = await notify({ api, server, token: "local", channel: "C0SUP", lanes: ["t2"] });
    assert.deepEqual(done.closed, ["t2:gate:choose"]);
    assert.deepEqual(calls.filter((x) => x.method === "chat.update").map((x) => x.body.ts).sort(), ["1793000000.000001", "1793000000.000002"]);
    assert.equal(answered().size, 0);
  });
}));

// ---------------------------------------------------------------- Socket Mode on the wire

/** A minimal WebSocket server (RFC 6455 text frames) standing in for the sidecar's /slack/socket. */
function wsServer(onConnect: (send: (o: unknown) => void, received: unknown[], close: () => void) => void) {
  const sockets: Duplex[] = [];
  const server = createServer((req, res) => {
    // apps.connections.open, as the sidecar answers it.
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const addr = server.address() as { port: number };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url === "/slack/api/apps.connections.open" && req.headers.authorization === "Bearer local"
        ? JSON.stringify({ ok: true, url: `ws://127.0.0.1:${addr.port}/slack/socket?ticket=${"t".repeat(43)}` })
        : JSON.stringify({ ok: false, error: "invalid_auth" }));
    });
  });
  server.on("upgrade", (req, socket: Duplex) => {
    sockets.push(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const received: unknown[] = [];
    let buf = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        const op = buf[0]! & 0x0f; let len = buf[1]! & 0x7f, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]!);
        buf = buf.subarray(off + 4 + len);
        if (op === 1) received.push(JSON.parse(Buffer.from(data).toString("utf8")));
      }
    });
    const send = (o: unknown) => {
      const p = Buffer.from(JSON.stringify(o));
      const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 0xff]);
      socket.write(Buffer.concat([head, p]));
    };
    onConnect(send, received, () => { socket.write(Buffer.from([0x88, 0])); socket.end(); });
  });
  return { server, sockets };
}

test("runSocket opens the connection, decides an interactive envelope, acks every envelope and reconnects when asked", async () => {
  const handled: { payload: unknown; envelope: string }[] = [];
  let connections = 0;
  const acks: unknown[][] = [];
  const { server, sockets } = wsServer((send, received, close) => {
    connections++;
    acks.push(received);
    send({ type: "hello", num_connections: 1 });
    if (connections === 1) {
      send({ envelope_id: "ev-1", type: "events_api", payload: { event: { type: "message" } }, accepts_response_payload: false });
      send({ envelope_id: "in-1", type: "interactive", payload: { type: "block_actions", n: 1 }, accepts_response_payload: true });
      setTimeout(() => send({ type: "disconnect", reason: "refresh_requested" }), 100);
    } else setTimeout(close, 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/slack/api`, stop = new AbortController();
  try {
    const run = runSocket({ api, token: "local", signal: stop.signal, sleep: async () => { if (connections >= 2) stop.abort(); },
      handle: async (payload, envelope) => { handled.push({ payload, envelope }); return { reply: { response_action: "clear" } }; } });
    await run;
    assert.deepEqual(handled, [{ payload: { type: "block_actions", n: 1 }, envelope: "in-1" }], "only interactive envelopes are decided");
    assert.deepEqual(acks[0], [{ envelope_id: "ev-1" }, { envelope_id: "in-1", payload: { response_action: "clear" } }]);
    assert.ok(connections >= 2, "a disconnect frame makes the client open a new connection");
  } finally { for (const s of sockets) s.destroy(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test("runSocket stops on a token the server will never accept, and refuses a connection URL off the API's address", async () => {
  const { server } = wsServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/slack/api`;
  try {
    await assert.rejects(runSocket({ api, token: "wrong", handle: async () => ({}) }), /invalid_auth/);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  assert.equal(socketUrl("wss://wss-primary.slack.com/link/?ticket=x", "https://slack.com/api"), "wss://wss-primary.slack.com/link/?ticket=x");
  assert.equal(socketUrl("ws://127.0.0.1:7878/slack/socket?ticket=x", SIDECAR), "ws://127.0.0.1:7878/slack/socket?ticket=x");
  for (const [u, a] of [["ws://127.0.0.1:7878/slack/socket", "https://slack.com/api"], ["ws://evil.test/slack/socket", SIDECAR], ["wss://slack.com.evil.test/x", "https://slack.com/api"], [42, SIDECAR]] as const)
    assert.throws(() => socketUrl(u, a), /connection URL/);
});

test("an upload to a Tayet sidecar goes to its own address as one multipart file field, with the bot token, and is shared under a new id", async () => {
  const d = tempDir("slack-tayet-upload"), root = join(d, "media"), file = write(join(root, "clip.mp4"), "video bytes");
  const call: Call = async (method) => {
    if (method === "conversations.replies") return { messages: [{ ts: "2.000002", thread_ts: "1.000001" }] };
    if (method === "files.getUploadURLExternal") return { upload_url: "http://127.0.0.1:7878/slack/upload/" + "b".repeat(43), file_id: "FABCDEFGHIJ" };
    // The sidecar shares the file under a new id.
    return { files: [{ id: "FSHARED0001" }] };
  };
  const puts: { url: string; init: RequestInit }[] = [];
  const request = (async (url: unknown, init: RequestInit) => { puts.push({ url: String(url), init }); return new Response("OK"); }) as typeof fetch;
  const receipt = await uploadFile(call, d, "C0SUP", { roots: [root], maxBytes: 100 }, { file, thread: "2.000002", api: SIDECAR, token: "xoxb-local" }, request);
  assert.equal(receipt.ts, "FSHARED0001", "the id the file was shared under");
  const type = (puts[0]!.init.headers as Record<string, string>)["Content-Type"]!, boundary = /boundary=(.+)$/.exec(type)?.[1];
  // The sidecar's upload URL asks for the bot token, as its Web API does.
  assert.equal((puts[0]!.init.headers as Record<string, string>).Authorization, "Bearer xoxb-local");
  assert.ok(boundary, type);
  const body = Buffer.from(puts[0]!.init.body as Uint8Array).toString("utf8");
  assert.match(body, new RegExp(`^--${boundary}\\r\\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\\r\\n`));
  assert.ok(body.includes("\r\n\r\nvideo bytes\r\n--" + boundary + "--\r\n"));
  // Without the sidecar's API configured, the same URL is refused before any byte leaves.
  await assert.rejects(uploadFile(call, d, "C0SUP", { roots: [root], maxBytes: 100 }, { file, thread: "2.000002" }, request), /invalid upload URL/);
  assert.equal(puts.length, 1);
});

test("a marked card no record claims is forgotten after a day", async () => scenario(async () => {
  markAnswered("C0SUP", "1.000001", Date.now() - 25 * 3600 * 1000);
  markAnswered("C0SUP", "1.000002");
  await fakeApi(async (api) => { await notify({ api, server: serverOf({ server: "tayet", api }, {}), token: "local", channel: "C0SUP" }); });
  assert.deepEqual([...answered()], ["C0SUP:1.000002"]);
}));
