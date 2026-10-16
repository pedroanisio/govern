import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeEnv, write } from "./helpers.ts";
import * as remote from "../ext/remote/remote.ts";
import * as pairing from "../ext/remote/remote-pair.ts";
import * as project from "../lib/project.ts";
import * as conversations from "../lib/conversation.ts";
import { GovernError } from "../lib/util.ts";

function local(f: () => void) {
  const e = makeEnv("remote-review"), old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify({ version: 1, name: "release", stages: [{ name: "draft" }], gates: [{ name: "final" }, { name: "legal", owner: "counsel" }] }));
    const cfg = join(e.root, "govern.config.json");
    write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, "unused"] } } }));
    project.create("r1", { process: "release" });
    project.appendLedger("r1", { kind: "test-setup" });
    f();
  } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const device = (person = "owner", lanes?: string[]) => remote.locked(() => remote.createDevice("phone", publicKey, person, lanes));
// Exercise the real HTTP handler without binding a socket (the sandbox forbids listen).
function call(server: ReturnType<typeof remote.remoteServer>, path: string, token?: string, body?: string, signature?: string, address = "127.0.0.1") {
  const req = Object.assign(new EventEmitter(), { method: body === undefined ? "GET" : "POST", url: path,
    headers: { authorization: token ? `Bearer ${token}` : undefined, "govern-signature": signature }, socket: { remoteAddress: address }, resume() {} });
  const res = Object.assign(new EventEmitter(), { headersSent: false, status: 0, data: "",
    writeHead(status: number) { this.status = status; this.headersSent = true; },
    write(text: string) { this.data += text; }, end(text = "") { this.data += text; },
  });
  server.emit("request", req, res);
  if (body !== undefined) { req.emit("data", Buffer.from(body)); req.emit("end"); }
  return res;
}

test("review: changes refuses non-owner without ledger, note or message", () => local(() => {
  conversations.create("chat", { adapter: "echo", lane: "r1" });
  const { device: d, token } = device("alice"), before = readFileSync(project.ledgerFile("r1"), "utf8"), state = readFileSync(project.stateFile("r1"), "utf8");
  const chat = readFileSync(join(conversations.directory("chat"), "session.json"), "utf8");
  assert.throws(() => remote.perform(d, { action: "changes", lane: "r1", gate: "final", quote: "fix it", at: new Date().toISOString(), nonce: "1234567890123456" }, Buffer.alloc(0), ""), GovernError);
  const body = JSON.stringify({ action: "changes", lane: "r1", gate: "final", quote: "fix it", at: new Date().toISOString(), nonce: "1234567890123456" });
  const res = call(remote.remoteServer(), "/v1/actions", token, body, sign("sha256", Buffer.from(body), kp.privateKey).toString("base64"));
  assert.equal(res.status, 409, res.data);
  assert.equal(readFileSync(project.ledgerFile("r1"), "utf8"), before);
  assert.equal(readFileSync(project.stateFile("r1"), "utf8"), state);
  assert.equal(readFileSync(join(conversations.directory("chat"), "session.json"), "utf8"), chat);
}));

test("review: broken sessions do not poison desks, lane reads or changes replies", () => local(() => {
  project.create("gone", { process: "release" });
  conversations.create("orphan", { adapter: "echo", lane: "gone" });
  conversations.create("broken", { adapter: "echo", lane: "r1" });
  write(join(conversations.directory("broken"), "session.json"), "{");
  rmSync(dirname(project.stateFile("gone")), { recursive: true });
  const server = remote.remoteServer();
  for (const lanes of [undefined, ["r1"]]) {
    const d = device("owner", lanes);
    const res = call(server, "/v1/desk", d.token);
    assert.equal(res.status, 200, res.data);
    const desk = JSON.parse(res.data);
    assert.ok(!desk.sessions.some((s: any) => s.id === "broken"));
    if (!lanes) { assert.equal(desk.sessions.find((s: any) => s.id === "orphan").needsDecision, false); assert.ok(desk.unreadableSessions.some((s: any) => s.id === "broken")); }
    else { assert.ok(!res.data.includes("orphan")); assert.deepEqual(desk.unreadableSessions, []); }
    assert.equal(call(server, "/v1/lane?slug=r1", d.token).status, 200);
  }
  const d = device(), body = JSON.stringify({ action: "changes", lane: "r1", gate: "final", quote: "fix it", at: new Date().toISOString(), nonce: "1234567890123456" });
  const res = call(server, "/v1/actions", d.token, body, sign("sha256", Buffer.from(body), kp.privateKey).toString("base64"));
  assert.equal(res.status, 200, res.data);
  assert.equal(project.load("r1").notes.at(-1)!.text, "changes requested on final by owner: fix it");
  assert.equal(readFileSync(project.ledgerFile("r1"), "utf8").split("\n").filter(l => l.includes('"changes-requested"')).length, 1);
}));

