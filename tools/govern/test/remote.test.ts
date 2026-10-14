// govern remote (lib/remote.ts, REMOTE.md): pairing, bearer reads, signed actions and the desk stream, over real HTTP
// against a throwaway workspace. The device key is a P-256 pair made here, as the Android Keystore would make it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomBytes, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";
import { makeEnv, govern, write, jsonl, asSession, type Env } from "./helpers.ts";
import { remoteServer, createPairing, revoke, PAIR_ATTEMPTS, MAX_STREAMS } from "../lib/remote.ts";
import { PROTOCOL } from "../lib/remote-view.ts";
import { encode, render } from "../lib/qr.ts";
import type { Project } from "../lib/project.ts";

const PROCESS = {
  version: 1, name: "release",
  people: { alice: { user: "govern-test-alice" }, bob: { user: "govern-test-bob" } },
  stages: [{ name: "draft" }, { name: "ship" }],
  gates: [
    { name: "final", stage: "draft" },
    { name: "publish", stage: "ship", needs: ["final"], message: "needs the final approval first" },
    { name: "legal", stage: "draft", owner: "counsel" },
    { name: "board", stage: "draft", policy: { people: ["alice", "bob"], quorum: 2 } },
  ],
};

function setup(): Env {
  const e = makeEnv("remote");
  write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify(PROCESS));
  const r = govern(e, ["new", "r1", "--process", "release", "--title", "Release one"]);
  assert.equal(r.code, 0, r.out + r.err);
  return e;
}
const stateOf = (e: Env, slug = "r1"): Project => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));

