// The mesh and agents commands end to end: real `govern peer serve` processes, real HTTP and signed response headers.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, childEnv, govern, servePeer, type Env } from "./helpers.ts";
import * as peer from "../ext/peer/peer.ts";
import * as queue from "../lib/queue.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const use = (e: Env) => { process.env = childEnv(e); };
const ok = (r: { code: number | null; out: string; err: string }) => { assert.equal(r.code, 0, r.err + r.out); return r.out; };

test("two hosts form a mesh over HTTP with one invite, discover each other and deliver", async () => {
  const a = makeEnv("mcli-a"), b = makeEnv("mcli-b");
  ok(govern(a, ["peer", "id", "--name", "a"])); ok(govern(b, ["peer", "id", "--name", "b"]));
  const as = await servePeer(a), bs = await servePeer(b);
  try {
    assert.match(ok(govern(a, ["mesh", "create", "--name", "lab", "--url", as.url, "--project", "p", "--allow", "codex"])), /registrar/);
    const code = ok(govern(a, ["mesh", "invite", "--host", "b"])).split("\n")[0]!;
    assert.match(code, /^govern-mesh:/);
    assert.match(ok(govern(b, ["mesh", "join", code, "--url", bs.url, "--project", "p"])), /joined mesh lab as b: 2 members/);
    assert.equal(govern(b, ["mesh", "join", code, "--url", bs.url, "--project", "p"]).code, 2);
    ok(govern(a, ["mesh", "sync"]));
    const status = ok(govern(a, ["mesh"]));
    assert.match(status, /mesh lab \(this host is the registrar\)/); assert.match(status, /\n {2}b {2}http:\/\/127\.0\.0\.1/);
    assert.match(ok(govern(b, ["agents", "register", "--project", "p", "--description", "reviews claims"], { GOVERN_AS: "reviewer" })), /reviewer@b/);
    const listing = ok(govern(a, ["agents", "list", "--refresh"]));
    assert.match(listing, /reviewer@b {2}agent \(stable\) {2}p {2}reviews claims/);
    assert.match(ok(govern(b, ["agents", "list", "--refresh"])), /codex@a {2}runner {2}p/);
    assert.match(ok(govern(a, ["agents"])), /reviewer@b/, "a bare listing reads the cache");
    ok(govern(a, ["task", "send", "--to", "reviewer@b", "--project", "p", "--task", "t", "--from", "alice", "--summary", "check", "--body", "claim"]));
    assert.match(ok(govern(a, ["peer", "push"])), /delivered to b/);
    use(b); const got = queue.all()[0]!.m; assert.equal(got.from, "alice@a"); assert.equal(got.to, "reviewer");
    assert.match(ok(govern(a, ["mesh", "revoke", "b"])), /revoked b/);
    assert.match(govern(b, ["mesh", "sync"]).err, /403.*not a member/);
  } finally { await Promise.all([as.stop(), bs.stop()]); }
});

for (const [args, why] of [
  [["mesh", "create", "--name", "lab", "--url", "https://a.example", "--project", "p"], /own terminal/],
  [["mesh", "invite"], /own terminal/],
  [["mesh", "policy", "--project", "p"], /own terminal/],
  [["mesh", "sync", "--url", "https://a.example"], /own terminal/],
] as const) test(`agents cannot run govern ${args.slice(0, 2).join(" ")}${(args as readonly string[]).includes("--url") && args[1] === "sync" ? " --url" : ""}`, () => {
  const r = govern(makeEnv("mcli-agent"), [...args], { CODEX_THREAD_ID: "agent" });
  assert.equal(r.code, 1); assert.match(r.err, why);
});

test("an agent registers only itself, never as a runner, and the owner sees why a mesh command is refused", () => {
  const e = makeEnv("mcli-reg");
  let r = govern(e, ["agents", "register", "--as", "other", "--project", "p"], { GOVERN_AS: "me" }); assert.equal(r.code, 2); assert.match(r.err, /registers only itself \(this is me\)/);
  r = govern(e, ["agents", "register", "--project", "p"], { GOVERN_AS: "codex" }); assert.equal(r.code, 2); assert.match(r.err, /only the owner grants it/);
  ok(govern(e, ["agents", "register", "--project", "p", "--ttl", "120"], { GOVERN_AS: "me" }));
  assert.match(ok(govern(e, ["agents"])), /me {2}agent \(stable\) {2}p/);
  const eph = ok(govern(e, ["agents", "register", "--ephemeral", "--project", "p", "--alias", "helper"], { GOVERN_AS: "me" }));
  const generated = /registered (e-[a-z2-7]{8})@\S+ \(ephemeral\)/.exec(eph)?.[1]; assert.ok(generated, eph);
  assert.match(eph, /also helper@/); assert.match(eph, new RegExp(`inbox --as ${generated}`));
  r = govern(e, ["agents", "register", "--as", "helper", "--project", "p"], { GOVERN_AS: "helper" }); assert.equal(r.code, 2); assert.match(r.err, new RegExp(`helper is held by agent ${generated}`));
  r = govern(e, ["agents", "unregister", generated!], { GOVERN_AS: "other" }); assert.equal(r.code, 2); assert.match(r.err, /another owner/);
  assert.match(ok(govern(e, ["agents", "unregister", generated!], { GOVERN_AS: "me" })), /unregistered/);
  assert.match(ok(govern(e, ["agents", "unregister"], { GOVERN_AS: "me" })), /unregistered me/);
  assert.match(ok(govern(e, ["agents"])), /no other hosts discovered yet/);
  assert.match(ok(govern(e, ["mesh", "status"])), /not in a mesh/);
  r = govern(e, ["mesh", "revoke", "x"]); assert.equal(r.code, 2); assert.match(r.err, /only the registrar/);
  r = govern(e, ["mesh", "join", "nope", "--url", "https://e.example", "--project", "p"]); assert.equal(r.code, 2); assert.match(r.err, /not a mesh invite code/);
  r = govern(e, ["task", "send", "--to", "codex@nowhere", "--project", "p", "--task", "t", "--from", "alice", "--summary", "s"]); assert.equal(r.code, 2); assert.match(r.err, /no live peer or mesh member nowhere/);
  void peer;
});
