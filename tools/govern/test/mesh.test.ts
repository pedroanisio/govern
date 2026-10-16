// Mesh registration and discovery: hosts join with one invite each, trust each other through registrar certificates,
// and list what they may address on every other host. Transport is in-process; peer-http.test.ts covers real HTTP.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, write, NOW, DAY, use, lower, network, policy, trio, task } from "./helpers.ts";
import * as peer from "../ext/peer/peer.ts";
import * as mesh from "../ext/peer/mesh.ts";
import * as agents from "../lib/agents.ts";
import * as queue from "../lib/queue.ts";
import { stateDir } from "../lib/workspace.ts";
import { newKeys, type Headers } from "../lib/peer-id.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
test("three hosts each join once and can deliver to each other with no pairwise setup", async () => {
  const { a, b, c, post } = await trio();
  for (const e of [a, b, c]) { use(e); assert.deepEqual(peer.remotes(NOW).map(r => r.name), ["a", "b", "c"].filter(n => n !== peer.identity().name)); }
  use(b); const sent = task("codex@c");
  assert.deepEqual((await peer.push({ now: NOW, post })).length, 1); assert.equal(queue.find(sent.id)?.state, "done");
  use(c); const got = queue.all()[0]!.m;
  assert.equal(got.from, "alice@b"); assert.equal(got.to, "codex"); assert.equal(got.access, "read-only"); assert.deepEqual(got.remote, { peer: "b", id: sent.id });
  assert.equal(mesh.isRegistrar(), false); use(a); assert.equal(mesh.isRegistrar(), true);
});

test("a member that joined after the receiver last synced is trusted by the certificate it presents", async () => {
  const { a, b, hosts, post } = await trio();
  const d = makeEnv("mesh-d"), all = network({ ...hosts, "https://d.example": d });
  use(d); peer.identity("d"); use(a); const { code } = mesh.invite({ host: "d", now: NOW });
  use(d); await mesh.join(code, { url: "https://d.example", policy: policy(), post: all, now: () => NOW });
  use(b); assert.equal(mesh.memberByName("d", NOW), undefined);
  use(d); task("codex@b"); assert.match((await peer.push({ now: NOW, post: all }))[0]!, /delivered to b/);
  use(b); assert.equal(queue.all()[0]!.m.from, "alice@d");
  void post;
});

test("a delivery captured on its way to one member is refused by every other member", async () => {
  const { b, c, post } = await trio();
  let captured: { bytes: Buffer; headers: Headers } | undefined;
  const tapped = network({ "https://b.example": b, "https://c.example": c }, () => NOW, (u, bytes, headers) => { if (u.includes("c.example")) captured = { bytes, headers }; });
  use(b); task("codex@c"); await peer.push({ now: NOW, post: tapped });
  assert.ok(captured);
  use(b); // b also grants codex in p to every member, so only the destination binding stops the replay
  const replay = peer.receive(captured.bytes, lower(captured.headers), NOW + 1000);
  assert.deepEqual(replay, { status: 403, body: { error: "addressed to another host" } });
  assert.equal(queue.all().filter(x => x.m.remote).length, 0);
  void post;
});

test("an invite works once, before it expires, for the host it names, with its own secret", async () => {
  const a = makeEnv("inv-a"), b = makeEnv("inv-b"), c = makeEnv("inv-c");
  const post = network({ "https://a.example": a, "https://b.example": b });
  use(a); peer.identity("a"); mesh.create({ name: "lab", url: "https://a.example", policy: policy(), now: NOW });
  use(b); peer.identity("b"); use(c); peer.identity("c");
  use(a); const once = mesh.invite({ now: NOW }).code;
  use(b); await mesh.join(once, { url: "https://b.example", policy: policy(), post, now: () => NOW });
  use(c); await assert.rejects(mesh.join(once, { url: "https://c.example", policy: policy(), post, now: () => NOW }), /registrar refused \(403\).*invalid or used invite/);
  use(a); const short = mesh.invite({ ttlSeconds: 60, now: NOW }).code;
  use(c); await assert.rejects(mesh.join(short, { url: "https://c.example", policy: policy(), post: network({ "https://a.example": a }, () => NOW + 61_000), now: () => NOW + 61_000 }), /invalid or used invite/);
  use(a); const pinned = mesh.invite({ host: "d", now: NOW }).code;
  use(c); await assert.rejects(mesh.join(pinned, { url: "https://c.example", policy: policy(), post, now: () => NOW }), /this invite is for host d/);
  use(a); const real = mesh.parseInvite(mesh.invite({ now: NOW }).code);
  const forged = "govern-mesh:" + Buffer.from(JSON.stringify({ ...real, secret: "guess" })).toString("base64url");
  use(c); await assert.rejects(mesh.join(forged, { url: "https://c.example", policy: policy(), post, now: () => NOW }), /invalid or used invite/);
  assert.throws(() => mesh.parseInvite("https://a.example"), /not a mesh invite code/);
  use(a); assert.throws(() => mesh.invite({ ttlSeconds: 59 }), /--ttl/); assert.throws(() => mesh.invite({ host: "Bad" }), /\$/);
  use(b); assert.throws(() => mesh.invite(), /only the registrar invites/);
});

