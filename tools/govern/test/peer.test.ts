// Peer protocol tests use two isolated workspaces and an in-process signed transport.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { makeEnv, childEnv, reply, write, jsonl } from "./helpers.ts";
import * as peer from "../lib/peer.ts";
import * as queue from "../lib/queue.ts";
import { stateDir } from "../lib/workspace.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const use = (e: ReturnType<typeof makeEnv>) => { process.env = childEnv(e); };
function pair() {
  const a = makeEnv("peer-a"), b = makeEnv("peer-b");
  use(a); const ai = peer.identity("a");
  use(b); const bi = peer.identity("b");
  peer.addPeer({ name: "a", url: "https://a.example", publicKey: ai.publicKey, allow: ["codex", "alice"], projects: ["p"] });
  use(a); peer.addPeer({ name: "b", url: "http://127.0.0.1:5003", publicKey: bi.publicKey, allow: ["codex", "alice"], projects: ["p"] });
  return { a, b, ai, bi };
}
const send = (extra: Partial<queue.Message> = {}) => queue.send({ project: "p", task: "t", kind: "TASK", from: "alice", to: "codex@b", summary: "please check", body: "the claim", files: [], access: "read-only", ...extra });
const raw = () => ({ protocol: "govern-peer/1", id: "origin-id", at: new Date(NOW).toISOString(), message: { project: "p", task: "t", kind: "TASK", from: "alice", to: "codex", summary: "check", body: "claim" } });
function signed(value: unknown, ai: peer.Identity) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, headers: peer.sign(bytes, ai) };
}

test("peer identity, registry and address validation", () => {
  const { a, ai, bi } = pair(); use(a);
  assert.deepEqual(peer.identity("a"), ai);
  assert.throws(() => peer.identity("other"), /name/);
  assert.equal(peer.fingerprint(ai.publicKey).length, 64);
  assert.notEqual(peer.fingerprint(ai.publicKey), peer.fingerprint(bi.publicKey));
  assert.equal(statSync(join(stateDir(), "peer")).mode & 0o777, 0o700);
  assert.equal(statSync(join(stateDir(), "peer/host.json")).mode & 0o777, 0o600);
  assert.deepEqual(peer.parseAddress("codex@b"), { name: "codex", peer: "b" });
  for (const v of ["codex", "Codex@b", "codex@@b", "../x@b"]) assert.equal(peer.parseAddress(v), undefined);
  assert.throws(() => send({ to: "codex@@b" }), /--to/);
  assert.throws(() => peer.addPeer({ ...peer.peers()[0]!, name: "b" }), /duplicate/);
  peer.revokePeer("b"); assert.ok(peer.peers()[0]!.revokedAt);
  peer.addPeer({ name: "b", url: "https://new.example", publicKey: bi.publicKey, allow: [], projects: ["*"] });
  assert.equal(peer.peers().length, 2);
});

