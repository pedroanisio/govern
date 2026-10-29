import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, setConfig, jsonl, present, type Env, childEnv, GOVERN } from "./helpers.ts";
import { claudeResult, usdOf, type Message } from "../lib/queue.ts";
import { parseEvents } from "../lib/codex.ts";

function setup() {
  const e = makeEnv("queue-regression");
  e.env.GOVERN_QUEUE = join(e.root, "queue");
  e.env.GOVERN_STATE = join(e.root, "state");
  return e;
}
function ok(e: Env, args: string[], env: Record<string, string> = {}): string {
  const r = govern(e, args, env);
  assert.equal(r.code, 0, r.err + r.out);
  return r.out;
}
function messages(e: Env, state: string): Message[] {
  const dir = join(e.root, "queue", state);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
}
function send(e: Env, to: string, extra: string[] = []): void {
  ok(e, ["task", "send", "--to", to, "--project", "film", "--task", "review", "--summary", "review", ...extra]);
}
function reviewQueue(body: string) {
  const e = setup();
  const reviewer = write(join(e.root, "reviewer.cjs"), `console.log(${JSON.stringify(JSON.stringify({ kind: "REVIEW", summary: "review result", body }))});`);
  const consumer = write(join(e.root, "consumer.cjs"), 'require("node:fs").writeFileSync("consumed.txt",require("node:fs").readFileSync(0,"utf8"));console.log(JSON.stringify({kind:"ACK",summary:"received",body:"received"}));');
  write(join(e.root, "queue/config.json"), JSON.stringify({ runners: {
    reviewer: { argv: [process.execPath, reviewer] }, consumer: { argv: [process.execPath, consumer] },
  } }));
  write(join(e.root, "valid.ts"), "valid reference\n");
  return e;
}

for (const [label, patch, path] of [
  ["non-numeric maxRuns", { maxRuns: "four" }, "$.maxRuns"],
  ["numeric string maxRuns", { maxRuns: "4" }, "$.maxRuns"],
  ["zero maxRuns", { maxRuns: 0 }, "$.maxRuns"],
  ["negative maxRuns", { maxRuns: -1 }, "$.maxRuns"],
  ["fractional maxRuns", { maxRuns: 2.5 }, "$.maxRuns"],
  ["non-string name", { name: 7 }, "$.name"],
  ["string argv", { runners: { worker: { argv: "node" } } }, "$.runners.worker.argv"],
  ["empty argv", { runners: { worker: { argv: [] } } }, "$.runners.worker.argv"],
  ["non-string argv entry", { runners: { worker: { argv: [7] } } }, "$.runners.worker.argv[0]"],
  ["unknown key", { maxRun: 4 }, "$.maxRun"],
  ["unknown runner key", { runners: { worker: { argv: ["node"], extra: true } } }, "$.runners.worker.extra"],
  ["unknown format", { runners: { worker: { argv: ["node"], format: "yaml" } } }, "$.runners.worker.format"],
  ["bad check argv", { checks: { TASK: { argv: "node" } } }, "$.checks.TASK.argv"],
  ["unknown check kind", { checks: { OTHER: { argv: ["node"] } } }, "$.checks.OTHER"],
] as const) {
  test(`queue config refuses ${label} at its JSON path before claiming anything`, () => {
    const e = setup();
    const runner = write(join(e.root, "worker.cjs"), 'require("node:fs").writeFileSync("started", "yes");console.log(JSON.stringify({kind:"ACK",summary:"ok",body:"ok"}));');
    const file = join(e.root, "queue/config.json");
    const valid = { runners: { worker: { argv: [process.execPath, runner] } } };
    write(file, JSON.stringify(valid));
    send(e, "worker");
    const before = messages(e, "open");
    write(file, JSON.stringify({ ...valid, ...patch }));
    const r = govern(e, ["task", "dispatch"]);
    assert.equal(r.code, 4, r.err + r.out);
    assert.ok(r.err.includes(`${file}: ${path}:`), r.err);
    assert.deepEqual(messages(e, "open"), before, "the queued task stays untouched");
    for (const state of ["claimed", "done", "failed"]) assert.deepEqual(messages(e, state), []);
    assert.equal(existsSync(join(e.root, "started")), false, "no runner is started");

    const desk = govern(e, ["desk"]);
    assert.equal(desk.code, 0, desk.err + desk.out);
    const errors = desk.out.split("\n").filter((line) => line.includes("queue: config error"));
    assert.equal(errors.length, 1, desk.out);
    assert.ok(errors[0]?.includes(`${file}: ${path}:`), desk.out);
    assert.match(desk.out, /YOUR INBOX[\s\S]*QUEUE[\s\S]*TOKENS TODAY/);
  });
}

