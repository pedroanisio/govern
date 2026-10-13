import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnv, govern, write, jsonl, GOVERN } from "./helpers.ts";

const env = () => { const e = makeEnv(); e.env.GOVERN_QUEUE = join(e.root, "queue"); return e; };
const ledger = (e: ReturnType<typeof makeEnv>, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const stop = (e: ReturnType<typeof makeEnv>, session: string) => govern(e, ["hook", "stop"], {}, JSON.stringify({ session_id: session, stop_hook_active: false, hook_event_name: "Stop" }));

test("process list and show describe the built-in processes", () => {
  const e = env();
  const l = govern(e, ["process", "list"]).out;
  assert.match(l, /^video\s+.*plan → script → script-check/m);
  assert.match(l, /^ops\s+.*plan → doing → review → done/m);
  assert.match(l, /^dev\s+.*plan → build → test → review → done/m);
  const s = govern(e, ["process", "show", "dev"]).out;
  assert.match(s, /3 test\s+exit: .*check: command "test"/);
  assert.match(govern(e, ["process", "show", "nope"]).err, /no process "nope" \(have: .*dev.*\)/);
});

test("a lane can follow any process, including one defined in the workspace", () => {
  const e = env();
  write(join(e.root, "PALS-Notes", "processes", "research.json"), JSON.stringify({
    version: 1, name: "research", description: "question to sourced answer",
    stages: [{ name: "gather", exit: "every claim has a source" }, { name: "draft", check: "lint" }, { name: "published" }],
    gates: [{ name: "signoff", stage: "draft" }],
  }));
  assert.match(govern(e, ["process", "list"]).out, /^research\s+question to sourced answer/m);
  assert.equal(govern(e, ["new", "q1", "--process", "research", "--title", "Q1"]).code, 0);
  const b = govern(e, ["brief", "q1"]).out;
  assert.match(b, /process research · stage 1\/3 gather/);
  assert.match(b, /exit when: every claim has a source/);
  assert.match(b, /approvals: signoff –/);
  assert.match(govern(e, ["work", "q1", "plan"]).err, /stage must be one of: gather, draft, published/);
  assert.match(govern(e, ["approve", "q1", "script", "--quote", "ok"]).err, /gate must be one of signoff/);
  assert.match(govern(e, ["new", "q2", "--process", "nope"]).err, /no process "nope"/);
  // the old forms keep working
  assert.equal(govern(e, ["new", "film", "--kind", "long"]).code, 0);
  assert.match(govern(e, ["brief", "film"]).out, /kind long · lang en · stage 1\/8 plan/);
  assert.match(govern(e, ["new", "x", "--process", "video"]).err, /--kind must be long or short/);
});

test("check runs the stage's exit check; advance needs the check, the gate or the evidence", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev", "--title", "A library"]);
  assert.match(govern(e, ["check", "lib"]).out, /stage plan has no check/);
  assert.match(govern(e, ["advance", "lib"]).err, /stage plan has no check: give the evidence with --note/);
  assert.match(govern(e, ["advance", "lib", "--note", "plan agreed in PLAN.md"]).out, /lib: plan → build/);
  govern(e, ["advance", "lib", "--note", "builds"]);
  assert.match(govern(e, ["brief", "lib"]).out, /stage 3\/5 test[\s\S]*check: command "test" \(not set: govern cmd lib test -- …\)/);
  assert.match(govern(e, ["check", "lib"]).err, /no command "test"/);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo 2 failing; exit 1"]);
  const c = govern(e, ["check", "lib"]);
  assert.equal(c.code, 1);
  assert.match(c.out, /check test: failed \(exit 1\)[\s\S]*2 failing/);
  assert.match(govern(e, ["advance", "lib"]).err, /check test failed \(exit 1\)/);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo all pass"]);
  assert.equal(govern(e, ["check", "lib"]).code, 0);
  assert.match(govern(e, ["advance", "lib"]).out, /lib: test → review \(check test ok\)/);
  const checks = ledger(e, "lib").filter((x) => x.kind === "check");
  assert.deepEqual(checks.map((x) => x.ok), [false, false, true, true]);
  assert.ok(ledger(e, "lib").some((x) => x.kind === "advance" && x.from === "test" && x.to === "review"));
  govern(e, ["advance", "lib", "--note", "reviewed"]);
  assert.match(govern(e, ["advance", "lib", "--note", "released"]).out, /lib: done was the last stage — lane finished/);
  assert.match(govern(e, ["status"]).out, /lib\s+dev\s+5\/5 done\s+finished/);
});

