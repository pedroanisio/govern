// slack.cards (ext/slack/cards.ts, notify.ts, slack.ts; SLACK.md): the case's card is the lane's place in Slack. The card
// shows who holds the case and its last note; each new lane note is posted in the card's thread; a mapped person's reply
// in that thread becomes a lane note (POST /slack/events, signed), once, and is not posted back. Against a fake Slack Web
// API and a real events server on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";
import { notify } from "../ext/slack/notify.ts";
import { slackServer } from "../ext/slack/slack.ts";
import { replyOf } from "../ext/slack/cards.ts";
import { load, save } from "../lib/project.ts";
import { humanAction } from "../lib/business.ts";
import { stateDir } from "../lib/workspace.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5", TEAM = "T0TEAM", CHANNEL = "C0SUP";
const PROCESS = {
  version: 1, name: "support",
  people: {
    ana: { user: userInfo().username, roles: ["suporte"], slack: "U0ANA" },
    otto: { user: "govern-test-otto", slack: "U0OTTO" },
  },
  stages: [{ name: "draft", human: { role: "suporte" }, next: [{ to: ["send"] }] }, { name: "send", next: [] }],
  gates: [{ name: "go", stage: "send", owner: "otto" }],
};

function setup(slack: Record<string, unknown> = { cards: true }): Env {
  const e = makeEnv("slack-cards");
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(PROCESS));
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: TEAM, channel: CHANNEL, ...slack } }));
  assert.equal(govern(e, ["new", "t1", "--process", "support", "--title", "Ticket one"]).code, 0);
  return e;
}
async function inWorkspace<T>(e: Env, f: () => Promise<T> | T): Promise<T> {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return await f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
interface Call { method: string; body: Record<string, unknown> }
async function fakeSlack(f: (api: string, calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  let ts = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/api\//, ""), parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push({ method, body: parsed });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: parsed.channel, ts: method === "chat.update" ? parsed.ts : `1793000000.${String(++ts).padStart(6, "0")}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}/api`, calls); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const run = (e: Env, api: string) => inWorkspace(e, () => notify({ api, token: "xoxb-test-token", channel: CHANNEL, cards: true }));
const textOf = (c: Call) => JSON.stringify(c.body.blocks ?? c.body.text);
const notes = (e: Env) => JSON.parse(readFileSync(join(e.projects, "t1", "govern.json"), "utf8")).notes as { text: string; by?: string; via?: string }[];

const NOW = 1793000000;
const cardTsOf = (e: Env) => inWorkspace(e, () => JSON.parse(readFileSync(join(stateDir(), "slack", "posted.json"), "utf8")).cards.t1.ts as string);
const reply = (user: string, thread: string, text: string, ts = "1793000100.000001", extra: Record<string, unknown> = {}) =>
  ({ type: "event_callback", team_id: TEAM, event_id: `Ev${ts}`, event: { type: "message", channel: CHANNEL, user, ts, thread_ts: thread, text, ...extra } });
const signed = (body: string, at = NOW) => ({ "X-Slack-Request-Timestamp": String(at), "X-Slack-Signature": `v0=${createHmac("sha256", SECRET).update(`v0:${at}:${body}`).digest("hex")}` });

/** An events server for the workspace, with a fake bot-token call recording the ephemeral messages. */
async function serving(e: Env, f: (post: (v: unknown, h?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }>, said: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const said: Record<string, unknown>[] = [];
  const server = slackServer(SECRET, { now: () => NOW, call: async (_m, b) => { said.push(b); return { ok: true }; } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const post = async (v: unknown, h?: Record<string, string>) => {
    const body = JSON.stringify(v);
    const r = await fetch(`http://127.0.0.1:${addr.port}/slack/events`, { method: "POST", headers: { "Content-Type": "application/json", ...(h ?? signed(body)) }, body });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  try { await f(post, said); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old;
  }
}

test("with cards, the card shows who holds the case, its last note, and that a thread reply is a note", async () => {
  const e = setup();
  await inWorkspace(e, () => { const p = load("t1"); humanAction(p, "draft", "claim", "ana", "eu pego"); save(p); });
  assert.equal(govern(e, ["note", "t1", "cliente respondeu"]).code, 0);
  await fakeSlack(async (api, calls) => {
    const r = await run(e, api);
    assert.ok(r.posted.includes("t1:card"), JSON.stringify(r));
    const c = textOf(calls[0]!);
    assert.match(c, /Held by <@U0ANA> \(draft\)/);
    assert.match(c, /Last note \[draft\]: cliente respondeu/);
    assert.match(c, /Reply in this thread to add a note to the case/);
    assert.ok(!r.posted.some((k) => k.startsWith("t1:note:")), "a note from before the card is not posted");
  });
});

test("with cards, a new lane note is posted in the card's thread once", async () => {
  const e = setup();
  await fakeSlack(async (api, calls) => {
    await run(e, api);
    const card = calls.find((c) => c.method === "chat.postMessage" && !c.body.thread_ts)!;
    assert.equal(govern(e, ["note", "t1", "decidi responder amanhã"]).code, 0);
    calls.length = 0;
    const r = await run(e, api);
    const posted = calls.filter((c) => c.method === "chat.postMessage" && c.body.text === "note [draft]: decidi responder amanhã");
    assert.equal(posted.length, 1, JSON.stringify(calls));
    assert.ok(posted[0]!.body.thread_ts, "in the card's thread");
    assert.ok(r.posted.includes("t1:note:0"));
    calls.length = 0;
    await run(e, api);
    assert.ok(!calls.some((c) => c.method === "chat.postMessage" && String(c.body.text).startsWith("note ")), "not posted again");
    assert.ok(card);
  });
});

test("a mapped person's reply in the card's thread becomes a lane note once, and is not posted back", async () => {
  const e = setup();
  await fakeSlack(async (api, calls) => {
    await run(e, api);
    const thread = calls.find((c) => c.method === "chat.postMessage" && !c.body.thread_ts)!;
    const cardTs = await cardTsOf(e);
    assert.ok(thread && cardTs);
    await serving(e, async (post) => {
      const ev = reply("U0ANA", cardTs, "liguei para o cliente");
      const r = await post(ev);
      assert.equal(r.status, 200);
      assert.equal(r.body.text, "t1: note by ana");
      assert.equal((await post(ev)).body.text, "ignored: already received", "Slack's retry adds nothing");
    });
    const n = notes(e).at(-1)!;
    assert.deepEqual([n.text, n.by, n.via], ["liguei para o cliente", "ana", "slack"]);
    assert.equal(notes(e).filter((x) => x.text === "liguei para o cliente").length, 1);
    const entry = jsonl(join(e.projects, "t1", "govern", "ledger.jsonl")).findLast((x) => x.kind === "note") as Record<string, unknown>;
    assert.equal(entry.by, "ana");
    assert.equal((entry.source as Record<string, unknown>).kind, "slack-message");
    calls.length = 0;
    await run(e, api);
    assert.ok(!calls.some((c) => c.method === "chat.postMessage" && String(c.body.text).includes("liguei")), "a note from the thread is not posted back");
  });
});

test("a reply from an unmapped person, another team or outside a card's thread adds no note", async () => {
  const e = setup();
  await fakeSlack(async (api) => {
    await run(e, api);
    const cardTs = await cardTsOf(e);
    const before = notes(e).length;
    await serving(e, async (post, said) => {
      const stranger = await post(reply("U0NOBODY", cardTs, "oi", "1793000100.000002"));
      assert.equal(stranger.status, 200);
      assert.equal(stranger.body.ok, false);
      assert.equal(said.length, 1, "the author is told, privately");
      assert.equal(said[0]!.user, "U0NOBODY");
      const other = { ...reply("U0ANA", cardTs, "oi", "1793000100.000003"), team_id: "T0OTHER" };
      assert.equal((await post(other)).body.ok, false);
      assert.equal((await post(reply("U0ANA", "1793000000.999999", "oi", "1793000100.000004"))).body.text, "ignored: not a case card's thread");
      assert.equal((await post(reply("U0ANA", cardTs, "editado", "1793000100.000005", { subtype: "message_changed" }))).body.text, "ignored");
      assert.equal((await post(reply("U0ANA", cardTs, "bot", "1793000100.000006", { bot_id: "B1" }))).body.text, "ignored");
    });
    assert.equal(notes(e).length, before);
  });
});

test("the events endpoint answers Slack's URL check and refuses an unsigned or forged request", async () => {
  const e = setup();
  await serving(e, async (post) => {
    const check = await post({ type: "url_verification", challenge: "abc123" });
    assert.deepEqual([check.status, check.body.challenge], [200, "abc123"]);
    const forged = await post({ type: "url_verification", challenge: "x" }, { "X-Slack-Request-Timestamp": String(NOW), "X-Slack-Signature": `v0=${"0".repeat(64)}` });
    assert.equal(forged.status, 401);
    assert.equal((await post({ type: "url_verification", challenge: "x" }, {})).status, 401);
  });
});

test("without slack.cards a thread reply is ignored", async () => {
  const e = setup({ threads: true });
  await fakeSlack(async (api) => {
    await inWorkspace(e, () => notify({ api, token: "xoxb-test-token", channel: CHANNEL, threads: true }));
    const cardTs = await cardTsOf(e);
    await serving(e, async (post) => {
      assert.equal((await post(reply("U0ANA", cardTs, "oi"))).body.text, "ignored: not a case card's thread");
    });
  });
});

test("replyOf reads only a person's threaded message with text", () => {
  assert.equal(replyOf(reply("U0ANA", "1.0", "  ")), undefined);
  assert.equal(replyOf({ type: "event_callback", team_id: TEAM, event: { type: "message", channel: CHANNEL, user: "U0ANA", ts: "1.0", text: "top" } }), undefined);
  assert.equal(replyOf(reply("U0ANA", "1.0", "x", "1.0")), undefined, "the parent itself");
  assert.equal(replyOf(reply("U0ANA", "1.0", "x", "2.0", { subtype: "thread_broadcast" }))?.text, "x");
});
