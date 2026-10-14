// Phone-initiated pairing: comparison, one delivery, terminal confirmation and per-device views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, asSession } from "./helpers.ts";
import { remoteServer, devices, scoped, Forbidden, BadRequest, createPairing, pair, deviceOfToken } from "../lib/remote.ts";
import { comparisonCode, requestPairing, pollPairing, confirmPairing, cancelPairing, refusePairing, requests, TooMany } from "../lib/remote-pair.ts";
import { deskView, laneSummary, PROTOCOL } from "../lib/remote-view.ts";
import { create, load } from "../lib/project.ts";

const vectors = [
  ["r-0123456789ab", "public-key", "", "121684"],
  ["r-ffffffffffff", "BMFvYQ==", "0123456789abcdef".repeat(4), "862710"],
  ["r-000000000000", "", "", "128897"],
];
test("comparison codes match independent SHA-256 vectors", () => {
  for (const [id, key, pin, fixed] of vectors) {
    const bytes = createHash("sha256").update(["govern-pair/2", id, key, pin].join("\n")).digest();
    const expected = String(bytes.readUInt32BE(0) % 1_000_000).padStart(6, "0");
    assert.equal(expected, fixed);
    assert.equal(comparisonCode(id!, key!, pin!), expected);
    assert.match(expected, /^\d{6}$/);
  }
});
const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicOf = (kp: ReturnType<typeof key>) => kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
async function workspace(f: (e: ReturnType<typeof makeEnv>, base: string, clock: { now: number }) => Promise<void>) {
  const e = makeEnv("remote-pair"), old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const clock = { now: Date.parse("2026-10-14T20:00:00Z") };
  const server = remoteServer({ now: () => clock.now });
  try {
    await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
    const addr = server.address(); assert.ok(addr && typeof addr === "object");
    await f(e, `http://127.0.0.1:${addr.port}`, clock);
  } finally {
    server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
    if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old;
  }
}
async function local(f: (e: ReturnType<typeof makeEnv>) => void | Promise<void>) {
  const e = makeEnv("pair-local"), old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { await f(e); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}

const post = (base: string, path: string, body: unknown, headers = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers });
const poll = (base: string, id: string, secret: string) => fetch(`${base}/v1/pair/request?id=${id}`, { headers: { "Govern-Pair-Secret": secret } });