test("a host name already in the mesh cannot be taken by another key, and a joiner rejects a forged registrar answer", async () => {
  const a = makeEnv("name-a"), b = makeEnv("name-b"), b2 = makeEnv("name-b2");
  const post = network({ "https://a.example": a });
  use(a); peer.identity("a"); mesh.create({ name: "lab", url: "https://a.example", policy: policy(), now: NOW });
  use(b); peer.identity("b"); use(a); let code = mesh.invite({ now: NOW }).code;
  use(b); await mesh.join(code, { url: "https://b.example", policy: policy(), post, now: () => NOW });
  use(b2); peer.identity("b"); use(a); code = mesh.invite({ now: NOW }).code;
  use(b2); await assert.rejects(mesh.join(code, { url: "https://b2.example", policy: policy(), post, now: () => NOW }), /\(409\).*name b is taken/);
  const e = makeEnv("name-e"); use(e); peer.identity("e"); use(a); code = mesh.invite({ now: NOW }).code;
  const forging: peer.Post = async (u, bytes, headers) => { const r = await post(u, bytes, headers, 1); return { ...r, text: r.text.replace('"lab"', '"evil"') }; };
  use(e); await assert.rejects(mesh.join(code, { url: "https://e.example", policy: policy(), post: forging, now: () => NOW }), /not signed by the mesh key/);
  assert.equal(mesh.state(), undefined);
  await assert.rejects(mesh.join(code, { url: "http://e.example", policy: policy(), post, now: () => NOW }), /https URL/);
  await assert.rejects(mesh.join(code, { url: "https://e.example", policy: policy([], []), post, now: () => NOW }), /--project is required/);
});

test("a revoked member is refused at once by synced members and cannot renew", async () => {
  const { a, b, c, post } = await trio();
  use(a); mesh.revoke("c", NOW); assert.throws(() => mesh.revoke("c", NOW), /no live member c/); assert.throws(() => mesh.revoke("a", NOW), /cannot revoke itself/);
  use(b); await mesh.sync({ post, now: () => NOW });
  assert.throws(() => peer.remote("c", NOW), /no live peer or mesh member c/);
  use(c); task("codex@b"); const lines = await peer.push({ now: NOW, post });
  assert.match(lines[0]!, /failed: peer b refused \(403\).*unknown peer/);
  await assert.rejects(mesh.sync({ post, now: () => NOW }), /\(403\).*not a member/);
});

test("certificates lapse after thirty days without a sync, and a sync renews them", async () => {
  const { b, c, hosts } = await trio(), later = NOW + 31 * DAY, post = network(hosts, () => later);
  use(c); task("codex@b");
  assert.match((await peer.push({ now: later, post }))[0]!, /no live peer or mesh member b/);
  use(b); await mesh.sync({ post, now: () => later }); use(c); await mesh.sync({ post, now: () => later });
  task("codex@b"); assert.match((await peer.push({ now: later, post }))[0]!, /delivered to b/);
});

test("a member moves to a new address with one sync, and the others follow at theirs", async () => {
  const { a, b, c, hosts } = await trio();
  const post = network({ ...hosts, "https://b2.example": b });
  use(b); await mesh.sync({ url: "https://b2.example", post, now: () => NOW });
  use(a); assert.equal(mesh.memberByName("b", NOW)?.url, "https://b2.example");
  use(c); await mesh.sync({ post, now: () => NOW }); assert.equal(peer.remote("b", NOW).url, "https://b2.example");
  use(a); await mesh.sync({ url: "https://a2.example", post, now: () => NOW }); assert.equal(mesh.state()!.mesh.url, "https://a2.example");
  await assert.rejects(mesh.sync({ url: "ftp://x", post }), /https URL/);
});

