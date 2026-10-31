import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, govern, write, reply } from "./helpers.ts";

const env = () => { const e = makeEnv(); e.env.GOVERN_QUEUE = join(e.root, "queue"); return e; };

test("an ops lane has its own stages, no owner gates and no video files", () => {
  const e = env();
  assert.equal(govern(e, ["new", "ops/engine", "--kind", "ops", "--title", "Engine releases"]).code, 0);
  const b = govern(e, ["brief", "ops/engine"]).out;
  assert.match(b, /kind ops · stage 1\/4 plan/);
  assert.doesNotMatch(b, /approvals|lang/);
  assert.match(govern(e, ["work", "ops/engine", "script"]).err, /stage must be one of: plan, doing, review, done/);
  assert.match(govern(e, ["work", "ops/engine", "doing"]).out, /stage 2\/4 doing/);
  const invalid = govern(e, ["new", "x", "--kind", "film"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.err, /choose a process: --process dev, .*--process ops.*--process video.*\(govern process list\)/);
});

test("desk shows lanes, the open work segment, the owner's inbox, the queue and today's tokens", () => {
  const e = env();
  govern(e, ["new", "film", "--kind", "long", "--title", "Film"]);
  govern(e, ["new", "ops/engine", "--kind", "ops"]);
  govern(e, ["approve", "film", "script", "--quote", "ok"]);
  govern(e, ["note", "ops/engine", "v0.5.0 waits for CI"]);
  govern(e, ["work", "ops/engine", "doing"], { CLAUDE_CODE_SESSION_ID: "S1" });
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check the claims"]);
  govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind: "REVIEW", summary: "all supported", body: "ok" }) });
  govern(e, ["task", "send", "--to", "claude", "--project", "film", "--task", "fix", "--summary", "later"]);
  const d = govern(e, ["desk"]).out;
  assert.match(d, /LANES \(2\)/);
  assert.match(d, /film\s+long\s+1\/8 plan\s+needs final/);
  assert.match(d, /ops\/engine\s+ops\s+2\/4 doing\s+● claude 0m\s+0m: v0\.5\.0 waits for CI/);
  assert.match(d, /YOUR INBOX \(1\)[\s\S]*REVIEW\s+from codex \[film\] all supported/);
  assert.match(d, /codex: 0 waiting, running 0\/1 · claude: 1 waiting, running 0\/1 · grok: 0 waiting, running 0\/1 · failed: 0 \(govern task triage\) · dispatcher: not running/);
  assert.match(d, /TOKENS TODAY[\s\S]*film\s+1 runs\s+20k in\s+300 out/);
});

test("dispatch --loop writes its pid for desk and removes it on SIGTERM", async () => {
  const e = env();
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { GOVERN, childEnv } = await import("./helpers.ts");
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "task", "dispatch", "--loop", "--interval", "1"], { env: childEnv(e) });
  const pidf = join(e.root, "queue", "dispatcher.json");
  for (let i = 0; i < 50 && !existsSync(pidf); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(govern(e, ["desk"]).out, /dispatcher: running \(pid \d+/);
  p.kill("SIGTERM");
  await new Promise((r) => p.on("close", r));
  assert.equal(existsSync(pidf), false);
});

test("desk counts grok queue runs and their cost in today's tokens, lists grok beside the other runners and shows an open grok segment", () => {
  const e = env();
  govern(e, ["new", "film", "--kind", "long", "--title", "Film"]);
  govern(e, ["work", "film", "plan"], { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-1" });
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "review", "--summary", "review it"]);
  govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "fine", body: "ok" }) });
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "later", "--summary", "later"]);
  const d = govern(e, ["desk"]).out;
  assert.match(d, /grok: 1 waiting, running 0\/1/);
  assert.match(d, /film\s+long\s+\S+\s+plan\s+.*● grok/);
  assert.match(d, /TOKENS TODAY[\s\S]*film\s+1 runs\s+10k in\s+200 out\s+\$0\.01/);
});
