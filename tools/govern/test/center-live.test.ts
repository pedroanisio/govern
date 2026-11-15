// The live lanes and processes in the command center: every host's lane summaries over the signed observer channel, the merged
// view with a host column and lane counts per process, hosts that predate the route, and the token-gated endpoints.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { trio, use, network, fixture, asSession, NOW, type Env } from "./helpers.ts";
import * as peer from "../ext/peer/peer.ts";
import * as center from "../ext/center/center.ts";
import { create, load, save } from "../lib/project.ts";
import { definitionOf, lanesAnswer, placesOf, LANES_ANSWER, MAX_CWD } from "../lib/livestate.ts";
import { parseFile } from "../lib/shape.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

function lanes(e: Env, spec: [slug: string, stage: string][]): void {
  mkdirSync(join(e.root, "PALS-Notes", "processes"), { recursive: true });
  copyFileSync(fixture("pn-process.json"), join(e.root, "PALS-Notes", "processes", "pn.json"));
  use(e);
  for (const [slug, stage] of spec) { create(slug, { process: "pn", title: `Lane ${slug}` }); const p = load(slug); p.stage = stage; save(p); }
}
async function federation() {
  const t = await trio();
  lanes(t.a, [["alpha", "plan"]]); lanes(t.b, [["beta", "build"], ["gamma", "plan"]]); lanes(t.c, [["delta", "ship"]]);
  return t;
}
/** The network with host c's govern older than this feature: it knows no /lanes or /process route. */
const withoutLanes = (post: peer.Post): peer.Post => async (u, bytes, headers, t) =>
  u.startsWith("https://c.example/") && /\/v1\/peer\/(lanes|process)$/.test(u) ? { status: 404, text: '{"error":"not found"}', headers: {} } : post(u, bytes, headers, t);

test("a lanes answer carries each lane's summary and the processes by name, revision and hash, in a closed shape, without raw state", async () => {
  const { b } = await federation();
  use(b);
  const id = peer.identity(), a = lanesAnswer({ host: id.name, fingerprint: peer.fingerprint(id.publicKey), now: NOW });
  assert.deepEqual(a.lanes.map((l) => l.slug), ["beta", "gamma"]);
  assert.equal(a.omitted, 0); assert.equal(a.unreadable, 0);
  const pn = a.processes.find((p) => p.name === "pn")!;
  assert.equal(pn.revision, 2); assert.match(pn.hash, /^[0-9a-f]{64}$/); assert.equal(pn.stages, 4);
  parseFile("lanes", JSON.stringify(a), LANES_ANSWER);
  assert.throws(() => parseFile("lanes", JSON.stringify({ ...a, extra: 1 }), LANES_ANSWER), /extra|unknown/i);
  assert.ok(JSON.stringify(a).length < 60_000, "a small payload");
  assert.equal(definitionOf("pn", pn.hash)?.includes('"name":"pn"'), true);
  assert.equal(definitionOf("pn", "0".repeat(64)), undefined);
});

test("the central view merges every host's lanes with a host column and counts each process's lanes per host", async () => {
  const { a, post } = await federation();
  use(a);
  const v = await center.gatherLive({ post, now: () => NOW });
  assert.deepEqual(v.hosts.map((h) => [h.host, h.self, h.ok, h.lanes]), [["a", true, true, 1], ["b", false, true, 2], ["c", false, true, 1]]);
  assert.deepEqual(v.lanes.map((l) => `${l.host}/${l.lane.slug}/${l.lane.stage}`), ["a/alpha/plan", "b/beta/build", "b/gamma/plan", "c/delta/ship"]);
  const pns = v.processes.filter((p) => p.name === "pn");
  assert.equal(pns.length, 1, "the same definition on three hosts is one process");
  const pn = pns[0]!;
  assert.deepEqual(pn.hosts.map((h) => [h.host, h.lanes]), [["a", 1], ["b", 2], ["c", 1]]);
  assert.equal(pn.name, "pn");
});

test("a host whose govern is older is listed with its lanes unknown, and the other hosts still show", async () => {
  const { a, post } = await federation();
  use(a);
  const v = await center.gatherLive({ post: withoutLanes(post), now: () => NOW });
  const c = v.hosts.find((h) => h.host === "c")!;
  assert.deepEqual([c.ok, c.unknown, c.lanes], [false, true, 0]); assert.match(c.error!, /does not report lanes/);
  assert.deepEqual(v.lanes.map((l) => l.host), ["a", "b", "b"]);
  assert.deepEqual(v.processes.find((p) => p.name === "pn")!.hosts.map((h) => h.host), ["a", "b"]);
  assert.equal(v.hosts.find((h) => h.host === "b")!.unknown, undefined);
});

