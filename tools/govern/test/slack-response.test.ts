// Signed interaction feedback uses the real decision transaction without requiring a listening socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { makeEnv, childEnv, setConfig, write } from "./helpers.ts";
import { create, load } from "../lib/project.ts";
import { decisionValue, handleInteraction } from "../ext/slack/slack.ts";
const SECRET = "signing-secret-with-32-characters", NOW = 1793448000;
async function scenario(f: (value: string) => Promise<void>) {
  const e = makeEnv("slack-response"), before = process.env;
  setConfig(e, { slack: { team: "T1" } }); process.env = childEnv(e);
  try {
    write(join(e.root, "PALS-Notes/processes/feedback.json"), JSON.stringify({ version: 1, name: "feedback", people: { operator: { user: "operator", slack: "U0USER" } }, stages: [{ name: "draft", human: { assignee: "operator" }, next: [] }], gates: [] }));
    create("work", { process: "feedback", title: "Work" });
    await f(decisionValue(load("work"), { task: "draft" }, "complete"));
  } finally { process.env = before; }
}
function signed(value: string, extra: Record<string, unknown> = {}, user = "U0USER") {
  const body = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: user }, response_url: "https://hooks.slack.com/actions/T1/test", actions: [{ action_id: "govern.decide", value, text: { text: "Complete" } }], ...extra })));
  return { body, signature: "v0=" + createHmac("sha256", SECRET).update(`v0:${NOW}:`).update(body).digest("hex") };
}

test("recorded decision replaces the clicked message immediately with its outcome", async () => scenario(async value => {
  const s = signed(value), updates: Record<string, unknown>[] = [];
  const request = (async (url: unknown, init: RequestInit) => {
    assert.equal(url, "https://hooks.slack.com/actions/T1/test");
    assert.equal(init.redirect, "error"); assert.equal(init.method, "POST");
    assert.equal(load("work").humanTasks?.draft?.completedBy, "operator", "decision commits before callback");
    updates.push(JSON.parse(String(init.body))); return new Response("ok");
  }) as typeof fetch;
  const result = await handleInteraction(SECRET, s.body, String(NOW), s.signature, { now: () => NOW, request });
  assert.equal(result.status, 200); assert.equal(updates.length, 1);
  assert.equal(updates[0]!.replace_original, true); assert.deepEqual(updates[0]!.blocks, []);
  assert.match(String(updates[0]!.text), /complete by operator/);
}));

test("refusals explain why to the clicker without replacing the shared decision", async () => scenario(async value => {
  const s = signed(value, {}, "U0OTHER"), updates: Record<string, unknown>[] = [];
  const request = (async (_: unknown, init: RequestInit) => { updates.push(JSON.parse(String(init.body))); return new Response("ok"); }) as typeof fetch;
  const result = await handleInteraction(SECRET, s.body, String(NOW), s.signature, { now: () => NOW, request });
  assert.equal(result.status, 403); assert.match(String(updates[0]!.text), /no person/);
  assert.equal(updates[0]!.response_type, "ephemeral"); assert.equal(updates[0]!.replace_original, false);
  assert.equal(load("work").humanTasks?.draft?.completedBy, undefined);
}));

test("callback failure never rolls back a recorded decision and never exposes the capability URL", async t => scenario(async value => {
  const s = signed(value), warnings: string[] = [];
  t.mock.method(process.stderr, "write", (s: string) => { warnings.push(s); return true; });
  const result = await handleInteraction(SECRET, s.body, String(NOW), s.signature, { now: () => NOW, request: (async () => { throw Error("https://hooks.slack.com/private-token"); }) as typeof fetch });
  assert.equal(result.status, 200); assert.equal(load("work").humanTasks?.draft?.completedBy, "operator");
  assert.ok(warnings.length); assert.ok(!warnings.join("").includes("private-token"));
}));

test("unsafe response URLs and forged signatures never call out or decide", async () => scenario(async value => {
  let calls = 0; const request = (async () => { calls++; return new Response("ok"); }) as typeof fetch;
  for (const response_url of ["http://hooks.slack.com/a", "https://hooks.slack.com.evil.test/a", "https://hooks.slack.com@evil.test/a", "https://evil.test/a", "https://hooks.slack.com:8443/a", "https://user@hooks.slack.com/a", "https://hooks.slack.com/a#x", 1]) {
    const s = signed(value, { response_url });
    assert.equal((await handleInteraction(SECRET, s.body, String(NOW), s.signature, { now: () => NOW, request })).status, 400);
  }
  const s = signed(value);
  assert.equal((await handleInteraction(SECRET, s.body, String(NOW), "v0=" + "0".repeat(64), { now: () => NOW, request })).status, 401);
  assert.equal(calls, 0); assert.equal(load("work").humanTasks?.draft?.completedBy, undefined);
}));

