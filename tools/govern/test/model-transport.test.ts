import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvents } from "../lib/codex.ts";
import { claudeResult, grokResult } from "../lib/queue.ts";
import { build } from "../ext/conversation/conversation-adapters.ts";
import { makeEnv, childEnv, write, HERE } from "./helpers.ts";

const oversized = "x".repeat(4 * 1024 * 1024 + 1);
const bad = [
  ["non-JSON", "not JSON"], ["null", "null"], ["array", "[]"],
  ["incomplete", '{}'], ["unknown field", '{"result":"ok","surprise":true}'],
  ["wrong type", '{"result":42}'], ["oversized", JSON.stringify({ result: oversized })]
] as const;
for (const [label, raw] of bad) {
  test(`Claude decoder rejects ${label} with a typed failure`, () => {
    const out = claudeResult(raw, 0, "");
    assert.ok(out.error, "invalid Claude output must fail");
    assert.equal(out.spendUnknown, true);
  });
  test(`Grok decoder rejects ${label} before a valid terminal event`, () => {
    const event = label === "non-JSON" || label === "null" || label === "array" ? raw : JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn", ...JSON.parse(raw) });
    const out = grokResult(event + '\n' + JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn", result: "ok" }), 0, "", undefined, 30);
    assert.ok(out.error, "invalid Grok event must not be hidden by a later success");
    assert.equal(out.spendUnknown, true);
  });
  test(`Codex decoder rejects ${label} before a valid terminal event`, () => {
    const event = label === "non-JSON" || label === "null" || label === "array" ? raw : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok", ...(label === "incomplete" ? { text: undefined } : label === "unknown field" ? { surprise: true } : label === "wrong type" ? { text: 42 } : { text: oversized }) } });
    const out = parseEvents(event + '\n' + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }));
    assert.ok(out.errors.length, "invalid Codex event must fail");
    assert.equal(out.spendUnknown, true);
    assert.equal(out.message, undefined);
  });
}
for (const engine of ["command", "codex", "claude", "grok"] as const) {
  test(`${engine} conversation decoder rejects malformed, incomplete and adversarial events`, { timeout: 10000 }, () => {
    const e = makeEnv("transport-" + engine), saved = process.env;
    process.env = childEnv(e);
    process.env.GOVERN_GROK_HOME = join(e.root, "grok-home");
    process.env.GROK_HOME = join(e.root, "source-grok");
    write(join(process.env.GROK_HOME, "auth.json"), "DUMMY");
    const adapter = engine === "command" ? { kind: "command" as const, name: "fixture", argv: ["fixture"] } : { kind: "profile" as const, name: `${engine}-read` };
    let a: ReturnType<typeof build> | undefined;
    try {
      a = build({ id: "chat", cwd: e.root, adapter } as Parameters<typeof build>[0], { id: "run", messageId: "message" } as Parameters<typeof build>[1], []);
      const valid = engine === "command" ? { type: "done", text: "ok" } : engine === "codex" ? { type: "item.completed", item: { type: "agent_message", text: "ok" } } : { type: "result", subtype: "success", stop_reason: "end_turn", result: "ok" };
      const incomplete = engine === "command" ? { type: "done" } : engine === "codex" ? { type: "item.completed" } : { type: "result", subtype: "success" };
      for (const value of ["not JSON", null, [], incomplete, { ...valid, surprise: true }, { ...valid, type: 42 }, engine === "codex" ? { ...valid, item: { type: "agent_message", text: oversized } } : { ...valid, text: oversized, result: oversized }]) {
        assert.equal(a.parse(value)[0]?.type, "error", "invalid event must return an adapter failure");
      }
    } finally { a?.finish(); process.env = saved; }
  });
}