test("a lane can set its own check for any stage; gates hold advance", () => {
  const e = env();
  govern(e, ["new", "ops/x", "--kind", "ops"]);
  govern(e, ["cmd", "ops/x", "smoke", "--", "sh", "-c", "exit 0"]);
  assert.match(govern(e, ["check", "ops/x", "--set", "smoke", "--stage", "doing"]).out, /ops\/x: stage doing checked by "smoke"/);
  govern(e, ["work", "ops/x", "doing"]);
  assert.match(govern(e, ["check", "ops/x"]).out, /check smoke: ok/);
  govern(e, ["new", "film", "--kind", "long"]);
  govern(e, ["work", "film", "script-check"]);
  assert.match(govern(e, ["advance", "film", "--note", "checked"]).err, /needs the owner's script approval \(govern approve film script --quote "…"\)/);
  govern(e, ["approve", "film", "script", "--quote", "script ok"]);
  assert.match(govern(e, ["advance", "film", "--note", "checked"]).out, /film: script-check → sound/);
  assert.match(govern(e, ["approve", "film", "publish", "--quote", "go"]).err, /no final-cut approval recorded yet/);
});

test("the Stop hook keeps a session on its lane until the stage's check passes, at most 3 times", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo boom; exit 1"]);
  govern(e, ["work", "lib", "test"], { CLAUDE_CODE_SESSION_ID: "S1" });
  assert.equal(stop(e, "OTHER").code, 0); // not this session's lane
  const r = stop(e, "S1");
  assert.equal(r.code, 2);
  assert.match(r.err, /lib: stage test is not done — check test failed \(exit 1\)/);
  assert.match(r.err, /boom/);
  assert.match(r.err, /govern check lib/);
  assert.equal(stop(e, "S1").code, 2);
  assert.equal(stop(e, "S1").code, 2);
  const capped = stop(e, "S1");
  assert.equal(capped.code, 0);
  assert.match(capped.err, /stopped 3 times/);
  assert.equal(ledger(e, "lib").filter((x) => x.kind === "stop-block").length, 3);
  govern(e, ["work", "lib", "test"], { CLAUDE_CODE_SESSION_ID: "S1" }); // a new segment resets the count
  assert.equal(stop(e, "S1").code, 2);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]);
  assert.equal(stop(e, "S1").code, 0);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 1"]);
  govern(e, ["done", "lib"], { CLAUDE_CODE_SESSION_ID: "S1" });
  assert.equal(stop(e, "S1").code, 0); // segment closed
  govern(e, ["work", "lib", "plan"], { CLAUDE_CODE_SESSION_ID: "S1" });
  assert.equal(stop(e, "S1").code, 0); // plan has no check
  assert.equal(govern(e, ["hook", "stop"], {}, "not json").code, 0); // never blocks on its own errors
});

test("lanes can wait on other lanes; status, desk, brief and advance show it", () => {
  const e = env();
  govern(e, ["new", "film", "--kind", "long"]);
  govern(e, ["new", "ops/engine", "--kind", "ops"]);
  govern(e, ["new", "lib", "--process", "dev"]);
  assert.match(govern(e, ["dep", "film", "--after", "ops/engine:review"]).out, /film: after ops\/engine:review/);
  assert.match(govern(e, ["dep", "film", "--after", "lib"]).out, /film: after ops\/engine:review, lib/);
  assert.match(govern(e, ["dep", "film", "--after", "nope"]).err, /missing nope|no govern.json/);
  assert.match(govern(e, ["status"]).out, /film\s.*blocked by ops\/engine:review, lib/);
  assert.match(govern(e, ["desk"]).out, /film\s.*blocked by ops\/engine:review, lib/);
  assert.match(govern(e, ["brief", "film"]).out, /after: ops\/engine:review \(waiting\) · lib \(waiting\)/);
  assert.match(govern(e, ["advance", "film", "--note", "x"]).err, /film is blocked by ops\/engine:review, lib/);
  govern(e, ["work", "ops/engine", "done"]);
  assert.match(govern(e, ["status"]).out, /film\s.*blocked by lib$/m);
  govern(e, ["dep", "film", "--rm", "lib"]);
  assert.match(govern(e, ["status"]).out, /film\s.*ready$/m);
  assert.doesNotMatch(govern(e, ["status"]).out, /lib\s.*(ready|blocked)/);
  assert.match(govern(e, ["advance", "film", "--note", "planned"]).out, /film: plan → script/);
});

