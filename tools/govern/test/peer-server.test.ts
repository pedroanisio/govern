// HTTP handler checks independent of permission to bind a TCP port; real transport is in peer-http.test.ts.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { makeEnv, childEnv, write } from "./helpers.ts";
import { stateDir } from "../lib/workspace.ts";
import * as peer from "../lib/peer.ts";
import * as queue from "../lib/queue.ts";
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
test("peer server handler enforces routes, size before auth, signatures and injected clock", () => {
  const a = makeEnv("peer-handler-a"), b = makeEnv("peer-handler-b");
  process.env = childEnv(a); const ai = peer.identity("a");
  process.env = childEnv(b); peer.identity("b");
  peer.addPeer({ name: "a", url: "https://a.example", publicKey: ai.publicKey, allow: ["codex"], projects: ["p"] });
  const now = Date.parse("2026-10-15T12:00:00Z"), server = peer.peerServer({ now: () => now });
  assert.equal(server.requestTimeout, 30000); assert.equal(server.headersTimeout, 10000);
  function request(method: string, url: string, chunks: Buffer[] = [], headers: peer.Headers = {}, incomplete = false) {
    const req = new IncomingMessage(new Socket()); req.method = method; req.url = url; req.headers = headers;
    let status = 0, result = "", responseHeaders: Record<string, string> = {};
    const res = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; responseHeaders = h; this.headersSent = true; }, end(s: string) { result = s; } };
    server.emit("request", req, res);
    for (const chunk of chunks) req.emit("data", chunk);
    if (incomplete) req.emit("error", new Error("disconnected")); else req.emit("end");
    assert.equal(responseHeaders["Cache-Control"], "no-store"); assert.match(responseHeaders["Content-Type"]!, /application\/json/);
    return { status, body: JSON.parse(result) };
  }
  try {
    assert.deepEqual(request("GET", "/v1/health"), { status: 200, body: { protocol: peer.PROTOCOL, name: "b" } });
    for (const [method, path] of [["POST", "/v1/health"], ["GET", "/v1/peer/deliver"], ["GET", "/no"], ["GET", "/v1/health?x=1"]]) assert.equal(request(method!, path!).status, 404);
    const call = (bytes: Buffer[], headers: peer.Headers = {}) => request("POST", "/v1/peer/deliver", bytes, headers);
    assert.deepEqual(call([Buffer.from("{")]), { status: 403, body: { error: "unknown peer" } });
    assert.equal(call([Buffer.alloc(peer.MAX_BODY), Buffer.alloc(1), Buffer.alloc(10)]).status, 413);
    const bytes = Buffer.from(JSON.stringify({ protocol: peer.PROTOCOL, id: "handler-id", at: new Date(now).toISOString(), toKey: peer.fingerprint(peer.identity().publicKey), message: { project: "p", task: "t", kind: "TASK", from: "alice", to: "codex", summary: "check", body: "claim" } }));
    const headers = peer.sign(bytes, ai);
    const first = call([bytes.subarray(0, 20), bytes.subarray(20)], headers); assert.equal(first.status, 200);
    assert.equal(call([bytes], headers).body.duplicate, true); assert.equal(queue.all().length, 1);
    assert.equal(call([Buffer.from("changed")], headers).status, 403);
    const invalid = Buffer.from("{"); assert.equal(call([invalid], peer.sign(invalid, ai)).status, 400);
    assert.equal(request("POST", "/v1/peer/deliver", [], {}, true).status, 400);
    write(join(stateDir(), "peer", "peers.json"), "{"); assert.deepEqual(call([bytes], headers), { status: 500, body: { error: "internal error" } });
    write(join(stateDir(), "peer", "host.json"), "{"); assert.deepEqual(request("GET", "/v1/health"), { status: 500, body: { error: "internal error" } });
  } finally { server.close(); }
});
