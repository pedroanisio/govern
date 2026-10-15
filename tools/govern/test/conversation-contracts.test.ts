import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sessions from "../lib/conversation.ts";
import { build } from "../lib/conversation-adapters.ts";
import { owner, ownerLive } from "../lib/conversation-owner.ts";
import { SUBS } from "../lib/conversation-cli.ts";
import { parseArgs } from "../lib/util.ts";
import { makeEnv, childEnv, write, type Env } from "./helpers.ts";

// Every direct library call gets the same isolated workspace and environment as a CLI child.
async function isolated(f: (e: Env) => void | Promise<void>) {
  const e = makeEnv("conversation-contracts"), previous = process.env;
  process.env = childEnv(e);
  try { await f(e); } finally { process.env = previous; }
}
function command(e: Env, script = "") {
  const config = join(e.root, "govern.config.json");
  const c = JSON.parse(readFileSync(config, "utf8"));
  c.conversationAdapters = { fixture: { argv: [process.execPath, "-e", script] } };
  write(config, JSON.stringify(c));
  return sessions.create("chat", { adapter: "fixture" });
}
function turn(s: sessions.Conversation) {
  return sessions.send(s.id, "question").run;
}

test("command adapter validates event shapes and preserves normalized usage and tools", () => isolated((e) => {
  Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_TEST: "1", CODEX_TEST: "1", GROK_AGENT: "1", GROK_SESSION_ID: "session" });
  const s = command(e), a = build(s, turn(s), [{ role: "user", content: "question" }]);
  assert.equal(JSON.parse(a.input).protocol, "govern-conversation-v1");
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_TEST", "CODEX_TEST", "GROK_AGENT", "GROK_SESSION_ID"])
    assert.equal(a.env[key], undefined);
  for (const value of [null, [], "text", { type: "assistant.delta", text: 1 },
    { type: "tool.started", id: "", name: "read" }, { type: "tool.started", id: "t", name: "" },
    { type: "tool.finished", id: "t", name: "read" }, { type: "done", text: " " },
    { type: "done", text: "ok", usage: null }, { type: "done", text: "ok", usage: "bad" },
    { type: "done", text: "ok", usage: { input: -1 } }, { type: "error", text: 1 }, { type: "unknown" }])
    assert.throws(() => a.parse(value), /adapter|delta|tool|done|unknown/);
  assert.deepEqual(a.parse({ type: "assistant.delta", text: "part" }), [{ type: "assistant.delta", text: "part" }]);
  assert.deepEqual(a.parse({ type: "tool.started", id: "t", name: "read" }), [{ type: "tool.started", id: "t", name: "read" }]);
  assert.deepEqual(a.parse({ type: "tool.finished", id: "t", name: "read", ok: false }), [{ type: "tool.finished", id: "t", name: "read", ok: false }]);
  assert.deepEqual(a.parse({ type: "error", text: "refused" }), [{ type: "error", text: "refused" }]);
  assert.deepEqual(a.parse({ type: "done", text: "ok" }), [{ type: "done", text: "ok" }]);
  assert.deepEqual(a.parse({ type: "done", text: "ok", usage: { input_tokens: 2, output_tokens: 3, costUsd: 0 } })[0]?.usage,
    { input: 2, output: 3, cached: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 });
  a.finish();
}));

test("Codex adapter tracks revisions, terminal errors, usage and tool completion", () => isolated(() => {
  const s = sessions.create("chat"), a = build(s, turn(s), []);
  try {
    assert.throws(() => a.parse(null), /invalid codex/);
    for (const [input, text] of [[{ type: "turn.failed", error: { message: "failed" } }, "failed"],
      [{ type: "error", message: "bad" }, "bad"], [{ type: "error" }, "codex failed"]] as const)
      assert.deepEqual(a.parse(input), [{ type: "error", text }]);
    const item = (type: string, text: string) => a.parse({ type, item: { type: "agent_message", text } });
    assert.equal(item("item.started", "a")[0]?.text, "a");
    assert.equal(item("item.updated", "ab")[0]?.text, "b");
    assert.deepEqual(item("item.updated", "ab"), []);
    assert.equal(item("item.completed", "replacement")[0]?.text, "replacement");
    assert.deepEqual(a.parse({ type: "turn.completed" }), [{ type: "done", text: "replacement" }]);
    assert.throws(() => a.parse({ type: "turn.completed", usage: { input_tokens: "many" } }), /invalid runtime usage/);
    assert.throws(() => a.parse({ type: "turn.completed", usage: { input_tokens: -1 } }), /invalid runtime usage/);
    assert.equal(a.parse({ type: "turn.completed", usage: {} })[0]?.usage?.input, 0);
    for (const type of ["item.started", "item.completed"])
      assert.deepEqual(a.parse({ type, item: { id: "t", type: "command_execution", status: "failed" } }),
        [{ type: type === "item.started" ? "tool.started" : "tool.finished", id: "t", name: "command_execution", ok: false }]);
    assert.deepEqual(a.parse({ type: "item.completed", item: { type: "reasoning" } }), []);
    assert.deepEqual(a.parse({ type: "thread.started" }), []);
  } finally { a.finish(); }
}));