test("a runner named in the queue config is dispatched like codex and claude; threads stop at maxRuns", () => {
  const e = env();
  const bin = write(join(e.root, "echo-agent.sh"), `#!/bin/sh\ncat > ${join(e.root, "echo-stdin.txt")}\necho "$1" > ${join(e.root, "echo-argv.txt")}\nprintf '%s' '{"kind":"ACK","summary":"done by echo","body":"ok"}'\n`);
  chmodSync(bin, 0o755);
  write(join(e.root, "queue", "config.json"), JSON.stringify({ name: "the test queue", maxRuns: 2, runners: { echo: { argv: [bin, "{dir}"], format: "text" } } }));
  assert.match(govern(e, ["task", "send", "--to", "echo", "--project", "film", "--task", "t", "--summary", "do it"]).out, /queued \S+-echo-\w+ \(TASK to echo\)/);
  assert.doesNotMatch(govern(e, ["task", "send", "--to", "echo", "--project", "film", "--task", "t2", "--summary", "x"]).out, /sessions are not woken/);
  assert.match(govern(e, ["desk"]).out, /echo: 2 waiting, 0 running/);
  const d = govern(e, ["task", "dispatch", "--max", "1"]).out;
  assert.match(d, /→ echo: ACK in \d+s · reply /);
  assert.match(readFileSync(join(e.root, "echo-stdin.txt"), "utf8"), /^You are the "echo" agent of the test queue\./);
  assert.match(readFileSync(join(e.root, "echo-argv.txt"), "utf8"), new RegExp(e.root));
  // a thread that already used maxRuns dispatched runs is stopped and goes to the owner
  const ack = govern(e, ["task", "list"]).out.match(/(\S+-owner-\w+) open\s+ACK/)![1];
  const back = govern(e, ["task", "reply", ack, "--kind", "DECISION", "--summary", "again", "--body", "b"]);
  assert.equal(back.code, 0, back.err);
  const q = JSON.parse(readFileSync(join(e.root, "queue", "config.json"), "utf8")); q.maxRuns = 1;
  write(join(e.root, "queue", "config.json"), JSON.stringify(q));
  const d2 = govern(e, ["task", "dispatch"]).out;
  assert.match(d2, /stopped: thread already ran 1 time \(maxRuns 1\)/);
  assert.match(govern(e, ["task", "list"]).out, /BLOCKED\s+dispatcher→owner \[film\/t\] thread reached maxRuns 1/);
});

test("the prompt names the queue generically when no config names it", () => {
  const e = env();
  const bin = write(join(e.root, "echo-agent.sh"), `#!/bin/sh\ncat > ${join(e.root, "echo-stdin.txt")}\nprintf '%s' '{"kind":"ACK","summary":"s","body":"b"}'\n`);
  chmodSync(bin, 0o755);
  write(join(e.root, "queue", "config.json"), JSON.stringify({ runners: { echo: { argv: [bin], format: "text" } } }));
  govern(e, ["task", "send", "--to", "echo", "--project", "p", "--task", "t", "--summary", "s"]);
  govern(e, ["task", "dispatch"]);
  assert.match(readFileSync(join(e.root, "echo-stdin.txt"), "utf8"), /^You are the "echo" agent of the govern task queue\./);
});

