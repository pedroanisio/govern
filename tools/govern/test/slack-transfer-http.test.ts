// Real fake-server transports for external upload and signed immediate feedback; requires loopback permission.
import { test } from "node:test";
import { slackBody } from "./slack-api.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { tempDir, write, makeEnv, childEnv, setConfig } from "./helpers.ts";
import { uploadFile, slackCall } from "../ext/slack/channel.ts";
import { slackServer, decisionValue } from "../ext/slack/slack.ts";
import { create, load } from "../lib/project.ts";
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }

test("fake Web API receives upload URL request, raw POST, completion and no token on the transfer", async () => {
  const d = tempDir("upload-http"), file = write(join(d, "image.png"), "image bytes"), received: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      received.push(req.url!); res.setHeader("Content-Type", "application/json");
      if (req.url === "/bytes") {
        assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, undefined);
        assert.equal(Buffer.concat(chunks).toString(), "image bytes"); res.end("ok"); return;
      }
      assert.equal(req.headers.authorization, "Bearer test-token");
      const body = slackBody(req.url!.split("/").at(-1)!, String(req.headers["content-type"]), Buffer.concat(chunks).toString());
      if (!body) { res.end(JSON.stringify({ ok: false, error: "invalid_arguments" })); return; }
      if (req.url === "/api/conversations.replies") res.end(JSON.stringify({ ok: true, messages: [{ ts: "2.000002", thread_ts: "1.000001" }] }));
      else if (req.url === "/api/files.getUploadURLExternal") {
        assert.deepEqual(body, { filename: "image.png", length: "11" });
        res.end(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/test", file_id: "F123" }));
      }
      else { assert.equal(body.thread_ts, "1.000001"); res.end(JSON.stringify({ ok: true, files: [{ id: "F123" }] })); }
    });
  });
  const url = await listen(server);
  try {
    await uploadFile(slackCall(`${url}/api`, "test-token"), d, "C1", { roots: [d], maxBytes: 100 }, { file, thread: "2.000002", key: "image" }, ((_target, init) => fetch(`${url}/bytes`, init)) as typeof fetch);
    assert.deepEqual(received, ["/api/conversations.replies", "/api/files.getUploadURLExternal", "/bytes", "/api/files.completeUploadExternal"]);
  } finally { await close(server); }
});

test("signed HTTP click commits before immediate callback; refusal is visible and callback failure preserves decision", async () => {
  const e = makeEnv("response-http"), before = process.env, secret = "signing-secret-with-32-characters", now = 1793448000;
  process.env = childEnv(e); setConfig(e, { slack: { team: "T1" } });
  write(join(e.root, "PALS-Notes/processes/feedback.json"), JSON.stringify({ version: 1, name: "feedback", people: { operator: { user: "operator", slack: "U0USER" } }, stages: [{ name: "draft", human: { assignee: "operator" }, next: [] }], gates: [] }));
  create("work", { process: "feedback", title: "Work" }); const value = decisionValue(load("work"), { task: "draft" }, "complete");
  const callbacks: Record<string, unknown>[] = []; let callbackFailure = false;
  const callback = createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      callbacks.push(JSON.parse(body)); assert.equal(req.headers.authorization, undefined);
      if (callbacks.at(-1)!.replace_original) assert.equal(load("work").humanTasks?.draft?.completedBy, "operator");
      res.writeHead(callbackFailure ? 500 : 200); res.end("ok");
    });
  });
  const callbackUrl = await listen(callback);
  const server = slackServer(secret, { now: () => now, request: ((_url, init) => fetch(callbackUrl, init)) as typeof fetch });
  try {
    const url = await listen(server);
    async function click(user: string) {
      const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: user }, response_url: "https://hooks.slack.com/actions/T1/test", actions: [{ action_id: "govern.decide", value, text: { text: "Complete" } }] }));
      const signature = "v0=" + createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex");
      return fetch(`${url}/slack/actions`, { method: "POST", body, headers: { "X-Slack-Request-Timestamp": String(now), "X-Slack-Signature": signature } });
    }
    assert.equal((await click("U0OTHER")).status, 403); assert.match(String(callbacks[0]!.text), /no person/);
    callbackFailure = true;
    assert.equal((await click("U0USER")).status, 200); assert.equal(callbacks[1]!.replace_original, true);
    assert.equal(load("work").humanTasks?.draft?.completedBy, "operator");
  } finally { await close(server); await close(callback); process.env = before; }
});