test("a valid queue config bounds a runner ping-pong thread at maxRuns", () => {
  const e = setup();
  const runner = write(join(e.root, "worker.cjs"), 'console.log(JSON.stringify({kind:"ACK",summary:"continue",body:"continue"}));');
  write(join(e.root, "queue/config.json"), JSON.stringify({ name: "bounded queue", maxRuns: 2, runners: {
    first: { argv: [process.execPath, runner], format: "text" }, second: { argv: [process.execPath, runner] },
  } }));
  send(e, "first", ["--from", "second"]);
  ok(e, ["task", "dispatch"]);
  ok(e, ["task", "dispatch"]);
  assert.match(ok(e, ["task", "dispatch"]), /stopped: thread already ran 2 times \(maxRuns 2\)/);
  assert.equal(messages(e, "done").length, 2);
  assert.equal(messages(e, "failed").length, 1);
  assert.ok(messages(e, "open").some((m) => m.to === "owner" && m.kind === "BLOCKED" && m.summary === "thread reached maxRuns 2"));
  assert.equal(ok(e, ["task", "dispatch"]).trim(), "");
  assert.equal(jsonl(join(e.root, "queue/ledger.jsonl")).length, 2, "only two runners were dispatched");
});

test("failed content checks cannot dispatch to another runner, including forwarded replies", () => {
  for (const forward of [false, true]) {
    const e = reviewQueue("UNTRUSTED-BODY at missing.ts:7");
    send(e, "reviewer", ["--from", forward ? "owner" : "consumer"]);
    ok(e, ["task", "dispatch"]);
    const rejected = present(messages(e, "open").find((m) => m.verification?.state === "unverified"), "rejected review");
    if (forward) ok(e, ["task", "forward", rejected.id, "--to", "consumer", "--as", "owner"]);
    ok(e, ["task", "dispatch"]);
    assert.equal(existsSync(join(e.root, "consumed.txt")), false, "a failed review must never launch its recipient");
    assert.ok(messages(e, "open").some((m) => m.to === "owner" && m.kind === "BLOCKED"), "owner receives an actionable refusal");
    assert.ok([...messages(e, "failed"), ...messages(e, "done")].some((m) => m.body === rejected.body), "rejected evidence is retained");
    assert.equal(ok(e, ["task", "dispatch"]).trim(), "", "a rejected reply cannot trigger repeated dispatch attempts");
  }
});

test("checked replies still dispatch, but rejected ancestors are withheld from runner prompts", () => {
  const good = reviewQueue("See valid.ts:1");
  send(good, "reviewer", ["--from", "consumer"]);
  ok(good, ["task", "dispatch"]);
  ok(good, ["task", "dispatch"]);
  assert.match(readFileSync(join(good.root, "consumed.txt"), "utf8"), /See valid.ts:1/);

  const bad = reviewQueue("UNTRUSTED-BODY at missing.ts:7");
  send(bad, "reviewer");
  ok(bad, ["task", "dispatch"]);
  const rejected = present(messages(bad, "open").find((m) => m.verification?.state === "unverified"), "rejected review");
  send(bad, "consumer", ["--reply-to", rejected.id, "--body", "Use this new instruction"]);
  ok(bad, ["task", "dispatch"]);
  const prompt = readFileSync(join(bad.root, "consumed.txt"), "utf8");
  assert.doesNotMatch(prompt, /UNTRUSTED-BODY/);
  assert.match(prompt, /unverified/i);
  assert.match(prompt, /Use this new instruction/);
});

