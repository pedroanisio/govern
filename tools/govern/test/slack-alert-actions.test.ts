// Alert buttons in Slack (SLACK.md): a timer alert can be acknowledged, snoozed for an hour or taken (its stage's task
// claimed), and a stage govern drive left to the operator can be retried, each by a person of the lane's process, with
// the signed request recorded as the source. The notifier posts the buttons and closes the message when the alert is
// settled anywhere (here or at the terminal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, childEnv, setConfig, write, govern, jsonl, type Env } from "./helpers.ts";
import { create, load, save, ledgerFile } from "../lib/project.ts";
import { stateDir } from "../lib/workspace.ts";
import { handleInteraction } from "../ext/slack/slack.ts";
import { notify } from "../ext/slack/notify.ts";

const SECRET = "signing-secret-with-32-characters", NOW = Math.floor(Date.now() / 1000);
const PROCESS = { version: 1, name: "desk",
  people: { ana: { user: "ana", roles: ["suporte"], slack: "U0ANA" }, gil: { user: "gil", roles: ["gestor"], slack: "U0GIL" } },
  stages: [{ name: "draft", human: { role: "suporte" }, timer: { afterSeconds: 1, reminders: [] }, next: [{ to: ["write"] }] },
    { name: "write", agent: { to: "codex", task: "write", summary: "write it", body: "write it", attempts: 1 }, next: [] }],
  gates: [] };

type Block = { type: string; block_id?: string; elements?: { action_id: string; value: string; text: { text: string } }[] };
interface Call { method: string; body: Record<string, unknown>; ts: string }

