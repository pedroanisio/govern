// Regression coverage for mesh grants, registrar moves, loop recovery and bounded transport.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { makeEnv, write, NOW, use, lower, network, trio, task, HERE } from "./helpers.ts";
import * as peer from "../lib/peer.ts";
import * as mesh from "../lib/mesh.ts";
import * as agents from "../lib/agents.ts";
import * as queue from "../lib/queue.ts";
import * as sessions from "../lib/sessions.ts";
import { origin } from "../lib/approval.ts";
import { fail } from "../lib/util.ts";
import { file, MAX_BODY, postFetch, signBytes } from "../lib/peer-id.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

for (const alias of [false, true]) test(`a registration whose ${alias ? "alias" : "name"} becomes a profile grants no run or directory entry`, async () => {
  const { b, c, post } = await trio();
  use(c);
  agents.register({ owner: "s1", name: alias ? "ana" : "reviewer", aliases: alias ? ["reviewer"] : [], projects: ["p"], now: NOW });
  process.env.GOVERN_CAPABILITIES = join(c.root, "caps"); c.env.GOVERN_CAPABILITIES = process.env.GOVERN_CAPABILITIES;
  write(join(c.root, "caps", "reviewer.json"), JSON.stringify({ version: 1, profiles: [{ name: "reviewer", engine: "claude", capabilities: ["read"] }] }));
  const toKey = peer.fingerprint(peer.identity().publicKey);
  use(b); const sent = task("reviewer@c"), env = peer.envelope(sent, toKey, NOW);
  use(b); const bytes = Buffer.from(JSON.stringify(env)), headers = { ...peer.sign(bytes), ...mesh.presentHeaders() };
  use(c); const denied = peer.receive(bytes, lower(headers), NOW);
  assert.deepEqual(denied, { status: 403, body: { error: "recipient not allowed" } });
  assert.equal(queue.all().length, 0);
  assert.equal(agents.resolve("reviewer", NOW), undefined); assert.deepEqual(agents.live(NOW), []);
  use(b); assert.deepEqual((await peer.discover({ post, now: () => NOW })).find(h => h.host === "c")!.agents.map(a => a.name), ["codex"]);
  use(c); mesh.setPolicy({ allow: ["codex", "reviewer"], projects: ["p"] });
  assert.equal(peer.receive(bytes, lower(headers), NOW).status, 200);
  assert.equal(queue.all()[0]!.m.profile, "reviewer");
});

test("a member learns the moved registrar URL from its certificate and uses it on the next sync", async () => {
  const { a, b, hosts } = await trio();
  use(a); await mesh.sync({ url: "https://new.example", now: () => NOW });
  const calls: string[] = [], post = network({ ...hosts, "https://new.example": a }, () => NOW, u => { calls.push(u); });
  use(b); await mesh.sync({ post, now: () => NOW });
  assert.equal(mesh.state()!.mesh.url, "https://new.example");
  await mesh.sync({ post, now: () => NOW });
  assert.deepEqual(calls, ["https://a.example/v1/mesh/sync", "https://new.example/v1/mesh/sync"]);
});

test("a signed snapshot missing the registrar certificate is refused without changing member state", async () => {
  const { a, b, post } = await trio();
  use(a); const key = JSON.parse(readFileSync(file("mesh-registrar.json"), "utf8")).privateKey;
  use(b); const before = readFileSync(file("mesh.json"), "utf8");
  await assert.rejects(mesh.sync({ now: () => NOW, post: async (...args) => {
    const r = await post(...args), snap = JSON.parse(r.text);
    snap.members = snap.members.filter((c: mesh.Cert) => JSON.parse(c.body).name !== snap.registrar);
    const text = JSON.stringify(snap);
    return { ...r, text, headers: { "govern-signature": signBytes(Buffer.from(text), key) } };
  } }), /mesh:.*registrar.*certificate/);
  assert.equal(readFileSync(file("mesh.json"), "utf8"), before);
});

// Exercise the CLI's actual tick with injected collaborators and timer, without a real interval or child process.
function loop(meshStep: object, dispatch = () => {}) {
  const source = readFileSync(join(HERE, "..", "govern.ts"), "utf8");
  const tick = source.slice(source.indexOf("    const tick = async () => {"), source.indexOf("    tick();", source.indexOf("    const tick = async () => {")));
  const logs: string[] = [], pending: (() => Promise<void>)[] = []; let discovered = 0;
  const start = new Function("mesh", "peer", "once", "out", "setTimeout", "tune", "reaping", stripTypeScriptTypes(`
    let lastTune = 0, lastReap = 0, lastSync = 0;
    const MESH_SYNC_MS = 0, reapEvery = undefined, max = undefined, secs = 1;
    ${tick}
  `) + "return tick;");
  const run = start(meshStep, { discover: async () => { discovered++; return []; }, remotes: () => [], push: async () => [] }, dispatch,
    (s: string) => logs.push(s), (f: () => Promise<void>) => pending.push(f), () => "ok", {});
  return { run: run as () => Promise<void>, logs, pending, discoveries: () => discovered };
}

test("a malformed mesh.json logs a mesh error and schedules the next dispatch tick", async () => {
  use(makeEnv("bad-mesh")); peer.identity(); write(file("mesh.json"), "{");
  let ticks = 0; const l = loop(mesh, () => { ticks++; });
  await l.run(); assert.match(l.logs.join("\n"), /\[mesh\].*mesh.json/); assert.equal(l.pending.length, 1);
  await l.pending.shift()!(); assert.equal(ticks, 2); assert.equal(l.pending.length, 1);
});

