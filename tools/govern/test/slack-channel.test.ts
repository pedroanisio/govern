// Channel contracts, including the Python poller's on-disk compatibility, against deterministic calls and local HTTP.
import { test } from "node:test";
import { slackBody } from "./slack-api.ts";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { slackConfig } from "../lib/workspace.ts";
import { commands } from "../ext/slack/index.ts";
import { parseArgs } from "../lib/util.ts";
import { create } from "../lib/project.ts";
import { commandText } from "../ext/slack/commands.ts";
import { makeEnv, tempDir, write, jsonl, setConfig, govern, childEnv, GOVERN } from "./helpers.ts";
import { poll, parsePost, parseCommand, slackCall, postMessage, SlackError, type Call } from "../ext/slack/channel.ts";

const cfg = { channel: "C1", bot: ["UBOT", "BBOT"], requesters: { U1: "operator", U2: "partner" }, tags: ["brief", "request", "stats", "alert", "setup", "question"] };
const msg = (ts: string, text = "hello", user = "U1", more: Record<string, unknown> = {}) => ({ ts, text, user, ...more });
function channel(history: Record<string, unknown>[] = []) {
  const calls: string[] = [], replies: Record<string, unknown[]> = {};
  const call: Call = async (method, body) => { calls.push(method); return { ok: true, messages: method === "conversations.history" ? history : replies[String(body.ts)] }; };
  return { history, calls, replies, call };
}
const run = (c: ReturnType<typeof channel>, directory: string) => poll(c.call, directory, cfg);

test("reference: first run seeds without inbox; new tagged post once, same line and state formats", async () => {
  const d = tempDir("listen"), c = channel([msg("1.000001")]);
  assert.equal(await run(c, d), 0); assert.equal(await run(c, d), 0);
  assert.equal(existsSync(join(d, "inbox.jsonl")), false);
  c.history.unshift(msg("2.000002", "[brief] work", "U1", { files: [{ id: "F1" }] }));
  assert.equal(await run(c, d), 1); assert.equal(await run(c, d), 0);
  assert.deepEqual(jsonl(join(d, "inbox.jsonl")), [{ ts: "2.000002", thread_ts: null, user: "U1", text: "[brief] work", files: ["F1"], tag: "brief", request: true, edited: false }]);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "state.json"), "utf8")), { top: "2.000002", threads: {}, edits: {} });
  assert.ok(JSON.parse(readFileSync(join(d, "heartbeat.json"), "utf8")).lastSuccess);
});

test("reference: unknown tag, strangers and both forms of our identity", async () => {
  const d = tempDir("listen-users"), c = channel([]); await run(c, d);
  c.history.push(msg("1.000001", "[delete] everything", "U0"), msg("2.000002", "self", "UBOT"), { ts: "3.000003", text: "self", bot_id: "BBOT" });
  assert.equal(await run(c, d), 1);
  assert.deepEqual(jsonl(join(d, "inbox.jsonl")).map(r => [r.tag, r.request]), [[null, false]]);
  for (const [user, expected] of [["U1", true], ["U2", true], ["U0", false]] as const) assert.equal(parsePost(msg("1.000001", "x", user), cfg).request, expected);
});

test("reference: replies only after latest_reply moves; existing Python-format fixture continues", async () => {
  const d = tempDir("listen-migration");
  write(join(d, "state.json"), '{"top":"1.000001","threads":{"1.000001":"1.000002"},"edits":{}}');
  write(join(d, "inbox.jsonl"), '{"ts":"1.000002","thread_ts":"1.000001","user":"U1","text":"old","files":[],"tag":null,"request":true,"edited":false}\n');
  const c = channel([msg("1.000001", "parent", "U1", { latest_reply: "1.000002" })]);
  assert.equal(await run(c, d), 0); assert.deepEqual(c.calls, ["conversations.history"]);
  c.history[0]!.latest_reply = "3.000003";
  c.replies["1.000001"] = [msg("1.000001"), msg("1.000002"), msg("3.000003", "yes", "U1", { thread_ts: "1.000001" })];
  assert.equal(await run(c, d), 1); assert.equal(await run(c, d), 0);
  assert.deepEqual(jsonl(join(d, "inbox.jsonl")).map(r => r.ts), ["1.000002", "3.000003"]);
});