test("two hosts round trip through dispatch and relay preserves thread and local profile", async () => {
  const { a, b } = pair(); use(a); const orig = send();
  assert.deepEqual(queue.dispatch(), []); assert.equal(queue.find(orig.id)?.state, "open");
  await peer.push({ now: NOW, post: async (url, bytes, headers, timeout) => {
    assert.equal(url, "http://127.0.0.1:5003/v1/peer/deliver"); assert.equal(timeout, 15000);
    use(b); const r = peer.receive(bytes, headers, NOW); use(a); return { status: r.status, text: JSON.stringify(r.body) };
  } });
  assert.equal(queue.find(orig.id)?.state, "done");
  assert.equal(jsonl(join(queue.QUEUE(), "ledger.jsonl"))[0].kind, "relay");
  use(b); const incoming = queue.all()[0]!.m;
  assert.equal(incoming.from, "alice@a"); assert.equal(incoming.to, "codex"); assert.equal(incoming.profile, "codex-read");
  assert.deepEqual(incoming.remote, { peer: "a", id: orig.id }); assert.deepEqual(incoming.files, []);
  assert.equal(incoming.access, "read-only"); assert.equal(incoming.lane, undefined); assert.equal(incoming.estimateUsd, undefined);
  assert.match(queue.prompt(incoming), /from alice@a \(another host\)/);
  process.env.FAKE_CODEX_SCRIPTS = reply(b, "answer", { kind: "HANDOFF", summary: "checked", body: "answer" });
  const dispatched = queue.dispatch(); assert.match(dispatched[0]!, /HANDOFF/, JSON.stringify(queue.find(incoming.id)));
  const answer = queue.all().find(x => x.m.to === "alice@a")!.m;
  const env = peer.envelope(answer, NOW); assert.equal(env.message.replyTo, orig.id);
  await peer.push({ now: NOW, post: async (_url, bytes, headers) => {
    use(a); const r = peer.receive(bytes, headers, NOW); use(b); return { status: r.status, text: JSON.stringify(r.body) };
  } });
  use(a); const received = queue.all().find(x => x.m.remote)!.m;
  assert.equal(received.replyTo, orig.id); assert.deepEqual(queue.thread(received).map(x => x.id), [orig.id, received.id]);
});

const refusals: [string, number, (v: any) => void][] = [
  ["unknown envelope key", 400, v => { v.extra = true; }],
  ["unknown message key", 400, v => { v.message.profile = "codex-write"; }],
  ["wrong protocol", 400, v => { v.protocol = "other"; }],
  ["stale at", 403, v => { v.at = new Date(NOW - 300001).toISOString(); }],
  ["future at", 403, v => { v.at = new Date(NOW + 300001).toISOString(); }],
  ["invalid timestamp", 400, v => { v.at = "no"; }],
  ["invalid kind", 400, v => { v.message.kind = "BOGUS"; }],
  ["empty summary", 400, v => { v.message.summary = "  "; }],
  ["long summary", 400, v => { v.message.summary = "x".repeat(201); }],
  ["disallowed recipient", 403, v => { v.message.to = "owner"; }],
  ["disallowed project", 403, v => { v.message.project = "other"; }],
  ["unrelated replyTo", 400, v => { v.message.replyTo = send({ to: "owner" }).id; }],
  ["missing replyTo", 400, v => { v.message.replyTo = "absent"; }],
  ["remote to", 400, v => { v.message.to = "codex@b"; }],
  ["remote from", 400, v => { v.message.from = "alice@a"; }],
  ["invalid project", 400, v => { v.message.project = "../p"; }],
];
for (const [label, status, mutate] of refusals) test(`receive refuses ${label} without filing`, () => {
  const { b, ai } = pair(); use(b); const v = raw(); mutate(v); const before = queue.all();
  const s = signed(v, ai), r = peer.receive(s.bytes, s.headers, NOW);
  assert.equal(r.status, status, JSON.stringify(r.body)); assert.deepEqual(queue.all(), before);
  if (status === 400) assert.match(JSON.stringify(r.body), /\$/);
});
for (const label of ["unknown fingerprint", "revoked peer", "bad signature", "changed body", "oversized body", "signed invalid JSON"]) test(`receive refuses ${label} before filing`, () => {
  const { b, ai } = pair(); use(b); let { bytes, headers } = signed(raw(), ai);
  let status = 403;
  if (label === "unknown fingerprint") headers["Govern-Peer-Key"] = "0".repeat(64);
  if (label === "revoked peer") peer.revokePeer("a");
  if (label === "bad signature") headers["Govern-Signature"] = "not-a-signature";
  if (label === "changed body") bytes = Buffer.from(bytes.toString().replace("claim", "other"));
  if (label === "oversized body") { bytes = Buffer.alloc(262145); status = 413; }
  if (label === "signed invalid JSON") { bytes = Buffer.from("{"); headers = peer.sign(bytes, ai); status = 400; }
  const r = peer.receive(bytes, headers, NOW); assert.equal(r.status, status); assert.equal(queue.all().length, 0);
});
test("duplicate delivery returns same id and prunes received ids after seven days", () => {
  const { b, ai } = pair(); use(b); const s = signed(raw(), ai);
  const first = peer.receive(s.bytes, s.headers, NOW); assert.equal(first.status, 200);
  const again = peer.receive(s.bytes, s.headers, NOW); assert.equal(again.body.id, first.body.id); assert.equal(again.body.duplicate, true); assert.equal(queue.all().length, 1);
  const v = raw(); v.at = new Date(NOW + 8 * 86400000).toISOString(); const next = signed(v, ai);
  assert.equal(peer.receive(next.bytes, next.headers, NOW + 8 * 86400000).status, 200); assert.equal(queue.all().length, 2);
});

