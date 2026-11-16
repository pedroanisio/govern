// Upload policy and real external-upload protocol with deterministic transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { symlinkSync, readFileSync } from "node:fs";
import { tempDir, write } from "./helpers.ts";
import { uploadFile, SlackError, sent, type Call } from "../ext/slack/channel.ts";

function fixture() {
  const d = tempDir("slack-upload"), root = join(d, "media"), file = write(join(root, "clip.mp4"), "video bytes");
  const calls: { method: string; body: Record<string, unknown> }[] = [], puts: RequestInit[] = [];
  const call: Call = async (method, body) => {
    calls.push({ method, body });
    if (method === "conversations.replies") return { messages: [{ ts: "2.000002", thread_ts: "1.000001" }] };
    if (method === "files.getUploadURLExternal") return { upload_url: "https://files.slack.com/upload/test", file_id: "F123" };
    return { files: [{ id: "F123", title: "Clip" }] };
  };
  const request = (async (_url: unknown, init: RequestInit) => { puts.push(init); return new Response("OK"); }) as typeof fetch;
  return { d, root, file, calls, puts, call, request, policy: { roots: [root], maxBytes: 100 } };
}

test("upload obtains URL, POSTs bytes without token, completes in parent thread and journals key", async () => {
  const f = fixture();
  const receipt = await uploadFile(f.call, f.d, "C1", f.policy, { file: f.file, thread: "2.000002", title: "Clip", text: "Delivered", key: "clip" }, f.request);
  assert.deepEqual(f.calls.map(c => c.method), ["conversations.replies", "files.getUploadURLExternal", "files.completeUploadExternal"]);
  assert.deepEqual(f.calls[1]!.body, { filename: "clip.mp4", length: 11 });
  assert.equal(f.puts[0]!.method, "POST"); assert.equal(f.puts[0]!.redirect, "manual");
  assert.deepEqual(Buffer.from(f.puts[0]!.body as Uint8Array), Buffer.from("video bytes"));
  assert.equal((f.puts[0]!.headers as Record<string, string>).Authorization, undefined);
  assert.deepEqual(f.calls[2]!.body, { files: [{ id: "F123", title: "Clip" }], channel_id: "C1", thread_ts: "1.000001", initial_comment: "Delivered" });
  assert.equal(receipt.ts, "F123"); assert.equal(receipt.kind, "upload"); assert.deepEqual(sent(f.d), [receipt]);
  await assert.rejects(uploadFile(f.call, f.d, "C1", f.policy, { file: f.file, thread: "2.000002", key: "clip" }, f.request), /already sent/);
});

test("upload shares a PDF document (a report) like an image or video", async () => {
  const f = fixture(), pdf = write(join(f.root, "relatorio.pdf"), "%PDF-1.4 x");
  const receipt = await uploadFile(f.call, f.d, "C1", f.policy, { file: pdf, thread: "2.000002", title: "Relatório", key: "report" }, f.request);
  assert.deepEqual(f.calls[1]!.body, { filename: "relatorio.pdf", length: 10 });
  assert.equal(receipt.ts, "F123"); assert.equal(receipt.kind, "upload");
});

test("upload refuses missing configuration, symlink escape, directory, oversize, unsupported type and invalid thread before sending", async () => {
  const f = fixture(), outside = write(join(f.d, "outside.png"), "image"), link = join(f.root, "escape.png"); symlinkSync(outside, link);
  for (const [file, policy, thread, reason] of [
    [f.file, undefined, "2.000002", /slack.upload/], [link, f.policy, "2.000002", /roots/],
    [f.root, f.policy, "2.000002", /regular file/], [f.file, { ...f.policy, maxBytes: 1 }, "2.000002", /maxBytes/],
    [write(join(f.root, "secret.txt"), "secret"), f.policy, "2.000002", /image, video or PDF/],
    [f.file, f.policy, "invalid", /thread/], [join(f.root, "missing.png"), f.policy, "2.000002", /resolve/],
  ] as const) await assert.rejects(uploadFile(f.call, f.d, "C1", policy, { file, thread }, f.request), reason);
  assert.equal(f.calls.length, 0); assert.equal(f.puts.length, 0);
});