test("request confirm poll delivers a sealed token once and permits authenticated reads", async () => workspace(async (e, base, clock) => {
  const kp = key(), publicKey = publicOf(kp);
  const r = await post(base, "/v1/pair/request", { name: "phone", publicKey, lanes: ["r1"] });
  assert.equal(r.status, 201);
  const created = await r.json() as any;
  assert.equal(created.protocol, PROTOCOL); assert.ok(created.host);
  const fixtures = join(import.meta.dirname, "../android/app/src/test/resources/fixtures");
  const keys = (name: string) => Object.keys(JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8"))).sort();
  assert.deepEqual(Object.keys(created).sort(), keys("pair-request"));
  assert.equal(Date.parse(created.expires), clock.now + 300_000);
  assert.equal((await poll(base, created.id, "wrong")).status, 403);
  assert.equal((await post(base, "/v1/pair/cancel", { id: created.id, secret: "wrong" })).status, 403);
  assert.equal((await (await poll(base, created.id, created.secret)).json() as any).state, "waiting");
  confirmPairing(created.id, comparisonCode(created.id, publicKey, null), { person: "owner", now: () => clock.now });
  const file = join(e.root, "PALS-Notes/govern-state/remote/requests.json");
  const stored = readFileSync(file, "utf8");
  assert.ok(!stored.includes(created.secret)); assert.equal(statSync(file).mode & 0o777, 0o600);
  const got = await (await poll(base, created.id, created.secret)).json() as any;
  assert.deepEqual(Object.keys(got).sort(), keys("pair-status"));
  assert.equal(got.state, "confirmed"); assert.ok(got.host); assert.equal(got.person, "owner");
  assert.deepEqual(got.lanes, ["r1"]); assert.ok(got.token); assert.ok(!stored.includes(got.token));
  assert.ok(!readFileSync(file, "utf8").includes('"sealed"'));
  assert.equal((await (await poll(base, created.id, created.secret)).json() as any).token, null);
  assert.equal((await fetch(base + "/v1/desk", { headers: { Authorization: `Bearer ${got.token}` } })).status, 200);
  assert.equal(devices().length, 1);
}));

test("wrong comparison refuses permanently; cancellation, expiry and 32 open requests are enforced", async () => workspace(async (_e, base, clock) => {
  const publicKey = publicOf(key()), now = () => clock.now;
  let address = 0;
  const make = () => requestPairing({ name: "phone", publicKey }, { now, address: String(address++) });
  const r = make();
  assert.throws(() => confirmPairing(r.id, "wrong", { now }), Forbidden);
  assert.equal(pollPairing(r.id, r.secret, now).state, "refused");
  assert.throws(() => confirmPairing(r.id, comparisonCode(r.id, publicKey, null), { now }));
  const c = make(); cancelPairing(c.id, c.secret, now);
  assert.equal(pollPairing(c.id, c.secret, now).state, "cancelled");
  const refused = make(); refusePairing(refused.id, now);
  assert.equal(pollPairing(refused.id, refused.secret, now).state, "refused");
  const expired = make(); clock.now += 300_000;
  assert.equal(pollPairing(expired.id, expired.secret, now).state, "expired");
  assert.throws(() => confirmPairing(expired.id, comparisonCode(expired.id, publicKey, null), { now }));
  for (let i = 0; i < 32; i++) make();
  assert.equal((await post(base, "/v1/pair/request", { name: "sixth", publicKey })).status, 429);
  clock.now += 300_000;
  assert.equal(requests(now).length, 0);
  assert.equal((await post(base, "/v1/pair/request", { name: "fresh", publicKey })).status, 201);
}));

test("scope filters every lane-bearing desk field without changing the cache and denies reads and actions", async () => workspace(async (e, base, clock) => {
  write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify({ version: 1, name: "release", stages: [{ name: "draft" }], gates: [] }));
  for (const slug of ["r1", "r2"]) assert.equal(govern(e, ["new", slug, "--process", "release"]).code, 0);
  const kp = key(), publicKey = publicOf(kp), now = () => clock.now;
  const r = requestPairing({ name: "phone", publicKey, lanes: ["r1"] }, { now });
  confirmPairing(r.id, comparisonCode(r.id, publicKey, null), { now });
  const p = pollPairing(r.id, r.secret, now), headers = { Authorization: `Bearer ${p.token}` };
  const d = devices()[0]!;
  const desk = deskView();
  desk.unreadable = [{ slug: "r1", error: "a" }, { slug: "r2", error: "b" }];
  desk.telemetry.tokens = ["r1", "r2"].map((lane) => ({ lane, calls: 1, input: 1, output: 1, usd: 1 }));
  desk.telemetry.machines = ["r1", "r2"].map((lane) => ({ lane, time: "1s", money: null }));
  desk.telemetry.inbox = ["r1", "r2"].map((project) => ({ project, id: project, kind: "TASK", from: "x", summary: "x", created: "x" }));
  const withSessions = { ...desk, sessions: [{ lane: "r1" }, { lane: "r2" }, { lane: null }] };
  const view = scoped(withSessions, d);
  assert.deepEqual(view.lanes.map((x) => x.slug), ["r1"]);
  assert.deepEqual(view.unreadable.map((x) => x.slug), ["r1"]);
  assert.deepEqual(view.telemetry.tokens.map((x) => x.lane), ["r1"]);
  assert.deepEqual(view.telemetry.machines.map((x) => x.lane), ["r1"]);
  assert.deepEqual(view.telemetry.inbox.map((x) => x.project), ["r1"]);
  assert.deepEqual(view.sessions, [{ lane: "r1" }]);
  assert.equal(desk.lanes.length, 2); assert.equal(withSessions.sessions.length, 3);
  assert.deepEqual((await (await fetch(base + "/v1/desk", { headers })).json() as any).lanes.map((x: any) => x.slug), ["r1"]);
  assert.equal((await fetch(base + "/v1/lane?slug=r1", { headers })).status, 200);
  assert.equal((await fetch(base + "/v1/lane?slug=r2", { headers })).status, 403);
  const body = JSON.stringify({ action: "ack", lane: "r2", alert: "a", at: new Date(clock.now).toISOString(), nonce: "1234567890123456" });
  const refused = await fetch(base + "/v1/actions", { method: "POST", body, headers: { ...headers, "Govern-Signature": sign("sha256", Buffer.from(body), kp.privateKey).toString("base64") } });
  assert.equal(refused.status, 403);
  assert.match((await refused.json() as { error: string }).error, /outside this device's scope/);
}));

test("remote requests confirm refuse link and device scopes work at the terminal and refuse agent sessions", async () => local(async (e) => {
  const publicKey = publicOf(key());
  const r = requestPairing({ name: "Pixel", publicKey, lanes: ["r1"] });
  const code = comparisonCode(r.id, publicKey, null);
  const listed = govern(e, ["remote", "requests"]); assert.equal(listed.code, 0, listed.err);
  assert.ok(listed.out.includes(code), JSON.stringify({out: listed.out, expected: code, id: r.id})); assert.ok(listed.out.includes("Pixel")); assert.ok(listed.out.includes("r1"));
  const confirmed = govern(e, ["remote", "confirm", r.id, "--code", code, "--lane", "r1", "--lane", "r2", "--person", "alice"]);
  assert.equal(confirmed.code, 0, confirmed.err);
  assert.deepEqual(devices()[0]!.lanes, ["r1", "r2"]); assert.equal(devices()[0]!.person, "alice");
  assert.match(govern(e, ["remote", "devices"]).out, /r1.*r2/);
  const r2 = requestPairing({ name: "Other", publicKey });
  assert.equal(govern(e, ["remote", "refuse", r2.id]).code, 0);
  assert.equal(pollPairing(r2.id, r2.secret).state, "refused");
  const link = govern(e, ["remote", "link", "--url", "http://127.0.0.1:5002", "--lane", "r1"]);
  assert.equal(link.code, 0, link.err); assert.match(link.out, /govern-remote:\/\/pair\?url=.*&lane=r1/); assert.doesNotMatch(link.out, /&code=/); assert.match(link.out, /[▀▄█]/u);
  asSession(e, "s-pair");
  for (const args of [["requests"], ["confirm", r.id, "--code", code], ["refuse", r.id], ["link", "--url", "http://127.0.0.1:5002"]]) {
    const result = govern(e, ["remote", ...args], { CLAUDE_CODE_SESSION_ID: "s-pair" });
    assert.equal(result.code, 1); assert.match(result.err, /owner's own terminal/);
  }
}));


test("pairing state transitions validate secrets, seal once, expire and share device creation", async () => local((e) => {
  let time = Date.parse("2026-10-14T20:00:00Z"); const now = () => time;
  const publicKey = publicOf(key());
  let address = 0;
  const make = (lanes?: string[]) => requestPairing({ name: "phone", publicKey, ...(lanes ? { lanes } : {}) }, { now, pin: "cert-pin", address: String(address++) });
  const confirm = (r: ReturnType<typeof make>, extra = {}) => confirmPairing(r.id, comparisonCode(r.id, publicKey, "cert-pin"), { now, ...extra });
  assert.throws(() => requestPairing({ name: " ", publicKey }, { now }), BadRequest);
  assert.throws(() => requestPairing({ name: "phone", publicKey: "wrong" }, { now }), BadRequest);
  assert.throws(() => make(["../secret"]), BadRequest);
  const r = make(["r1"]);
  assert.throws(() => pollPairing(r.id, "wrong", now), Forbidden);
  assert.throws(() => cancelPairing(r.id, "wrong", now), Forbidden);
  assert.equal(pollPairing(r.id, r.secret, now).state, "waiting");
  const d = confirm(r);
  assert.deepEqual(d.lanes, ["r1"]);
  const state = join(e.root, "PALS-Notes/govern-state/remote/requests.json");
  const before = readFileSync(state, "utf8");
  assert.ok(!before.includes(r.secret)); assert.match(before, /"sealed"/);
  assert.equal(statSync(state).mode & 0o777, 0o600);
  const status = pollPairing(r.id, r.secret, now);
  assert.equal(status.state, "confirmed"); assert.ok(status.token); assert.ok(!before.includes(status.token));
  assert.equal(deviceOfToken(status.token)?.id, d.id);
  assert.ok(!readFileSync(state, "utf8").includes('"sealed"'));
  assert.equal(pollPairing(r.id, r.secret, now).token, null);
  assert.throws(() => confirm(r));
  const all = make(["r1"]); assert.equal(confirm(all, { all: true }).lanes, undefined);
  pollPairing(all.id, all.secret, now);
  const wrong = make();
  assert.throws(() => confirmPairing(wrong.id, "wrong", { now }), Forbidden);
  assert.equal(pollPairing(wrong.id, wrong.secret, now).state, "refused");
  assert.throws(() => confirm(wrong));
  const cancel = make(); cancelPairing(cancel.id, cancel.secret, now);
  assert.equal(pollPairing(cancel.id, cancel.secret, now).state, "cancelled");
  assert.throws(() => confirm(cancel));
  const refuse = make(); refusePairing(refuse.id, now);
  assert.equal(pollPairing(refuse.id, refuse.secret, now).state, "refused");
  const expire = make(), pending = make(), undelivered = confirm(pending, { all: true });
  time += 300_000;
  for (const r of [expire, pending]) assert.equal(pollPairing(r.id, r.secret, now).state, "expired");
  assert.ok(devices().find((x) => x.id === undelivered.id)?.revokedAt, "a device whose token was never delivered is revoked at expiry");
  assert.equal(devices().find((x) => x.id === d.id)?.revokedAt, undefined, "a delivered device stays paired");
  assert.ok(!readFileSync(state, "utf8").includes('"sealed"'));
  for (let i = 0; i < 32; i++) make();
  assert.throws(() => make(), TooMany);
  time += 300_000; assert.equal(requests(now).length, 0); make();
  const legacy = pair(createPairing("alice", 10).code, "legacy", publicKey);
  assert.equal(deviceOfToken(legacy.token)?.person, "alice"); assert.equal(legacy.device.lanes, undefined);
}));

test("scope filtering preserves global desks and excludes unassigned sessions for restricted devices", async () => local((e) => {
  const publicKey = publicOf(key()), r = requestPairing({ name: "scope", publicKey, lanes: [] });
  const d = confirmPairing(r.id, comparisonCode(r.id, publicKey, null), { lanes: [] });
  const desk = { ...deskView(), unreadable: [{ slug: "r1", error: "private" }], unreadableSessions: [{ id: "c1", error: "private" }], sessions: [{ lane: null }, { lane: "r1" }] };
  desk.telemetry.tokens.push({ lane: "r1", calls: 1, input: 1, output: 1, usd: 1 });
  desk.telemetry.machines.push({ lane: "r1", time: "1s", money: null });
  desk.telemetry.inbox.push({ project: "r1", id: "m", kind: "TASK", from: "x", summary: "private", created: "x" });
  write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify({ version: 1, name: "release", stages: [{ name: "draft" }], gates: [] }));
  create("r1", { process: "release" });
  desk.lanes = [{ ...laneSummary(load("r1")), blockedBy: ["r1", "r2"] }];
  desk.telemetry.allowances = ["private  lane:r2  model-usd/day", "mine  lane:r1  model-usd/day", "host  profile:codex  model-usd/day"];
  const view = scoped(desk, d);
  assert.deepEqual(view.telemetry.allowances, ["host  profile:codex  model-usd/day"]);
  assert.equal(view.telemetry.queue, desk.telemetry.queue);
  assert.equal(view.telemetry.dispatcher, desk.telemetry.dispatcher);
  assert.equal(view.engines, desk.engines);
  assert.deepEqual([view.unreadableSessions, scoped(desk, { ...d, lanes: ["r1"] }).unreadableSessions], [[], []], "an unreadable session's lane is unknown: no scoped device sees it");
  assert.deepEqual([view.unreadable, view.sessions, view.telemetry.tokens, view.telemetry.machines, view.telemetry.inbox], [[], [], [], [], []]);
  const allowed = scoped(desk, { ...d, lanes: ["r1"] });
  assert.deepEqual(allowed.sessions, [{ lane: "r1" }]);
  assert.deepEqual(allowed.telemetry.allowances, desk.telemetry.allowances.slice(1));
  assert.deepEqual(allowed.lanes[0]!.blockedBy, ["r1"]);
  assert.deepEqual(desk.lanes[0]!.blockedBy, ["r1", "r2"]);
  assert.deepEqual([allowed.unreadable.length, allowed.telemetry.tokens.length, allowed.telemetry.machines.length, allowed.telemetry.inbox.length], [1, 1, 1, 1]);
  assert.equal(desk.sessions.length, 2); assert.equal(desk.telemetry.tokens.length, 1);
  assert.equal(scoped(desk, { ...d, lanes: undefined }), desk);
}));


test("pair request routes reject malformed bodies, unknown fields and invalid lane scopes", async () => workspace(async (_e, base) => {
  const publicKey = publicOf(key());
  for (const body of [{ name: "phone", publicKey, extra: true }, { name: "phone" }, { name: "", publicKey },
    { name: "phone", publicKey, lanes: null }, { name: "phone", publicKey, lanes: ["../bad"] }, { name: "phone", publicKey: "bad" }])
    assert.equal((await post(base, "/v1/pair/request", body)).status, 400);
  assert.equal((await fetch(base + "/v1/pair/request", { method: "POST", body: "{" })).status, 400);
  assert.equal((await post(base, "/v1/pair/cancel", { id: "missing" })).status, 400);
  assert.equal((await poll(base, "missing", "secret")).status, 404);
  const legacy = await post(base, "/v1/pair", { code: createPairing("owner", 10).code, name: "legacy", publicKey });
  assert.equal(legacy.status, 200);
  const paired = await legacy.json() as any;
  assert.ok(paired.host);
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../android/app/src/test/resources/fixtures/pair.json"), "utf8"));
  assert.deepEqual(Object.keys(paired).sort(), Object.keys(fixture).sort());
}));