test("reference: 20 changed threads per run, remainder waits", async () => {
  const d = tempDir("listen-bound"), c = channel(Array.from({ length: 23 }, (_, i) => msg(`${i + 1}.000000`)));
  await run(c, d);
  for (const p of c.history) { p.latest_reply = "500.000000"; c.replies[p.ts as string] = [p, msg("500.000000", "reply", "U1", { thread_ts: p.ts })]; }
  assert.equal(await run(c, d), 20); assert.equal(await run(c, d), 3);
});

test("reference: edits once, malformed reply recorded without stopping, private files", async () => {
  const d = tempDir("listen-edit"), c = channel([msg("1.000001", "old", "U1", { latest_reply: "1.000001" })]);
  await run(c, d); chmodSync(join(d, "state.json"), 0o644);
  c.history[0] = msg("1.000001", "changed", "U1", { latest_reply: "3.000003", edited: { ts: "2.000000" } });
  c.replies["1.000001"] = [msg("1.000001"), { ts: "3.000003", text: "no author" }, msg("4.000004", "fine")];
  assert.equal(await run(c, d), 3); assert.equal(await run(c, d), 0);
  const rows = jsonl(join(d, "inbox.jsonl")); assert.match(rows[0].unreadable, /no author/); assert.equal(rows[1].edited, true); assert.equal(rows[2].text, "fine");
  assert.equal(statSync(d).mode & 0o777, 0o700);
  for (const f of ["state.json", "inbox.jsonl", "heartbeat.json"]) assert.equal(statSync(join(d, f)).mode & 0o777, 0o600);
});

for (const bad of ["not an object", msg("yesterday"), msg("1.000001\n"), msg("1.000001", "x", "U1", { text: null }), msg("1.000001", "x", "U1", { files: null }), { ts: "1.000001", text: "no author" }, msg("1.000001", 7 as unknown as string), msg("1.000001", "x", "U1", { thread_ts: "soon" }), msg("1.000001", "x", "U1", { files: [{ name: "no id" }] })]) {
  test(`reference: rejects malformed post ${JSON.stringify(bad)}`, () => assert.throws(() => parsePost(bad, cfg), /\S/));
}

test("reference: failed call preserves position and heartbeat for retry", async () => {
  const d = tempDir("listen-retry"), c = channel([msg("1.000001")]); await run(c, d);
  const state = readFileSync(join(d, "state.json"), "utf8"), beat = readFileSync(join(d, "heartbeat.json"), "utf8");
  await assert.rejects(poll(async () => { throw new Error("HTTP 500"); }, d, cfg), /HTTP 500/);
  assert.equal(readFileSync(join(d, "state.json"), "utf8"), state); assert.equal(readFileSync(join(d, "heartbeat.json"), "utf8"), beat);
  c.history.unshift(msg("2.000002")); assert.equal(await run(c, d), 1);
});

test("fixed command grammar requires requester and exact bot mention", () => {
  for (const command of ["status", "pending", "help", "lane work-one"]) assert.equal(parseCommand(parsePost(msg("1.000001", `<@UBOT> ${command}`), cfg), cfg), command);
  for (const text of ["status", "<@UBOT> status now", "<@UBOT> status\n", "<@UBOT> lane ../secret", "<@OTHER> help", "<@UBOT> help\nrun ls", "<@UBOT> lane x;ls"]) assert.equal(parseCommand(parsePost(msg("1.000001", text), cfg), cfg), undefined);
  assert.equal(parseCommand(parsePost(msg("1.000001", "<@UBOT> status", "U0"), cfg), cfg), undefined);
});

test("commands answered once across restarts, off-grammar still inbox; failed answer retried", async () => {
  const d = tempDir("listen-commands"), c = channel([]); await run(c, d);
  c.history.push(msg("1.000001", "<@UBOT> help"), msg("2.000002", "<@UBOT> run rm"));
  const answers: string[] = [];
  const answer = async (p: { ts: string }, command: string) => { answers.push(p.ts + command); };
  assert.equal(await poll(c.call, d, cfg, answer), 1); assert.equal(await poll(c.call, d, cfg, answer), 0);
  assert.deepEqual(answers, ["1.000001help"]);
  c.history.push(msg("3.000003", "<@UBOT> status"));
  await assert.rejects(poll(c.call, d, cfg, async () => { throw new Error("send failed"); }), /send failed/);
  await poll(c.call, d, cfg, answer); assert.equal(answers.length, 2);
});