test("upload sanitizes transport failures, frees a key before completion and keeps it after; proven refusal can retry", async () => {
  const f = fixture(), o = { file: f.file, thread: "2.000002", key: "retry" };
  await assert.rejects(uploadFile(f.call, f.d, "C1", f.policy, o, (async () => { throw Error("secret-token"); }) as typeof fetch), e => !String(e).includes("secret-token"));
  assert.equal(sent(f.d).length, 0);
  const lost: Call = async (m, b) => { if (m === "files.completeUploadExternal") throw new SlackError("lost", true); return f.call(m, b); };
  await assert.rejects(uploadFile(lost, f.d, "C1", f.policy, o, f.request), /lost/);
  await assert.rejects(uploadFile(f.call, f.d, "C1", f.policy, o, f.request), /uncertain/);
  assert.equal(sent(f.d).length, 0);
  const g = fixture(); let refuse = true;
  const call: Call = async (m, b) => { if (refuse && m === "files.completeUploadExternal") throw new SlackError("refused", false); return g.call(m, b); };
  await assert.rejects(uploadFile(call, g.d, "C1", g.policy, { ...o, file: g.file }, g.request), /refused/);
  refuse = false; await uploadFile(call, g.d, "C1", g.policy, { ...o, file: g.file }, g.request);
  assert.equal(sent(g.d).length, 1);
  assert.ok(!readFileSync(join(g.d, "sent.jsonl"), "utf8").includes("upload_url"));
});

test("upload rejects unsafe URLs and malformed completion without logging API bodies", async () => {
  for (const url of ["http://files.slack.com/u", "https://evil.test/u", "https://files.slack.com@evil.test/u", "https://files.slack.com:8443/u"]) {
    const f = fixture();
    const call: Call = async (m, b) => m === "files.getUploadURLExternal" ? { upload_url: url, file_id: "F123" } : f.call(m, b);
    await assert.rejects(uploadFile(call, f.d, "C1", f.policy, { file: f.file, thread: "2.000002" }, f.request), /upload URL/);
    assert.equal(f.puts.length, 0);
  }
  const f = fixture();
  await assert.rejects(uploadFile(async (m, b) => m === "files.completeUploadExternal" ? { files: [] } : f.call(m, b), f.d, "C1", f.policy, { file: f.file, thread: "2.000002" }, f.request), /completion/);
});

test("upload CLI reads configured credentials, validates required arguments and keeps secrets out of refusals", async t => {
  const { makeEnv, childEnv, setConfig } = await import("./helpers.ts");
  const { commands } = await import("../ext/slack/index.ts"), { parseArgs } = await import("../lib/util.ts");
  const e = makeEnv("upload-cli"), before = process.env, file = write(join(e.root, "media/image.png"), "image");
  setConfig(e, { slack: { team: "T1", channel: "C1", inbox: "generated/slack", botTokenVar: "UPLOAD_TEST_TOKEN", upload: { roots: ["media"], maxBytes: 100 } } });
  process.env = childEnv(e); process.env.UPLOAD_TEST_TOKEN = "private_bot_token";
  const calls: string[] = [], sub = commands[0]!.subs!.upload!;
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    calls.push(String(url));
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer private_bot_token");
    return Response.json(String(url).endsWith("replies") ? { ok: true, messages: [{ ts: "1.000001" }] } : { ok: false, error: "private_bot_token" });
  });
  try {
    for (const args of [[], ["--file", file]]) await assert.rejects(async () => sub.run!(parseArgs(args, sub.flags!, "slack upload")), /requires/);
    await assert.rejects(async () => sub.run!(parseArgs(["--file", file, "--thread", "1.000001"], sub.flags!, "slack upload")), e => /redacted/.test(String(e)) && !String(e).includes("private_bot_token"));
    assert.equal(calls.length, 2);
    const f = fixture();
    for (const extra of [{ text: " " }, { text: "x".repeat(40001) }, { title: "" }, { title: "x".repeat(256) }, { name: " " }, { name: "a/b.png" }, { name: "a\\b.png" }, { name: "x".repeat(256) }])
      await assert.rejects(uploadFile(f.call, f.d, "C1", f.policy, { file: f.file, thread: "2.000002", ...extra }, f.request), /text|title|name/);
  } finally { process.env = before; }
});
