// The command center: per-host telemetry, who may read it, the merged view with its alerts, and the loopback dashboard.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, NOW, DAY, use, lower, network, policy, trio, task } from "./helpers.ts";
import * as peer from "../ext/peer/peer.ts";
import * as mesh from "../ext/peer/mesh.ts";
import * as agents from "../lib/agents.ts";
import * as queue from "../lib/queue.ts";
import * as center from "../ext/center/center.ts";
import { type Headers } from "../lib/peer-id.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const ledger = (entries: Record<string, unknown>[]) => { mkdirSync(queue.QUEUE(), { recursive: true }); for (const e of entries) appendFileSync(join(queue.QUEUE(), "ledger.jsonl"), JSON.stringify(e) + "\n"); };
const iso = (ms: number) => new Date(ms).toISOString();

test("a host's telemetry counts its queue, relay, last day's runs by agent and agents, and carries no message body", async () => {
  const { b, post } = await trio();
  use(b);
  agents.register({ owner: "s1", name: "ana", aliases: ["qa"], projects: ["p"], description: "reviews", now: NOW });
  task("codex@c"); task("owner", { summary: "x".repeat(300) });
  await peer.push({ now: NOW, post });
  ledger([
    { t: iso(NOW - 1000), agent: "codex", ok: true, seconds: 12, usage: { input: 1000, output: 200, costUsd: 0.25 } },
    { t: iso(NOW - 2000), agent: "codex", ok: false, seconds: 3, usage: { input: 10, output: 0 } },
    { t: iso(NOW - 3000), agent: "claude", ok: true, seconds: 5 },
    { t: iso(NOW - 2 * DAY), agent: "codex", ok: true, seconds: 99, usage: { costUsd: 9 } },
    { t: iso(NOW - 1000), kind: "relay", agent: "relay", ok: true, seconds: 1 },
  ]);
  const t = peer.localTelemetry(NOW);
  assert.equal(t.host, "b"); assert.equal(t.mesh?.name, "lab"); assert.equal(t.mesh?.registrar, false); assert.deepEqual(t.mesh?.observers, ["a"]);
  assert.deepEqual(t.queue, { open: 1, claimed: 0, done: 1, failed: 0, unverified: 0 });
  assert.equal(t.relay.delivered24h, 1); assert.equal(t.relay.outboundOpen, 0);
  assert.deepEqual(t.runs24h, { count: 3, ok: 2, failed: 1, seconds: 20, input: 1010, output: 200, costUsd: 0.25 });
  assert.deepEqual(Object.keys(t.byAgent).sort(), ["claude", "codex"]); assert.equal(t.byAgent.codex!.count, 2);
  assert.deepEqual(t.agents.registered, [{ name: "ana", kind: "stable", aliases: ["qa"], projects: ["p"], expires: iso(NOW + 12 * 3600_000), description: "reviews" }]);
  assert.ok(t.agents.runners.includes("codex"));
  assert.equal(t.recent.length, 2); assert.ok(t.recent.every(m => m.summary.length <= 200));
  assert.ok(!JSON.stringify(t).includes("evidence"), "message bodies never leave the host");
});

test("only the members a host names as observers read its telemetry, by default the registrar", async () => {
  const { a, b, c, post } = await trio();
  use(a); const seen = await peer.observe({ post, now: () => NOW });
  assert.deepEqual(seen.map(o => [o.host, o.ok, o.telemetry?.host]), [["b", true, "b"], ["c", true, "c"]]);
  use(b); const denied = await peer.observe({ post, now: () => NOW });
  assert.deepEqual(denied.map(o => [o.host, o.ok]), [["a", false], ["c", false]]); assert.match(denied[1]!.error!, /403.*not an observer/);
  use(c); mesh.setPolicy({ ...policy(), observers: ["b"] });
  use(b); assert.equal((await peer.observe({ post, now: () => NOW })).find(o => o.host === "c")?.ok, true);
  use(a); assert.match((await peer.observe({ post, now: () => NOW })).find(o => o.host === "c")!.error!, /not an observer/, "naming observers replaces the default");
});

