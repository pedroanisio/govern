// Real HTTP peer delivery and the public CLI contract.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../lib/workspace.ts";
import { makeEnv, childEnv, govern, GOVERN, reply, servePeer as serve } from "./helpers.ts";
import * as peer from "../ext/peer/peer.ts";
import { newKeys } from "../lib/peer-id.ts";
import * as queue from "../lib/queue.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const use = (e: ReturnType<typeof makeEnv>) => { process.env = childEnv(e); };
function pair() {
  const a = makeEnv("peer-http-a"), b = makeEnv("peer-http-b");
  use(a); const ai = peer.identity("a"); use(b); const bi = peer.identity("b");
  peer.addPeer({ name: "a", url: "https://a.example", publicKey: ai.publicKey, allow: ["codex"], projects: ["p"] });
  use(a); peer.addPeer({ name: "b", url: "https://b.example", publicKey: bi.publicKey, allow: ["alice"], projects: ["p"] });
  return { a, b, ai, bi };
}
const sendArgs = ["task", "send", "--to", "codex@b", "--project", "p", "--task", "t", "--from", "alice", "--summary", "check", "--body", "claim"];

test("peer CLI creates identity, lists relay state and revokes grants", () => {
  const { a, ai, bi } = pair();
  let r = govern(a, ["peer", "id", "--name", "a"]); assert.equal(r.code, 0, r.err);
  for (const s of ["a", ai.publicKey, peer.fingerprint(ai.publicKey)]) assert.ok(r.out.includes(s), r.out);
  r = govern(a, ["peer", "id", "--name", "other"]); assert.equal(r.code, 4); assert.match(r.err, /already.*name/);
  const ck = newKeys().publicKey;
  r = govern(a, ["peer", "add", "c", "--url", "https://c.example", "--key", ck, "--allow", "owner", "--allow", "codex", "--project", "p", "--project", "q"]); assert.equal(r.code, 0, r.err);
  assert.equal(govern(a, sendArgs).code, 0);
  r = govern(a, ["peer", "push", "--max", "0"]); assert.equal(r.code, 2); assert.match(r.err, /positive integer/);
  use(a); const outbound = queue.all()[0]!.m;
  outbound.relay = { attempts: 1, lastError: "offline test", nextAt: new Date(Date.now() + 30000).toISOString() }; queue.save(outbound, "open");
  r = govern(a, ["peer", "list"]); assert.equal(r.code, 0, r.err); assert.match(r.out, /https:\/\/c.example/); assert.match(r.out, /owner, codex/); assert.match(r.out, /p, q/); assert.match(r.out, /open: 1/); assert.match(r.out, /last relay error: offline test/); assert.ok(r.out.includes(peer.fingerprint(ck)));
  r = govern(a, ["peer", "revoke", "b"]); assert.equal(r.code, 0, r.err);
  r = govern(a, sendArgs); assert.equal(r.code, 4); assert.match(r.err, /live peer/);
});
for (const extra of [["--write"], ["--profile", "codex-read"], ["--lane", "p"], ["--estimate-usd", "0"], ["--file", "x"], ["--to", "auto@b"]]) test(`remote send refuses ${extra[0]} ${extra[1] ?? ""}`, () => {
  const { a } = pair();
  const args = extra[1] === "auto@b" ? sendArgs.map(x => x === "codex@b" ? "auto@b" : x) : [...sendArgs, ...extra];
  const r = govern(a, args); assert.equal(r.code, 2); assert.match(r.err, /receiving host decides/); use(a); assert.equal(queue.all().length, 0);
});
test("remote send skips session liveness but requires a live peer and explains waking", () => {
  const { a } = pair();
  let r = govern(a, sendArgs.map(x => x === "codex@b" ? "absent-session@b" : x)); assert.equal(r.code, 0, r.err); assert.match(r.out, /sessions on b are not woken by the queue/);
  r = govern(a, sendArgs.map(x => x === "codex@b" ? "codex@unknown" : x)); assert.equal(r.code, 4); assert.match(r.err, /live peer/);
});
for (const sub of ["add", "revoke"]) test(`peer ${sub} requires the owner's terminal`, () => {
  const { a, bi } = pair(); const r = govern(a, ["peer", sub, "b", ...(sub === "add" ? ["--url", "https://b.example", "--key", bi.publicKey] : [])], { CODEX_THREAD_ID: "agent" });
  assert.equal(r.code, 1); assert.match(r.err, /own terminal/);
});
test("peer serve refuses public binds and invalid ports", () => {
  const { a } = pair();
  for (const args of [["--host", "0.0.0.0"], ["--host", "example.com"], ["--port", "0"], ["--port", "65536"], ["--port", "NaN"]]) {
    const r = govern(a, ["peer", "serve", ...args]); assert.equal(r.code, args[0] === "--host" ? 4 : 2, r.err); assert.match(r.err, args[0] === "--host" ? /loopback.*TLS.*tunnel/ : /1\.\.65535/);
  }
});
test("peer server bounds requests, authenticates bytes, routes strictly and injects its clock", async () => {
  const { b, ai } = pair(); use(b);
  const now = Date.parse("2026-10-15T12:00:00Z"), server = peer.peerServer({ now: () => now });
  assert.equal(server.requestTimeout, 30000); assert.equal(server.headersTimeout, 10000);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const health = await fetch(`${url}/v1/health`); assert.deepEqual(await health.json(), { protocol: peer.PROTOCOL, name: "b" }); assert.equal(health.headers.get("cache-control"), "no-store");
    for (const [path, method] of [["/v1/health", "POST"], ["/v1/peer/deliver", "GET"], ["/no", "GET"], ["/v1/health?x=1", "GET"]]) assert.equal((await fetch(url + path, { method })).status, 404);
    const bytes = Buffer.from(JSON.stringify({ protocol: peer.PROTOCOL, id: "http-id", at: new Date(now).toISOString(), toKey: peer.fingerprint(peer.identity().publicKey), message: { project: "p", task: "t", kind: "TASK", from: "alice", to: "codex", summary: "check", body: "claim" } }));
    let r = await fetch(`${url}/v1/peer/deliver`, { method: "POST", body: bytes, headers: peer.sign(bytes, ai) }); assert.equal(r.status, 200);
    r = await fetch(`${url}/v1/peer/deliver`, { method: "POST", body: "{", headers: { "X-Forwarded-For": "127.0.0.1" } }); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: "unknown peer" });
    r = await fetch(`${url}/v1/peer/deliver`, { method: "POST", body: "x".repeat(peer.MAX_BODY + 1) }); assert.equal(r.status, 413); assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(queue.all().length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("peer CLI real HTTP round trip dispatches B and threads its reply on A, plus 403", async () => {
  const { a, b } = pair(); const bs = await serve(b);
  let as: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    as = await serve(a);
    use(a); const bp = peer.peers()[0]!; peer.revokePeer("b"); peer.addPeer({ ...bp, url: bs.url });
    use(b); const ap = peer.peers()[0]!; peer.revokePeer("a"); peer.addPeer({ ...ap, url: as.url });
    const sent = govern(a, sendArgs); assert.equal(sent.code, 0, sent.err);
    assert.equal(govern(a, ["task", "dispatch"]).code, 0);
    use(a); assert.equal(queue.all()[0]?.state, "open");
    const delivered = govern(a, ["peer", "push", "--max", "1"]); assert.equal(delivered.code, 0, delivered.err); assert.match(delivered.out, /delivered to b/);
    use(a); const orig = queue.all()[0]!.m; assert.equal(queue.find(orig.id)?.state, "done");
    use(b); const incoming = queue.all()[0]!.m; assert.equal(incoming.from, "alice@a"); assert.equal(incoming.profile, "codex-read");
    const script = reply(b, "ok", { kind: "HANDOFF", summary: "checked", body: "answer" });
    const dispatched = govern(b, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: script }); assert.equal(dispatched.code, 0, dispatched.err);
    const pushed = govern(b, ["peer", "push"]); assert.equal(pushed.code, 0, pushed.err); assert.match(pushed.out, /delivered to a/);
    use(a); const answer = queue.all().find(x => x.m.remote)!.m; assert.equal(answer.replyTo, orig.id); assert.equal(queue.thread(answer).length, 2);
    const refusal = await fetch(`${bs.url}/v1/peer/deliver`, { method: "POST", body: "{}" }); assert.equal(refusal.status, 403);
  } finally { await Promise.all([as?.stop(), bs.stop()]); }
});