test("transport schemas reject invalid nested fields and preserve unrelated harness events", () => {
  for (const raw of [
    { type: "thread.started", thread_id: 4 },
    { type: "turn.failed", error: {} },
    { type: "error", message: ["error"] },
    { type: "item.completed", item: { type: "agent_message", text: "ok", surprise: 1 } },
    { type: "item.completed", item: { type: "command_execution", id: 42 } },
  ]) {
    const out = parseEvents(JSON.stringify(raw));
    assert.ok(out.invalid);
    assert.equal(out.spendUnknown, true);
  }
  const ignored = parseEvents('{"type":"new.harness.event","payload":{"unknown":true}}\n{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}');
  assert.deepEqual(ignored.errors, []);
  assert.equal(ignored.spendUnknown, undefined);
  // An invalid usage report in a queue run is not a measurement: the run is not failed for it, and its spend is unknown.
  const unmeasured = parseEvents('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0,"surprise":1}}');
  assert.equal(unmeasured.invalid, undefined);
  assert.equal(unmeasured.spendUnknown, true);
  for (const usage of [{ input_tokens: "1", output_tokens: 0 }, { input_tokens: 0, output_tokens: 0, surprise: 1 }]) {
    const raw = JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn", result: "ok", usage });
    for (const out of [claudeResult(raw, 0, ""), grokResult(raw, 0, "", undefined, 30)]) {
      assert.equal(out.error, undefined);
      assert.equal(out.text, "ok");
      assert.equal(out.spendUnknown, true);
      assert.equal(out.usage, undefined);
    }
  }
  for (const extra of [
    { num_turns: -1 }, { total_cost_usd: -1 }, { is_error: "false" },
  ]) {
    const raw = JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn", result: "ok", ...extra });
    for (const out of [claudeResult(raw, 0, ""), grokResult(raw, 0, "", undefined, 30)]) {
      assert.ok(out.error);
      assert.equal(out.spendUnknown, true);
    }
  }
});

test("terminal measurements preserve explicit zero and unknown spend", () => {
  const raw = (extra: object) => JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn", result: "ok", ...extra });
  for (const decode of [(s: string) => claudeResult(s, 0, ""), (s: string) => grokResult(s, 0, "", undefined, 30)]) {
    const zero = decode(raw({ usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
    assert.equal(zero.error, undefined);
    assert.equal(zero.usage?.costUsd, 0);
    assert.equal(zero.spendUnknown, undefined);
    for (const usage of [undefined, null, {}, { input_tokens: 1 }]) {
      const out = decode(raw({ usage, total_cost_usd: 0 }));
      assert.equal(out.error, undefined);
      assert.equal(out.usage, undefined);
      assert.equal(out.spendUnknown, true);
    }
  }
});

// Captured `claude -p --output-format stream-json --verbose` runs (system events dropped, paths and signatures scrubbed).
for (const version of ["2.1.219", "2.1.312"]) {
  test(`Claude Code ${version} stream and result decode`, { timeout: 10000 }, () => {
    const lines = readFileSync(join(HERE, `fixtures/claude-code-${version}.jsonl`), "utf8").trim().split("\n");
    const e = makeEnv("transport-claude-" + version), saved = process.env;
    process.env = childEnv(e);
    let a: ReturnType<typeof build> | undefined;
    try {
      a = build({ id: "chat", cwd: e.root, adapter: { kind: "profile", name: "claude-read" } } as Parameters<typeof build>[0], { id: "run", messageId: "message" } as Parameters<typeof build>[1], []);
      const events = lines.flatMap((line) => a!.parse(JSON.parse(line)));
      assert.deepEqual(events.filter((x) => x.type === "error"), []);
      assert.deepEqual(events.map((x) => x.type), ["tool.started", "tool.finished", "assistant.delta", "done"]);
      const done = events.at(-1)!;
      assert.equal(done.text, "ok");
      assert.ok(done.usage, "the result usage is a measurement");
    } finally { a?.finish(); process.env = saved; }
    const out = claudeResult(lines.at(-1)!, 0, "");
    assert.equal(out.error, undefined);
    assert.equal(out.text, "ok");
    assert.ok(out.usage);
    assert.equal(out.spendUnknown, undefined);
  });
}