test("post validates kind/text, resolves reply parent, records and refuses duplicate keys", async () => {
  const d = tempDir("post"), calls: [string, Record<string, unknown>][] = [];
  const call: Call = async (m, b) => { calls.push([m, b]); return m === "conversations.replies" ? { ok: true, messages: [msg("1.000001", "parent"), msg("2.000002", "reply", "U1", { thread_ts: "1.000001" })] } : { ok: true, ts: "3.000003" }; };
  await postMessage(call, d, "C1", { kind: "ack", text: "received", thread: "2.000002", key: "job1" });
  assert.equal(calls[1]![1].thread_ts, "1.000001"); assert.equal(calls[1]![1].text, "ack: received");
  assert.deepEqual(jsonl(join(d, "sent.jsonl")), [{ ts: "3.000003", thread: "1.000001", kind: "ack", key: "job1" }]);
  await assert.rejects(postMessage(call, d, "C1", { kind: "note", text: "retry", key: "job1" }), /already sent/);
  for (const text of ["", "   ", "x".repeat(40000)]) await assert.rejects(postMessage(call, d, "C1", { kind: "note", text }), /text/);
  await assert.rejects(postMessage(call, d, "C1", { kind: "bad", text: "x" }), /kind/);
  assert.equal(calls.length, 2); assert.equal(statSync(join(d, "sent.jsonl")).mode & 0o777, 0o600);
});

test("API failures never expose token, including reflected malicious response/errors; bounded 429 retries", async () => {
  const token = "test-secret", delays: number[] = []; let n = 0;
  const call = slackCall("http://local/api", token, async () => { n++; return n < 3 ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : Response.json({ ok: true }); }, async ms => { delays.push(ms); });
  await call("chat.postMessage", {}); assert.deepEqual(delays, [2000, 2000]);
  for (const response of [Response.json({ ok: false, error: token }), Response.json([]), new Response("not JSON"), new Response("", { status: 500 }), new Response("", { status: 429, headers: { "Retry-After": "99999999" } })]) {
    await assert.rejects(slackCall("http://local", token, async () => response.clone(), async () => {})("conversations.history", {}), e => e instanceof Error && !e.message.includes(token) && e.message.includes("conversations.history"));
  }
  for (const e of [new Error(token), new TypeError(token), new DOMException(token, "TimeoutError")]) await assert.rejects(slackCall("http://local", token, async () => { throw e; })("conversations.history", {}), e => e instanceof Error && !e.message.includes(token));
});

test("Config accepts typed new fields, rejects nested unknowns and invalid bounds", () => {
  for (const slack of [{ ...cfg, team: "T1", inbox: "generated/slack", botTokenVar: "BOT_TOKEN", route: { to: "claude", profile: "reader", maxPerHour: 6 }, alerts: { listenStaleSec: 300, unansweredSec: 600 }, upload: { roots: ["generated"], maxBytes: 100000000 } }, { ...cfg, team: "T1", route: { to: "claude", profile: "reader", maxPerHour: 0 } }, { ...cfg, team: "T1", upload: { roots: [], maxBytes: 1, extra: true } }, { ...cfg, team: "T1", oops: true }]) {
    const e = makeEnv("slack-config"); setConfig(e, { slack });
    const back = process.env.GOVERN_REPO; process.env.GOVERN_REPO = e.root;
    try {
      if ("oops" in slack || ("route" in slack && slack.route?.maxPerHour === 0) || ("upload" in slack && "extra" in (slack.upload ?? {}))) assert.throws(() => slackConfig(), /slack/);
      else { const parsed = slackConfig()!; assert.equal(parsed.botTokenVar, "BOT_TOKEN"); assert.equal(parsed.inbox, join(e.root, "generated/slack")); }
    } finally { if (back === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = back; }
  }

});

async function cli(e: ReturnType<typeof makeEnv>, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [GOVERN, ...args], { env: childEnv(e, env) }); let out = "", err = "";
    p.stdout.on("data", b => { out += b; }); p.stderr.on("data", b => { err += b; }); p.on("error", reject); p.on("exit", code => resolve({ code, out, err }));
  });
}

