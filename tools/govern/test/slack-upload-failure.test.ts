// A failed transfer against a real loopback server: the wire contract of the upload, the real reason on failure, and the
// one way out of an uncertain send. No failure here may be able to share a file twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, write } from "./helpers.ts";
import { slackBody } from "./slack-api.ts";
import { uploadFile, resolveSend, slackCall, sent, networkReason, transferMs, SETTLE_MS } from "../ext/slack/channel.ts";

const HOST = "https://files.slack.com";
type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
interface Fake {
  url: string; server: Server; transfers: { method: string; auth?: string; type?: string; bytes: string }[]; completions: Record<string, unknown>[];
  transfer: Handler; complete: Handler; thread: Record<string, unknown>[]; hasMore: boolean; repliesDown: boolean; malformed: boolean; hits: string[];
}

/** The Web API and the upload host on one loopback server; `transfer` and `complete` decide each test's failure. */
async function fake(t: { after: (f: () => void | Promise<void>) => void }): Promise<Fake> {
  const json = (res: ServerResponse, v: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(v)); };
  const f: Fake = {
    url: "", transfers: [], completions: [], thread: [{ ts: "1.000001" }], hasMore: false, repliesDown: false, malformed: false, hits: [],
    transfer: (_q, res) => { res.end("OK - 5"); }, complete: (_q, res) => json(res, { ok: true, files: [{ id: "F123" }] }),
    server: createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks), path = req.url!;
        f.hits.push(path);
        if (path === "/moved") { res.end("followed"); return; }
        if (path === "/upload/1") {
          f.transfers.push({ method: req.method!, auth: req.headers.authorization, type: req.headers["content-type"], bytes: body.toString() });
          f.transfer(req, res, body); return;
        }
        const method = path.split("/").at(-1)!, parsed = slackBody(method, String(req.headers["content-type"]), body.toString());
        if (method === "conversations.replies") {
          if (f.repliesDown) { res.statusCode = 503; res.end(); return; }
          if (f.malformed) { json(res, { ok: true, messages: "nothing" }); return; }
          json(res, { ok: true, messages: f.thread, has_more: f.hasMore }); return;
        }
        if (method === "files.getUploadURLExternal") { json(res, { ok: true, upload_url: `${HOST}/upload/1`, file_id: "F123" }); return; }
        if (method === "files.completeUploadExternal") { f.completions.push(parsed!); f.complete(req, res, body); return; }
        res.statusCode = 404; res.end();
      });
    }),
  };
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`;
  t.after(() => { f.server.closeAllConnections(); return new Promise<void>((r) => f.server.close(() => r())); });
  return f;
}

/** fetch itself, with the upload host's name pointed at the loopback server. */
const toLoopback = (f: Fake, init: Partial<RequestInit> = {}) =>
  ((url: string, o: RequestInit) => fetch(String(url).replace(HOST, f.url), { ...o, ...init })) as typeof fetch;

function setup(f: Fake) {
  const d = tempDir("upload-fail"), root = join(d, "media"), file = write(join(root, "cover.jpg"), "bytes");
  const call = slackCall(`${f.url}/api`, "secret-token", fetch, async () => {});
  // The token is offered as a sidecar would need it: Slack's upload URL must still never get it.
  const policy = { roots: [root], maxBytes: 100 }, o = { file, thread: "1.000001", key: "k", token: "secret-token" };
  const upload = (request = toLoopback(f)) => uploadFile(call, d, "C1", policy, o, request);
  const intents = (): Record<string, string> => { const p = join(d, "send-intents.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, string> : {}; };
  const seed = (value: string) => writeFileSync(join(d, "send-intents.json"), JSON.stringify({ k: value }));
  return { d, call, upload, intents, seed };
}
const AGO = (ms: number) => new Date(Date.now() - ms).toISOString();

test("Slack's completion must name the file it was given; another id is an uncertain completion", async (t) => {
  const f = await fake(t), s = setup(f);
  f.complete = (_q, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, files: [{ id: "F999" }] })); };
  await assert.rejects(s.upload(), /invalid upload completion/);
  assert.match(s.intents().k ?? "", /^completing F123 /, "left for govern slack resolve");
});

test("the transfer POSTs the raw bytes to the upload URL, without the token", async (t) => {
  const f = await fake(t), s = setup(f);
  const receipt = await s.upload();
  assert.deepEqual(f.transfers, [{ method: "POST", auth: undefined, type: "application/octet-stream", bytes: "bytes" }]);
  assert.equal(f.completions.length, 1);
  assert.equal(receipt.ts, "F123");
  assert.deepEqual(s.intents(), {});
});

test("a redirect from the upload host is reported by status, not followed and not called a network failure", async (t) => {
  const f = await fake(t), s = setup(f);
  f.transfer = (_q, res) => { res.statusCode = 302; res.setHeader("Location", `${f.url}/moved`); res.end(); };
  await assert.rejects(s.upload(), /^.*file upload: HTTP 302$/);
  assert.ok(!f.hits.includes("/moved"), "the bytes went nowhere else");
  assert.equal(f.completions.length, 0);
});

test("a refused transfer never reached the channel: the retry goes through and shares once", async (t) => {
  const f = await fake(t), s = setup(f);
  f.transfer = (_q, res) => { res.statusCode = 500; res.end("no"); };
  await assert.rejects(s.upload(), /file upload: HTTP 500/);
  assert.deepEqual(s.intents(), {});
  f.transfer = (_q, res) => { res.end("OK"); };
  await s.upload();
  assert.equal(f.completions.length, 1);
  assert.equal(sent(s.d).length, 1);
});

test("a dropped connection surfaces its system code and frees the key; the message carries no URL or token", async (t) => {
  const f = await fake(t), s = setup(f);
  f.transfer = (req) => { req.socket.destroy(); };
  await assert.rejects(s.upload(), (e: Error) => {
    assert.match(e.message, /^file upload: network failure \([A-Z_]+\)$/);
    assert.doesNotMatch(e.message, /127\.0\.0\.1|slack\.com|secret-token/);
    return true;
  });
  assert.deepEqual(s.intents(), {}, "completion was never issued, so nothing can have reached the channel");
  f.transfer = (_q, res) => { res.end("OK"); };
  await s.upload();
  assert.equal(f.completions.length, 1);
});

test("a stalled transfer says it timed out and frees the key", async (t) => {
  const f = await fake(t), s = setup(f);
  f.transfer = () => { /* never answers */ };
  await assert.rejects(s.upload(toLoopback(f, { signal: AbortSignal.timeout(50) })), /file upload: network failure \(timed out\)/);
  assert.deepEqual(s.intents(), {});
});

test("the transfer limit grows with the file: a 100 MB upload does not get the 210 KB limit", () => {
  assert.ok(transferMs(210_000) >= 30_000);
  assert.ok(transferMs(100_000_000) >= 300_000);
  assert.ok(transferMs(100_000_000) > transferMs(50_000_000));
});

test("a run killed mid-transfer left only a staging mark: the next upload proceeds on its own", async (t) => {
  const f = await fake(t), s = setup(f);
  s.seed("staging");
  await s.upload();
  assert.equal(f.completions.length, 1);
  assert.deepEqual(s.intents(), {});
});

test("once completion was issued a lost answer keeps the key: no retry, and the mark names the file and thread", async (t) => {
  const f = await fake(t), s = setup(f);
  f.complete = (req) => { req.socket.destroy(); };
  await assert.rejects(s.upload(), /files\.completeUploadExternal: network failure \([A-Z_]+\)/);
  assert.match(s.intents().k!, /^completing F123 1\.000001 \d{4}-/);
  await assert.rejects(s.upload(), /uncertain send.*govern slack resolve --key k/);
  assert.equal(f.completions.length, 1, "the refused retry reached no API");
  assert.deepEqual(f.transfers.length, 1);
});

test("a proven refusal of completion frees the key", async (t) => {
  const f = await fake(t), s = setup(f);
  f.complete = (_q, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: false, error: "not_in_channel" })); };
  await assert.rejects(s.upload(), /not_in_channel/);
  assert.deepEqual(s.intents(), {});
});

test("resolve finds the file in the thread: the receipt is written, the key is spent and nothing is posted", async (t) => {
  const f = await fake(t), s = setup(f);
  s.seed(`completing F123 1.000001 ${AGO(1000)}`);
  f.thread = [{ ts: "1.000001" }, { ts: "1.000002", files: [{ id: "F999" }, { id: "F123" }] }];
  assert.match(await resolveSend(s.call, s.d, "C1", { key: "k" }), /delivered/);
  assert.deepEqual(sent(s.d), [{ ts: "F123", thread: "1.000001", kind: "upload", key: "k" }]);
  assert.deepEqual(s.intents(), {});
  await assert.rejects(s.upload(), /already sent/);
  assert.equal(f.completions.length, 0);
});

test("resolve without a flag never frees a key whose file it cannot see", async (t) => {
  const f = await fake(t), s = setup(f);
  s.seed(`completing F123 1.000001 ${AGO(SETTLE_MS * 2)}`);
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k" }), /--not-delivered/);
  assert.ok(s.intents().k);
});

test("resolve --not-delivered needs a whole thread read after the settle window", async (t) => {
  const f = await fake(t), s = setup(f), mark = `completing F123 1.000001 ${AGO(SETTLE_MS * 2)}`;
  s.seed(`completing F123 1.000001 ${AGO(1000)}`);
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }), /settle|too early|wait/i);
  s.seed(mark); f.hasMore = true;
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }), /whole thread/);
  f.hasMore = false; f.repliesDown = true;
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }), /HTTP 503/);
  f.repliesDown = false; f.malformed = true;
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }));
  assert.equal(s.intents().k, mark, "every refusal keeps the key");
  f.malformed = false;
  assert.match(await resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }), /released/);
  assert.deepEqual(s.intents(), {});
  await s.upload();
  assert.equal(f.completions.length, 1);
});

test("resolve --not-delivered on a thread that shows the file is refused", async (t) => {
  const f = await fake(t), s = setup(f);
  s.seed(`completing F123 1.000001 ${AGO(SETTLE_MS * 2)}`);
  f.thread = [{ ts: "1.000001", files: [{ id: "F123" }] }];
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }), /is in the thread/);
  assert.ok(s.intents().k);
  assert.equal(sent(s.d).length, 0);
});

test("a staging mark resolves at once: completion was never issued", async (t) => {
  const f = await fake(t), s = setup(f);
  s.seed("staging");
  assert.match(await resolveSend(s.call, s.d, "C1", { key: "k" }), /released/);
  assert.deepEqual(s.intents(), {});
  assert.deepEqual(f.hits, [], "no Slack call was needed");
});

test("an intent from before this version names no file: only the operator's explicit word settles it", async (t) => {
  for (const legacy of ["uploading", "sending"]) {
    const f = await fake(t), s = setup(f);
    s.seed(legacy);
    await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k" }), /--delivered --ts TS.*--not-delivered/);
    await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", delivered: true }), /--ts/);
    assert.equal(s.intents().k, legacy);
    assert.match(await resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true }), /released/);
    assert.deepEqual(s.intents(), {});
    s.seed(legacy);
    assert.match(await resolveSend(s.call, s.d, "C1", { key: "k", delivered: true, ts: "1.000009" }), /delivered/);
    assert.deepEqual(sent(s.d), [{ ts: "1.000009", thread: null, kind: legacy === "uploading" ? "upload" : "post", key: "k" }]);
    assert.deepEqual(f.hits, []);
  }
});

test("--delivered on a completing mark journals the file the mark names, without a thread read", async (t) => {
  const f = await fake(t), s = setup(f);
  s.seed(`completing F123 1.000001 ${AGO(1000)}`);
  await resolveSend(s.call, s.d, "C1", { key: "k", delivered: true });
  assert.deepEqual(sent(s.d), [{ ts: "F123", thread: "1.000001", kind: "upload", key: "k" }]);
  assert.deepEqual(f.hits, []);
});

test("resolve refuses an unknown key, a spent key, contradictory flags and a damaged mark", async (t) => {
  const f = await fake(t), s = setup(f);
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k" }), /no uncertain send/);
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", delivered: true, notDelivered: true }), /one of/);
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k", notDelivered: true, ts: "1.000001" }), /--ts/);
  for (const damaged of ["completing", "completing F123", "completing evil 1.000001 2026-10-31T00:00:00.000Z", "completing F123 1.000001 yesterday", "other"]) {
    s.seed(damaged);
    await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "k" }), /--delivered --ts TS.*--not-delivered/, damaged);
    assert.equal(s.intents().k, damaged);
  }
  assert.deepEqual(f.hits, []);
  await assert.rejects(resolveSend(s.call, s.d, "C1", { key: "" }), /key/);
});

test("networkReason names a code, a timeout or a class, and never a message", () => {
  const coded = Object.assign(new Error("connect failed to https://files.slack.com/upload/SECRET"), { code: "ECONNRESET" });
  assert.equal(networkReason(new TypeError("fetch failed", { cause: coded })), "ECONNRESET");
  assert.equal(networkReason(coded), "ECONNRESET");
  assert.equal(networkReason(Object.assign(new DOMException("x", "TimeoutError"))), "timed out");
  assert.equal(networkReason(new DOMException("x", "AbortError")), "aborted");
  assert.equal(networkReason(new TypeError("fetch failed", { cause: new RangeError("secret") })), "RangeError");
  assert.equal(networkReason(Object.assign(new Error("x"), { code: "lower case secret" })), "Error");
  assert.equal(networkReason("thrown text secret"), "unknown cause");
  assert.equal(networkReason(undefined), "unknown cause");
  const loop: { cause?: unknown; name: string } = { name: "Error" }; loop.cause = loop;
  assert.equal(networkReason(loop), "Error", "a cycle ends");
});

test("an API call's network failure carries the same reason, and the call stays uncertain", async () => {
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const dead = slackCall(`http://127.0.0.1:${port}`, "secret-token");
  await assert.rejects(dead("chat.postMessage", { channel: "C1", text: "x" }), (e: Error & { uncertain: boolean }) => {
    assert.match(e.message, /^chat\.postMessage: network failure \(ECONNREFUSED\)$/);
    assert.equal(e.uncertain, true);
    return true;
  });
});
