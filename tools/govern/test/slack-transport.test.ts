// Wire encoding contracts without loopback or credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { slackCall, SlackError } from "../ext/slack/channel.ts";
import { slackBody } from "./slack-api.ts";
import "./helpers.ts"; // every test file runs in the sandbox

for (const [method, args] of [
  ["conversations.history", { channel: "C1", limit: 100 }],
  ["conversations.replies", { channel: "C1", ts: "1.000001", limit: 200 }],
  ["files.getUploadURLExternal", { filename: "image & video+.png", length: 12345 }],
] as const) test(`${method} uses form encoding and decimal scalars`, async () => {
  const call = slackCall("https://fake/api", "test-secret", async (url, init) => {
    const headers = new Headers(init?.headers), raw = String(init?.body);
    assert.equal(headers.get("authorization"), "Bearer test-secret");
    assert.ok(!String(url).includes("test-secret") && !raw.includes("test-secret"));
    const body = slackBody(method, headers.get("content-type") ?? "", raw);
    if (!body) return Response.json({ ok: false, error: "invalid_arguments" });
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded; charset=utf-8");
    assert.deepEqual(body, Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])));
    return Response.json({ ok: true });
  });
  await call(method, args);
});

for (const [method, args] of [
  ["chat.postMessage", { channel: "C1", text: "hello", blocks: [{ type: "divider" }] }],
  ["chat.update", { channel: "C1", ts: "1.000001", blocks: [] }],
  ["files.completeUploadExternal", { files: [{ id: "F1", title: "image" }], channel_id: "C1" }],
] as const) test(`${method} preserves structured JSON arguments`, async () => {
  await slackCall("https://fake/api", "test-secret", async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(String(init?.body)), args);
    return Response.json({ ok: true });
  })(method, args);
});

test("unknown methods fail with a typed, credential-free error before any request", async () => {
  let requests = 0;
  const call = slackCall("https://fake/api", "test-secret", async () => { requests++; return Response.json({ ok: true }); });
  for (const method of ["unknown.method", "toString", "__proto__", "test-secret"]) {
    await assert.rejects(call(method, {}), e => e instanceof SlackError && !e.uncertain && !e.message.includes("test-secret"));
  }
  assert.equal(requests, 0);
});

test("fake API refuses JSON on form-only methods and accepts both encodings for history", () => {
  for (const method of ["conversations.replies", "files.getUploadURLExternal"]) {
    assert.equal(slackBody(method, "application/json; charset=utf-8", "{}"), undefined);
    assert.deepEqual(slackBody(method, "application/x-www-form-urlencoded", "limit=200"), { limit: "200" });
  }
  assert.deepEqual(slackBody("conversations.history", "application/json", '{"limit":100}'), { limit: 100 });
  assert.deepEqual(slackBody("conversations.history", "application/x-www-form-urlencoded", "limit=100"), { limit: "100" });
});

test("form scalars preserve decimal numbers, booleans and escaped strings", async () => {
  let raw = "";
  await slackCall("https://fake/api", "test-secret", async (_url, init) => {
    raw = String(init?.body); return Response.json({ ok: true });
  })("conversations.history", { limit: 1e21, oldest: 0.000001, inclusive: false, channel: "C+ &1" });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(raw)), {
    limit: "1000000000000000000000", oldest: "0.000001", inclusive: "false", channel: "C+ &1",
  });
});

test("form arguments reject structured or invalid scalar values before any request", async () => {
  let requests = 0;
  const call = slackCall("https://fake/api", "test-secret", async () => { requests++; return Response.json({ ok: true }); });
  for (const value of [{ text: "test-secret" }, [], null, undefined, NaN, Infinity]) {
    await assert.rejects(call("conversations.history", { value }), e => e instanceof SlackError && !e.uncertain && !e.message.includes("test-secret"));
  }
  assert.equal(requests, 0);
});