test("agents register themselves: addressable for their projects until expiry, never under a runner's name", async () => {
  const { b, c, post } = await trio();
  use(c);
  assert.throws(() => agents.register({ owner: "s1", name: "codex", projects: ["p"] }), /only the owner grants it/);
  assert.throws(() => agents.register({ owner: "s1", name: "owner", projects: ["p"] }), /only the owner grants it/);
  assert.throws(() => agents.register({ owner: "s1", name: "x", projects: ["p"], ttlSeconds: 30 }), /--ttl/);
  assert.throws(() => agents.register({ owner: "s1", name: "x", projects: ["*", "p"] }), /only project/);
  assert.throws(() => agents.register({ owner: "s1", name: "x", projects: ["p"], description: "two\nlines" }), /one line/);
  agents.register({ owner: "s1", name: "reviewer", projects: ["p", "q"], description: "reviews claims", ttlSeconds: 3600, now: NOW });
  use(b); const ok = task("reviewer@c"), outside = task("reviewer@c", { project: "q" }), stranger = task("nobody@c");
  const lines = await peer.push({ now: NOW, post }), line = (m: queue.Message) => lines.find(l => l.startsWith(m.id)) ?? "";
  assert.match(line(ok), /delivered to c/);
  assert.match(line(outside), /refused \(403\).*project not allowed/, "the receiving host's policy bounds a registration");
  assert.match(line(stranger), /refused \(403\).*recipient not allowed/);
  use(c); assert.ok(agents.unregister("reviewer", "s1", NOW)); assert.equal(agents.unregister("reviewer", "s1", NOW), false);
  agents.register({ owner: "s1", name: "reviewer", projects: ["p"], ttlSeconds: 60, now: NOW });
  use(b); task("reviewer@c");
  assert.match((await peer.push({ now: NOW + 61_000, post: network({ "https://c.example": c }, () => NOW + 61_000) }))[0]!, /recipient not allowed/);
});