for (const [label, patch] of Object.entries({ unverified: { verification: { state: "unverified", reason: "bad" } }, files: { files: ["govern.config.json"] }, profile: { profile: "codex-read" }, lane: { lane: "p" }, estimateUsd: { estimateUsd: 0 }, write: { access: "write" }, revoked: {}, unknown: { to: "codex@missing" }, oversized: { body: "x".repeat(262144) } })) test(`relay refuses ${label} and notifies owner`, async () => {
  const { a } = pair(); use(a); const m = send({ from: "codex", ...patch } as Partial<queue.Message>);
  if (label === "revoked") peer.revokePeer("b");
  await peer.push({ now: NOW, post: async () => { assert.fail("transport must not run"); } });
  assert.equal(queue.find(m.id)?.state, "failed");
  const notice = queue.all().find(x => x.m.kind === "BLOCKED")!.m; assert.equal(notice.to, "owner"); assert.equal(notice.replyTo, m.id);
  assert.match(notice.body, /refused|unverified|files|profile|lane|estimate|write|peer|size|limit/i);
});
for (const mode of ["throw", "503", "429", "invalid success"]) test(`relay retries ${mode}, skips backoff and fails on eighth attempt`, async () => {
  const { a } = pair(); use(a); const m = send(); let calls = 0, now = NOW;
  const post: peer.Post = async () => { calls++; if (mode === "throw") throw new Error("offline"); return mode === "invalid success" ? { status: 200, text: '{"protocol":"govern-peer/1","id":"x","extra":1}' } : { status: Number(mode), text: "busy" }; };
  for (let attempt = 1; attempt <= 8; attempt++) {
    await peer.push({ now, post });
    const hit = queue.find(m.id)!;
    if (attempt < 8) {
      assert.equal(hit.state, "open"); assert.equal(hit.m.relay?.attempts, attempt);
      const next = Date.parse(hit.m.relay!.nextAt); assert.equal(next - now, Math.min(30000 * 2 ** (attempt - 1), 3600000));
      await peer.push({ now: next - 1, post }); assert.equal(calls, attempt); now = next;
    } else assert.equal(hit.state, "failed");
  }
  assert.equal(calls, 8); assert.equal(queue.all().filter(x => x.m.kind === "BLOCKED").length, 1);
});
test("relay refreshes each envelope timestamp during a long pass", async () => {
  const { a, b } = pair(); use(a);
  const messages = Array.from({ length: 30 }, () => send());
  let now = NOW, calls = 0;
  await peer.push({ now: () => now, post: async (_url, bytes, headers) => {
    calls++; now += 20_000;
    assert.ok(Math.abs(Date.parse(JSON.parse(bytes.toString()).at) - now) <= 300_000);
    use(b); const r = peer.receive(bytes, headers, now); use(a);
    return { status: r.status, text: JSON.stringify(r.body) };
  } });
  assert.equal(calls, 30);
  for (const m of messages) assert.equal(queue.find(m.id)?.state, "done");
  use(b); assert.equal(queue.all().length, 30);
});
test("relay schedules backoff from the clock after each failed post", async () => {
  const { a } = pair(); use(a); const messages = [send(), send()]; let now = NOW;
  await peer.push({ now: () => now, post: async () => { now += 20_000; return { status: 503, text: "busy" }; } });
  assert.equal(now, NOW + 40_000);
  const next = messages.map(m => {
    const hit = queue.find(m.id)!; assert.equal(hit.state, "open"); assert.equal(hit.m.relay?.attempts, 1);
    return Date.parse(hit.m.relay!.nextAt);
  }).sort((a, b) => a - b);
  assert.deepEqual(next, [NOW + 50_000, NOW + 70_000]);
});
for (const from of ["codex", "dispatcher", "relay", "alice", "alice@b"]) test(`relay failure notice reaches the reader for ${from}`, async () => {
  const { a, b } = pair(); use(a); const m = send({ from, files: ["govern.config.json"] });
  await peer.push({ now: NOW, post: async () => { assert.fail("transport must not run"); } });
  assert.equal(queue.find(m.id)?.state, "failed");
  const notice = queue.all().find(x => x.m.replyTo === m.id)!.m;
  assert.equal(notice.kind, "BLOCKED"); assert.equal(notice.from, "relay");
  assert.equal(notice.to, ["codex", "dispatcher", "relay"].includes(from) ? "owner" : from);
  if (from === "alice@b") {
    await peer.push({ now: NOW, post: async (_url, bytes, headers) => {
      use(b); const r = peer.receive(bytes, headers, NOW); use(a); return { status: r.status, text: JSON.stringify(r.body) };
    } });
    assert.equal(queue.find(notice.id)?.state, "done");
    use(b); const incoming = queue.all()[0]!.m; assert.equal(incoming.to, "alice"); assert.equal(incoming.kind, "BLOCKED");
  }
});
test("relay permanent 403 fails immediately and clips peer error", async () => {
  const { a } = pair(); use(a); const m = send();
  await peer.push({ now: NOW, post: async () => ({ status: 403, text: "denied" + "x".repeat(1000) }) });
  assert.equal(queue.find(m.id)?.state, "failed"); assert.ok(queue.find(m.id)!.m.result!.error!.length < 400);
});
test("relay max, oldest first, translated replyTo only for target peer, and duplicate success", async () => {
  const { a } = pair(); use(a); const local = send({ to: "owner" });
  const m = send({ replyTo: local.id }); const second = send(); let calls = 0;
  // Give the ordering a deterministic tie breaker independent of random message ids.
  m.created = new Date(NOW - 1000).toISOString(); write(join(queue.QUEUE(), "open", `${m.id}.json`), JSON.stringify(m));
  await peer.push({ max: 1, now: NOW, post: async (_url, bytes) => { calls++; assert.equal(JSON.parse(bytes.toString()).message.replyTo, undefined); return { status: 200, text: '{"protocol":"govern-peer/1","id":"remote","duplicate":true}' }; } });
  assert.equal(calls, 1); assert.equal(queue.find(m.id)?.state, "done"); assert.equal(queue.find(second.id)?.state, "open");
});

