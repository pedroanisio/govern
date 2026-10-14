import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, chmodSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { makeEnv, govern, write, childEnv, GOVERN, HERE, type Env } from "./helpers.ts";
function setup() {
  const e = makeEnv("conversation");
  const file = join(e.root, "govern.config.json");
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.conversationAdapters = Object.fromEntries(
    ["echo", "slow", "hang", "partial", "fail", "malformed", "oversize", "tool", "approval"].map((name) => [
      name,
      { argv: [process.execPath, join(HERE, "fake-conversation.ts"), name, ...(name === "approval" ? [GOVERN] : [])] }
    ])
  );
  write(file, JSON.stringify(c));
  e.env.FAKE_CONVERSATION_LOG = join(e.root, "requests.jsonl");
  e.env.FAKE_CONVERSATION_RELEASE = join(e.root, "release");
  mkdirSync(e.env.FAKE_CONVERSATION_RELEASE);
  return e;
}
/** Lets the "slow" adapter finish its reply to this message. */
function release(e: Env, message: string) {
  write(join(e.env.FAKE_CONVERSATION_RELEASE!, encodeURIComponent(message)), "");
}
function ok(e: Env, args: string[]) {
  const r = govern(e, ["conversation", ...args]);
  assert.equal(r.code, 0, r.err + r.out);
  return r.out;
}
function json(e: Env, args: string[]) {
  return JSON.parse(ok(e, args));
}
function create(e: Env, adapter = "echo", extra: string[] = []) {
  return json(e, ["create", "chat", "--adapter", adapter, ...extra]);
}
function send(e: Env, text: string, extra: string[] = []) {
  return json(e, ["send", "chat", "--message", text, ...extra]);
}
function state(e: Env) {
  return json(e, ["show", "chat"]);
}
function worker(e: Env, args: string[] = []) {
  const p = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", GOVERN, "conversation", "run", "chat", ...args],
    { env: childEnv(e), stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "",
    err = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (err += c));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    p.on("close", (code) => resolve({ code, out, err }))
  );
  return { p, done };
}
async function until(e: Env, predicate: (s: any) => boolean) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const s = state(e);
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail("runtime condition did not arrive");
}

