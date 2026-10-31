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
