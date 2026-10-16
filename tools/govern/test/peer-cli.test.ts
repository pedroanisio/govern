// Exercise the CLI's parsed command handlers without a child process.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/util.ts";
import { makeEnv, childEnv, govern, fullTable } from "./helpers.ts";
import * as peer from "../lib/peer.ts";
import * as queue from "../lib/queue.ts";
const COMMANDS = await fullTable();
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
function run(name: string, sub: string, argv: string[] = []) {
  const command = COMMANDS.find(c => c.name === name)!.subs![sub]!;
  const a = parseArgs(argv, command.flags ?? {}, `${name} ${sub}`); a._.unshift(name, sub);
  return command.run(a);
}
const args = ["--to", "codex@b", "--project", "p", "--task", "t", "--from", "alice", "--summary", "check", "--body", "claim"];
test("task send refuses remote sender names at the CLI", () => {
  const e = makeEnv("peer-cli-sender"); process.env = childEnv(e);
  for (const from of ["alice@a", "alice@@a", "@a"]) {
    const r = govern(e, ["task", "send", ...args.map(x => x === "codex@b" ? "owner" : x === "alice" ? from : x)]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /--from must be a local name without @; only receive\(\) files a remote sender/);
    assert.deepEqual(queue.all(), []);
  }
});
for (const sub of ["reply", "forward", "close"]) test(`task ${sub} refuses remote actor names at the CLI`, () => {
  const e = makeEnv(`peer-cli-${sub}`); process.env = childEnv(e);
  const m = queue.send({ project: "p", task: "t", kind: "TASK", from: "alice", to: "owner", summary: "check", body: "claim", files: [], access: "read-only" });
  const r = govern(e, ["task", sub, m.id, "--as", "alice@a", ...(sub === "reply" ? ["--kind", "HANDOFF", "--summary", "checked", "--body", "answer"] : sub === "forward" ? ["--to", "owner"] : [])]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /--as must be a local name without @; only receive\(\) files a remote sender/);
  assert.deepEqual(queue.all(), [{ state: "open", m }]);
});
test("peer command handlers enforce grants, identity, remote options and relay bounds", async () => {
  const e = makeEnv("peer-cli"); process.env = childEnv(e);
  await run("peer", "id", ["--name", "a"]); const h = peer.identity(); assert.equal(h.name, "a");
  await assert.rejects(async () => run("peer", "id", ["--name", "other"]), /already has name/);
  await run("peer", "add", ["b", "--url", "https://b.example", "--key", h.publicKey, "--allow", "codex", "--allow", "owner", "--project", "p", "--project", "q"]);
  assert.deepEqual(peer.peers()[0]!.allow, ["codex", "owner"]); assert.deepEqual(peer.peers()[0]!.projects, ["p", "q"]);
  for (const extra of [["--write"], ["--profile", "codex-read"], ["--lane", "p"], ["--file", "x"], ["--estimate-usd", "0"]])
    await assert.rejects(async () => run("task", "send", [...args, ...extra]), /receiving host decides/);
  await assert.rejects(async () => run("task", "send", args.map(x => x === "codex@b" ? "auto@b" : x)), /receiving host decides/);
  await assert.rejects(async () => run("task", "send", args.map(x => x === "codex@b" ? "codex@missing" : x)), /live peer/);
  assert.equal(queue.all().length, 0);
  await run("task", "send", args.map(x => x === "codex@b" ? "absent@b" : x));
  const m = queue.all()[0]!.m; assert.equal(m.to, "absent@b"); assert.equal(m.profile, undefined); assert.equal(m.access, "read-only"); assert.deepEqual(m.files, []);
  assert.deepEqual(queue.dispatch(), []); assert.equal(queue.find(m.id)?.state, "open");
  await run("peer", "list");
  for (const opts of [["--host", "0.0.0.0"], ["--host", "example.com"], ["--port", "0"], ["--port", "NaN"], ["--port", "65536"]])
    await assert.rejects(async () => run("peer", "serve", opts), /loopback|1\.\.65535/);
  await assert.rejects(async () => run("peer", "push", ["--max", "0"]), /positive integer/);
  for (const env of [{ CODEX_THREAD_ID: "agent" }, { CLAUDE_CODE_SESSION_ID: "session" }] as Record<string, string>[]) {
    process.env = childEnv(e, env);
    for (const sub of ["add", "revoke"]) await assert.rejects(async () => run("peer", sub, ["b"]), /own terminal/);
  }
  process.env = childEnv(e); await run("peer", "revoke", ["b"]);
  assert.ok(peer.peers()[0]!.revokedAt); await assert.rejects(async () => run("task", "send", args), /live peer/);
});