test("history and context survive new CLI processes; successful turns commit once", () => {
  const e = setup();
  create(e);
  const first = send(e, "hello", ["--request-id", "first"]);
  ok(e, ["run", "chat"]);
  assert.equal(state(e).runs[0].state, "completed");
  assert.equal(state(e).messages.at(-1).content, "reply:hello:previous=0");
  assert.equal(send(e, "hello", ["--request-id", "first"]).run.id, first.run.id);
  assert.equal(govern(e, ["conversation", "send", "chat", "--message", "different", "--request-id", "first"]).code, 2);
  send(e, "next");
  ok(e, ["run", "chat"]);
  assert.equal(state(e).messages.at(-1).content, "reply:next:previous=1");
  assert.equal(state(e).messages.length, 4);
});
test("partial output and nonzero exits never become completed assistant messages", () => {
  for (const adapter of ["partial", "fail", "malformed"]) {
    const e = setup();
    create(e, adapter);
    send(e, "work");
    const r = govern(e, ["conversation", "run", "chat"]);
    assert.equal(r.code, 1, r.out + r.err);
    const s = state(e);
    assert.equal(s.runs[0].state, "failed");
    assert.equal(s.messages.filter((m: any) => m.role === "assistant").length, 0);
    assert.equal(s.runs[0].partial, adapter === "malformed" ? "" : "part:");
  }
});
test("follow-ups are queued, streamed events persist, and concurrent workers serialize", async () => {
  const e = setup();
  create(e, "slow");
  send(e, "one");
  const a = worker(e);
  await until(e, (s) => s.runs[0].partial === "part:");
  send(e, "two");
  const b = worker(e);
  release(e, "one");
  release(e, "two");
  const results = await Promise.all([a.done, b.done]);
  assert.ok(
    results.every((r) => r.code === 0),
    JSON.stringify(results)
  );
  const s = state(e);
  assert.deepEqual(
    s.runs.map((r: any) => r.state),
    ["completed", "completed"]
  );
  assert.equal(s.messages.filter((m: any) => m.role === "assistant").length, 2);
  assert.equal(s.messages.at(-1).content, "reply:two:previous=1");
  const events = json(e, ["events", "chat"]);
  assert.ok(events.some((x: any) => x.type === "assistant.delta"));
  assert.equal(new Set(events.map((x: any) => x.seq)).size, events.length);
  const cursor = events[2].seq;
  assert.ok(json(e, ["events", "chat", "--after", String(cursor)]).every((x: any) => x.seq > cursor));
});
test("cancellation retains partial progress, stops the run, and permits a queued follow-up", async () => {
  const e = setup();
  create(e, "slow");
  const first = send(e, "stop");
  const w = worker(e);
  await until(e, (s) => s.runs[0].partial === "part:");
  send(e, "continue");
  ok(e, ["cancel", "chat", first.run.id, "--reason", "changed my mind"]);
  release(e, "continue");
  assert.equal((await w.done).code, 0);
  const s = state(e);
  assert.deepEqual(
    s.runs.map((r: any) => r.state),
    ["cancelled", "completed"]
  );
  assert.ok(s.runs[0].endedAt);
  assert.equal(s.messages.filter((m: any) => m.role === "assistant").length, 1);
});
test("a killed worker is interrupted, never replayed, and requires explicit recovery", async () => {
  const e = setup();
  create(e, "slow");
  send(e, "uncertain");
  const w = worker(e);
  await until(e, (s) => s.runs[0].partial === "part:");
  w.p.kill("SIGKILL");
  await w.done;
  const s = await until(e, (s) => s.runs[0].state === "interrupted");
  assert.equal(s.messages.filter((m: any) => m.role === "assistant").length, 0);
  send(e, "new task");
  assert.equal(govern(e, ["conversation", "run", "chat"]).code, 1);
  ok(e, ["recover", "chat", "--action", "continue", "--note", "inspected the effects"]);
  release(e, "new task");
  ok(e, ["run", "chat"]);
  assert.deepEqual(
    state(e).runs.map((r: any) => r.state),
    ["interrupted", "completed"]
  );
  const reqs = readFileSync(e.env.FAKE_CONVERSATION_LOG!, "utf8").trim().split("\n");
  assert.equal(reqs.length, 2, "uncertain instruction was not rerun");
});
test("queued cancellation, close, input validation, and traversal preserve existing state", () => {
  const e = setup();
  create(e);
  const r = send(e, "never execute");
  ok(e, ["cancel", "chat", r.run.id]);
  ok(e, ["run", "chat"]);
  assert.equal(state(e).runs[0].state, "cancelled");
  for (const args of [
    ["create", "../outside"],
    ["send", "chat", "--message", " "],
    ["send", "chat", "--message", "x", "--mode", "bad"]
  ])
    assert.equal(govern(e, ["conversation", ...args]).code, 2);
  ok(e, ["close", "chat"]);
  assert.equal(govern(e, ["conversation", "send", "chat", "--message", "closed"]).code, 2);
  assert.equal(state(e).messages.length, 1);
});
test("timeouts and output limits fail without committing a reply", () => {
  for (const adapter of ["hang", "oversize"]) {
    const e = setup();
    // Oversize gets a timeout it cannot reach, so only its output limit can fail it.
    create(e, adapter, ["--timeout", adapter === "hang" ? "1" : "600"]);
    send(e, "bounded");
    assert.equal(govern(e, ["conversation", "run", "chat"]).code, 1);
    const s = state(e);
    assert.equal(s.runs[0].state, "failed");
    assert.match(s.runs[0].error, adapter === "hang" ? /timed out/ : /output exceeds/);
    assert.equal(s.messages.length, 1);
  }
});
test("interrupt follow-up cancels the active turn before the new one starts", async () => {
  const e = setup();
  create(e, "slow");
  send(e, "old task");
  const w = worker(e);
  await until(e, (s) => s.runs[0].partial === "part:");
  send(e, "replacement", ["--mode", "interrupt"]);
  release(e, "replacement");
  assert.equal((await w.done).code, 0);
  assert.deepEqual(
    state(e).runs.map((r: any) => r.state),
    ["cancelled", "completed"]
  );
});
test("background worker outlives the command and event followers replay progress", async () => {
  const e = setup();
  create(e, "slow");
  send(e, "background");
  const receipt = json(e, ["run", "chat", "--bg"]);
  assert.ok(receipt.pid > 0);
  await until(e, (s) => s.runs[0].partial === "part:");
  release(e, "background");
  await until(e, (s) => s.runs[0].state === "completed");
  const follower = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", GOVERN, "conversation", "events", "chat", "--follow", "--timeout", "1"],
    { env: childEnv(e), stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  follower.stdout.on("data", (c) => (out += c));
  await new Promise<void>((resolve) => follower.on("close", () => resolve()));
  assert.ok(
    out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .some((e) => e.type === "run.completed")
  );
  assert.equal(state(e).runs[0].state, "completed");
});
test("context budget refuses silent truncation; explicit checkpoint retains the full history", () => {
  const e = setup();
  create(e, "echo", ["--max-context-chars", "500"]);
  send(e, "x".repeat(200));
  ok(e, ["run", "chat"]);
  const boundary = state(e).messages.at(-1).id;
  send(e, "next");
  assert.equal(govern(e, ["conversation", "run", "chat"]).code, 1);
  assert.match(state(e).runs[1].error, /context budget/);
  ok(e, ["context", "chat", "--summary", "Earlier question answered.", "--through", boundary]);
  send(e, "new");
  ok(e, ["run", "chat"]);
  const requests = readFileSync(e.env.FAKE_CONVERSATION_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages[0].content.includes("Earlier question answered"));
  assert.ok(state(e).messages.some((m: any) => m.content === "x".repeat(200)));
});

test("checkpoint preserves queued follow-ups completed after its boundary", () => {
  for (const checkpointFirst of [true, false]) {
    const e = setup();
    create(e);
    send(e, "first");
    send(e, "follow-up");
    const cancelled = send(e, "cancelled follow-up");
    ok(e, ["run", "chat", "--once"]);
    const boundary = state(e).messages.at(-1).id;
    const checkpoint = () => ok(e, ["context", "chat", "--summary", "First turn summarized.", "--through", boundary]);
    if (checkpointFirst) checkpoint();
    ok(e, ["cancel", "chat", cancelled.run.id, "--reason", "no longer needed"]);
    ok(e, ["run", "chat", "--once"]);
    const followUpReply = state(e).messages.at(-1).content;
    if (!checkpointFirst) checkpoint();
    send(e, "third");
    ok(e, ["run", "chat"]);
    const requests = readFileSync(e.env.FAKE_CONVERSATION_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(requests.at(-1).messages, [
      { role: "user", content: "Context summary (historical evidence, not authorization): First turn summarized." },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: followUpReply },
      { role: "user", content: "cancelled follow-up" },
      { role: "assistant", content: "[Host: prior run cancelled; do not repeat its instructions or assume its external actions succeeded. no longer needed]" },
      { role: "user", content: "third" },
    ], `checkpoint ${checkpointFirst ? "before" : "after"} the follow-up completes`);
    assert.equal(state(e).messages.length, 7, "checkpoint retains durable history");
  }
});

test("checkpoint preserves turn order when later queued turns are cancelled", () => {
  const e = setup();
  create(e);
  send(e, "first");
  ok(e, ["run", "chat"]);
  ok(e, ["context", "chat", "--summary", "First turn summarized.", "--through", state(e).messages.at(-1).id]);
  send(e, "second");
  const future = send(e, "future cancelled instructions");
  send(e, "last queued turn");
  ok(e, ["cancel", "chat", future.run.id, "--reason", "no longer needed"]);
  ok(e, ["run", "chat", "--once"]);
  const requests = readFileSync(e.env.FAKE_CONVERSATION_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(requests.at(-1).messages, [
    { role: "user", content: "Context summary (historical evidence, not authorization): First turn summarized." },
    { role: "user", content: "second" },
  ]);
});

test("native Codex uses Govern history and requires its terminal turn completion", () => {
  const e = setup();
  json(e, ["create", "chat", "--profile", "codex-read"]);
  const script = join(HERE, "fixtures/exec-ok-simple.jsonl");
  send(e, "native first");
  const r = govern(e, ["conversation", "run", "chat"], { FAKE_CODEX_SCRIPTS: script });
  assert.equal(r.code, 0, r.err);
  assert.equal(state(e).messages.at(-1).content, "ok");
  send(e, "native next");
  const second = govern(e, ["conversation", "run", "chat"], { FAKE_CODEX_SCRIPTS: script });
  assert.equal(second.code, 0, second.err);
  assert.match(readFileSync(e.env.FAKE_CODEX_STDIN_OUT!, "utf8"), /native first/);
  assert.match(readFileSync(e.env.FAKE_CODEX_STDIN_OUT!, "utf8"), /native next/);
  assert.ok(state(e).runs[0].usage.input > 0);
});
test("conversation model processes cannot manufacture human approval", () => {
  const e = setup();
  write(
    join(e.root, "PALS-Notes/processes/approval-case.json"),
    JSON.stringify({
      version: 1,
      name: "approval-case",
      stages: [{ name: "review" }],
      gates: [{ name: "final", stage: "review" }]
    })
  );
  assert.equal(govern(e, ["new", "p", "--process", "approval-case"]).code, 0);
  create(e, "approval", ["--lane", "p"]);
  send(e, "approve");
  ok(e, ["run", "chat"]);
  assert.match(state(e).messages.at(-1).content, /conversation.*cannot.*verified|conversation.*cannot.*approve/i);
  const p = JSON.parse(readFileSync(join(e.projects, "p/govern.json"), "utf8"));
  assert.equal(p.approvals.final, undefined);
});
test("usage and allowance reservations cover conversation execution", () => {
  const e = setup();
  const f = join(e.root, "govern.config.json"),
    c = JSON.parse(readFileSync(f, "utf8"));
  c.allowances = [
    {
      name: "chat-budget",
      consumer: "profile:echo",
      unit: "model-usd",
      limit: 0.02,
      period: "total",
      owner: "owner",
      taskEstimate: 0.02
    }
  ];
  write(f, JSON.stringify(c));
  create(e);
  send(e, "paid");
  ok(e, ["run", "chat"]);
  const report = govern(e, ["usage"]);
  assert.equal(report.code, 0, report.err);
  assert.match(report.out, /govern conversations/);
  assert.match(report.out, /0\.01/);
  send(e, "over");
  assert.equal(govern(e, ["conversation", "run", "chat"]).code, 1);
  assert.match(state(e).runs[1].error, /allowance/);
});
test("missing sessions do not poison listing and malformed persisted state fails closed", () => {
  const e = setup();
  assert.equal(govern(e, ["conversation", "show", "missing"]).code, 2);
  assert.deepEqual(json(e, ["list"]), []);
  create(e);
  const path = join(e.root, "PALS-Notes/govern-state/conversations/chat/session.json");
  const s = JSON.parse(readFileSync(path, "utf8"));
  s.user = "another-user";
  write(path, JSON.stringify(s));
  assert.equal(govern(e, ["conversation", "show", "chat"]).code, 2);
});
test("tool progress requires a finished lifecycle before committing a successful reply", () => {
  const e = setup();
  create(e, "tool");
  send(e, "read");
  ok(e, ["run", "chat"]);
  const s = state(e);
  assert.equal(s.runs[0].tools[0].state, "completed");
  const events = json(e, ["events", "chat"]);
  assert.ok(events.some((x: any) => x.type === "tool.started"));
  assert.ok(events.some((x: any) => x.type === "tool.finished"));
});
test("explicit retry after interruption creates a new attempt and does not lose the original", async () => {
  const e = setup();
  create(e, "slow");
  send(e, "retry work");
  const w = worker(e);
  await until(e, (s) => s.runs[0].partial === "part:");
  w.p.kill("SIGKILL");
  await w.done;
  await until(e, (s) => s.runs[0].state === "interrupted" && !s.runs[0].host?.running);
  await new Promise((r) => setTimeout(r, 500));
  ok(e, ["recover", "chat", "--action", "retry", "--note", "external effects checked; retry approved"]);
  release(e, "retry work");
  ok(e, ["run", "chat"]);
  assert.deepEqual(
    state(e).runs.map((r: any) => r.state),
    ["interrupted", "completed"]
  );
  assert.equal(state(e).messages.filter((m: any) => m.role === "assistant").length, 1);
});
test("background once executes one turn and leaves further turns durable", async () => {
  const e = setup();
  create(e);
  send(e, "one");
  send(e, "two");
  json(e, ["run", "chat", "--bg", "--once"]);
  await until(e, (s) => s.runs[0].state === "completed");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(state(e).runs[1].state, "queued");
  ok(e, ["run", "chat"]);
  assert.equal(state(e).runs[1].state, "completed");
});
test("graceful worker shutdown cancels active work and leaves queued turns for restart", async () => {
  const e = setup();
  create(e, "slow");
  send(e, "first");
  const w = worker(e);
  await until(e, (s) => s.runs[0].partial === "part:");
  send(e, "later");
  w.p.kill("SIGTERM");
  await w.done;
  assert.deepEqual(
    state(e).runs.map((r: any) => r.state),
    ["cancelled", "queued"]
  );
  release(e, "later");
  ok(e, ["run", "chat"]);
  assert.equal(state(e).runs[1].state, "completed");
});
test("native Claude streams text but commits only its successful result, with correct usage", () => {
  const e = setup();
  const wrapper = join(e.root, "claude-runner");
  write(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(HERE, "fake-conversation-claude.ts")}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  e.env.GOVERN_CLAUDE_BIN = wrapper;
  json(e, ["create", "chat", "--profile", "claude-read"]);
  send(e, "claude");
  ok(e, ["run", "chat"]);
  assert.equal(state(e).runs[0].usage.input, 7);
  assert.equal(state(e).messages.at(-1).content, "native reply");
  send(e, "incomplete");
  const r = govern(e, ["conversation", "run", "chat"], { FAKE_CONVERSATION_CLAUDE_PARTIAL: "1" });
  assert.equal(r.code, 1);
  assert.equal(state(e).messages.filter((m: any) => m.role === "assistant").length, 1);
});
test("native Grok streaming results preserve completion and include cache tokens in input", () => {
  const e = setup();
  e.env.FAKE_GROK_RESULT = "native grok";
  e.env.GOVERN_GROK_HOME = join(e.root, "private-grok");
  e.env.GROK_HOME = join(e.root, "test-grok");
  write(join(e.env.GROK_HOME, "auth.json"), "DUMMY");
  json(e, ["create", "chat", "--profile", "grok-read"]);
  send(e, "grok");
  ok(e, ["run", "chat"]);
  assert.equal(state(e).runs[0].usage.input, 10000);
  assert.equal(state(e).runs[0].usage.costUsd, 0.0123);
});
test("declared profile output checks must pass before an assistant reply is committed", () => {
  const e = setup();
  write(
    join(e.root, "PALS-Notes/capabilities/checked.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: "checked",
          engine: "codex",
          capabilities: ["read"],
          selfTest: "optional",
          check: { argv: [process.execPath, "-e", "process.exit(1)"], label: "reject response" }
        }
      ]
    })
  );
  json(e, ["create", "chat", "--profile", "checked"]);
  send(e, "verify");
  const r = govern(e, ["conversation", "run", "chat"], {
    FAKE_CODEX_SCRIPTS: join(HERE, "fixtures/exec-ok-simple.jsonl")
  });
  assert.equal(r.code, 1);
  const s = state(e);
  assert.equal(s.messages.filter((m: any) => m.role === "assistant").length, 0);
  assert.equal(s.runs[0].candidate, "ok");
  assert.match(s.runs[0].error, /check|verification/);
});
test("cancellation arriving during final verification cannot race into a committed reply", async () => {
  const e = setup();
  // The check holds until the test releases it, so the cancel always lands while it runs (bounded at 60 s).
  const release = join(e.root, "release-check");
  write(
    join(e.root, "PALS-Notes/capabilities/checked.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: "checked",
          engine: "codex",
          capabilities: ["read"],
          selfTest: "optional",
          check: { argv: [process.execPath, "-e", `const f=${JSON.stringify(release)},end=Date.now()+60000;const t=setInterval(()=>{if(require("fs").existsSync(f)){clearInterval(t)}else if(Date.now()>end){process.exit(1)}},20)`], label: "held check" }
        }
      ]
    })
  );
  e.env.FAKE_CODEX_SCRIPTS = join(HERE, "fixtures/exec-ok-simple.jsonl");
  json(e, ["create", "chat", "--profile", "checked"]);
  const input = send(e, "late cancellation");
  const w = worker(e);
  await until(e, (s) => s.runs[0].candidate === "ok");
  ok(e, ["cancel", "chat", input.run.id]);
  write(release, "");
  await w.done;
  assert.equal(state(e).runs[0].state, "cancelled");
  assert.equal(state(e).messages.filter((m: any) => m.role === "assistant").length, 0);
});
test("restart recovery rejects a recorded owner from another boot even if its PID is live", () => {
  const e = setup();
  create(e);
  send(e, "interrupted by restart");
  const path = join(e.root, "PALS-Notes/govern-state/conversations/chat/session.json");
  const s = JSON.parse(readFileSync(path, "utf8"));
  s.runs[0].state = "running";
  s.runs[0].startedAt = new Date().toISOString();
  s.runs[0].owner = { pid: process.pid, boot: "another-boot" };
  write(path, JSON.stringify(s));
  assert.equal(state(e).runs[0].state, "interrupted");
  ok(e, ["recover", "chat", "--action", "continue", "--note", "restored after reboot"]);
});