async function workspace(f: (e: Env, api: string, calls: Call[]) => Promise<void>): Promise<void> {
  const e = makeEnv("slack-alerts"), before = process.env;
  setConfig(e, { slack: { team: "T1", channel: "C1" } }); process.env = childEnv(e);
  const calls: Call[] = []; let ts = 0;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => { const b = JSON.parse(body), at = b.ts ?? `1793000000.${String(++ts).padStart(6, "0")}`;
      calls.push({ method: (req.url ?? "").replace(/^\/api\//, ""), body: b, ts: at });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: b.channel, ts: at })); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    write(join(e.root, "PALS-Notes/processes/desk.json"), JSON.stringify(PROCESS));
    create("t1", { process: "desk", title: "Ticket one" });
    await f(e, `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, calls);
  } finally { process.env = before; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
}
const run = (api: string) => notify({ api, token: "xoxb-t", channel: "C1" });
const buttons = (c: Call) => ((c.body.blocks as Block[] | undefined) ?? []).filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
/** An open timer alert on t1's draft stage, as govern tick raises it. */
async function dueAlert(e: Env): Promise<string> {
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(govern(e, ["tick", "t1"]).code, 0);
  return load("t1").alerts![0]!.id;
}
async function click(button: { action_id: string; value: string; text: { text: string } }, user: string, message: unknown) {
  const body = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: user },
    response_url: "https://hooks.slack.com/actions/T1/x", message, actions: [button] })));
  const signature = "v0=" + createHmac("sha256", SECRET).update(`v0:${NOW}:`).update(body).digest("hex"), sent: Record<string, unknown>[] = [];
  const request = (async (_: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("ok"); }) as typeof fetch;
  const result = await handleInteraction(SECRET, body, String(NOW), signature, { now: () => NOW, request });
  return { result, update: sent[0] as { blocks: Block[]; text: string; response_type: string } };
}
const alertPost = (calls: Call[]) => calls.find((c) => c.method === "chat.postMessage" && /due|draft/.test(String(c.body.text)) && buttons(c).some((b) => b.action_id.startsWith("govern.alert")))!;
const button = (c: Call, action: string) => buttons(c).find((b) => b.action_id === `govern.alert.${action}` || b.action_id === `govern.drive.${action}`)!;
const outcome = (blocks: Block[]) => JSON.stringify(blocks.filter((b) => b.block_id === "govern.outcome"));

test("a timer alert is posted with Acknowledge, Snooze 1h and Take it", async () => workspace(async (e, api, calls) => {
  await dueAlert(e);
  await run(api);
  const post = alertPost(calls);
  assert.ok(post, "the alert has buttons");
  assert.deepEqual(buttons(post).map((b) => b.action_id), ["govern.alert.ack", "govern.alert.snooze", "govern.alert.take"]);
}));

test("Acknowledge records the person's acknowledgement with the signed source and closes the message", async () => workspace(async (e, api, calls) => {
  const id = await dueAlert(e);
  await run(api);
  const post = alertPost(calls), { result, update } = await click(button(post, "ack"), "U0GIL", post.body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.ok(load("t1").alerts!.find((a) => a.id === id)!.acknowledgedAt);
  const entry = jsonl(ledgerFile("t1")).findLast((x) => x.kind === "alert-ack");
  assert.deepEqual([entry.id, entry.by, entry.source.kind, entry.source.user], [id, "gil", "slack", "U0GIL"]);
  assert.ok(!update.blocks.some((b) => b.type === "actions"));
  assert.match(outcome(update.blocks), /Acknowledged by <@U0GIL>/);
  const again = await click(button(post, "ack"), "U0ANA", post.body);
  assert.equal(again.result.status, 409, "an acknowledged alert is not acknowledged twice");
  const before = calls.length;
  await run(api);
  assert.equal(calls.filter((c, i) => i >= before && c.method === "chat.postMessage").length, 0, "an acknowledged alert is not posted again");
}));

test("Snooze hides the alert for an hour, then the notifier posts it again", async () => workspace(async (e, api, calls) => {
  const id = await dueAlert(e);
  await run(api);
  const post = alertPost(calls), { result, update } = await click(button(post, "snooze"), "U0ANA", post.body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const until = Date.parse(load("t1").alerts!.find((a) => a.id === id)!.snoozedUntil!);
  assert.ok(Math.abs(until - (NOW + 3600) * 1000) < 2000, "snoozed for one hour");
  assert.match(outcome(update.blocks), /Snoozed until .* by <@U0ANA>/);
  assert.ok(!update.blocks.some((b) => b.type === "actions"));
  const before = calls.length;
  await run(api);
  assert.equal(calls.length, before, "nothing while snoozed");
  const p = load("t1"); p.alerts!.find((a) => a.id === id)!.snoozedUntil = new Date(Date.now() - 1000).toISOString(); save(p);
  await run(api);
  const again = calls.slice(before).filter((c) => c.method === "chat.postMessage");
  assert.equal(again.length, 1, "posted again once the snooze ends");
  assert.match(String(again[0]!.body.text), /still open/);
  assert.equal(buttons(again[0]!).length, 3);
  await run(api);
  assert.equal(calls.slice(before).filter((c) => c.method === "chat.postMessage").length, 1, "and only once");
}));

test("Take it claims the alert's stage task for the person; someone not eligible is refused", async () => workspace(async (e, api, calls) => {
  await dueAlert(e);
  await run(api);
  const post = alertPost(calls);
  const refused = await click(button(post, "take"), "U0GIL", post.body);
  assert.equal(refused.result.status, 409, "gil has no suporte role");
  assert.equal(load("t1").humanTasks?.draft?.assignee, undefined);
  const { result, update } = await click(button(post, "take"), "U0ANA", post.body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(load("t1").humanTasks?.draft?.assignee, "ana");
  assert.match(outcome(update.blocks), /Taken by <@U0ANA>/);
  assert.equal(jsonl(ledgerFile("t1")).findLast((x) => x.kind === "human-claim").source.kind, "slack");
}));

test("an alert button from someone who is no person of the process, or for an unknown alert, changes nothing", async () => workspace(async (e, api, calls) => {
  const id = await dueAlert(e);
  await run(api);
  const post = alertPost(calls);
  assert.equal((await click(button(post, "ack"), "U0STRANGER", post.body)).result.status, 403);
  const forged = { ...button(post, "ack"), value: JSON.stringify({ ...JSON.parse(button(post, "ack").value), alert: "nope" }) };
  assert.equal((await click(forged, "U0ANA", post.body)).result.status, 409);
  const bad = { ...button(post, "ack"), value: JSON.stringify({ ...JSON.parse(button(post, "ack").value), extra: 1 }) };
  assert.equal((await click(bad, "U0ANA", post.body)).result.status, 400);
  assert.equal(load("t1").alerts!.find((a) => a.id === id)!.acknowledgedAt, undefined);
}));

test("an alert acknowledged at the terminal closes its Slack message", async () => workspace(async (e, api, calls) => {
  const id = await dueAlert(e);
  await run(api);
  const post = alertPost(calls);
  assert.equal(govern(e, ["alerts", "t1", "--ack", id]).code, 0);
  await run(api);
  const update = calls.find((c) => c.method === "chat.update" && c.body.ts === post.ts)!;
  assert.ok(update, "the alert message is updated");
  assert.equal(buttons(update).length, 0);
  assert.match(JSON.stringify(update.body.blocks), /[Aa]cknowledged/);
}));

test("a stage govern drive gave up on has Retry: it clears the failure for drive to send again, and the message closes", async () => workspace(async (e, api, calls) => {
  const runs = { "t1:write": { task: "20261104-codex-x", round: 0, attempt: 1, state: "failed", reason: "the agent is blocked: Jira is down" } };
  write(join(stateDir(), "drive", "state.json"), JSON.stringify(runs));
  await run(api);
  const post = calls.find((c) => String(c.body.text).includes("Jira is down"))!;
  assert.deepEqual(buttons(post).map((b) => b.action_id), ["govern.drive.retry"]);
  const { result, update } = await click(button(post, "retry"), "U0ANA", post.body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(JSON.parse(readFileSync(join(stateDir(), "drive", "state.json"), "utf8"))["t1:write"], undefined, "drive will send attempt 1 again");
  const entry = jsonl(ledgerFile("t1")).findLast((x) => x.kind === "drive-retry");
  assert.deepEqual([entry.stage, entry.round, entry.by, entry.source.kind], ["write", 0, "ana", "slack"]);
  assert.match(outcome(update.blocks), /Retry by <@U0ANA>/);
  assert.equal((await click(button(post, "retry"), "U0GIL", post.body)).result.status, 409, "a stage no longer failed is not retried");
  await run(api);
  const closed = calls.find((c) => c.method === "chat.update" && c.body.ts === post.ts)!;
  assert.ok(closed, "the notifier closes the failure");
  assert.equal(buttons(closed).length, 0); assert.match(JSON.stringify(closed.body.blocks), /no longer failed/);
  write(join(stateDir(), "drive", "state.json"), JSON.stringify(runs));
  const before = calls.length;
  await run(api);
  assert.equal(calls.slice(before).filter((c) => c.method === "chat.postMessage").length, 1, "a later failure is a new post");
}));