test("missing response URL remains compatible; callback HTTP failure preserves the decision", async () => {
  await scenario(async value => {
    const s = signed(value, { response_url: undefined });
    const result = await handleInteraction(SECRET, s.body, String(NOW), s.signature, { now: () => NOW, request: (async () => { assert.fail("no URL"); }) as typeof fetch });
    assert.equal(result.status, 200);
  });
  await scenario(async value => {
    const s = signed(value);
    assert.equal((await handleInteraction(SECRET, s.body, String(NOW), s.signature, { now: () => NOW, request: (async () => new Response("error", { status: 500 })) as typeof fetch })).status, 200);
    assert.equal(load("work").humanTasks?.draft?.completedBy, "operator");
  });
});

// A clicked message keeps what it asked: the callback rebuilds it from the message Slack sends with the click.
type Block = { type: string; block_id?: string; elements?: unknown[]; text?: { text: string } };
const message = (value: string, label = "Complete"): { text: string; blocks: Block[] } => ({ text: "Work (work): task draft", blocks: [
  { type: "section", block_id: "ask", text: { type: "mrkdwn", text: "*Work* (`work`) · task *draft*\n<@U0USER>" } } as Block,
  { type: "actions", block_id: "govern", elements: [{ type: "button", action_id: "govern.decide.complete", value, text: { type: "plain_text", text: label } }] }] });
const outcome = (blocks: Block[]) => blocks.filter((b) => b.block_id === "govern.outcome");
const outcomeText = (blocks: Block[]) => JSON.stringify(outcome(blocks));
async function click(value: string, user: string, msg: unknown, label = "Complete") {
  const body = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: user }, response_url: "https://hooks.slack.com/actions/T1/test", message: msg, actions: [{ action_id: "govern.decide", value, text: { text: label } }] })));
  const signature = "v0=" + createHmac("sha256", SECRET).update(`v0:${NOW}:`).update(body).digest("hex"), sent: Record<string, unknown>[] = [];
  const request = (async (_: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("ok"); }) as typeof fetch;
  const result = await handleInteraction(SECRET, body, String(NOW), signature, { now: () => NOW, request });
  return { result, update: sent[0]! as { replace_original: boolean; text: string; blocks: Block[] } };
}

test("a decided message keeps its content, loses its buttons and says who decided", async () => scenario(async value => {
  const { result, update } = await click(value, "U0USER", message(value));
  assert.equal(result.status, 200); assert.equal(update.replace_original, true);
  assert.equal(update.text, "Work (work): task draft", "the notification text stays");
  assert.equal(update.blocks[0]!.block_id, "ask", "what was asked stays");
  assert.ok(!update.blocks.some((b) => b.type === "actions"), "a decided message has no buttons");
  assert.equal(outcome(update.blocks).length, 1); assert.match(outcomeText(update.blocks), /Done by <@U0USER>/);
}));

test("a gate that needs two approvals keeps its buttons after the first vote and shows progress", async () => {
  const e = makeEnv("slack-quorum"), before = process.env;
  setConfig(e, { slack: { team: "T1" } }); process.env = childEnv(e);
  try {
    write(join(e.root, "PALS-Notes/processes/quorum.json"), JSON.stringify({ version: 1, name: "quorum",
      people: { ana: { user: "ana", roles: ["gestor"], slack: "U0ANA" }, gil: { user: "gil", roles: ["gestor"], slack: "U0GIL" } },
      stages: [{ name: "review", next: [{ to: ["send"] }] }, { name: "send", next: [] }],
      gates: [{ name: "validacao", stage: "review", policy: { role: "gestor", quorum: 2 } }] }));
    create("work", { process: "quorum", title: "Work" });
    const value = decisionValue(load("work"), { gate: "validacao" }, "approve");
    const first = await click(value, "U0ANA", message(value, "Approve"), "Approve");
    assert.equal(first.result.status, 200);
    const buttons = first.update.blocks.filter((b) => b.type === "actions");
    assert.equal(buttons.length, 1, "the other approver still has the buttons");
    assert.deepEqual(buttons[0], message(value, "Approve").blocks[1], "the buttons are unchanged");
    assert.match(outcomeText(first.update.blocks), /1\/2 approvals: <@U0ANA>/);
    assert.ok(first.update.blocks.findIndex((b) => b.block_id === "govern.outcome") < first.update.blocks.findIndex((b) => b.type === "actions"), "progress shows above the buttons");
    const second = await click(value, "U0GIL", first.update, "Approve");
    assert.equal(second.result.status, 200);
    assert.ok(!second.update.blocks.some((b) => b.type === "actions"));
    assert.equal(outcome(second.update.blocks).length, 1, "the progress line is replaced, not repeated");
    assert.match(outcomeText(second.update.blocks), /Approved by <@U0ANA>, <@U0GIL>/);
  } finally { process.env = before; }
});

test("a message Slack does not send back is not invented: the bare outcome line replaces it", async () => {
  for (const msg of [undefined, { text: "x" }, { blocks: "nope" }, { blocks: [1] }]) await scenario(async value => {
    const { result, update } = await click(value, "U0USER", msg);
    assert.equal(result.status, 200);
    assert.deepEqual(update.blocks, []); assert.match(update.text, /complete by operator/);
  });
});