test("dispatch loop logs peer errors, continues and relays on later passes", async () => {
  const { a, b } = pair(), bs = await serve(b);
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    use(a); const bp = peer.peers()[0]!; peer.revokePeer("b"); peer.addPeer({ ...bp, url: bs.url });
    const messages = [1, 2].map(i => queue.send({ project: "p", task: "t", kind: "TASK", from: "alice", to: "codex@b", summary: `check ${i}`, body: "claim", files: [], access: "read-only" }));
    const file = join(stateDir(), "peer", "peers.json"), good = readFileSync(file, "utf8");
    writeFileSync(file, "{");
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "task", "dispatch", "--loop", "--max", "1", "--interval", "0.05"], { env: childEnv(a), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`loop did not relay: ${output}`)), 15000);
      child!.once("error", e => { clearTimeout(timer); reject(e); });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`loop exited ${code}: ${output}`)); });
      child!.stderr!.on("data", b => { output += b; });
      child!.stdout!.on("data", b => {
        output += b;
        if (output.includes("[peer] failed:")) writeFileSync(file, good);
        if (messages.every(m => output.includes(`${m.id} → codex@b: delivered to b`))) { clearTimeout(timer); resolve(); }
      });
    });
    assert.match(output, /\[peer\] failed:/); assert.equal((output.match(/\[peer\].*delivered to b/g) ?? []).length, 2);
    use(a); for (const m of messages) assert.equal(queue.find(m.id)?.state, "done");
    use(b); assert.equal(queue.all().length, 2);
  } finally {
    if (child && child.exitCode === null) { const end = once(child, "exit"); child.kill(); await end; }
    await bs.stop();
  }
});