test("CLI local API: custom dotenv token, listen reports lines and failures, post file, command help", async () => {
  const e = makeEnv("slack-channel-cli"), bodies: Record<string, unknown>[] = []; let history: unknown[] = [], refused = false;
  setConfig(e, { slack: { team: "T1", ...cfg, envFile: "slack.env", botTokenVar: "BOT_TOKEN", inbox: "generated/slack" } });
  write(join(e.root, "slack.env"), 'BOT_TOKEN="test-secret"\n');
  const server = createServer((req, res) => { let body = ""; req.on("data", b => { body += b; }); req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer test-secret"); const b = slackBody(req.url!.split("/").at(-1)!, String(req.headers["content-type"]), body);
    if (!b) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: false, error: "invalid_arguments" })); return; }
    bodies.push(b);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(refused ? { ok: false, error: "test-secret" } : req.url?.endsWith("history") ? { ok: true, messages: history } : req.url?.endsWith("replies") ? { ok: true, messages: [msg(String(b.ts))] } : { ok: true, ts: "9.000009" }));
  }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const address = server.address(); assert.ok(address && typeof address === "object");
  const env = { GOVERN_SLACK_API: `http://127.0.0.1:${address.port}/api`, BOT_TOKEN: "" };
  try {
    assert.equal((await cli(e, ["slack", "listen", "--once"], env)).code, 0);
    history = [msg("1.000001", "new"), msg("2.000002", "<@UBOT> help")];
    const r = await cli(e, ["slack", "listen", "--once"], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /1 new/);
    assert.ok(bodies.some(b => String(b.text).includes("pending"))); assert.ok(bodies.some(b => b.thread_ts === "2.000002"));
    const file = write(join(e.root, "message.txt"), "done");
    assert.equal((await cli(e, ["slack", "post", "--kind", "delivered", "--file", file, "--key", "done", "--thread", "1.000001"], env)).code, 0);
    refused = true; const failed = await cli(e, ["slack", "listen", "--once"], env); assert.equal(failed.code, 1); assert.doesNotMatch(failed.err, /test-secret/);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});


test("command views share workspace status, pending decisions and lane brief, truncate and fail closed", () => {
  const e = makeEnv("slack-command-views"), back = process.env;
  process.env = childEnv(e);
  try {
    assert.match(commandText("status"), /nothing under govern/);
    assert.equal(commandText("pending"), "Nothing pending.");
    write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify({ version: 1, name: "support", people: { operator: { user: "operator" } }, stages: [{ name: "draft", human: { assignee: "operator" }, next: [] }], gates: [] }));
    create("work-one", { process: "support", title: "Channel work" });
    assert.match(commandText("status"), /work-one/); assert.match(commandText("pending"), /work-one: task draft/);
    assert.match(commandText("lane work-one"), /Channel work/); assert.match(commandText("lane missing"), /could not be read/);
    assert.match(commandText("arbitrary"), /Unknown command/);
    assert.ok(commandText("help").length < 40000);
  } finally { process.env = back; }
});