for (const label of ["not JSON", "unknown host key", "bad host key", "mismatched host key", "unknown peer key", "bad URL", "remote http", "bad public key", "duplicate live name"]) test(`state refuses ${label} naming file and path`, () => {
  const { a, bi } = pair(); use(a); const file = join(stateDir(), "peer", label.includes("host") ? "host.json" : "peers.json");
  let v = JSON.parse(readFileSync(file, "utf8"));
  if (label === "not JSON") write(file, "{");
  else {
    if (label === "unknown host key") v.extra = 1;
    if (label === "bad host key") v.privateKey = "bad";
    if (label === "mismatched host key") v.publicKey = bi.publicKey;
    if (label === "unknown peer key") v.peers[0].extra = 1;
    if (label === "bad URL") v.peers[0].url = "bad";
    if (label === "remote http") v.peers[0].url = "http://example.com";
    if (label === "bad public key") v.peers[0].publicKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    if (label === "duplicate live name") v.peers.push(v.peers[0]);
    write(file, JSON.stringify(v));
  }
  assert.throws(() => label.includes("host") ? peer.identity() : peer.peers(), (e: Error) => e.message.includes(file) && (label === "not JSON" ? /not JSON/.test(e.message) : /\$/.test(e.message)));
});

test("in-process reply relays back into the original thread without a child process", async () => {
  const { a, b } = pair(); use(a); const orig = send();
  const transport = (source: typeof a, dest: typeof a): peer.Post => async (_url, bytes, headers) => {
    use(dest); const r = peer.receive(bytes, headers, NOW); use(source); return { status: r.status, text: JSON.stringify(r.body) };
  };
  await peer.push({ now: NOW, post: transport(a, b) });
  use(b); const incoming = queue.all()[0]!.m;
  queue.reply(incoming.id, "codex", { kind: "HANDOFF", summary: "checked", body: "answer" });
  await peer.push({ now: NOW, post: transport(b, a) });
  use(a); const answer = queue.all().find(x => x.m.remote)!.m;
  assert.equal(answer.from, "codex@b"); assert.equal(answer.to, "alice");
  assert.deepEqual(queue.thread(answer).map(x => x.id), [orig.id, answer.id]);
});
test("receiver accepts wildcard projects and a reply to a message received from the peer", () => {
  const { b, ai } = pair(); use(b); peer.revokePeer("a");
  peer.addPeer({ name: "a", url: "https://a.example", publicKey: ai.publicKey, allow: ["codex"], projects: ["*"] });
  const s = signed(raw(), ai), first = peer.receive(s.bytes, s.headers, NOW);
  const v = { ...raw(), id: "second-id", message: { ...raw().message, project: "other", replyTo: first.body.id } };
  const next = signed(v, ai); const r = peer.receive(next.bytes, next.headers, NOW);
  assert.equal(r.status, 200); assert.equal(queue.find(r.body.id!)!.m.replyTo, first.body.id);
});
test("receiver authenticates malformed JSON before parsing and checks stale duplicates", () => {
  const { b, ai } = pair(); use(b); const bytes = Buffer.from("{");
  assert.deepEqual(peer.receive(bytes, { "govern-peer-key": "unknown", "govern-signature": "bad" }, NOW), { status: 403, body: { error: "unknown peer" } });
  assert.deepEqual(peer.receive(bytes, { "Govern-Peer-Key": peer.fingerprint(ai.publicKey), "Govern-Signature": "bad" }, NOW), { status: 403, body: { error: "bad signature" } });
  const s = signed(raw(), ai); assert.equal(peer.receive(s.bytes, s.headers, NOW).status, 200);
  assert.equal(peer.receive(s.bytes, s.headers, NOW + 300001).status, 403);
  assert.equal(queue.all().length, 1);
});
for (const [fileName, value, path] of [
  ["host.json", "{", "not JSON"],
  ["host.json", '{"name":"Bad","publicKey":"x","privateKey":"x"}', "$.name"],
  ["peers.json", '{"peers":null}', "$.peers"],
  ["received.json", '{"received":[],"extra":1}', "$.extra"],
] as const) test(`state ${fileName} rejects ${path}`, () => {
  const { b, ai } = pair(); use(b); const f = join(stateDir(), "peer", fileName); write(f, value);
  assert.throws(() => fileName === "host.json" ? peer.identity() : fileName === "peers.json" ? peer.peers() : peer.receive(signed(raw(), ai).bytes, signed(raw(), ai).headers, NOW), (e: Error) => e.message.includes(f) && e.message.includes(path));
});
test("relay does not forward replyTo from a different peer", () => {
  const { a } = pair(); use(a); const parent = send({ to: "alice", from: "codex@c", remote: { peer: "c", id: "foreign-id" } });
  assert.equal(peer.envelope(send({ replyTo: parent.id }), NOW).message.replyTo, undefined);
});