test("Grok NDJSON conversation commits only the final turn and rejects error streams", () => {
  for (const trailingNewline of [false, true]) {
    const e = setup();
    e.env.GOVERN_GROK_HOME = join(e.root, "private-grok");
    e.env.GROK_HOME = join(e.root, "test-grok");
    write(join(e.env.GROK_HOME, "auth.json"), "DUMMY");
    const capture = readFileSync(join(HERE, "fixtures/grok-stream/stream-success-2turns.ndjson"), "utf8");
    e.env.FAKE_GROK_RAW = capture.trimEnd() + (trailingNewline ? "\n" : "");
    json(e, ["create", "chat", "--profile", "grok-read"]);
    send(e, "read");
    ok(e, ["run", "chat"]);
    const replies = state(e).messages.filter((m: any) => m.role === "assistant");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, '{"capability": "read", "status": "ok", "evidence": "chk-feedface00112233"}');
    send(e, "fail");
    e.env.FAKE_GROK_RAW = readFileSync(join(HERE, "fixtures/grok-stream/stream-error-max-turns.ndjson"), "utf8");
    assert.equal(govern(e, ["conversation", "run", "chat"]).code, 1);
    assert.equal(state(e).messages.filter((m: any) => m.role === "assistant").length, 1);
  }
});