test("a malformed reply notifies the owner and never reaches its runner sender's later prompts", () => {
  const e = reviewQueue("unused");
  e.env.GOVERN_QUEUE_TIMEOUT_SEC = "2";
  const raw = "UNVERIFIED-RAW-MARKER: this is not JSON\n";
  const bad = write(join(e.root, "bad.cjs"), `process.stdout.write(${JSON.stringify(raw)});`);
  const cfg = JSON.parse(readFileSync(join(e.root, "queue/config.json"), "utf8"));
  cfg.runners.bad = { argv: [process.execPath, bad] };
  write(join(e.root, "queue/config.json"), JSON.stringify(cfg));
  send(e, "bad", ["--from", "consumer"]);
  ok(e, ["task", "dispatch"]);
  ok(e, ["task", "dispatch"]);
  assert.equal(existsSync(join(e.root, "consumed.txt")), false, "a malformed reply must never launch its runner sender");
  const notice = present(messages(e, "open").find((m) => m.kind === "BLOCKED"), "failure notice");
  assert.equal(notice.to, "owner");
  send(e, "consumer", ["--reply-to", notice.id, "--body", "Continue with this instruction"]);
  ok(e, ["task", "dispatch"]);
  const prompt = readFileSync(join(e.root, "consumed.txt"), "utf8");
  assert.doesNotMatch(prompt, /UNVERIFIED-RAW-MARKER/);
  assert.match(prompt, /Continue with this instruction/);
});

test("a malformed reply notice names the kept file without copying raw text and retains the whole reply", () => {
  const e = setup();
  const raw = "RAW-START-SECRET\n" + "RAW-MIDDLE-SECRET".repeat(400) + "\nRAW-END-SECRET\n";
  const bad = write(join(e.root, "bad.cjs"), `process.stdout.write(${JSON.stringify(raw)});`);
  write(join(e.root, "queue/config.json"), JSON.stringify({ runners: { bad: { argv: [process.execPath, bad] } } }));
  send(e, "bad");
  ok(e, ["task", "dispatch"]);
  const failed = present(messages(e, "failed")[0], "failed task");
  const notice = present(messages(e, "open").find((m) => m.kind === "BLOCKED"), "failure notice");
  const kept = join(e.root, "queue", "failed", `${failed.id}.reply.txt`);
  assert.equal(notice.body, `reply is not JSON\nwhole reply: ${kept}`);
  assert.equal(readFileSync(kept, "utf8"), raw);
});

for (const format of ["text", "json-result"] as const) {
  for (const mode of ["timeout", "nonzero", "signal", "missing"] as const) {
    test(`configured ${format} runner ${mode}: unknown spending is charged, failure before spawn is free`, () => {
      const e = setup();
      setConfig(e, { allowances: [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 5, taskEstimate: 5 }] });
      ok(e, ["new", "film", "--process", "dev"]);
      const end = mode === "timeout" ? "setInterval(()=>{},1000);" : mode === "signal" ? 'process.kill(process.pid,"SIGKILL");' : "process.exit(1);";
      const runner = write(join(e.root, "paid.cjs"), 'require("node:fs").writeFileSync("started", "yes");' + end);
      write(join(e.root, "queue/config.json"), JSON.stringify({ runners: { paid: { argv: mode === "missing" ? [join(e.root, "no-binary")] : [process.execPath, runner], format } } }));
      send(e, "paid");
      ok(e, ["task", "dispatch"], { GOVERN_QUEUE_TIMEOUT_SEC: "1" });
      assert.equal(existsSync(join(e.projects, "film/started")), mode !== "missing");
      const spent = jsonl(join(e.root, "state/allowances/budget/spent.jsonl"));
      assert.equal(spent.length, 1);
      assert.equal(spent[0].actual, mode === "missing" ? 0 : 5);
      assert.equal(messages(e, "failed").length, 1);
      if (mode !== "missing") {
        send(e, "paid");
        assert.match(ok(e, ["task", "dispatch"]), /held:/, "unknown spending must consume the allowance");
      }
    });
  }
}