test("discovery still runs when mesh sync fails", async () => {
  const l = loop({ state: () => ({}), sync: async () => { throw new Error("registrar down"); } });
  await l.run(); assert.match(l.logs.join("\n"), /\[mesh\].*registrar down/); assert.equal(l.discoveries(), 1); assert.equal(l.pending.length, 1);
});

test("an unexpected dispatch failure is logged and schedules another tick", async () => {
  const l = loop({ state: () => undefined }, () => { throw new Error("dispatch failed"); });
  await l.run(); assert.match(l.logs.join("\n"), /dispatch failed/); assert.equal(l.pending.length, 1);
});

for (const size of [MAX_BODY, MAX_BODY + 1]) test(`peer transport ${size === MAX_BODY ? "reads exactly MAX_BODY" : "cancels a response exceeding MAX_BODY"} bytes`, async () => {
  const real = globalThis.fetch; let cancelled = false, aborted = false;
  globalThis.fetch = async (_u, init) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(MAX_BODY)); c.enqueue(new Uint8Array(size - MAX_BODY)); c.close(); },
      cancel() { cancelled = true; },
    }));
  };
  try {
    if (size === MAX_BODY) assert.equal((await postFetch("https://example.test", Buffer.from("{}"), {}, 1000)).text.length, MAX_BODY);
    else { await assert.rejects(postFetch("https://example.test", Buffer.from("{}"), {}, 1000), /262144.*bytes/); assert.ok(cancelled || aborted); }
  } finally { globalThis.fetch = real; }
});

// Run the command body against real registration/session state, with the caller identity injected.
test("an unnamed session cannot register a live session name or alias but can register free and ephemeral names", async () => {
  const e = makeEnv("unnamed"); use(e);
  write(join(e.env.GOVERN_SESSIONS_DIR!, "alice.json"), JSON.stringify({ pid: 1, name: "alice", sessionId: "alice-session" }));
  const source = readFileSync(join(HERE, "..", "govern.ts"), "utf8");
  const fn = source.slice(source.indexOf("async function cmdAgents("), source.indexOf("/** The operator's view"))
    .replace('await import("./lib/sessions.ts")', "sessionModule");
  let self: string | undefined;
  const run = new Function("opt", "flag", "many", "resolveAs", "callingSession", "sessions", "sessionModule", "agents", "peer", "out", "fail", "secondsOpt",
    stripTypeScriptTypes(fn) + "; return cmdAgents;")(
    (a: Record<string, unknown>, n: string) => a[n], (a: Record<string, unknown>, n: string) => !!a[n],
    (a: Record<string, unknown>, n: string) => a[n] ?? [], () => self, () => ({ pid: process.pid, sessionId: "caller" }),
    sessions.sessions, sessions, agents, peer, () => {}, fail, () => undefined);
  for (const args of [{ as: "alice" }, { as: "free", alias: ["alice"] }])
    await assert.rejects(run({ _: ["agents", "register"], project: ["p"], ...args }), /alice.*live session/);
  for (const args of [{ as: "free" }, { ephemeral: true }]) await run({ _: ["agents", "register"], project: ["p"], ...args });
  assert.ok(agents.resolve("free")); assert.ok(agents.live().some(a => a.kind === "ephemeral"));
  self = "mine";
  write(join(e.env.GOVERN_SESSIONS_DIR!, "mine.json"), JSON.stringify({ pid: process.pid, name: self, sessionId: "caller" }));
  await run({ _: ["agents", "register"], project: ["p"] }); assert.ok(agents.resolve("mine"));
});

test("bare mesh prints status from a non-terminal origin", async () => {
  use(makeEnv("mesh-default")); process.env.CODEX_THREAD_ID = "agent";
  assert.throws(() => origin(), /Codex session/);
  const source = readFileSync(join(HERE, "..", "govern.ts"), "utf8");
  const fn = source.slice(source.indexOf("async function cmdMesh("), source.indexOf("/** Agents publish and find"));
  const output: string[] = [];
  const run = new Function("opt", "many", "origin", "mesh", "out", "fail", stripTypeScriptTypes(fn) + "; return cmdMesh;")(
    () => undefined, () => [], origin, mesh, (s: string) => output.push(s), fail);
  await run({ _: ["mesh"] }); assert.match(output.join("\n"), /not in a mesh/);
});

test("center serve listens and prints the requested IPv6 loopback host", async () => {
  const source = readFileSync(join(HERE, "..", "govern.ts"), "utf8");
  const fn = source.slice(source.indexOf("async function cmdCenter("), source.indexOf("/** The text of the user service"));
  const listening: unknown[][] = [], output: string[] = [];
  const run = new Function("opt", "remote", "peer", "center", "out", "fail", "process", stripTypeScriptTypes(fn) + "; return cmdCenter;")(
    (_a: unknown, n: string) => n === "host" ? "::1" : "5004", { loopback: () => true }, { identity() {} },
    { newToken: () => "token", centerServer: () => ({ on() {}, listen(...args: unknown[]) { listening.push(args.slice(0, 2)); (args[2] as () => void)(); } }) },
    (s: string) => output.push(s), assert.fail, process);
  await run({ _: ["center", "serve"] });
  assert.deepEqual(listening, [[5004, "::1"]]); assert.match(output.join("\n"), /http:\/\/\[::1\]:5004/);
});