test("discovery lists, per host, what this host may address there, from answers signed by that host", async () => {
  const { a, b, c, post } = await trio();
  use(c); agents.register({ owner: "s1", name: "reviewer", projects: ["*"], description: "reviews claims", now: NOW });
  use(a); mesh.setPolicy(policy(["codex", "claude"], ["p", "q"]));
  use(b); const hosts = await peer.discover({ post, now: () => NOW });
  assert.deepEqual(hosts.map(h => [h.host, h.via, h.ok]), [["a", "mesh", true], ["c", "mesh", true]]);
  assert.deepEqual(hosts[0]!.agents, [{ name: "codex", kind: "runner", projects: ["p", "q"] }, { name: "claude", kind: "runner", projects: ["p", "q"] }]);
  assert.deepEqual(hosts[1]!.agents, [{ name: "codex", kind: "runner", projects: ["p"] }, { name: "reviewer", kind: "agent", projects: ["p"], lifetime: "stable", description: "reviews claims" }]);
  assert.deepEqual(peer.cached()?.hosts, hosts);
  const forging: peer.Post = async (u, bytes, headers) => { const r = await post(u, bytes, headers, 1); return { ...r, text: r.text.replace("reviewer", "attacker") }; };
  const bad = await peer.discover({ post: forging, now: () => NOW });
  assert.equal(bad[1]!.ok, false); assert.match(bad[1]!.error!, /not signed by the host's key/); assert.deepEqual(bad[1]!.agents, []);
  const offline = await peer.discover({ post: async () => { throw new Error("offline"); }, now: () => NOW });
  assert.deepEqual(offline.map(h => h.error), ["offline", "offline"]);
});

test("a directory request is bound to its destination and clock like a delivery", async () => {
  const { b, c, post } = await trio();
  let captured: { bytes: Buffer; headers: Headers } | undefined;
  use(b); await peer.discover({ post: async (u, bytes, headers, t) => { if (u.includes("c.example")) captured = { bytes, headers }; return post(u, bytes, headers, t); }, now: () => NOW });
  assert.ok(captured);
  use(b); assert.deepEqual(peer.serveDirectory(captured.bytes, lower(captured.headers), NOW).body, { error: "addressed to another host" });
  use(c); assert.deepEqual(peer.serveDirectory(captured.bytes, lower(captured.headers), NOW + 301_000).body, { error: "timestamp outside five minute window" });
  assert.equal(peer.serveDirectory(captured.bytes, lower(captured.headers), NOW).status, 200);
  assert.deepEqual(peer.serveDirectory(Buffer.from("{}"), { "govern-peer-key": "x" }, NOW).body, { error: "unknown peer" });
});

test("a static peer and a mesh member that share a name with different keys are refused, not guessed", async () => {
  const { b, c, post } = await trio();
  use(b); peer.addPeer({ name: "c", url: "https://other.example", publicKey: newKeys().publicKey, allow: [], projects: ["p"] });
  assert.throws(() => peer.remote("c", NOW), /ambiguous/);
  assert.deepEqual(peer.remotes(NOW).map(r => r.name), ["a"]);
  use(c); task("codex@b"); assert.match((await peer.push({ now: NOW, post }))[0]!, /refused \(403\).*unknown peer/);
});

test("the mesh policy bounds every member, and mesh state is a closed shape", async () => {
  const { b, c, post } = await trio();
  use(b); assert.throws(() => mesh.setPolicy(policy([], [])), /--project is required/);
  mesh.setPolicy(policy(["codex"], ["other"]));
  use(c); task("codex@b"); assert.match((await peer.push({ now: NOW, post }))[0]!, /project not allowed/);
  use(b); const f = join(stateDir(), "peer", "mesh.json"); write(f, JSON.stringify({ ...mesh.state(), extra: 1 }));
  assert.throws(() => mesh.state(), (e: Error) => e.message.includes(f) && e.message.includes("$.extra"));
});

test("certificates verify only under their own mesh key, unexpired and correctly signed", () => {
  const m = newKeys(), other = newKeys(), host = newKeys();
  const cert = mesh.issue(m, { name: "h", url: "https://h.example", publicKey: host.publicKey }, NOW);
  assert.equal(mesh.verifyCert(cert, m.publicKey, NOW).name, "h");
  assert.throws(() => mesh.verifyCert(cert, other.publicKey, NOW), /bad signature/);
  assert.throws(() => mesh.verifyCert({ ...cert, body: cert.body.replace('"h"', '"x"') }, m.publicKey, NOW), /bad signature/);
  assert.throws(() => mesh.verifyCert(cert, m.publicKey, NOW + mesh.CERT_MS), /expired/);
  assert.throws(() => mesh.verifyCert(cert, m.publicKey, NOW - 10 * 60_000), /future/);
});

test("a host is in at most one mesh", async () => {
  const { b } = await trio();
  use(b); assert.throws(() => mesh.create({ name: "x", url: "https://b.example", policy: policy() }), /already in mesh lab/);
  await assert.rejects(mesh.join("govern-mesh:" + Buffer.from(JSON.stringify({ v: 1, url: "https://a.example", mesh: newKeys().publicKey, id: "i", secret: "s" })).toString("base64url"), { url: "https://b.example", policy: policy() }), /already in mesh lab/);
  const fresh = makeEnv("mesh-none"); use(fresh); await assert.rejects(mesh.sync(), /not in a mesh/);
  assert.throws(() => mesh.setPolicy(policy()), /not in a mesh/);
});

test("p2p is bidirectional: an answer reaches the local author of the message it answers without a grant", async () => {
  const { b, c, post } = await trio();
  use(c); mesh.setPolicy(policy(["codex"], ["p"]));       // c grants members codex only: alice@c is not granted
  use(c); const asked = task("codex@b"); await peer.push({ now: NOW, post });
  use(b); const incoming = queue.all()[0]!.m;
  const answer = queue.send({ project: "p", task: "t", kind: "HANDOFF", from: "codex", to: "alice@c", summary: "done", body: "answer", files: [], replyTo: incoming.id, access: "read-only" });
  assert.match((await peer.push({ now: NOW, post }))[0]!, /delivered to c/);
  use(c); const back = queue.all().find(x => x.m.remote)!.m;
  assert.equal(back.to, "alice"); assert.equal(back.replyTo, asked.id); assert.deepEqual(queue.thread(back).map(x => x.id), [asked.id, back.id]);
  use(b); const unsolicited = task("alice@c"); await peer.push({ now: NOW, post });
  assert.equal(queue.find(unsolicited.id)?.state, "failed", "a new conversation still needs a grant");
  void answer;
});

test("an answer never starts a run on the asking host without a grant", async () => {
  const { b, c, post } = await trio();
  use(c); mesh.setPolicy(policy([], ["p"]));
  use(c); const asked = task("reviewer@b", { from: "claude" });
  use(b); agents.register({ owner: "s-b", name: "reviewer", projects: ["p"], now: NOW });
  use(c); await peer.push({ now: NOW, post });
  use(b); const incoming = queue.all()[0]!.m;
  queue.send({ project: "p", task: "t", kind: "HANDOFF", from: "reviewer", to: "claude@c", summary: "done", body: "x", files: [], replyTo: incoming.id, access: "read-only" });
  assert.match((await peer.push({ now: NOW, post }))[0]!, /refused \(403\).*recipient not allowed/);
  void asked;
});

test("agent names and aliases are unique per host, held by their owner, and an alias files under the agent's name", async () => {
  const { b, c, post } = await trio();
  use(c);
  const r = agents.register({ owner: "s1", name: "ana", aliases: ["reviewer", "qa"], projects: ["p"], description: "reviews", now: NOW });
  assert.deepEqual(r.aliases, ["reviewer", "qa"]); assert.equal(r.kind, "stable");
  assert.throws(() => agents.register({ owner: "s2", name: "ana", projects: ["p"], now: NOW }), /held by another owner/);
  assert.throws(() => agents.register({ owner: "s2", name: "bob", aliases: ["qa"], projects: ["p"], now: NOW }), /qa is held by agent ana/);
  assert.throws(() => agents.register({ owner: "s2", name: "reviewer", projects: ["p"], now: NOW }), /reviewer is held by agent ana/);
  assert.throws(() => agents.register({ owner: "s1", name: "ana", aliases: ["codex"], projects: ["p"], now: NOW }), /only the owner grants it/);
  assert.throws(() => agents.register({ owner: "s1", name: "ana", aliases: ["ana"], projects: ["p"], now: NOW }), /alias must differ/);
  assert.throws(() => agents.unregister("ana", "s2", NOW), /another owner/);
  assert.equal(agents.register({ owner: "s1", name: "ana", aliases: ["reviewer"], projects: ["p"], description: "reviews", now: NOW + 1000 }).registeredAt, r.registeredAt, "a refresh by its owner keeps the name");
  assert.equal(agents.resolve("reviewer", NOW)?.name, "ana"); assert.equal(agents.resolve("qa", NOW), undefined, "a refresh replaces the aliases");
  use(b); task("reviewer@c"); assert.match((await peer.push({ now: NOW, post }))[0]!, /delivered to c/);
  use(c); assert.equal(queue.all().find(x => x.m.remote)!.m.to, "ana");
  use(b); const listed = (await peer.discover({ post, now: () => NOW })).find(h => h.host === "c")!.agents.find(x => x.name === "ana");
  assert.deepEqual(listed, { name: "ana", kind: "agent", projects: ["p"], lifetime: "stable", aliases: ["reviewer"], description: "reviews" });
});

test("an ephemeral name is generated, unique, short-lived and ends with the process that holds it", async () => {
  const { b, c, post } = await trio();
  use(c);
  assert.throws(() => agents.register({ owner: "s1", ephemeral: true, name: "x", projects: ["p"], now: NOW }), /generated/);
  assert.throws(() => agents.register({ owner: "s1", projects: ["p"], now: NOW }), /needs a name/);
  assert.throws(() => agents.register({ owner: "s1", ephemeral: true, projects: ["p"], ttlSeconds: 86401, now: NOW }), /--ttl/);
  const e1 = agents.register({ owner: "s1", ephemeral: true, projects: ["p"], now: NOW }), e2 = agents.register({ owner: "s1", ephemeral: true, projects: ["p"], now: NOW });
  assert.match(e1.name, /^e-[a-z2-7]{8}$/); assert.notEqual(e1.name, e2.name); assert.equal(e1.kind, "ephemeral");
  assert.equal(Date.parse(e1.expires) - NOW, 3600_000);
  use(b); task(`${e1.name}@c`); assert.match((await peer.push({ now: NOW, post }))[0]!, /delivered to c/);
  use(c); const gone = agents.register({ owner: "s3", ephemeral: true, projects: ["p"], pid: 2 ** 22 + 12345, now: NOW });
  assert.equal(agents.resolve(gone.name, NOW), undefined, "a registration whose process has exited is not live");
});