test("only the members a host names as observers read its lanes", async () => {
  const { b, post } = await federation();
  use(b);
  const seen = await peer.observeLanes({ post, now: () => NOW });
  assert.deepEqual(seen.map((o) => [o.host, o.ok, o.unknown ?? false]), [["a", false, false], ["c", false, false]]);
  assert.match(seen[0]!.error!, /403.*not an observer/);
});

test("a process definition of another host is fetched by its hash over the signed channel, and an unknown hash is not found", async () => {
  const { a, post } = await federation();
  use(a);
  const v = await center.gatherLive({ post, now: () => NOW });
  const hash = v.processes.find((p) => p.name === "pn")!.hash;
  const text = await peer.fetchProcess("b", "pn", hash, { post, now: () => NOW });
  assert.match(text!, /"name":"pn"/);
  assert.equal(await peer.fetchProcess("b", "pn", "1".repeat(64), { post, now: () => NOW }), undefined);
  await assert.rejects(() => peer.fetchProcess("nobody", "pn", hash, { post, now: () => NOW }), /not a live mesh member/);
  await assert.rejects(() => peer.fetchProcess("c", "pn", hash, { post: withoutLanes(post), now: () => NOW }).then((x) => { if (x === undefined) throw new Error("not found"); }), /not found/);
});

async function get(port: number, path: string, headers: Record<string, string> = {}) {
  const req = request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } });
  req.end(); const [res] = await once(req, "response") as [import("node:http").IncomingMessage];
  let body = ""; for await (const chunk of res) body += chunk;
  return { status: res.statusCode, headers: res.headers, body };
}
const auth = { Authorization: "Bearer secret-token" };

test("the center serves lanes, processes and diagrams over HTTP: token required, 404 for what is not there, host and lane selection", async () => {
  const { a, hosts } = await federation();
  use(a);
  const server = center.centerServer({ token: "secret-token", post: network(hosts), now: () => NOW });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    for (const p of ["/api/lanes", "/api/processes", "/api/process/pn.svg"]) {
      assert.equal((await get(port, p)).status, 401, `${p} without a token`);
      assert.equal((await get(port, p, { Authorization: "Bearer wrong" })).status, 401);
      assert.equal((await get(port, p, { ...auth, Host: "evil.example" })).status, 403);
    }
    const ls = await get(port, "/api/lanes", auth);
    assert.equal(ls.status, 200); assert.match(String(ls.headers["content-type"]), /application\/json/);
    const lv = JSON.parse(ls.body);
    assert.deepEqual(lv.lanes.map((l: { host: string; lane: { slug: string } }) => `${l.host}/${l.lane.slug}`), ["a/alpha", "b/beta", "b/gamma", "c/delta"]);
    const ps = JSON.parse((await get(port, "/api/processes", auth)).body);
    const pn = ps.processes.find((p: { name: string }) => p.name === "pn");
    assert.deepEqual(pn.hosts.map((h: { host: string; lanes: number }) => [h.host, h.lanes]), [["a", 1], ["b", 2], ["c", 1]]);
    const hash = pn.hash;

    const here = await get(port, "/api/process/pn.svg", auth);
    assert.equal(here.status, 200); assert.equal(here.headers["content-type"], "image/svg+xml; charset=utf-8");
    assert.match(here.body, /^<svg /); assert.match(here.body, /data-lane="alpha"/); assert.ok(!here.body.includes('data-lane="beta"'), "this host's lanes only");
    const theirs = await get(port, `/api/process/pn.svg?host=b&hash=${hash}`, auth);
    assert.equal(theirs.status, 200); assert.match(theirs.body, /data-lane="beta"/); assert.match(theirs.body, /data-lane="gamma"/); assert.match(theirs.body, /2 lanes/);
    const one = await get(port, `/api/process/pn.svg?host=b&lane=beta`, auth);
    assert.equal(one.status, 200); assert.match(one.body, /lane beta · /); assert.match(one.body, /bp-done/);

    assert.equal((await get(port, "/api/process/nothing.svg", auth)).status, 404);
    assert.equal((await get(port, "/api/process/pn.svg?host=zed", auth)).status, 404);
    assert.equal((await get(port, "/api/process/pn.svg?lane=nope", auth)).status, 404);
    assert.equal((await get(port, "/api/process/pn.svg?host=b", auth)).status, 404, "another host's process is named by its hash");
    assert.equal((await get(port, `/api/process/pn.svg?host=b&hash=${"2".repeat(64)}`, auth)).status, 404);
    assert.equal((await get(port, "/api/process/pn.svg?hash=zz", auth)).status, 404);
    assert.equal((await get(port, "/api/process/pn.png", auth)).status, 404);
    assert.equal((await get(port, "/api/nothing", auth)).status, 404);
  } finally { server.close(); }
});