test("Claude adapter deduplicates streamed text and handles tool results and unsuccessful results", () => isolated(() => {
  const s = sessions.create("chat", { profile: "claude-read" }), a = build(s, turn(s), [], 0.1);
  try {
    assert.ok(a.args.includes("stream-json"));
    assert.throws(() => a.parse(null), /invalid claude/);
    const delta = (text: unknown) => a.parse({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    assert.throws(() => delta(4), /invalid claude text/);
    assert.equal(delta("hello")[0]?.text, "hello");
    assert.deepEqual(a.parse({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }), []);
    assert.deepEqual(a.parse({ type: "assistant", message: { content: [{ type: "text", text: "more" }, { type: "tool_use", id: "t", name: "read" }] } }),
      [{ type: "assistant.delta", text: "more" }, { type: "tool.started", id: "t", name: "read" }]);
    assert.deepEqual(a.parse({ type: "user", message: { content: [{ type: "text", text: "ignored" }, { type: "tool_result", tool_use_id: "t", is_error: true }] } }),
      [{ type: "tool.finished", id: "t", name: "tool", ok: false }]);
    assert.deepEqual(a.parse({ type: "user" }), []);
    assert.deepEqual(a.parse({ type: "assistant" }), []);
    for (const result of [{ subtype: "error" }, { subtype: "success", is_error: true }])
      assert.equal(a.parse({ type: "result", ...result })[0]?.type, "error");
    assert.deepEqual(a.parse({ type: "result", subtype: "success" }), [{ type: "done", text: "hellomore" }]);
    const result = a.parse({ type: "result", subtype: "success", result: "final", total_cost_usd: 0.1,
      usage: { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } })[0];
    assert.equal(result?.text, "final");
    assert.equal(result?.usage?.input, 9);
    assert.deepEqual(a.parse({ type: "system" }), []);
  } finally { a.finish(); }
}));

test("Grok adapter refuses incomplete completion and omits partial usage", () => isolated((e) => {
  process.env.GOVERN_GROK_HOME = join(e.root, "private-grok");
  process.env.GROK_HOME = join(e.root, "source-grok");
  process.env.GOVERN_GROK_MAX_TURNS = "3";
  write(join(process.env.GROK_HOME, "auth.json"), "DUMMY");
  const s = sessions.create("chat", { profile: "grok-read" }), a = build(s, turn(s), []);
  try {
    assert.equal(a.args[a.args.indexOf("--max-turns") + 1], "3");
    for (const stop_reason of [undefined, "max_tokens"]) {
      const events = a.parse({ type: "result", subtype: "success", stop_reason, result: "partial" });
      assert.ok(events.some((event) => event.type === "error"));
      assert.ok(events.every((event) => event.type !== "done"));
    }
    const completion = { type: "result", subtype: "success", stop_reason: "end_turn", result: "ok",
      usage: { input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.1 };
    const complete = a.parse(completion)[0];
    assert.equal(complete?.type, "done");
    assert.equal(complete?.usage?.input, 5);
    for (const flags of [{ usage_is_incomplete: true }, { cost_is_partial: true },
      { usage_is_incomplete: true, cost_is_partial: true }]) {
      assert.deepEqual(a.parse({ ...completion, ...flags }), [{ type: "done", text: "ok" }],
        "partial usage and cost are omitted entirely, not recorded as zeros");
    }
  } finally { a.finish(); }
}));

test("owner identity accepts legacy records and rejects changed start and boot identities", () => {
  const current = owner(process.pid);
  assert.equal(ownerLive(current), true);
  assert.equal(ownerLive({ pid: process.pid }), true);
  assert.equal(ownerLive({ ...current, start: "different-start" }), false);
  assert.equal(ownerLive({ ...current, boot: "different-boot" }), false);
});

test("profile adapters use configured models and fallback binaries and price only recognized models", () => isolated((e) => {
  delete process.env.GOVERN_CODEX_BIN;
  delete process.env.GOVERN_CLAUDE_BIN;
  delete process.env.GOVERN_GROK_BIN;
  process.env.GOVERN_GROK_HOME = join(e.root, "private-grok");
  process.env.GROK_HOME = join(e.root, "source-grok");
  write(join(process.env.GROK_HOME, "auth.json"), "DUMMY");
  write(join(e.projects, "../capabilities/models.json"), JSON.stringify({ version: 1, profiles: [
    { name: "priced", engine: "codex", capabilities: ["read"], model: "claude-opus-5" },
    { name: "unpriced", engine: "codex", capabilities: ["read"], model: "unlisted-model" },
    { name: "claude-model", engine: "claude", capabilities: ["read"], model: "sonnet" },
    { name: "grok-model", engine: "grok", capabilities: ["read"], model: "test-model" },
  ] }));
  for (const profile of ["priced", "unpriced", "claude-model", "grok-model"]) {
    const s = sessions.create(profile, { profile }), a = build(s, turn(s), []);
    try {
      if (profile === "priced" || profile === "unpriced") {
        assert.equal(a.bin, "codex");
        const result = a.parse({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })[0]!;
        assert.equal(typeof result.usage?.costUsd, profile === "priced" ? "number" : "undefined");
      } else {
        assert.equal(a.bin, profile === "claude-model" ? "claude" : "grok");
        assert.equal(a.args[a.args.indexOf("--model") + 1], profile === "claude-model" ? "sonnet" : "test-model");
      }
    } finally { a.finish(); }
  }
}));

test("claim refuses changed profiles and unmet capability checks without starting a turn", () => isolated((e) => {
  const file = join(e.projects, "../capabilities/profile.json");
  const definition = { version: 1, profiles: [{ name: "checked", engine: "codex", capabilities: ["read"], model: "first" }] };
  write(file, JSON.stringify(definition));
  const s = sessions.create("chat", { profile: "checked" }); turn(s);
  assert.throws(() => sessions.claim(s.id), /self-test|check|caps test/);
  definition.profiles[0]!.model = "second";
  write(file, JSON.stringify(definition));
  assert.throws(() => sessions.claim(s.id), /profile changed/);
  assert.equal(sessions.read(s.id).runs[0]?.state, "queued");
}));

test("persisted conversation rejects inconsistent identities, replies, events and context", () => isolated((e) => {
  const s = command(e); turn(s);
  const path = join(sessions.directory(s.id), "session.json");
  const original = readFileSync(path, "utf8");
  const cases: [string, (s: sessions.Conversation) => void][] = [
    ["identities", (s) => s.runs.push(structuredClone(s.runs[0]!))],
    ["identities", (s) => s.messages.push(structuredClone(s.messages[0]!))],
    ["identities", (s) => s.runs.push({ ...s.runs[0]!, id: "second" })],
    ["identities", (s) => {
      s.runs[0]!.state = "running";
      s.runs.push({ ...s.runs[0]!, id: "second", requestId: "second-request" });
    }],
    ["nonnegative finite number", (s) => s.runs[0]!.estimateUsd = -1],
    ["no input", (s) => s.messages[0]!.role = "assistant"],
    ["no owner", (s) => s.runs[0]!.state = "running"],
    ["no owner", (s) => { s.runs[0]!.state = "running"; s.runs[0]!.owner = owner(process.pid); }],
    ["no end", (s) => s.runs[0]!.state = "failed"],
    ["reply", (s) => { s.runs[0]!.state = "completed"; s.runs[0]!.endedAt = s.createdAt; }],
    ["reply", (s) => s.messages.push({ ...s.messages[0]!, id: "reply", role: "assistant" })],
    ["no run", (s) => s.messages.push({ ...s.messages[0]!, id: "orphan", runId: "missing" })],
    ["event sequence", (s) => s.events[0]!.seq = 2],
    ["event sequence", (s) => s.events[0]!.runId = "missing"],
    ["context boundary", (s) => s.context = { summary: "summary", through: s.messages[0]!.id }],
  ];
  for (const [message, corrupt] of cases) {
    const changed = JSON.parse(original); corrupt(changed); write(path, JSON.stringify(changed));
    assert.throws(() => sessions.read("chat"), new RegExp(message));
  }
  write(path, original);
  const copy = write(join(e.root, "copy.json"), original);
  unlinkSync(path); symlinkSync(copy, path);
  assert.throws(() => sessions.read("chat"), /state cannot be a symlink/);
}));

test("conversation directories refuse symlinks at either storage boundary", () => isolated((e) => {
  const target = join(e.root, "target"); mkdirSync(target);
  const root = sessions.root(); mkdirSync(root, { recursive: true });
  symlinkSync(target, join(root, "chat"));
  assert.throws(() => sessions.directory("chat"), /conversation cannot be a symlink/);
  unlinkSync(join(root, "chat"));
  // A separate workspace avoids replacing a folder that holds another test's records.
  process.env.GOVERN_REPO = join(e.root, "other");
  write(join(process.env.GOVERN_REPO, "govern.config.json"), JSON.stringify({ state: "state" }));
  const other = sessions.root(); mkdirSync(join(process.env.GOVERN_REPO, "state"), { recursive: true });
  symlinkSync(target, other);
  assert.throws(() => sessions.directory("chat"), /conversation folder cannot be a symlink/);
}));

test("checkpoint validation preserves history and refuses backwards boundaries and oversized summaries", () => isolated((e) => {
  const s = command(e);
  const complete = () => {
    const r = sessions.send(s.id, "question").run;
    sessions.claim(s.id);
    const replyId = "reply-" + r.id;
    sessions.update(s.id, r.id, (s, r) => {
      r.state = "completed"; r.endedAt = s.createdAt;
      s.messages.push({ id: replyId, role: "assistant", content: "answer", at: s.createdAt, runId: r.id });
    });
    return replyId;
  };
  const first = complete(), second = complete();
  assert.throws(() => sessions.checkpoint(s.id, " ", second), /nonempty/);
  assert.throws(() => sessions.checkpoint(s.id, "summary", "missing"), /completed assistant/);
  assert.throws(() => sessions.checkpoint(s.id, "x".repeat(s.maxContextChars + 1), second), /exceeds context/);
  sessions.checkpoint(s.id, "summary", second);
  assert.throws(() => sessions.checkpoint(s.id, "old", first), /cannot move backwards/);
  assert.equal(sessions.read(s.id).messages.length, 4);
}));

test("reconciliation survives a rejected transaction and retry retains its estimate", () => isolated((e) => {
  const s = command(e);
  const r = sessions.send(s.id, "uncertain", { estimateUsd: 0.25 }).run;
  sessions.claim(s.id);
  sessions.update(s.id, r.id, (_s, r) => { r.owner = { pid: process.pid, boot: "previous-boot" }; });
  assert.throws(() => sessions.transact(s.id, () => { throw new Error("transaction rejected"); }), /transaction rejected/);
  assert.equal(sessions.read(s.id).runs[0]?.state, "interrupted");
  sessions.recover(s.id, "retry", "effects inspected");
  const retry = sessions.read(s.id).runs[1]!;
  assert.equal(retry.estimateUsd, 0.25);
  assert.equal(retry.messageId, r.messageId);
  assert.equal(retry.state, "queued");
  assert.throws(() => sessions.send(s.id, "bad", { estimateUsd: NaN }), /estimate-usd/);
  assert.throws(() => sessions.send(s.id, "bad", { estimateUsd: -1 }), /estimate-usd/);
  assert.throws(() => sessions.send(s.id, "x".repeat(262145)), /256 KiB/);
}));

test("event follower advances its cursor and ends at its injected clock deadline", (t) => isolated(async (e) => {
  command(e);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-15T00:00:00Z") });
  const lines: string[] = [];
  const output = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  try {
    const sub = SUBS.events!;
    const args = parseArgs(["conversation", "events", "chat", "--follow", "--timeout", "1"], sub.flags!, "conversation events");
    const following = sub.run(args);
    sessions.transact("chat", (s) => sessions.event(s, "test.progress"));
    t.mock.timers.tick(100);
    await Promise.resolve();
    t.mock.timers.tick(900);
    await following;
    assert.deepEqual(lines.map((line) => JSON.parse(line).seq), [1, 2]);
  } finally { output.mock.restore(); t.mock.timers.reset(); }
}));

test("conversation transactions enforce ownership, cancellation, recovery and closed-session contracts", () => isolated((e) => {
  const s = command(e), r = turn(s);
  assert.throws(() => sessions.close(s.id), /pending runs/);
  assert.throws(() => sessions.cancel(s.id, "missing", "reason"), /unknown/);
  assert.throws(() => sessions.update(s.id, "missing", () => {}), /unknown/);
  assert.throws(() => sessions.update(s.id, r.id, () => {}), /lost ownership/);
  const claim = sessions.claim(s.id)!;
  assert.equal(sessions.claim(s.id), undefined);
  assert.throws(() => sessions.checkpoint(s.id, "summary", "missing"), /active/);
  sessions.cancel(s.id, r.id, "first reason");
  sessions.cancel(s.id, r.id, "second reason");
  assert.equal(sessions.read(s.id).runs[0]?.reason, "first reason");
  sessions.update(s.id, r.id, (_s, r) => { r.state = "interrupted"; r.endedAt = claim.run.startedAt; r.host = owner(process.pid); });
  assert.throws(() => sessions.recover(s.id, "cancel", "checked"), /host is still alive/);
  sessions.transact(s.id, (s) => { delete s.runs[0]!.host; });
  sessions.recover(s.id, "cancel", "effects checked");
  assert.equal(sessions.read(s.id).runs[0]?.state, "cancelled");
  assert.throws(() => sessions.recover(s.id, "continue", "checked"), /no interrupted/);
  assert.throws(() => sessions.recover(s.id, "bad", "checked"), /recover requires/);
  assert.throws(() => sessions.recover(s.id, "retry", " "), /recover requires/);
  sessions.cancel(s.id, r.id, "ignored");
  sessions.close(s.id); sessions.close(s.id);
  assert.equal(sessions.claim(s.id), undefined);
}));

const WORKER = fileURLToPath(new URL("../lib/conversation-worker.ts", import.meta.url));
test("worker entry point exits normally on idle, failed runs and invalid session IDs", () => isolated((e) => {
  command(e, 'process.stdout.write(JSON.stringify({type:"error",text:"refused"})+"\\n")');
  const run = (id: string) => spawnSync(process.execPath, [WORKER, id, "--once"], { env: childEnv(e), encoding: "utf8" });
  assert.equal(run("chat").status, 0);
  turn(sessions.read("chat"));
  assert.equal(run("chat").status, 1);
  assert.match(sessions.read("chat").runs[0]!.error!, /refused/);
  const bad = run("../invalid");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /conversation ID/);
  const lock = join(sessions.directory("chat"), "lock");
  rmSync(lock, { recursive: true }); write(lock, "not a lock directory");
  const brokenStorage = run("chat");
  assert.equal(brokenStorage.status, 1);
  assert.match(brokenStorage.stderr, /EEXIST|ENOTDIR/);
}));

test("host forwards input, output, errors and signal exits and terminates normally", async () => {
  const host = fileURLToPath(new URL("../lib/conversation-host.ts", import.meta.url));
  for (const script of ['process.stdin.pipe(process.stdout);process.stderr.write("diagnostic")', 'process.kill(process.pid,"SIGTERM")']) {
    const child = spawn(process.execPath, [host], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let out = "", err = "";
    child.stdout!.on("data", (chunk) => out += chunk);
    child.stderr!.on("data", (chunk) => err += chunk);
    const done = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    child.send({ bin: process.execPath, args: ["-e", script], cwd: process.cwd(), env: process.env, input: "input", owner: owner(process.pid) });
    assert.equal(await done, script.includes("pipe") ? 0 : 1);
    if (script.includes("pipe")) { assert.equal(out, "input"); assert.equal(err, "diagnostic"); }
  }
});