test("Grok stream adapter emits tool events and covers every parse failure", async () => {
  const { build } = await import("../lib/conversation-adapters.ts");
  const e = setup(), saved = process.env;
  process.env = childEnv(e, { GOVERN_GROK_HOME: join(e.root, "private-grok"), GROK_HOME: join(e.root, "test-grok") });
  let adapter: ReturnType<typeof build> | undefined;
  try {
    const s = { id: "chat", cwd: e.root, adapter: { kind: "profile", name: "grok-read" } } as Parameters<typeof build>[0];
    adapter = build(s, { id: "run", messageId: "msg" } as any, []);
    assert.equal(adapter.args[adapter.args.indexOf("--output-format") + 1], "streaming-messages-json");
    const events = readFileSync(join(HERE, "fixtures/grok-stream/stream-success-2turns.ndjson"), "utf8")
      .split("\n").filter((line) => line.trim()).flatMap((line) => adapter!.parse(JSON.parse(line)));
    const done = events.filter((event) => event.type === "done");
    assert.equal(done.length, 1);
    assert.equal(done[0]?.text, '{"capability": "read", "status": "ok", "evidence": "chk-feedface00112233"}');
    assert.equal(done[0]?.usage?.input, 29570);
    assert.ok(events.some((event) => event.type === "tool.started"));
    assert.ok(events.some((event) => event.type === "tool.finished"));
    for (const name of ["bad-model", "max-turns"]) {
      const failed = readFileSync(join(HERE, `fixtures/grok-stream/stream-error-${name}.ndjson`), "utf8")
        .split("\n").filter((line) => line.trim()).flatMap((line) => adapter!.parse(JSON.parse(line)));
      assert.equal(failed.filter((event) => event.type === "error").length, 1);
      assert.equal(failed.filter((event) => event.type === "done").length, 0);
    }
    assert.deepEqual(adapter.parse({ type: "system" }), []);
    assert.deepEqual(adapter.parse({ type: "assistant", message: { content: [{ type: "text", text: "preamble" }, { type: "tool_use", id: "t", name: "read" }] } }), [
      { type: "assistant.delta", text: "preamble" }, { type: "tool.started", id: "t", name: "read" }
    ]);
    assert.deepEqual(adapter.parse({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: true }] } }), [{ type: "tool.finished", id: "t", name: "tool", ok: false }]);
    for (const o of [null, [], 42]) assert.equal(adapter.parse(o)[0]?.type, "error");
    for (const extra of [{ is_error: true, errors: ["failure"] }, { subtype: "bad" }, { stop_reason: "cancelled" }, { result: null }]) {
      assert.equal(adapter.parse({ type: "result", subtype: "success", stop_reason: "end_turn", result: "final", ...extra })[0]?.type, "error");
    }
    for (const extra of [{ subtype: "" }, { subtype: undefined }, { is_error: true, errors: [] }]) {
      const [ev] = adapter.parse({ type: "result", subtype: "success", stop_reason: "end_turn", result: "final", ...extra });
      assert.equal(ev?.type, "error");
      assert.match((ev as { text: string }).text, /^grok failed: subtype /);
    }
    for (const message of ["early", null]) assert.equal(adapter.parse({ type: "error", message })[0]?.type, "error");
    for (const message of ["", "  ", null]) assert.equal((adapter.parse({ type: "error", message })[0] as { text: string }).text, "grok failed");
    for (const type of ["assistant", "user"]) {
      assert.deepEqual(adapter.parse({ type }), []);
      assert.throws(() => adapter!.parse({ type, message: { content: {} } }));
    }
    for (const extra of [{}, { usage: {}, usage_is_incomplete: true }, { usage: {}, cost_is_partial: true }]) {
      assert.deepEqual(adapter.parse({ type: "result", subtype: "success", stop_reason: "end_turn", result: "final", ...extra }), [{ type: "done", text: "final" }]);
    }
    assert.throws(() => adapter!.parse({ type: "result", subtype: "success", stop_reason: "end_turn", result: "final", usage: { input_tokens: -1 } }), /invalid runtime usage/);
  } finally { adapter?.finish(); process.env = saved; }
});