test("CLI handlers refuse missing config and credentials and contradictory options", async () => {
  const back = process.env;
  try {
    for (const [slack, pattern] of [[undefined, /slack configuration/], [{ team: "T1" }, /slack.channel/], [{ team: "T1", channel: "C1" }, /slack.inbox/], [{ team: "T1", channel: "C1", inbox: "generated/slack", botTokenVar: "BOT_TOKEN" }, /BOT_TOKEN/]] as const) {
      const e = makeEnv("slack-handler"); if (slack) setConfig(e, { slack });
      process.env = { ...childEnv(e), BOT_TOKEN: "", SLACK_BOT_TOKEN: "" };
      const listen = commands[0]!.subs!.listen!;
      await assert.rejects(async () => listen.run!(parseArgs([], listen.flags!, "slack listen")), pattern);
    }
    const listen = commands[0]!.subs!.listen!, post = commands[0]!.subs!.post!;
    for (const args of [["--once", "--loop"], ["--interval", "1"], ["--loop", "--interval", "0"]]) await assert.rejects(async () => listen.run!(parseArgs(args, listen.flags!, "slack listen")), /--/);
    await assert.rejects(async () => post.run!(parseArgs([], post.flags!, "slack post")), /--kind/);
    await assert.rejects(async () => post.run!(parseArgs(["--kind", "note", "--text", "x", "--file", "x"], post.flags!, "slack post")), /exactly one/);
    const e = makeEnv("slack-alerts-flag"); setConfig(e, { slack: { team: "T1", channel: "C1", inbox: "generated/slack" } });
    process.env = { ...childEnv(e), SLACK_BOT_TOKEN: "xoxb-test" };
    await assert.rejects(async () => post.run!(parseArgs(["--kind", "note", "--text", "x", "--alerts", "--thread", "1.000001"], post.flags!, "slack post")), /cannot take --thread/);
    await assert.rejects(async () => post.run!(parseArgs(["--kind", "note", "--text", "x", "--alerts"], post.flags!, "slack post")), /slack.alertsChannel/);
  } finally { process.env = back; }
});


test("keyed sends retain ambiguous intent across restart, but proven refusals can retry", async () => {
  const d = tempDir("post-intent"); let calls = 0;
  const unknown: Call = async () => { calls++; throw new SlackError("network failure", true); };
  await assert.rejects(postMessage(unknown, d, "C1", { kind: "note", text: "x", key: "uncertain" }), /network/);
  await assert.rejects(postMessage(unknown, d, "C1", { kind: "note", text: "x", key: "uncertain" }), /uncertain send/);
  assert.equal(calls, 1);
  const refused: Call = async () => { throw new SlackError("ratelimited", false); };
  await assert.rejects(postMessage(refused, d, "C1", { kind: "note", text: "x", key: "retry" }), /ratelimited/);
  await postMessage(async () => ({ ok: true, ts: "1.000001" }), d, "C1", { kind: "note", text: "x", key: "retry" });
  assert.equal(statSync(join(d, "send-intents.json")).mode & 0o777, 0o600);
});


test("CLI handlers use custom dotenv token, record and answer commands, read files, redact failures", async t => {
  const e = makeEnv("slack-injected-cli"), back = process.env;
  setConfig(e, { slack: { ...cfg, team: "T1", inbox: "generated/slack", envFile: "slack.env", botTokenVar: "BOT_TOKEN", alertsChannel: "C0OPS" } });
  write(join(e.root, "slack.env"), 'export BOT_TOKEN="test-secret"\n');
  const bodies: Record<string, unknown>[] = [], output: string[] = [], methods: string[] = []; let history: unknown[] = [], failure = false;
  process.env = { ...childEnv(e), BOT_TOKEN: "", SLACK_BOT_TOKEN: "wrong-variable", GOVERN_SLACK_API: "http://fake/api" };
  t.mock.method(process.stdout, "write", (s: string) => { output.push(s); return true; });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal((options!.headers as Record<string, string>).Authorization, "Bearer test-secret");
    const b = slackBody(String(url).split("/").at(-1)!, new Headers(options!.headers).get("content-type") ?? "", String(options!.body));
    if (!b) return Response.json({ ok: false, error: "invalid_arguments" });
    bodies.push(b); methods.push(String(url));
    if (failure) return Response.json({ ok: false, error: "test-secret" });
    return Response.json(String(url).endsWith("history") ? { ok: true, messages: history } : String(url).endsWith("replies") ? { ok: true, messages: [msg(String(b.ts))] } : { ok: true, ts: "9.000009" });
  });
  try {
    const listen = commands[0]!.subs!.listen!, post = commands[0]!.subs!.post!;
    const once = () => listen.run!(parseArgs(["--once"], listen.flags!, "slack listen"));
    await once(); history = [msg("1.000001", "new"), msg("2.000002", "<@UBOT> help")];
    await once(); await once();
    assert.match(output.join(""), /1 new/);
    assert.equal(bodies.filter(b => String(b.text).includes("pending")).length, 1);
    assert.ok(bodies.some(b => b.thread_ts === "2.000002"));
    assert.equal(methods.filter(m => m.endsWith("replies")).length, 0);
    const file = write(join(e.root, "message.txt"), "done");
    await post.run!(parseArgs(["--kind", "delivered", "--file", file, "--key", "done", "--thread", "1.000001"], post.flags!, "slack post"));
    assert.equal(jsonl(join(e.root, "generated/slack/sent.jsonl")).length, 2);
    await post.run!(parseArgs(["--kind", "blocked", "--text", "escalated", "--alerts"], post.flags!, "slack post"));
    assert.equal(bodies.at(-1)!.channel, "C0OPS");
    assert.equal(jsonl(join(e.root, "generated/slack/sent.jsonl")).length, 3);
    history = [msg("1.000001", "parent", "U1", { latest_reply: "3.000003" })];
    await once();
    assert.equal(methods.filter(m => m.endsWith("replies")).length, 2);
    failure = true;
    await assert.rejects(async () => once(), error => error instanceof Error && !error.message.includes("test-secret") && error.message.includes("conversations.history"));
  } finally { process.env = back; }
});