test("the page offers the Projects and Processes views, reads only the token-gated endpoints and stays read-only", async () => {
  const at = new Date(NOW).toISOString();
  const server = center.centerServer({ token: "secret-token", view: async () => ({ at, hosts: [], peers: [], alerts: [], messages: [], agents: [] } as unknown as center.View), live: async () => ({ at, hosts: [], lanes: [], processes: [], places: [] }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const page = (await get(port, "/")).body;
    assert.match(page, /data-view="projects"/); assert.match(page, /data-view="processes"/);
    for (const path of ["/api/lanes", "/api/processes", "/api/process/"]) assert.ok(page.includes(path), `the page reads ${path}`);
    assert.ok(!/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(page), "the page never writes");
    assert.deepEqual(JSON.parse((await get(port, "/api/lanes", auth)).body), { at, hosts: [], lanes: [], places: [] });
  } finally { server.close(); }
});

test("the page explains a missing token and a failed update in the live views instead of loading forever", async () => {
  const server = center.centerServer({ token: "secret-token", view: async () => ({}) as unknown as center.View, live: async () => ({ at: new Date(NOW).toISOString(), hosts: [], lanes: [], processes: [], places: [] }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const page = (await get(port, "/")).body;
    assert.match(page, /govern center url/, "the no-token text names the command that prints the address");
    assert.ok(!page.includes("govern center serve printed"), "no pointer to the old per-process address");
    assert.match(page, /liveError = token \? "" : NO_TOKEN/, "a page opened without a token says so in the live views");
    assert.match(page, /catch \(e\) \{\s*liveError = "update failed: "/, "a refused or failed live update is shown, not swallowed");
    assert.match(page, /liveError \|\| "loading…"/, "the tables show the error in place of loading…");
  } finally { server.close(); }
});

test("each live session and registered agent is placed in its folder: one entry per name and folder, runners and folderless sessions left out", () => {
  const sessions = [{ pid: 1, name: "s1", cwd: "/a" }, { pid: 2, name: "s1", cwd: "/a" }, { pid: 3, name: "s2", cwd: "/b" }, { pid: 4, name: "s3" }, { pid: 5, name: "s1", cwd: "/c" }];
  const agents = [
    { name: "bot", aliases: ["b2"], owner: "s2" },
    { name: "pidbot", aliases: [], owner: "elsewhere", pid: 1 },
    { name: "term", aliases: [], owner: "terminal" },
  ];
  assert.deepEqual(placesOf(sessions, agents), [
    { name: "b2", cwd: "/b" }, { name: "bot", cwd: "/b" }, { name: "pidbot", cwd: "/a" },
    { name: "s1", cwd: "/a" }, { name: "s1", cwd: "/c" }, { name: "s2", cwd: "/b" },
  ]);
  assert.deepEqual(placesOf([{ pid: 9, name: "long", cwd: "/" + "x".repeat(MAX_CWD + 50) }], []).map((p) => p.cwd.length <= MAX_CWD), [true], "a folder is clipped to the answer's limit");
});

test("a lanes answer may carry the places and still parses without them; a malformed place is refused", async () => {
  const { b } = await federation();
  use(b);
  const id = peer.identity(), a = lanesAnswer({ host: id.name, fingerprint: peer.fingerprint(id.publicKey), now: NOW });
  const { places: _, ...without } = a;
  parseFile("lanes", JSON.stringify(without), LANES_ANSWER);
  parseFile("lanes", JSON.stringify({ ...a, places: [{ name: "s1", cwd: "/a" }] }), LANES_ANSWER);
  for (const bad of [[{ name: "s1" }], [{ name: "s1", cwd: 7 }], [{ name: "s1", cwd: "/a", pid: 3 }], [{ name: "s1", cwd: "x".repeat(MAX_CWD + 1) }]])
    assert.throws(() => parseFile("lanes", JSON.stringify({ ...a, places: bad }), LANES_ANSWER), /places/, JSON.stringify(bad));
});

test("the central view says in which folder every host's live sessions run, and /api/lanes passes it to the page", async () => {
  const { a, b, post } = await federation();
  asSession(b, "sess-b");
  use(a);
  const v = await center.gatherLive({ post, now: () => NOW });
  assert.deepEqual(v.places.filter((p) => p.host === "b"), [{ host: "b", name: "tester", cwd: b.root }]);
  assert.equal(v.places.some((p) => p.host === "a"), false, "host a runs no session in this test");
  const server = center.centerServer({ token: "secret-token", live: async () => v });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    assert.deepEqual(JSON.parse((await get(port, "/api/lanes", auth)).body).places, v.places);
    const page = (await get(port, "/")).body;
    assert.match(page, /<th>Folder<\/th>/, "the agents table has a Folder column");
  } finally { server.close(); }
});
