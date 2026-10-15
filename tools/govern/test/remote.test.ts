// govern remote (lib/remote.ts, REMOTE.md): pairing, bearer reads, signed actions and the desk stream, over real HTTP
// against a throwaway workspace. The device key is a P-256 pair made here, as the Android Keystore would make it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomBytes, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { makeEnv, govern, write, jsonl, asSession, childEnv, type Env } from "./helpers.ts";
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
async function serving(e: Env, f: (base: string, server: Server) => Promise<void>, o: Parameters<typeof remoteServer>[0] = {}): Promise<void> {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const server: Server = remoteServer({ streamIntervalMs: 50, pingMs: 1000, ...o });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}`, server); } finally {
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

test("malformed request targets return 400 without terminating the remote server", { timeout: 15000 }, async (t) => {
  const e = setup();
  const module = new URL("../lib/remote.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { remoteServer } from ${JSON.stringify(module)};
    const server = remoteServer();
    server.listen(0, "127.0.0.1", () => process.send(server.address().port));
  `], { env: childEnv(e), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", (chunk) => { errors += chunk; });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => { child.kill(); await closed; });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("message", (port) => resolve(Number(port)));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited ${code}: ${errors}`)));
  });
  for (const path of ["http://[", "//[", "http://example.test:bad/v1/health"]) {
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, signal: t.signal }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.status, 400, `${path}: ${response.body}\n${errors}`);
    assert.match(JSON.parse(response.body).error, /request.*url|request.*target/i);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: t.signal })).status, 200);
  }
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

test("revocation rejects signed actions whose headers arrived before their body", { timeout: 15000 }, async (t) => {
  const e = setup();
  const p = stateOf(e);
  p.alerts = [{ id: "a-1", stage: "draft", kind: "due", at: new Date().toISOString(), message: "draft is due" }];
  write(join(e.projects, "r1", "govern.json"), JSON.stringify(p));
  await serving(e, async (base, server) => {
    for (const fields of [
      { action: "approve", lane: "r1", gate: "final", quote: "approved before revocation" },
      { action: "ack", lane: "r1", alert: "a-1" },
    ]) {
      const phone = await pairPhone(base);
      const signed = action(phone, fields);
      // The server's handler runs first, so this barrier confirms it has authenticated the headers.
      const received = new Promise<void>((resolve) => server.once("request", () => resolve()));
      const req = request(`${base}/v1/actions`, { method: "POST", signal: t.signal, headers: {
        ...auth(phone), "Govern-Signature": signed.sig, "Content-Length": Buffer.byteLength(signed.body),
      } });
      const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        req.once("response", (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.once("end", () => resolve({ status: res.statusCode, body }));
          res.once("error", reject);
        });
        req.once("error", reject);
      });
      req.flushHeaders();
      await received;
      revoke(phone.id);
      req.end(signed.body);
      const result = await response;
      assert.equal(result.status, 403, result.body);
      assert.match(JSON.parse(result.body).error, /revoked|no longer paired/);
    }
    assert.equal(stateOf(e).approvals.final, undefined);
    assert.equal(stateOf(e).alerts![0]!.acknowledgedAt, undefined);
    assert.deepEqual(jsonl(join(e.projects, "r1", "govern", "ledger.jsonl")), []);
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