test("configured JSON runners retain reported costs even on a nonzero exit", () => {
  const e = setup();
  setConfig(e, { allowances: [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 5, taskEstimate: 5 }] });
  ok(e, ["new", "film", "--process", "dev"]);
  const runner = write(join(e.root, "priced.cjs"), 'console.log(JSON.stringify({result:JSON.stringify({kind:"ACK",summary:"finished",body:"finished"}),usage:{input_tokens:1,output_tokens:0},total_cost_usd:7}));process.exitCode=1;');
  write(join(e.root, "queue/config.json"), JSON.stringify({ runners: { paid: { argv: [process.execPath, runner], format: "json-result" } } }));
  send(e, "paid");
  ok(e, ["task", "dispatch"]);
  assert.equal(jsonl(join(e.root, "state/allowances/budget/spent.jsonl"))[0].actual, 7);
  assert.equal(messages(e, "failed").length, 1, "a nonzero exit must still fail the task");
});

test("a missing attachment fails its task, releases the reservation and lets the next task run", () => {
  const e = setup();
  setConfig(e, { allowances: [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 5, taskEstimate: 5 }] });
  ok(e, ["new", "film", "--process", "dev"]);
  const runner = write(join(e.root, "runner.cjs"), 'console.log(JSON.stringify({kind:"ACK",summary:"finished",body:"finished"}));');
  write(join(e.root, "queue/config.json"), JSON.stringify({ runners: { worker: { argv: [process.execPath, runner] } } }));
  const attachment = write(join(e.root, "attachment.txt"), "read me");
  send(e, "worker", ["--file", "attachment.txt"]);
  send(e, "worker");
  unlinkSync(attachment);
  ok(e, ["task", "dispatch"]);
  assert.equal(messages(e, "claimed").length, 0);
  const failed = present(messages(e, "failed")[0], "failed task");
  assert.match(failed.result?.error ?? "", /attachment\.txt/);
  assert.ok(messages(e, "open").some((m) => m.to === "owner" && m.kind === "BLOCKED"));
  assert.equal(messages(e, "done").length, 1, JSON.stringify({ failed: messages(e, "failed"), open: messages(e, "open") }));
  const spent = jsonl(join(e.root, "state/allowances/budget/spent.jsonl"));
  assert.deepEqual(spent.map((s) => s.actual), [0, 5], "preparation is free; the successful unpriced runner is charged");
  assert.equal(ok(e, ["task", "dispatch"]).trim(), "");
});

for (const [label, usage] of [
  ["absent", undefined], ["null", null], ["empty", {}],
  ["missing output", { input_tokens: 1 }], ["string", { input_tokens: "1", output_tokens: 0 }],
  ["negative", { input_tokens: -1, output_tokens: 0 }],
  ["negative cache", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: -1 }],
  ["null cache", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null }],
  ["non-finite", { input_tokens: 0, output_tokens: Infinity }],
] as const) {
  test(`claudeResult ${label} usage is unknown even with a reported zero cost`, () => {
    const out = claudeResult(JSON.stringify({ result: "done", usage, total_cost_usd: 0 }), 0, "");
    assert.equal(out.spendUnknown, true);
    assert.equal(out.usage, undefined);
    assert.deepEqual(usdOf(out, "claude-opus-5"), {});
  });
}