test("a govern.config.json above the working directory makes any folder a govern workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "govern-ws-"));
  write(join(root, "govern.config.json"), JSON.stringify({ projects: "lanes", queue: "q" }));
  mkdirSync(join(root, "lanes"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  const { GOVERN_REPO: _a, GOVERN_PROJECTS: _b, GOVERN_QUEUE: _c, GOVERN_PROCESSES: _d, CLAUDE_CODE_SESSION_ID: _e, ...base } = process.env;
  const run = (args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, ...args], { cwd: join(root, "src", "deep"), env: { ...base, GOVERN_AS: "owner" }, encoding: "utf8" });
  assert.equal(run(["new", "api", "--process", "dev"]).status, 0);
  assert.match(readFileSync(join(root, "lanes", "api", "govern.json"), "utf8"), /"process": "dev"/);
  assert.equal(run(["task", "send", "--to", "owner", "--project", "api", "--task", "t", "--summary", "hello"]).status, 0);
  assert.match(run(["task", "list"]).stdout, /owner/);
  assert.equal(spawnSync("sh", ["-c", `ls ${join(root, "q", "open")} | wc -l`], { encoding: "utf8" }).stdout.trim(), "1");
});

test("work can move a lane forward only past stages whose check, gate and dependencies allow it", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo 1 failing; exit 1"]);
  const skip = govern(e, ["work", "lib", "review"]);
  assert.equal(skip.code, 2, "a refusal, like advance's");
  assert.match(skip.err, /lib: cannot skip stage test: check test failed \(exit 1\)[\s\S]*1 failing[\s\S]*govern advance lib/);
  assert.match(govern(e, ["status"]).out, /lib\s+dev\s+1\/5 plan/);
  assert.match(govern(e, ["work", "lib", "test"]).out, /stage 3\/5 test/);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo all pass"]);
  assert.match(govern(e, ["work", "lib", "review"]).out, /stage 4\/5 review/);
  assert.ok(ledger(e, "lib").some((x) => x.kind === "check" && x.stage === "test" && x.ok));
  assert.match(govern(e, ["work", "lib", "plan"]).out, /stage 1\/5 plan/, "going back to rework a stage is always allowed");

  govern(e, ["new", "film", "--kind", "long"]);
  assert.match(govern(e, ["work", "film", "sound"]).err, /film: cannot skip stage script-check: needs the owner's script approval/);
  govern(e, ["approve", "film", "script", "--quote", "script ok"]);
  assert.match(govern(e, ["work", "film", "sound"]).out, /stage 4\/8 sound/);

  govern(e, ["new", "ops/engine", "--kind", "ops"]);
  govern(e, ["dep", "lib", "--after", "ops/engine"]);
  assert.match(govern(e, ["work", "lib", "build"]).err, /lib is blocked by ops\/engine/);
  assert.match(govern(e, ["work", "lib", "plan"]).out, /stage 1\/5 plan/);
});

test("dependencies cannot form a cycle", () => {
  const e = env();
  for (const s of ["a", "b", "c"]) govern(e, ["new", s, "--process", "dev"]);
  govern(e, ["dep", "a", "--after", "b:review"]);
  govern(e, ["dep", "b", "--after", "c"]);
  const r = govern(e, ["dep", "c", "--after", "a"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /c cannot wait on a: a → b → c already waits the other way/);
  assert.match(govern(e, ["dep", "c"]).out, /c: no dependencies/);
});

test("the prompt states the reply limits, and a reply that fails verification is kept whole", () => {
  const e = env();
  const long = "x".repeat(300), tail = "y".repeat(6000) + " TAIL-MARKER";
  const bin = write(join(e.root, "echo-agent.sh"), `#!/bin/sh\ncat > ${join(e.root, "echo-stdin.txt")}\nprintf '%s' '{"kind":"REVIEW","summary":"${long}","body":"${tail}"}'\n`);
  chmodSync(bin, 0o755);
  write(join(e.root, "queue", "config.json"), JSON.stringify({ runners: { echo: { argv: [bin], format: "text" } } }));
  govern(e, ["task", "send", "--to", "echo", "--project", "p", "--task", "t", "--summary", "s"]);
  govern(e, ["task", "dispatch"]);
  assert.match(readFileSync(join(e.root, "echo-stdin.txt"), "utf8"), /"summary": one line of at most 200 characters/);
  const blocked = govern(e, ["task", "list"]).out.match(/(\S+-owner-\w+) open\s+BLOCKED/)![1];
  const shown = govern(e, ["task", "show", blocked]).out;
  const raw = shown.match(/whole reply: (\S+)/)![1];
  assert.match(readFileSync(raw, "utf8"), /TAIL-MARKER/);
});