test("a telemetry request is bound to its destination and clock, and a forged answer is discarded", async () => {
  const { a, b, c, post } = await trio();
  let captured: { bytes: Buffer; headers: Headers } | undefined;
  use(a); await peer.observe({ post: async (u, bytes, headers, t) => { if (u.includes("b.example")) captured = { bytes, headers }; return post(u, bytes, headers, t); }, now: () => NOW });
  assert.ok(captured);
  use(c); assert.deepEqual(peer.serveTelemetry(captured.bytes, lower(captured.headers), NOW).body, { error: "addressed to another host" });
  use(b); assert.deepEqual(peer.serveTelemetry(captured.bytes, lower(captured.headers), NOW + 301_000).body, { error: "timestamp outside five minute window" });
  assert.deepEqual(peer.serveTelemetry(Buffer.from("{"), { "govern-peer-key": "x" }, NOW).body, { error: "unknown peer" });
  const forging: peer.Post = async (u, bytes, headers) => { const r = await post(u, bytes, headers, 1); return { ...r, text: r.text.replace('"queue"', '"queue" ') }; };
  use(a); const bad = await peer.observe({ post: forging, now: () => NOW });
  assert.ok(bad.every(o => !o.ok && /not signed by the host's key/.test(o.error!)));
});

test("a static peer is never an observer", async () => {
  const { b } = await trio();
  const z = makeEnv("center-z"); use(z); const zi = peer.identity("z");
  use(b); peer.addPeer({ name: "z", url: "https://z.example", publicKey: zi.publicKey, allow: [], projects: ["p"] });
  mesh.setPolicy({ ...policy(), observers: ["z"] });
  use(z); peer.addPeer({ name: "b", url: "https://b.example", publicKey: (use(b), peer.identity()).publicKey, allow: [], projects: ["p"] });
  use(z); const bytes = Buffer.from(JSON.stringify({ protocol: peer.PROTOCOL, kind: "telemetry", at: iso(NOW), toKey: peer.fingerprint((use(b), peer.identity()).publicKey), id: "i" }));
  use(z); const headers = peer.sign(bytes);
  use(b); assert.deepEqual(peer.serveTelemetry(bytes, lower(headers), NOW).body, { error: "not an observer of this host" });
});

test("the command center merges every host, newest messages first, and raises alerts with their consequence", async () => {
  const { a, b, c, hosts } = await trio();
  use(b); task("codex@c", { summary: "from b" }); use(c); task("owner", { summary: "from c" });
  const partial = network({ "https://b.example": b }, () => NOW + 25 * DAY);
  use(a); const v = await center.gather({ post: partial, now: () => NOW + 25 * DAY });
  assert.equal(v.mesh?.name, "lab"); assert.equal(v.mesh?.registrar, "a");
  assert.deepEqual(v.hosts.map(h => [h.host, h.self, h.registrar, h.ok]), [["a", true, true, true], ["b", false, false, true], ["c", false, false, false]]);
  assert.equal(v.alerts[0]!.level, "critical"); assert.equal(v.alerts[0]!.host, "c"); assert.match(v.alerts[0]!.message, /no telemetry: no host at https:\/\/c.example/);
  assert.ok(v.alerts.some(x => x.host === "b" && /certificate expires in 5 days/.test(x.message)));
  assert.ok(v.alerts.some(x => x.host === "a" && /dispatcher not running/.test(x.message)));
  assert.ok(v.alerts.some(x => /last mesh sync/.test(x.message)));
  assert.deepEqual(v.messages.map(m => [m.host, m.summary]), [["b", "from b"]]);
  assert.deepEqual(v.agents.filter(r => r.kind === "runners").map(r => r.host), ["a", "b"], "every reporting host lists its agents");
  const text = center.render(v);
  for (const s of ["COMMAND CENTER", "mesh lab (registrar a)", "HOSTS (3)", "● a", "✖ c", "ALERTS", "‼ c: no telemetry", "AGENTS", "SPEND, LAST 24 H", "MESSAGES (latest 1)", "codex@c"]) assert.ok(text.includes(s), s);
  use(a); const all = await center.gather({ post: network(hosts), now: () => NOW });
  assert.equal(all.hosts.filter(h => h.ok).length, 3);
  assert.deepEqual(all.messages.map(m => m.summary).sort(), ["from b", "from c"]);
});

test("certificate and failure alerts are derived from telemetry alone", () => {
  const t = (over: Record<string, unknown>) => ({ host: "h", self: false, registrar: false, ok: true, telemetry: { ...peerless(), ...over } as never });
  assert.deepEqual(center.alertsFor({ host: "h", self: false, registrar: false, ok: false, error: "offline" }, NOW), [{ level: "critical", host: "h", message: "no telemetry: offline" }]);
  const expired = center.alertsFor(t({ mesh: { name: "m", registrar: false, syncedAt: iso(NOW), certExpires: iso(NOW - 1), members: 2, observers: [] } }), NOW);
  assert.deepEqual(expired.map(x => x.level), ["critical"]);
  const busy = center.alertsFor(t({ relay: { outboundOpen: 2, retrying: 1, failed24h: 3, delivered24h: 0, inbound24h: 0, lastError: "offline" }, queue: { open: 0, claimed: 0, done: 0, failed: 0, unverified: 2 }, runs24h: { count: 4, ok: 3, failed: 1, seconds: 1, input: 0, output: 0, costUsd: 0 } }), NOW);
  assert.deepEqual(busy.map(x => x.message), ["3 outbound deliveries failed in 24 h: offline", "1 outbound deliveries are retrying", "2 replies failed verification and wait for review", "1 of 4 runs failed in 24 h"]);
});
test("the agents list shows every live session once, beside registered agents and runners, for each reporting host", () => {
  const h = (host: string, agents: Record<string, unknown>) => ({ host, self: false, registrar: false, ok: true, telemetry: { ...peerless(), host, agents } as never });
  const rows = center.agentRows([
    h("a", { runners: ["codex"], sessions: ["ana", "bob"], registered: [{ name: "ana", kind: "stable", aliases: ["qa"], projects: ["p", "q"], expires: iso(NOW) }, { name: "e-k3v9q2mz", kind: "ephemeral", aliases: [], projects: ["p"], expires: iso(NOW + 1) }] }),
    h("b", { runners: ["codex", "grok"], sessions: ["cy"], registered: [] }),
    { host: "c", self: false, registrar: false, ok: false, error: "offline" },
  ]);
  assert.deepEqual(rows, [
    { host: "a", names: ["ana", "qa"], address: "ana@a (qa)", kind: "stable", reach: "p, q", until: iso(NOW) },
    { host: "a", names: ["e-k3v9q2mz"], address: "e-k3v9q2mz@a", kind: "ephemeral", reach: "p", until: iso(NOW + 1) },
    { host: "a", names: ["bob"], address: "bob@a", kind: "session", reach: "this host only" },
    { host: "a", names: ["codex"], address: "codex @a", kind: "runners", reach: "as granted" },
    { host: "b", names: ["cy"], address: "cy@b", kind: "session", reach: "this host only" },
    { host: "b", names: ["codex", "grok"], address: "codex, grok @b", kind: "runners", reach: "as granted" },
  ], "a registered session is listed once, as registered; an unreachable host lists nothing");
  const text = center.render({ at: iso(NOW), hosts: [], peers: [], alerts: [], messages: [], agents: rows });
  for (const s of ["bob@a  session  this host only", "ana@a (qa)  stable  p, q  until " + iso(NOW), "codex, grok @b  runners  as granted"]) assert.ok(text.includes(s), s);
});

function peerless() {
  return { protocol: "govern-telemetry/1", host: "h", fingerprint: "0".repeat(64), at: iso(NOW), dispatcher: { running: true }, peers: 0,
    queue: { open: 0, claimed: 0, done: 0, failed: 0, unverified: 0 }, relay: { outboundOpen: 0, retrying: 0, failed24h: 0, delivered24h: 0, inbound24h: 0 },
    runs24h: { count: 0, ok: 0, failed: 0, seconds: 0, input: 0, output: 0, costUsd: 0 }, byAgent: {}, agents: { runners: [], sessions: [], registered: [] }, recent: [] };
}

async function get(port: number, path: string, headers: Record<string, string> = {}) {
  const req = request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } });
  req.end(); const [res] = await once(req, "response") as [import("node:http").IncomingMessage];
  let body = ""; for await (const chunk of res) body += chunk;
  return { status: res.statusCode, headers: res.headers, body };
}
test("the dashboard serves its page openly and its data only with the token, to loopback host names", async () => {
  let calls = 0;
  const view: center.View = { at: iso(NOW), hosts: [], peers: [], alerts: [], messages: [], agents: [] };
  const server = center.centerServer({ token: "secret-token", view: async () => { calls++; return view; } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const page = await get(port, "/");
    assert.equal(page.status, 200); assert.match(page.body, /<title>govern command center<\/title>/);
    assert.match(page.body, /navigator\.clipboard\.writeText/, "host ids, agent names and addresses copy on click");
    for (const s of ['copy(host,', 'copy(n,', 'copy(`${r.names[0]}@${r.host}`']) assert.ok(page.body.includes(s), s);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/); assert.equal(page.headers["cache-control"], "no-store");
    assert.equal((await get(port, "/api/state")).status, 401);
    assert.equal((await get(port, "/api/state", { Authorization: "Bearer wrong" })).status, 401);
    const ok = await get(port, "/api/state", { Authorization: "Bearer secret-token" });
    assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.body), view);
    await get(port, "/api/state", { Authorization: "Bearer secret-token" }); assert.equal(calls, 1, "a view is reused for ten seconds");
    assert.equal((await get(port, "/api/state", { Authorization: "Bearer secret-token", Host: "evil.example" })).status, 403);
    assert.equal((await get(port, "/", { Host: `localhost:${port}` })).status, 200);
    assert.equal((await get(port, "/other")).status, 404);
  } finally { server.close(); }
  assert.match(center.newToken(), /^[A-Za-z0-9_-]{32}$/);
});

test("govern center prints the view, as JSON on request, and its server binds loopback only", () => {
  const e = makeEnv("center-cli");
  let r = govern(e, ["center"]); assert.equal(r.code, 0, r.err); assert.match(r.out, /COMMAND CENTER .* not in a mesh/); assert.match(r.out, /HOSTS \(1\)/);
  r = govern(e, ["center", "show", "--json"]); assert.equal(r.code, 0, r.err);
  const v = JSON.parse(r.out); assert.equal(v.hosts.length, 1); assert.equal(v.hosts[0].self, true); assert.equal(v.mesh, undefined);
  for (const args of [["--host", "0.0.0.0"], ["--port", "0"]]) { r = govern(e, ["center", "serve", ...args]); assert.equal(r.code, args[0] === "--host" ? 4 : 2, r.err); }
});