/** Runs `f` with GOVERN_REPO pointing at the workspace and a server listening on a free loopback port. */
async function serving(e: Env, f: (base: string) => Promise<void>, o: Parameters<typeof remoteServer>[0] = {}): Promise<void> {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const server: Server = remoteServer({ streamIntervalMs: 50, pingMs: 1000, ...o });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}`); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old;
  }
}

interface Phone { key: KeyObject; publicKey: string; token: string; id: string }
function keyPair(): { key: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { key: privateKey, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

async function pairPhone(base: string, person = "owner"): Promise<Phone> {
  const { code } = createPairing(person, 10);
  const kp = keyPair();
  const r = await post(`${base}/v1/pair`, JSON.stringify({ code, name: "Pixel test", publicKey: kp.publicKey }));
  assert.equal(r.status, 200);
  const j = await r.json() as { protocol: string; deviceId: string; person: string; token: string };
  assert.equal(j.protocol, PROTOCOL);
  assert.equal(j.person, person);
  return { ...kp, token: j.token, id: j.deviceId };
}
const auth = (p: Phone) => ({ Authorization: `Bearer ${p.token}` });

/** A signed action as the app sends it: the body is signed as sent (ECDSA P-256, SHA-256, DER signature). */
function action(p: Phone, fields: Record<string, unknown>, o: { at?: string; nonce?: string } = {}): { body: string; sig: string } {
  const body = JSON.stringify({ ...fields, nonce: o.nonce ?? randomBytes(16).toString("base64url"), at: o.at ?? new Date().toISOString() });
  return { body, sig: sign("sha256", Buffer.from(body), p.key).toString("base64") };
}
const act = (base: string, p: Phone, a: { body: string; sig: string }) => post(`${base}/v1/actions`, a.body, { ...auth(p), "Govern-Signature": a.sig });

test("health answers without a token; every other route needs a paired device's token", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const h = await fetch(`${base}/v1/health`);
    assert.equal(h.status, 200);
    assert.equal((await h.json() as { protocol: string }).protocol, PROTOCOL);
    assert.equal((await fetch(`${base}/v1/desk`)).status, 401);
    assert.equal((await fetch(`${base}/v1/desk`, { headers: { Authorization: "Bearer not-a-token" } })).status, 401);
    assert.equal((await fetch(`${base}/v1/lane?slug=r1`)).status, 401);
  });
});

test("a code pairs one device; wrong codes count and void it; a used or missing code pairs nothing", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const kp = keyPair();
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code: "AAAA-BBBB-CCCC", name: "x", publicKey: kp.publicKey }))).status, 403, "no code open");
    const { code } = createPairing("owner", 10);
    for (let i = 1; i < PAIR_ATTEMPTS; i++)
      assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code: "WRONG-CODE-0000", name: "x", publicKey: kp.publicKey }))).status, 403);
    const last = await post(`${base}/v1/pair`, JSON.stringify({ code: "WRONG-CODE-0000", name: "x", publicKey: kp.publicKey }));
    assert.match((await last.json() as { error: string }).error, /now void/);
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code, name: "x", publicKey: kp.publicKey }))).status, 403, "the right code after the void");
    const phone = await pairPhone(base);
    assert.match(phone.token, /^[A-Za-z0-9_-]{43}$/);
    const fresh = createPairing("owner", 10);
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code: fresh.code.toLowerCase().replace(/-/g, " "), name: "y", publicKey: kp.publicKey }))).status, 200, "case and separators fold");
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code: fresh.code, name: "z", publicKey: kp.publicKey }))).status, 403, "single use");
    const devices = JSON.parse(readFileSync(join(e.root, "PALS-Notes", "govern-state", "remote", "devices.json"), "utf8")).devices;
    assert.equal(devices.length, 2);
    assert.ok(!JSON.stringify(devices).includes(phone.token), "only the token's hash is stored");
    assert.equal(statSync(join(e.root, "PALS-Notes", "govern-state", "remote", "devices.json")).mode & 0o777, 0o600);
  });
});

test("pairing refuses malformed requests and keys that are not P-256", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const { code } = createPairing("owner", 10);
    assert.equal((await post(`${base}/v1/pair`, "{")).status, 400);
    assert.equal((await post(`${base}/v1/pair`, " ".repeat(65537))).status, 413);
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code, name: "x" }))).status, 400, "publicKey missing");
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code, name: "x", publicKey: "x", extra: 1 }))).status, 400, "unknown field");
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code, name: "x", publicKey: "bm90IGEga2V5" }))).status, 400);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const r = await post(`${base}/v1/pair`, JSON.stringify({ code, name: "x", publicKey: rsa }));
    assert.equal(r.status, 400);
    assert.match((await r.json() as { error: string }).error, /P-256/);
    assert.equal((await post(`${base}/v1/pair`, JSON.stringify({ code, name: "x", publicKey: keyPair().publicKey }))).status, 200, "the code survived the malformed tries");
  });
});

test("desk and lane views carry the lanes, their gates and today's telemetry", async () => {
  const e = setup();
  assert.equal(govern(e, ["cmd", "r1", "test", "--", "true"]).code, 0);
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const desk = await (await fetch(`${base}/v1/desk`, { headers: auth(phone) })).json() as any;
    assert.equal(desk.protocol, PROTOCOL);
    assert.equal(desk.lanes.length, 1);
    const lane = desk.lanes[0];
    assert.equal(lane.slug, "r1");
    assert.equal(lane.title, "Release one");
    assert.equal(lane.process, "release");
    assert.deepEqual([lane.stage, lane.stageIndex, lane.stageCount, lane.state], ["draft", 0, 2, "open"]);
    assert.deepEqual(lane.gates.map((g: any) => [g.name, g.owner, g.policy, g.approved]),
      [["final", "owner", false, false], ["publish", "owner", false, false], ["legal", "counsel", false, false], ["board", "owner", true, false]]);
    assert.deepEqual(Object.keys(desk.telemetry).sort(), ["allowances", "day", "dispatcher", "inbox", "machines", "queue", "tokens"]);
    assert.deepEqual(desk.telemetry.queue.runners.map((r: any) => r.runner), ["codex", "claude", "grok"]);
    const detail = await (await fetch(`${base}/v1/lane?slug=r1`, { headers: auth(phone) })).json() as any;
    assert.deepEqual(detail.stages, ["draft", "ship"]);
    assert.deepEqual(detail.ledger.map((x: any) => x.kind), ["cmd-set"]);
    assert.match(detail.ledger[0].text, /"name":"test"/);
    assert.equal((await fetch(`${base}/v1/lane?slug=nope`, { headers: auth(phone) })).status, 404);
    assert.equal((await fetch(`${base}/v1/lane?slug=..%2Fx`, { headers: auth(phone) })).status, 400);
    assert.equal((await fetch(`${base}/v1/nothing`, { headers: auth(phone) })).status, 404);
  });
});

test("a signed approval records the owner's words with the device as their source", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const a = action(phone, { action: "approve", lane: "r1", gate: "final", quote: "final cut looks right, approved" });
    const r = await act(base, phone, a);
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json() as any;
    assert.equal(j.lane.gates.find((g: any) => g.name === "final").approved, true);
    assert.equal(j.lane.gates.find((g: any) => g.name === "final").approvedBy, "owner");
    assert.equal(j.lane.gates.find((g: any) => g.name === "final").quote, "final cut looks right, approved");
    assert.equal(j.lane.decisions[0].device, phone.id);
    const approval = stateOf(e).approvals.final!;
    assert.equal(approval.quote, "final cut looks right, approved");
    assert.equal(approval.by, "owner");
    assert.deepEqual(approval.source, { kind: "device", device: phone.id, signedBody: a.body, signature: a.sig });
    const led = jsonl(join(e.projects, "r1", "govern", "ledger.jsonl")).filter((x) => x.kind === "approve");
    assert.equal(led.length, 1);
    assert.equal(led[0].source.kind, "device");
    // the stored lane still parses: the brief reads it
    assert.match(govern(e, ["brief", "r1"]).out, /final ✓/);
  });
});

test("signed actions are refused when unsigned, tampered, replayed, stale or signed by another key", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const phone = await pairPhone(base), other = keyPair();
    const fields = { action: "approve", lane: "r1", gate: "final", quote: "yes, approved" };
    const unsigned = action(phone, fields);
    assert.equal((await post(`${base}/v1/actions`, unsigned.body, auth(phone))).status, 403);
    const signed = action(phone, fields);
    assert.equal((await act(base, phone, { body: signed.body.replace("final", "legal"), sig: signed.sig })).status, 403, "tampered");
    const foreign = action({ ...phone, key: other.key }, fields);
    assert.equal((await act(base, phone, foreign)).status, 403, "another key");
    const stale = action(phone, fields, { at: new Date(Date.now() - 10 * 60_000).toISOString() });
    assert.match((await (await act(base, phone, stale)).json() as any).error, /minutes from the server's clock/);
    const good = action(phone, fields);
    assert.equal((await act(base, phone, good)).status, 200);
    const again = await act(base, phone, good);
    assert.equal(again.status, 403);
    assert.match((await again.json() as any).error, /nonce reused/);
    const extra = action(phone, { ...fields, gate: "publish", force: true });
    assert.equal((await act(base, phone, extra)).status, 400, "unknown field");
    const shortQuote = action(phone, { ...fields, gate: "publish", quote: "y" });
    assert.equal((await act(base, phone, shortQuote)).status, 400);
    assert.equal(jsonl(join(e.projects, "r1", "govern", "ledger.jsonl")).filter((x) => x.kind === "approve").length, 1);
  });
});

test("a device approves only what its person may: needs, other owners and policy gates are refused", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const publish = await act(base, phone, action(phone, { action: "approve", lane: "r1", gate: "publish", quote: "publish it" }));
    assert.equal(publish.status, 409);
    assert.match((await publish.json() as any).error, /needs the final approval first/);
    const legal = await act(base, phone, action(phone, { action: "approve", lane: "r1", gate: "legal", quote: "legal ok" }));
    assert.equal(legal.status, 409);
    assert.match((await legal.json() as any).error, /decided by counsel, not owner/);
    const board = await act(base, phone, action(phone, { action: "approve", lane: "r1", gate: "board", quote: "board ok" }));
    assert.equal(board.status, 409);
    assert.match((await board.json() as any).error, /approval policy/);
    assert.equal((await act(base, phone, action(phone, { action: "approve", lane: "r1", gate: "nope", quote: "ok ok" }))).status, 409);
    assert.equal((await act(base, phone, action(phone, { action: "approve", lane: "zz", gate: "final", quote: "ok ok" }))).status, 404);
    const counsel = await pairPhone(base, "counsel");
    assert.equal((await act(base, counsel, action(counsel, { action: "approve", lane: "r1", gate: "legal", quote: "cleared by counsel" }))).status, 200);
    assert.equal(stateOf(e).approvals.legal!.by, "counsel");
    assert.deepEqual(Object.keys(stateOf(e).approvals), ["legal"]);
  });
});

test("an alert is acknowledged by a signed ack, once", async () => {
  const e = setup();
  const p = stateOf(e);
  p.alerts = [{ id: "a-1", stage: "draft", kind: "due", at: new Date().toISOString(), message: "draft is due" }];
  write(join(e.projects, "r1", "govern.json"), JSON.stringify(p));
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const desk = await (await fetch(`${base}/v1/desk`, { headers: auth(phone) })).json() as any;
    assert.equal(desk.lanes[0].openAlerts, 1);
    assert.equal((await act(base, phone, action(phone, { action: "ack", lane: "r1", alert: "a-1" }))).status, 200);
    assert.ok(stateOf(e).alerts![0]!.acknowledgedAt);
    assert.equal((await act(base, phone, action(phone, { action: "ack", lane: "r1", alert: "a-1" }))).status, 409);
    assert.equal((await act(base, phone, action(phone, { action: "ack", lane: "r1", alert: "a-9" }))).status, 409);
    assert.equal(stateOf(e).approvals.final, undefined, "an ack approves nothing");
  });
});

/** Reads server-sent events from `path` until `until` returns true for the events so far; the connection is then closed. */
function events(base: string, token: string, until: (ev: { event: string; data: string }[], ended: boolean) => boolean): Promise<{ event: string; data: string }[]> {
  return new Promise((resolve, reject) => {
    const got: { event: string; data: string }[] = [];
    const req = request(`${base}/v1/stream`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let buf = "";
      const done = (ended: boolean) => { if (until(got, ended) || ended) { req.destroy(); resolve(got); } };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data !== undefined) got.push({ event: ev, data });
        }
        done(false);
      });
      res.on("end", () => done(true));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the stream sends the desk, then a new desk when a lane changes, and ends when the device is revoked", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    let approved = false;
    const got = await events(base, phone.token, (ev) => {
      if (ev.length === 1 && !approved) {
        approved = true;
        void act(base, phone, action(phone, { action: "approve", lane: "r1", gate: "final", quote: "approve the final" }));
      }
      return ev.length >= 2;
    });
    assert.deepEqual(got.map((x) => x.event), ["desk", "desk"]);
    const second = JSON.parse(got[1]!.data);
    assert.equal(second.lanes[0].gates[0].approved, true);
    let revoked = false;
    const ended = events(base, phone.token, (ev, end) => { if (ev.length === 1 && !revoked) { revoked = true; revoke(phone.id); } return end; });
    assert.equal((await ended).length, 1, "one desk, then the stream closed");
    assert.equal((await fetch(`${base}/v1/desk`, { headers: auth(phone) })).status, 401);
  });
});

test("streams are bounded in number", async () => {
  const e = setup();
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const open = await Promise.all(Array.from({ length: MAX_STREAMS }, () => fetch(`${base}/v1/stream`, { headers: auth(phone) })));
    assert.ok(open.every((r) => r.status === 200));
    assert.equal((await fetch(`${base}/v1/stream`, { headers: auth(phone) })).status, 429);
    for (const r of open) await r.body?.cancel();
  });
});

test("govern remote pair --url draws the pairing link as a QR code for the phone's camera; --no-qr leaves it out", () => {
  const e = setup();
  const r = govern(e, ["remote", "pair", "--url", "http://127.0.0.1:5002"]);
  assert.equal(r.code, 0, r.err);
  const link = /pairing link[^:]*: (govern-remote:\/\/pair\?\S+)/.exec(r.out)?.[1];
  assert.ok(link, r.out);
  assert.ok(r.out.includes(render(encode(link), { colour: false })), "the QR code of the printed link, undecorated off a terminal");
  assert.match(r.out, /scan it with the phone's camera/);
  const bare = govern(e, ["remote", "pair", "--url", "http://127.0.0.1:5002", "--no-qr"]);
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.out, /govern-remote:\/\/pair\?/);
  assert.doesNotMatch(bare.out, /[▀▄█]/u);
  assert.doesNotMatch(govern(e, ["remote", "pair"]).out, /[▀▄█]/u, "no link without --url, so no code");
});

test("govern remote pair needs the owner's terminal; serve refuses a public host without TLS", () => {
  const e = setup();
  const r = govern(e, ["remote", "pair", "--url", "https://govern.example.ts.net"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pairing code [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  assert.match(r.out, /govern-remote:\/\/pair\?url=https%3A%2F%2Fgovern\.example\.ts\.net&code=/);
  asSession(e, "s-remote");
  const inSession = govern(e, ["remote", "pair"], { CLAUDE_CODE_SESSION_ID: "s-remote" });
  assert.equal(inSession.code, 1);
  assert.match(inSession.err, /owner's own terminal/);
  const pub = govern(e, ["remote", "serve", "--host", "0.0.0.0"]);
  assert.equal(pub.code, 2);
  assert.match(pub.err, /serve TLS/);
  assert.match(govern(e, ["remote", "serve", "--tls-cert", "x"]).err, /go together/);
  assert.match(govern(e, ["remote", "devices"]).out, /no paired devices/);
});

/** Every object key path of `a` and `b` that one has and the other lacks. Arrays compare their first items; a null on
 *  either side, an empty array, and the free-form `data` map are skipped (their shape is not fixed by the contract). */
function shapeDiff(a: unknown, b: unknown, path = "$"): string[] {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || path.endsWith(".data")) return [];
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length && b.length ? shapeDiff(a[0], b[0], `${path}[0]`) : [];
  const ka = Object.keys(a), kb = Object.keys(b);
  return [...ka.filter((k) => !kb.includes(k)).map((k) => `${path}.${k} only on the server`), ...kb.filter((k) => !ka.includes(k)).map((k) => `${path}.${k} only in the app's fixture`),
    ...ka.filter((k) => kb.includes(k)).flatMap((k) => shapeDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`))];
}

test("the server's desk and lane match the app's contract fixtures (android/app/src/test/resources/fixtures)", async () => {
  const e = setup();
  const dir = join(import.meta.dirname, "..", "android", "app", "src", "test", "resources", "fixtures");
  assert.equal(govern(e, ["cmd", "r1", "test", "--", "true"]).code, 0);
  assert.equal(govern(e, ["run", "r1", "test"]).code, 0);
  assert.equal(govern(e, ["work", "r1", "draft", "--engine", "codex"]).code, 0);
  assert.equal(govern(e, ["task", "send", "--to", "owner", "--project", "r1", "--task", "t", "--kind", "REVIEW", "--summary", "review ready", "--body", "b"]).code, 0);
  const queueDir = join(e.root, "PALS-Notes", "queue");
  write(join(queueDir, "dispatcher.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString(), interval: 30 }));
  write(join(queueDir, "ledger.jsonl"), JSON.stringify({ t: new Date().toISOString(), project: "r1", usage: { input: 41000, output: 900, costUsd: 0.12 } }) + "\n");
  const p = stateOf(e);
  p.alerts = [{ id: "a-1", stage: "draft", kind: "due", at: new Date().toISOString(), message: "draft is due" }];
  write(join(e.projects, "r1", "govern.json"), JSON.stringify(p));
  write(join(e.projects, "broken", "govern.json"), "{");
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    assert.equal((await act(base, phone, action(phone, { action: "approve", lane: "r1", gate: "final", quote: "looks right" }))).status, 200);
    const desk = await (await fetch(`${base}/v1/desk`, { headers: auth(phone) })).json();
    assert.deepEqual(shapeDiff(desk, JSON.parse(readFileSync(join(dir, "desk.json"), "utf8"))), []);
    const lane = await (await fetch(`${base}/v1/lane?slug=r1`, { headers: auth(phone) })).json();
    assert.deepEqual(shapeDiff(lane, JSON.parse(readFileSync(join(dir, "lane.json"), "utf8"))), []);
    // the comparison saw every part of the desk: none of these came back empty or null
    const d = desk as any;
    for (const [what, v] of Object.entries({ working: d.lanes[0].working, lastNote: d.lanes[0].lastNote, lastJob: d.lanes[0].lastJob, unreadable: d.unreadable[0],
      tokens: d.telemetry.tokens[0], dispatcher: d.telemetry.dispatcher, inbox: d.telemetry.inbox[0], gates: d.lanes[0].gates[0] })) assert.ok(v, `${what} is empty`);
  });
});

test("v2 reads expose checks, sessions, jobs, artifact versions and digest-bound reviews", async () => {
  const e = setup();
  const cfg = join(e.root, "govern.config.json");
  write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, join(import.meta.dirname, "fake-conversation.ts"), "echo"] } } }));
  const run = (args: string[]) => { const r = govern(e, args); assert.equal(r.code, 0, r.err + r.out); return r; };
  run(["conversation", "create", "chat", "--adapter", "echo", "--lane", "r1", "--title", "Review"]);
  run(["conversation", "send", "chat", "--message", "hello"]);
  run(["conversation", "run", "chat", "--once"]);
  run(["cmd", "r1", "test", "--", "printf", "first\nsecond\n"]);
  run(["run", "r1", "test"]);
  const p = stateOf(e); p.checks = { draft: "test", ship: "test" };
  write(join(e.projects, "r1", "govern.json"), JSON.stringify(p));
  const source = write(join(e.root, "proof.txt"), "old");
  run(["artifact", "add", "r1", source]);
  const led = join(e.projects, "r1", "govern", "ledger.jsonl");
  const old = jsonl(led).find(x => x.kind === "artifact").sha256;
  write(source, "new evidence"); run(["artifact", "add", "r1", source, "--title", "Proof", "--caption", "Latest"]);
  await serving(e, async (base) => {
    const { appendLedger } = await import("../lib/project.ts");
    const artifacts = await import("../lib/artifacts.ts");
    const sha256 = artifacts.view("r1", "proof.txt").sha256;
    for (const [sha, person] of [[old, "old-person"], [sha256, "owner"]]) appendLedger("r1", { kind: "artifact-reviewed", artifact: { name: "proof.txt", sha256: sha }, by: person, device: "d-review" });
    appendLedger("r1", { kind: "check", stage: "draft", name: "test", ok: false, exit: 1, job: null });
    appendLedger("r1", { kind: "check", stage: "draft", name: "test", ok: true, exit: 0, job: null });
    appendLedger("r1", { kind: "changes-requested", gate: "final", by: "owner", quote: "revise this", device: "d-review", artifact: { name: "proof.txt", sha256 } });
    const phone = await pairPhone(base);
    const get = (path: string) => fetch(base + path, { headers: auth(phone) });
    const desk = await (await get("/v1/desk")).json() as any;
    assert.equal(desk.protocol, "govern-remote/2");
    assert.deepEqual(desk.viewer, { person: "owner", device: phone.id, lanes: null });
    assert.equal(desk.host, (await import("node:os")).hostname());
    const { registry } = await import("../lib/caps.ts");
    assert.deepEqual(desk.engines, [...new Set([...registry().profiles.values()].filter(p => ["claude", "codex", "grok"].includes(p.engine)).map(p => p.name).concat("echo"))].sort());
    assert.deepEqual(desk.lanes[0].checkSummary, { passed: 1, failed: 0, total: 2 });
    const s = desk.sessions[0];
    assert.equal(s.id, "chat"); assert.equal(s.title, "Review"); assert.equal(s.engine, "echo"); assert.equal(s.lane, "r1");
    assert.equal(s.state, "idle"); assert.equal(s.needsDecision, true);
    assert.equal(s.lastMessage.role, "assistant"); assert.equal(s.lastMessage.verification, "transport-only"); assert.ok(s.updatedAt);
    const lane = await (await get("/v1/lane?slug=r1")).json() as any;
    assert.equal(lane.checks.length, 1); assert.equal(lane.checks[0].ok, true); assert.equal(lane.checks[0].exit, 0);
    assert.equal(lane.checks[0].stage, "draft"); assert.equal(lane.checks[0].name, "test"); assert.equal(lane.checks[0].job, null); assert.ok(lane.checks[0].at);
    assert.deepEqual(lane.sessions, desk.sessions);
    assert.equal(lane.artifacts[0].version, 2); assert.equal(lane.artifacts[0].title, "Proof"); assert.equal(lane.artifacts[0].caption, "Latest");
    assert.equal(lane.artifacts[0].reviews.length, 1); assert.equal(lane.artifacts[0].reviews[0].person, "owner");
    assert.equal(lane.decisions[0].kind, "changes"); assert.equal(lane.decisions[0].quote, "revise this"); assert.equal(lane.decisions[0].artifact.sha256, sha256);
    assert.equal(lane.gates[0].approvedBy, null); assert.equal(lane.gates[0].quote, null); assert.equal(lane.gates[0].artifact, null);
    const detail = await (await get("/v1/session?id=chat&messages=1")).json() as any;
    assert.equal(detail.messages.length, 1); assert.equal(detail.runs.length, 1); assert.equal(detail.runs[0].state, "completed");
    assert.equal(detail.runs[0].verification, "transport-only"); assert.equal(detail.runs[0].error, null);
    const fixtures = join(import.meta.dirname, "../android/app/src/test/resources/fixtures");
    assert.deepEqual(shapeDiff(detail, JSON.parse(readFileSync(join(fixtures, "session.json"), "utf8"))), []);
    const j = lane.jobs[0]; assert.equal(j.status, "ok"); assert.equal(j.exit, 0); assert.equal(j.progress, null); assert.equal(typeof j.seconds, "number");
    const job = await (await get(`/v1/job?lane=r1&id=${j.id}&lines=1`)).json() as any;
    assert.deepEqual(shapeDiff(job, JSON.parse(readFileSync(join(fixtures, "job.json"), "utf8"))), []);
    assert.deepEqual(job.argv, ["printf", "first\nsecond\n"]); assert.deepEqual(job.log, ["second"]); assert.deepEqual(job.job, j);
    const download = await get("/v1/artifact?lane=r1&name=proof.txt");
    assert.equal(download.status, 200); assert.equal(download.headers.get("govern-artifact-sha256"), sha256); assert.equal(await download.text(), "new evidence");
    for (const name of ["../x", "a/b"]) assert.equal((await get(`/v1/artifact?lane=r1&name=${encodeURIComponent(name)}`)).status, 400);
    const { symlinkSync, truncateSync } = await import("node:fs");
    symlinkSync(source, join(e.projects, "r1", "artifacts", "link"));
    assert.equal((await get("/v1/artifact?lane=r1&name=link")).status, 400);
    assert.equal((await get("/v1/artifact?lane=r1&name=missing")).status, 404);
    truncateSync(join(e.projects, "r1", "artifacts", "proof.txt"), 32 * 1024 * 1024 + 1);
    assert.equal((await get("/v1/artifact?lane=r1&name=proof.txt")).status, 413);
    assert.equal((await get("/v1/session?id=missing")).status, 404);
    for (const n of ["0", "1001", "-1", "1.5", "abc", ""]) assert.equal((await get(`/v1/job?lane=r1&id=${j.id}&lines=${n}`)).status, 400);
    for (const n of ["0", "101", "-1", "1.5"]) assert.equal((await get(`/v1/session?id=chat&messages=${n}`)).status, 400);
    assert.equal((await get("/v1/job?lane=r1&id=missing")).status, 404);
    const other = await pairPhone(base, "alice");
    const second = await (await fetch(base + "/v1/desk", { headers: auth(other) })).json() as any;
    assert.equal(second.viewer.person, "alice"); assert.equal(second.viewer.device, other.id);
  }, { streamIntervalMs: 60_000 });
});

test("v2 projections count latest checks and preserve session state, clipping and run nullability", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T12:00:00Z") });
  const e = makeEnv("read-projections"), previous = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    const { create, save, appendLedger } = await import("../lib/project.ts");
    const sessions = await import("../lib/conversation.ts");
    const views = await import("../lib/remote-view.ts");
    write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify(PROCESS));
    const cfg = join(e.root, "govern.config.json");
    write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, join(import.meta.dirname, "fake-conversation.ts"), "echo"] } } }));
    const p = create("r1", { process: "release", title: "Release one" });
    p.checks = { draft: "test", ship: "test" }; save(p);
    appendLedger("r1", { kind: "check", stage: "draft", name: "old", ok: true, exit: 0, job: "old-job" });
    appendLedger("r1", { kind: "check", stage: "draft", name: "test", ok: false, exit: 1, job: "new-job" });
    assert.deepEqual(views.laneSummary(p).checkSummary, { passed: 0, failed: 1, total: 2 });
    sessions.create("chat", { adapter: "echo", lane: "r1" });
    assert.equal(views.sessionDetail("chat").session.lastMessage, null);
    sessions.send("chat", "u".repeat(5000));
    let detail = views.sessionDetail("chat");
    assert.equal(detail.session.state, "queued"); assert.equal(detail.session.needsDecision, true);
    assert.equal(detail.session.lastMessage!.text.length, 400); assert.equal(detail.messages[0]!.text.length, 4000);
    assert.equal(detail.messages[0]!.verification, null);
    assert.deepEqual([detail.runs[0]!.startedAt, detail.runs[0]!.endedAt, detail.runs[0]!.error, detail.runs[0]!.verification], [null, null, null, null]);
    const claimed = sessions.claim("chat")!;
    assert.equal(views.sessionSummary(claimed.session).state, "running");
    sessions.update("chat", claimed.run.id, (s, r) => {
      r.state = "completed"; r.endedAt = "2026-10-14T12:01:00.000Z"; r.verification = "checked";
      s.messages.push({ id: "reply", role: "assistant", content: "a".repeat(5000), at: r.endedAt, runId: r.id });
      s.events.push({ seq: s.events.length + 1, at: "2026-10-14T12:02:00.000Z", type: "run.completed", runId: r.id });
    });
    detail = views.sessionDetail("chat", 1);
    assert.equal(detail.session.state, "idle"); assert.equal(detail.session.updatedAt, "2026-10-14T12:02:00.000Z");
    assert.equal(detail.messages.length, 1); assert.equal(detail.messages[0]!.verification, "checked");
    const stored = sessions.read("chat");
    for (const state of ["failed", "interrupted"] as const) {
      const copy = structuredClone(stored); copy.runs[0]!.state = state;
      assert.equal(views.sessionSummary(copy).state, "failed");
      copy.closedAt = "2026-10-14T12:03:00.000Z";
      assert.equal(views.sessionSummary(copy).state, "closed");
    }
    p.finished = "2026-10-14T12:03:00.000Z"; save(p);
    assert.equal(views.sessionSummary(stored).needsDecision, false);
    const lane = views.laneDetail(p);
    assert.equal(lane.checks.length, 2); assert.equal(lane.sessions.length, 1);
    assert.deepEqual(lane.jobs, []); assert.deepEqual(lane.artifacts, []); assert.deepEqual(lane.decisions, []);
  } finally { if (previous === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = previous; }
});

test("v2 request handler streams artifact bytes and rejects invalid read parameters", async () => {
  const e = makeEnv("read-handler"), previous = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    const { create, save } = await import("../lib/project.ts");
    const { pair } = await import("../lib/remote.ts");
    const { PassThrough, Writable } = await import("node:stream");
    const { symlinkSync, truncateSync } = await import("node:fs");
    const artifacts = await import("../lib/artifacts.ts");
    const jobs = await import("../lib/jobs.ts");
    const sessions = await import("../lib/conversation.ts");
    write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify(PROCESS));
    const p = create("r1", { process: "release" });
    p.commands.test = ["printf", "first\nsecond\n"]; save(p);
    const job = jobs.start(p, "test", [], false);
    sessions.create("chat", { profile: "codex-read", lane: "r1" });
    const source = write(join(e.root, "source.txt"), "evidence"), a = artifacts.add("r1", source, { name: "proof.txt" });
    const { code } = createPairing("owner", 10), phone = pair(code, "reader", keyPair().publicKey);
    const server = remoteServer();
    // Exercise the actual request handler without a listener; the socket tests above cover HTTP transport.
    const get = (url: string, token = phone.token): Promise<{ status: number; headers: Record<string, string | number>; body: Buffer }> => new Promise((resolve, reject) => {
      let status = 0; let headers: Record<string, string | number> = {}; const chunks: Buffer[] = [];
      const response = Object.assign(new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }), {
        headersSent: false,
        writeHead(code: number, values: Record<string, string | number>) { status = code; headers = values; this.headersSent = true; },
      });
      response.on("finish", () => resolve({ status, headers, body: Buffer.concat(chunks) })); response.on("error", reject);
      server.emit("request", Object.assign(new PassThrough(), { method: "GET", url, headers: { authorization: `Bearer ${token}` } }), response);
    });
    assert.equal((await get("/v1/artifact?lane=r1&name=proof.txt", "wrong")).status, 401);
    const download = await get("/v1/artifact?lane=r1&name=proof.txt");
    assert.equal(download.status, 200); assert.equal(download.body.toString(), "evidence");
    assert.equal(download.headers["Govern-Artifact-Sha256"], a.sha256); assert.equal(download.headers["Content-Length"], 8);
    assert.equal(download.headers["Content-Disposition"], 'attachment; filename="proof.txt"'); assert.equal(download.headers["Content-Type"], "text/plain");
    for (const name of ["../x", "a/b"]) assert.equal((await get(`/v1/artifact?lane=r1&name=${encodeURIComponent(name)}`)).status, 400);
    symlinkSync(source, artifacts.path("r1", "link"));
    assert.equal((await get("/v1/artifact?lane=r1&name=link")).status, 400);
    assert.equal((await get("/v1/artifact?lane=r1&name=missing")).status, 404);
    const session = await get("/v1/session?id=chat"); assert.equal(session.status, 200); assert.equal(JSON.parse(session.body.toString()).session.state, "idle");
    assert.equal((await get("/v1/session?id=missing")).status, 404);
    for (const n of ["0", "101", "1.5", ""]) assert.equal((await get(`/v1/session?id=chat&messages=${n}`)).status, 400);
    const j = await get(`/v1/job?lane=r1&id=${job.id}&lines=1`); assert.equal(j.status, 200); assert.deepEqual(JSON.parse(j.body.toString()).log, ["second"]);
    for (const n of ["0", "1001", "-1", "1.5", "abc", ""]) assert.equal((await get(`/v1/job?lane=r1&id=${job.id}&lines=${n}`)).status, 400);
    assert.equal((await get("/v1/job?lane=r1&id=missing")).status, 404);
    assert.equal((await get("/v1/job?lane=missing&id=job")).status, 404);
    const d = JSON.parse((await get("/v1/desk")).body.toString());
    assert.deepEqual(d.viewer, { person: "owner", device: phone.device.id, lanes: null });
    const other = pair(createPairing("alice", 10).code, "other", keyPair().publicKey);
    const d2 = JSON.parse((await get("/v1/desk", other.token)).body.toString());
    assert.deepEqual(d2.viewer, { person: "alice", device: other.device.id, lanes: null });
    truncateSync(artifacts.path("r1", "proof.txt"), artifacts.MAX_BYTES + 1);
    assert.equal((await get("/v1/artifact?lane=r1&name=proof.txt")).status, 413);
  } finally { if (previous === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = previous; }
});

test("a lane-scoped device reads no session, job or artifact of another lane, and its desk shows only its own sessions", async () => {
  const e = setup();
  assert.equal(govern(e, ["new", "r2", "--process", "release"]).code, 0);
  const cfg = join(e.root, "govern.config.json");
  write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, join(import.meta.dirname, "fake-conversation.ts"), "echo"] } } }));
  const run = (args: string[]) => { const r = govern(e, args); assert.equal(r.code, 0, r.err + r.out); return r; };
  run(["conversation", "create", "chat", "--adapter", "echo", "--lane", "r1"]);
  run(["conversation", "create", "mine", "--adapter", "echo", "--lane", "r2"]);
  run(["conversation", "create", "loose", "--adapter", "echo"]);
  run(["cmd", "r1", "test", "--", "printf", "x\n"]);
  run(["run", "r1", "test"]);
  run(["artifact", "add", "r1", write(join(e.root, "proof.txt"), "evidence")]);
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const { readState, writeState } = await import("../lib/remote.ts");
    const all = readState<{ devices: { id: string; lanes?: string[] }[] }>("devices.json", { devices: [] });
    all.devices.find((d) => d.id === phone.id)!.lanes = ["r2"];
    writeState("devices.json", all);
    const get = (path: string) => fetch(base + path, { headers: auth(phone) });
    const desk = await (await get("/v1/desk")).json() as any;
    assert.deepEqual(desk.viewer.lanes, ["r2"]);
    assert.deepEqual(desk.sessions.map((s: any) => s.id), ["mine"]);
    assert.equal((await get("/v1/session?id=mine")).status, 200);
    for (const path of ["/v1/session?id=chat", "/v1/session?id=loose", "/v1/job?lane=r1&id=missing", "/v1/artifact?lane=r1&name=proof.txt",
      "/v1/job?lane=nowhere&id=missing", "/v1/artifact?lane=nowhere&name=proof.txt"]) {
      const r = await get(path);
      assert.equal(r.status, 403, path);
      assert.match((await r.json() as { error: string }).error, /outside this device's scope/, path);
    }
  }, { streamIntervalMs: 60_000 });
});

test("signed FIELD actions review evidence, request changes, instruct and open fake sessions", async () => {
  const e = setup(), cfg = join(e.root, "govern.config.json");
  write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, join(import.meta.dirname, "fake-conversation.ts"), "echo"] } } }));
  const run = (args: string[]) => { const r = govern(e, args); assert.equal(r.code, 0, r.err + r.out); };
  run(["artifact", "add", "r1", write(join(e.root, "proof.txt"), "evidence")]);
  run(["conversation", "create", "older", "--adapter", "echo", "--lane", "r1"]);
  run(["conversation", "create", "chat", "--adapter", "echo", "--lane", "r1"]);
  run(["conversation", "create", "closed-newest", "--adapter", "echo", "--lane", "r1"]);
  run(["conversation", "close", "closed-newest"]);
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const send = async (fields: Record<string, unknown>, status = 200) => {
      const r = await act(base, phone, action(phone, fields)), data = await r.json() as any;
      assert.equal(r.status, status, JSON.stringify(data)); return data;
    };
    const lane = await (await fetch(base + "/v1/lane?slug=r1", { headers: auth(phone) })).json() as any;
    const artifact = { name: "proof.txt", sha256: lane.artifacts[0].sha256 };
    const { inspect } = await import("../lib/conversation.ts");
    const settled = async (id: string) => {
      for (let i = 0; i < 600; i++) {
        const s = inspect(id);
        if (s.runs.length && s.runs.every(r => r.state === "completed")) return s;
        await new Promise(r => setTimeout(r, 25));
      }
      assert.fail(`background runs did not complete: ${JSON.stringify(inspect(id).runs)}`);
    };
    const review = await send({ action: "reviewed", lane: "r1", artifact });
    assert.equal(review.ok, true); assert.equal(review.session, null);
    assert.equal(review.lane.artifacts[0].reviews[0].device, phone.id);
    const twice = await send({ action: "reviewed", lane: "r1", artifact });
    assert.equal(twice.lane.artifacts[0].reviews.length, 1);
    const changed = await send({ action: "changes", lane: "r1", gate: "final", quote: "adjust the heading", artifact });
    assert.equal(changed.session, null); assert.equal(changed.lane.gates[0].approved, false);
    assert.deepEqual(changed.lane.decisions[0].artifact, artifact);
    assert.equal(changed.lane.notes.at(-1).text, "changes requested on final by owner: adjust the heading");
    assert.equal((await settled("chat")).messages[0]!.content, changed.lane.notes.at(-1).text);
    assert.equal(inspect("older").messages.length, 0);
    assert.equal(inspect("closed-newest").messages.length, 0);
    for (const mode of ["queue", "interrupt"]) {
      const instructed = await send({ action: "instruct", session: "chat", text: "  continue  ", mode });
      assert.equal(instructed.lane.slug, "r1"); assert.equal(instructed.session.session.id, "chat");
      await settled("chat");
    }
    const desk = await (await fetch(base + "/v1/desk", { headers: auth(phone) })).json() as any;
    assert.ok(desk.engines.includes("echo"));
    const opened = await send({ action: "session", lane: "r1", engine: "echo", title: "Review", text: "hello" });
    assert.match(opened.session.session.id, /^r1-[a-f0-9]{6}$/);
    assert.equal(opened.lane.slug, "r1"); await settled(opened.session.session.id);
    const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, "../android/app/src/test/resources/fixtures/action-results.json"), "utf8"));
    assert.deepEqual(shapeDiff(opened, fixtures[1]), []);
    run(["conversation", "create", "loose", "--adapter", "echo"]);
    const loose = await send({ action: "instruct", session: "loose", text: "hello", mode: "queue" });
    assert.equal(loose.lane, null); assert.equal(loose.session.session.id, "loose");
    assert.deepEqual(shapeDiff(loose, fixtures[2]), []); await settled("loose");
    const approved = await send({ action: "approve", lane: "r1", gate: "final", quote: "I approve these bytes", artifact });
    assert.deepEqual(approved.lane.gates[0].artifact, artifact);
    assert.equal(approved.lane.decisions[0].device, phone.id);
    assert.equal(approved.session, null);
    const ledger = jsonl(join(e.projects, "r1", "govern", "ledger.jsonl"));
    for (const kind of ["artifact-reviewed", "changes-requested", "instruct", "session-opened", "approve"]) assert.ok(ledger.some(x => x.kind === kind && x.device === phone.id), kind);
    const audit = jsonl(join(e.root, "PALS-Notes", "govern-state", "remote", "audit.jsonl"));
    for (const kind of ["reviewed", "changes", "instruct", "session", "approve"]) assert.ok(audit.some(x => x.kind === kind), kind);
  });
});

test("FIELD action refusals preserve scope, gates, digests, bounds and nonce protection", async () => {
  const e = setup(), cfg = join(e.root, "govern.config.json");
  write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, join(import.meta.dirname, "fake-conversation.ts"), "echo"] } } }));
  const run = (args: string[]) => { const r = govern(e, args); assert.equal(r.code, 0, r.err + r.out); };
  run(["artifact", "add", "r1", write(join(e.root, "proof.txt"), "evidence")]);
  run(["conversation", "create", "closed", "--adapter", "echo", "--lane", "r1"]);
  run(["conversation", "close", "closed"]);
  run(["conversation", "create", "loose", "--adapter", "echo"]);
  await serving(e, async (base) => {
    const phone = await pairPhone(base);
    const refuse = async (fields: Record<string, unknown>, status: number, pattern?: RegExp) => {
      const r = await act(base, phone, action(phone, fields)), j = await r.json() as any;
      assert.equal(r.status, status, JSON.stringify(j)); if (pattern) assert.match(j.error, pattern);
    };
    for (const kind of [undefined, "unknown", "constructor", "__proto__"]) await refuse({ action: kind }, 400, /approve, ack, changes, reviewed, instruct, session/);
    const lane = await (await fetch(base + "/v1/lane?slug=r1", { headers: auth(phone) })).json() as any;
    const artifact = { name: "proof.txt", sha256: lane.artifacts[0].sha256 };
    for (const kind of ["approve", "changes", "reviewed"]) {
      const fields = { action: kind, lane: "r1", ...(kind === "reviewed" ? {} : { gate: "final", quote: "my words" }) };
      await refuse({ ...fields, artifact: { ...artifact, name: "missing" } }, 404);
      await refuse({ ...fields, artifact: { ...artifact, sha256: "0".repeat(64) } }, 409, /the artifact changed since you reviewed it/);
      await refuse({ ...fields, artifact: null }, 400);
    }
    await refuse({ action: "changes", lane: "r1", gate: "board", quote: "change it" }, 409);
    await refuse({ action: "changes", lane: "r1", gate: "missing", quote: "change it" }, 409);
    await refuse({ action: "instruct", session: "missing", text: "hi", mode: "queue" }, 404);
    await refuse({ action: "instruct", session: "closed", text: "hi", mode: "queue" }, 409);
    for (const text of [" ", "x".repeat(8001)]) {
      await refuse({ action: "instruct", session: "loose", text, mode: "queue" }, 400);
      await refuse({ action: "session", lane: "r1", engine: "echo", title: "title", text }, 400);
    }
    for (const title of [" ", "x".repeat(121)]) await refuse({ action: "session", lane: "r1", engine: "echo", title, text: "hi" }, 400);
    await refuse({ action: "instruct", session: "loose", text: "hi", mode: "bad" }, 400);
    await refuse({ action: "session", lane: "r1", engine: "unknown", title: "title", text: "hi" }, 400);
    const approval = action(phone, { action: "approve", lane: "r1", gate: "final", quote: "approved", artifact });
    assert.equal((await act(base, phone, approval)).status, 200);
    assert.equal((await act(base, phone, approval)).status, 403);
    await refuse({ action: "changes", lane: "r1", gate: "final", quote: "change it" }, 409);
    const { readState, writeState } = await import("../lib/remote.ts");
    const all = readState<{ devices: { id: string; lanes?: string[] }[] }>("devices.json", { devices: [] });
    all.devices.find(d => d.id === phone.id)!.lanes = ["other"]; writeState("devices.json", all);
    for (const action of ["approve", "changes", "reviewed", "session", "ack"]) {
      const extra = action === "ack" ? { alert: "missing" } : action === "session" ? { engine: "echo", title: "title", text: "hi" } : action === "reviewed" ? { artifact } : { gate: "final", quote: "my words" };
      for (const lane of ["r1", "missing"]) await refuse({ action, lane, ...extra }, 403);
    }
    for (const session of ["closed", "loose"]) await refuse({ action: "instruct", session, text: "hi", mode: "queue" }, 403);
  });
});

test("FIELD signed shapes enforce every action's signature, clock, nonce and closed fields without HTTP", async () => {
  const e = makeEnv("field-shapes"), old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    const { verifyAction, createDevice, locked, BadRequest, Forbidden } = await import("../lib/remote.ts");
    const kp = keyPair(), { device } = locked(() => createDevice("test", kp.publicKey, "owner"));
    const now = Date.parse("2026-10-14T12:00:00Z"), at = new Date(now).toISOString();
    const artifact = { name: "proof.txt", sha256: "a".repeat(64) };
    const fields = [
      { action: "approve", lane: "r1", gate: "final", quote: "yes", artifact },
      { action: "ack", lane: "r1", alert: "a1" },
      { action: "changes", lane: "r1", gate: "final", quote: "fix it", artifact },
      { action: "reviewed", lane: "r1", artifact },
      { action: "instruct", session: "chat", text: "hello", mode: "queue" },
      { action: "session", lane: "r1", engine: "echo", title: "Title", text: "hello" },
    ];
    const signed = (v: unknown) => { const body = Buffer.from(JSON.stringify(v)); return { body, sig: sign("sha256", body, kp.key).toString("base64") }; };
    let serial = 0;
    const check = (f: unknown) => { const { body, sig } = signed(f); return verifyAction(device, body, sig, now); };
    const fresh = (f: object) => ({ ...f, at, nonce: `nonce-${String(++serial).padStart(16, "0")}` });
    for (const f of fields) {
      const raw = fresh(f), { body, sig } = signed(raw);
      assert.throws(() => verifyAction(device, body, undefined, now), Forbidden);
      assert.throws(() => verifyAction(device, body, "bad", now), Forbidden);
      assert.throws(() => verifyAction(device, body, sig, now + 300001), Forbidden);
      assert.deepEqual(verifyAction(device, body, sig, now), raw);
      assert.throws(() => verifyAction(device, body, sig, now), /nonce reused/);
      assert.throws(() => check({ ...fresh(f), extra: true }), BadRequest);
      for (const nonce of ["short", "x".repeat(129), "!".repeat(16)]) assert.throws(() => check({ ...fresh(f), nonce }), BadRequest);
    }
    for (const action of [undefined, "unknown", "constructor", "__proto__"]) assert.throws(() => check(fresh({ action })), /approve, ack, changes, reviewed, instruct, session/);
    for (const action of ["approve", "changes"]) {
      for (const quote of [" ", "x", "x".repeat(2001)]) assert.throws(() => check(fresh({ action, lane: "r1", gate: "final", quote })), BadRequest);
      for (const artifact of [null, { name: "../proof", sha256: "a".repeat(64) }, { name: "x", sha256: "invalid" }]) assert.throws(() => check(fresh({ action, lane: "r1", gate: "final", quote: "yes", artifact })), BadRequest);
    }
    for (const text of [" ", "x".repeat(8001)]) {
      assert.throws(() => check(fresh({ ...fields[4], text })), BadRequest);
      assert.throws(() => check(fresh({ ...fields[5], text })), BadRequest);
    }
    for (const title of [" ", "x".repeat(121)]) assert.throws(() => check(fresh({ ...fields[5], title })), BadRequest);
    assert.throws(() => check(fresh({ ...fields[4], mode: "other" })), BadRequest);
    assert.equal((check(fresh({ ...fields[4], text: " x ", mode: "interrupt" })) as any).text, "x");
    check(fresh({ ...fields[5], title: "x".repeat(120), text: "x".repeat(8000) }));
  } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
});

test("FIELD local actions bind decisions to current artifacts and refuse scope before lane access", async () => {
  const e = makeEnv("field-local"), old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify(PROCESS));
    const project = await import("../lib/project.ts"), remote = await import("../lib/remote.ts"), artifacts = await import("../lib/artifacts.ts");
    const cfg = join(e.root, "govern.config.json");
    write(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), conversationAdapters: { echo: { argv: [process.execPath, join(import.meta.dirname, "fake-conversation.ts"), "echo"] } } }));
    project.create("r1", { process: "release" });
    const kp = keyPair(), { device } = remote.locked(() => remote.createDevice("local", kp.publicKey, "owner"));
    const conversations = await import("../lib/conversation.ts");
    conversations.create("closed", { adapter: "echo", lane: "r1" }); conversations.close("closed");
    conversations.create("loose", { adapter: "echo" });
    const proof = artifacts.add("r1", write(join(e.root, "proof.txt"), "evidence"));
    const artifact = { name: proof.name, sha256: proof.sha256 };
    let serial = 0;
    const act = (fields: object, d = device) => {
      const body = Buffer.from(JSON.stringify({ ...fields, nonce: `nonce-${String(++serial).padStart(16, "0")}`, at: "2026-10-14T12:00:00Z" }));
      const sig = sign("sha256", body, kp.key).toString("base64");
      return remote.perform(d, remote.verifyAction(d, body, sig, Date.parse("2026-10-14T12:00:00Z")), body, sig);
    };
    for (const id of ["closed", "loose"]) {
      const f = join(conversations.directory(id), "session.json"), before = readFileSync(f, "utf8");
      assert.throws(() => act({ action: "instruct", session: id, text: "hello", mode: "queue" }, { ...device, lanes: [] }), remote.Forbidden);
      assert.equal(readFileSync(f, "utf8"), before);
    }
    assert.throws(() => act({ action: "instruct", session: "missing", text: "hello", mode: "queue" }), remote.NotFound);
    assert.throws(() => act({ action: "instruct", session: "closed", text: "hello", mode: "queue" }), /closed/);
    assert.throws(() => act({ action: "session", lane: "r1", engine: "unknown", title: "Title", text: "hello" }), remote.BadRequest);
    assert.throws(() => act({ action: "reviewed", lane: "missing", artifact }), remote.NotFound);
    act({ action: "reviewed", lane: "r1", artifact });
    assert.equal(act({ action: "reviewed", lane: "r1", artifact }).lane!.artifacts[0]!.reviews.length, 1);
    const changes = act({ action: "changes", lane: "r1", gate: "final", quote: "adjust it", artifact });
    assert.equal(changes.lane!.gates[0]!.approved, false);
    assert.equal(changes.lane!.notes.at(-1)!.text, "changes requested on final by owner: adjust it");
    assert.deepEqual(changes.lane!.decisions[0]!.artifact, artifact);
    assert.throws(() => act({ action: "changes", lane: "r1", gate: "board", quote: "adjust it" }), /policy/);
    assert.throws(() => act({ action: "changes", lane: "r1", gate: "absent", quote: "adjust it" }), /gate must be/);
    const approved = act({ action: "approve", lane: "r1", gate: "final", quote: "I approve", artifact });
    assert.deepEqual(approved.lane!.gates[0]!.artifact, artifact);
    assert.equal(approved.lane!.decisions[0]!.device, device.id);
    assert.throws(() => act({ action: "changes", lane: "r1", gate: "final", quote: "adjust it" }), /already approved/);
    artifacts.add("r1", write(join(e.root, "proof.txt"), "replacement"));
    for (const action of ["reviewed", "approve", "changes"]) {
      const extra = action === "reviewed" ? {} : { gate: "final", quote: "my words" };
      assert.throws(() => act({ action, lane: "r1", artifact, ...extra }), /the artifact changed since you reviewed it/);
      assert.throws(() => act({ action, lane: "r1", artifact: { ...artifact, name: "missing" }, ...extra }), remote.NotFound);
      assert.throws(() => act({ action, lane: "missing", artifact, ...extra }, { ...device, lanes: [] }), remote.Forbidden);
    }
    assert.equal(artifacts.view("r1", "proof.txt").reviews.length, 0);
    const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, "../android/app/src/test/resources/fixtures/action-results.json"), "utf8"));
    assert.deepEqual(shapeDiff(approved, fixtures[0]), []);
    assert.equal(approved.session, fixtures[0].session);
  } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
});