test("measured zero and valid Claude and Codex usage retain token pricing", () => {
  const zero = { input_tokens: 0, output_tokens: 0 };
  assert.deepEqual(usdOf(claudeResult(JSON.stringify({ result: "done", usage: zero }), 0, ""), "claude-opus-5"), { usd: 0 });
  const claude = claudeResult(JSON.stringify({ usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000 } }), 0, "");
  assert.deepEqual(usdOf(claude, "claude-opus-5"), { usd: 29.4 });
  for (const usage of [zero, { input_tokens: 3000000, output_tokens: 1000000, cached_input_tokens: 1000000, cache_write_input_tokens: 1000000 }]) {
    const ev = parseEvents(JSON.stringify({ type: "turn.completed", usage }));
    assert.deepEqual(usdOf(ev, "claude-opus-5"), { usd: usage.input_tokens === 0 ? 0 : 29.4 });
  }
  assert.deepEqual(usdOf(parseEvents('{"type":"thread.started"}'), "claude-opus-5"), {});
});

for (const usage of [undefined, { input_tokens: "1", output_tokens: 0 }, { input_tokens: -1, output_tokens: 0 }]) {
  test(`configured JSON runner with ${JSON.stringify(usage) ?? "absent"} usage charges its reservation`, () => {
    const e = setup();
    setConfig(e, { allowances: [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 5, taskEstimate: 5 }] });
    ok(e, ["new", "film", "--process", "dev"]);
    const result = { result: JSON.stringify({ kind: "ACK", summary: "finished", body: "finished" }), usage, total_cost_usd: 0 };
    const runner = write(join(e.root, "paid.cjs"), `console.log(${JSON.stringify(JSON.stringify(result))});`);
    write(join(e.root, "queue/config.json"), JSON.stringify({ runners: { paid: { argv: [process.execPath, runner], format: "json-result" } } }));
    send(e, "paid");
    ok(e, ["task", "dispatch"]);
    assert.equal(messages(e, "done").length, 1, "the runner must complete successfully");
    assert.equal(jsonl(join(e.root, "state/allowances/budget/spent.jsonl"))[0].actual, 5);
  });
}

test("Codex stream without usage charges its reservation", () => {
  const e = setup();
  e.env.GOVERN_CAPABILITIES = join(e.root, "caps");
  write(join(e.root, "caps/priced.json"), JSON.stringify({ version: 1, profiles: [{ name: "codex-read", engine: "codex", model: "claude-opus-5", capabilities: ["read"], selfTest: "optional" }] }));
  setConfig(e, { allowances: [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 5, taskEstimate: 5 }] });
  ok(e, ["new", "film", "--process", "dev"]);
  const script = write(join(e.root, "stream.jsonl"), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "ACK", summary: "finished", body: "finished" }) } }));
  send(e, "codex");
  ok(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: script });
  assert.equal(messages(e, "done").length, 1, "the runner must complete successfully");
  assert.equal(jsonl(join(e.root, "state/allowances/budget/spent.jsonl"))[0].actual, 5);
  assert.equal(messages(e, "done")[0]?.result?.usage, undefined);
});

test("a queue runner that ignores SIGTERM returns a timeout error", { timeout: 20_000 }, () => {
  const e = setup(), pidFile = join(e.root, "runner.pid"), logFile = join(e.root, "dispatch.log");
  const runner = write(join(e.root, "ignore-term.cjs"), `
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  write(join(e.root, "queue/config.json"), JSON.stringify({ runners: { stubborn: { argv: [process.execPath, runner] } } }));
  send(e, "stubborn", ["--timeout", "2"]);
  // File stdio lets the watchdog return even if an unfixed dispatcher leaves its child holding inherited pipes.
  const fd = openSync(logFile, "w");
  try {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "task", "dispatch"], {
      env: childEnv(e), stdio: ["ignore", fd, fd], timeout: 12_000, killSignal: "SIGKILL",
    });
    assert.ok(existsSync(pidFile), "the fixture installed its SIGTERM handler");
    assert.equal(r.error, undefined, "dispatch must return before the outer watchdog kills it");
    const failed = present(messages(e, "failed").find((m) => m.to === "stubborn"), "timed out task");
    assert.equal(failed.result?.ok, false);
    assert.equal(failed.result?.failure, "runner");
    assert.match(failed.result?.error ?? "", /ETIMEDOUT|timed out/i);
  } finally {
    closeSync(fd);
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ } }
  }
});