test("review: pairing caps are per address and global", () => local(() => {
  const server = remote.remoteServer(), body = JSON.stringify({ name: "phone", publicKey });
  const request = (address: string) => call(server, "/v1/pair/request", undefined, body, undefined, address);
  assert.equal(request("a").status, 201); assert.equal(request("a").status, 201);
  assert.equal(request("a").status, 429); assert.equal(request("b").status, 201);
  for (let i = 0; i < 29; i++) assert.equal(request(`other-${i}`).status, 201);
  assert.equal(request("fresh").status, 429);
}));

test("review: confirmation requires explicit scope when none requested", () => local(() => {
  for (const lanes of [undefined, []]) {
    const r = pairing.requestPairing({ name: "phone", publicKey, lanes });
    const code = pairing.comparisonCode(r.id, publicKey);
    assert.throws(() => pairing.confirmPairing(r.id, code), /choose the lanes: --lane SLUG \(repeatable\) or --all/);
    assert.equal(remote.devices().length, lanes === undefined ? 0 : 1);
    const d = pairing.confirmPairing(r.id, code, lanes === undefined ? { lanes: ["r1"] } : { all: true });
    assert.deepEqual(d.lanes, lanes === undefined ? ["r1"] : undefined);
    pairing.pollPairing(r.id, r.secret);
  }
}));

test("review: streams have device and global caps and release on close", () => local(() => {
  const server = remote.remoteServer(), a = device(), b = device(), opened: ReturnType<typeof call>[] = [];
  const open = (token: string) => { const r = call(server, "/v1/stream", token); if (r.status === 200) opened.push(r); return r; };
  try {
    assert.equal(open(a.token).status, 200); assert.equal(open(a.token).status, 200);
    assert.equal(open(a.token).status, 429); assert.equal(open(b.token).status, 200);
    opened.shift()!.emit("close"); assert.equal(open(a.token).status, 200);
    while (opened.length < remote.MAX_STREAMS) assert.equal(open(device().token).status, 200);
    assert.equal(open(device().token).status, 429);
  } finally { for (const r of opened) r.emit("close"); server.close(); }
}));

test("review: legacy expiry and desk cache use injected clock; oversized action returns 413", () => local(() => {
  const pg = remote.createPairing("owner", 10), expiry = Date.parse(pg.expires);
  const lateServer = remote.remoteServer({ now: () => expiry + 1 });
  const expired = call(lateServer, "/v1/pair", undefined, JSON.stringify({ code: pg.code, name: "late", publicKey }));
  assert.equal(expired.status, 403); assert.match(expired.data, /expired/);
  const pg2 = remote.createPairing("owner", 10);
  assert.throws(() => remote.pair(pg2.code, "late", publicKey, Date.parse(pg2.expires) + 1), /expired/);
  const fresh = remote.createPairing("owner", 10), time = Date.parse(fresh.expires) - 1;
  const paired = remote.pair(fresh.code, "on time", publicKey, time);
  assert.equal(paired.device.pairedAt, new Date(time).toISOString());
  let now = time;
  const server = remote.remoteServer({ now: () => now, streamIntervalMs: 100 });
  const read = () => JSON.parse(call(server, "/v1/desk", paired.token).data);
  const before = read().lanes[0].title;
  const p = project.load("r1"); p.title = "changed"; project.save(p);
  assert.equal(read().lanes[0].title, before);
  now += 100; assert.equal(read().lanes[0].title, "changed");
  assert.equal(call(server, "/v1/actions", paired.token, "x".repeat(65537)).status, 413);
}));