test("notify and listen share token selection, dotenv fallback and redacted failures", async t => {
  const back = process.env, exitCode = process.exitCode;
  const output: string[] = []; let expected = "", calls = 0;
  t.mock.method(process.stdout, "write", (s: string) => { output.push(s); return true; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${expected}`);
    return Response.json({ ok: false, error: expected });
  });
  try {
    for (const command of ["notify", "listen"]) for (const custom of [false, true]) for (const fromEnv of [false, true]) {
      const e = makeEnv("slack-token-selection"), variable = custom ? "BOT_TOKEN" : "SLACK_BOT_TOKEN";
      setConfig(e, { slack: { ...cfg, team: "T1", inbox: "generated/slack", envFile: "slack.env",
        ...(custom ? { botTokenVar: variable } : {}), alerts: { listenStaleSec: 300, unansweredSec: 600 } } });
      write(join(e.root, "slack.env"), `${variable}=private-dotenv-token\n`);
      process.env = { ...childEnv(e), SLACK_BOT_TOKEN: "wrong-default-token", [variable]: fromEnv ? "private-env-token" : "" };
      expected = fromEnv ? "private-env-token" : "private-dotenv-token";
      const sub = commands[0]!.subs![command]!, before = calls;
      const run = async () => sub.run!(parseArgs([], sub.flags!, `slack ${command}`));
      if (command === "listen") await assert.rejects(run, error => error instanceof Error && !error.message.includes(expected));
      else { await run(); assert.equal(process.exitCode, 1); }
      assert.equal(calls, before + 1);
      assert.ok(!output.join("").includes(expected));
      // A selected custom name must never fall back to SLACK_BOT_TOKEN.
      write(join(e.root, "slack.env"), ""); process.env[variable] = "";
      await assert.rejects(run, new RegExp(`${variable} is not set`));
      assert.equal(calls, before + 1);
    }
  } finally { process.env = back; process.exitCode = exitCode; }
});

test("a rate-limited read is one call per run; failed inbox append never advances position", async () => {
  let reads = 0;
  await assert.rejects(slackCall("http://fake", "secret", async () => { reads++; return new Response("", { status: 429 }); })("conversations.history", {}), /HTTP 429/);
  assert.equal(reads, 1);
  const d = tempDir("listen-append-failure"), c = channel([msg("1.000001")]);
  await run(c, d); const before = readFileSync(join(d, "state.json"), "utf8");
  // A file in place of the inbox's parent path refuses append deterministically, independent of user privileges.
  const { mkdirSync } = await import("node:fs"); mkdirSync(join(d, "inbox.jsonl"));
  c.history.push(msg("2.000002")); await assert.rejects(run(c, d));
  assert.equal(readFileSync(join(d, "state.json"), "utf8"), before);
});


test("history has_more is reported and persisted without a second history call", async t => {
  const d = tempDir("listen-more"), warnings: string[] = []; let calls = 0;
  t.mock.method(process.stderr, "write", (s: string) => { warnings.push(s); return true; });
  await poll(async () => { calls++; return { ok: true, messages: [], has_more: true }; }, d, cfg);
  assert.equal(calls, 1); assert.match(warnings.join(""), /has_more/);
  assert.equal(JSON.parse(readFileSync(join(d, "heartbeat.json"), "utf8")).hasMore, true);
});
