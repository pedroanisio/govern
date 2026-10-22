import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, jsonl, present, GOVERN, tempDir, parentEnv } from "./helpers.ts";

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

test("gates and stages named after Object.prototype members (constructor, toString, valueOf) start open and unset", () => {
  const e = env();
  write(join(e.root, "PALS-Notes", "processes", "proto.json"), JSON.stringify({
    version: 1, name: "proto", description: "names every object inherits",
    stages: [{ name: "draft" }, { name: "valueOf" }, { name: "done" }],
    gates: [{ name: "constructor", stage: "draft" }, { name: "toString", stage: "valueOf", needs: ["constructor"] }],
  }));
  const n = govern(e, ["new", "p1", "--process", "proto", "--title", "P1"]);
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /approvals: constructor – · toString –/, "new prints the fresh lane's brief");
  for (const args of [["brief", "p1"], ["status", "p1"]]) {
    const r = govern(e, args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    assert.match(r.out, /approvals: constructor – · toString –/, args.join(" "));
  }
  const row = (cmd: string, re: RegExp) => { const r = govern(e, [cmd]); assert.equal(r.code, 0, `${cmd}: ${r.err}`); assert.match(r.out, re, cmd); };
  row("status", /^p1 +proto +1\/3 draft +approvals ··/m);
  row("desk", /^ +p1 +proto +1\/3 draft +needs constructor/m);
  // a lane check on one stage is no check on a stage named like an inherited member
  govern(e, ["cmd", "p1", "smoke", "--", "sh", "-c", "exit 0"]);
  assert.equal(govern(e, ["check", "p1", "--set", "smoke", "--stage", "draft"]).code, 0);
  assert.match(govern(e, ["advance", "p1"]).err, /p1: needs the owner's constructor approval/);
  assert.match(govern(e, ["work", "p1", "valueOf"]).err, /cannot skip stage draft: needs the owner's constructor approval/);
  assert.match(govern(e, ["approve", "p1", "toString", "--quote", "ok"]).err, /needs the constructor approval first/);
  assert.match(govern(e, ["approve", "p1", "constructor", "--quote", "draft ok"]).out, /p1: constructor approved/);
  assert.match(govern(e, ["brief", "p1"]).out, /approvals: constructor ✓ \d{4}-\d{2}-\d{2} · toString –/);
  row("desk", /^ +p1 +proto +1\/3 draft +needs toString/m);
  assert.match(govern(e, ["advance", "p1"]).out, /p1: draft → valueOf \(check smoke ok\)/);
  assert.match(govern(e, ["check", "p1"]).out, /p1: stage valueOf has no check/);
  assert.match(govern(e, ["advance", "p1", "--note", "reviewed"]).err, /p1: needs the owner's toString approval/);
  assert.match(govern(e, ["approve", "p1", "toString", "--quote", "review ok"]).out, /p1: toString approved/);
  assert.match(govern(e, ["advance", "p1", "--note", "reviewed"]).out, /p1: valueOf → done/);
  row("status", /^p1 +proto +3\/3 done +approvals CT/m);
  row("desk", /^ +p1 +proto +3\/3 done +all approved/m);
  const saved = JSON.parse(readFileSync(join(e.projects, "p1", "govern.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.approvals), ["constructor", "toString"]);
  assert.deepEqual(Object.keys(saved.checks), ["draft"]);
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

/** The reason of a Stop hook refusal: Claude Code's JSON block decision on stdout, exit 0. */
const blocked = (r: { code: number | null; out: string; err: string }): string => {
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out) as { decision?: unknown; reason?: unknown };
  assert.equal(j.decision, "block");
  assert.equal(typeof j.reason, "string");
  return j.reason as string;
};

test("the Stop hook keeps a session on its lane until the stage's check passes, at most 3 times", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo boom; exit 1"]);
  govern(e, ["work", "lib", "test"], { CLAUDE_CODE_SESSION_ID: "S1" });
  assert.equal(stop(e, "OTHER").code, 0); // not this session's lane
  const r = stop(e, "S1");
  assert.equal(r.code, 0, r.err);
  const reason = blocked(r);
  assert.match(reason, /lib: stage test is not done — check test failed \(exit 1\)/);
  assert.match(reason, /boom/);
  assert.match(reason, /govern check lib/);
  blocked(stop(e, "S1"));
  blocked(stop(e, "S1"));
  const capped = stop(e, "S1");
  assert.equal(capped.code, 0);
  assert.equal(capped.out, "");
  assert.match(capped.err, /stopped 3 times/);
  assert.equal(ledger(e, "lib").filter((x) => x.kind === "stop-block").length, 3);
  govern(e, ["work", "lib", "test"], { CLAUDE_CODE_SESSION_ID: "S1" }); // a new segment resets the count
  blocked(stop(e, "S1"));
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]);
  assert.equal(stop(e, "S1").out, "");
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
  assert.match(govern(e, ["desk"]).out, /echo: 2 waiting, running 0\/1/);
  const d = govern(e, ["task", "dispatch", "--max", "1"]).out;
  assert.match(d, /→ echo: ACK in \d+s · reply /);
  assert.match(readFileSync(join(e.root, "echo-stdin.txt"), "utf8"), /^You are the "echo" agent of the test queue\./);
  assert.match(readFileSync(join(e.root, "echo-argv.txt"), "utf8"), new RegExp(e.root));
  // a thread that already used maxRuns dispatched runs is stopped and goes to the owner
  const ack = present(govern(e, ["task", "list"]).out.match(/(\S+-owner-\w+) open\s+ACK/)?.[1], "the ACK's id");
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
  const root = tempDir("ws");
  write(join(root, "govern.config.json"), JSON.stringify({ projects: "lanes", queue: "q" }));
  mkdirSync(join(root, "lanes"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  const { CLAUDE_CODE_SESSION_ID: _, ...base } = parentEnv(); // no GOVERN_* says where the workspace is: only the config file
  const env = { ...base, HOME: join(root, "home"), GOVERN_AS: "owner" };
  const run = (args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, ...args], { cwd: join(root, "src", "deep"), env, encoding: "utf8" });
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
  assert.equal(skip.code, 4, "a refusal, like advance's");
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
  assert.equal(r.code, 4);
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
  const blocked = present(govern(e, ["task", "list"]).out.match(/(\S+-owner-\w+) open\s+BLOCKED/)?.[1], "the BLOCKED reply's id");
  const shown = govern(e, ["task", "show", blocked]).out;
  const raw = present(shown.match(/whole reply: (\S+)/)?.[1], "the whole reply's file");
  assert.match(readFileSync(raw, "utf8"), /TAIL-MARKER/);
});

// The rule these tests hold (lib/project.ts, pendingCheckChanges): a swap of a stage's check, or a redefinition or removal
// of a command that is some stage's check, is flagged until the owner accepts it or the lane is finished. A pass does not
// clear it: a gamed check is exactly what produces that pass.
const accepted = "the owner has not accepted it";

test("check --set is ledgered with the stage's effective check; a swap is flagged at every stage, a first check is setup", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  // A swap made before the lane reaches the stage. The first version of this test expected "none → smoke" here, i.e. a
  // `from` taken from the lane's own overrides; the stage's effective check before the change was the process's "test".
  assert.match(govern(e, ["check", "lib", "--set", "smoke", "--stage", "test"]).out, /lib: stage test checked by "smoke"/);
  const sets = ledger(e, "lib").filter((x) => x.kind === "check-set").map(({ stage, from, to }) => ({ stage, from, to }));
  assert.deepEqual(sets, [{ stage: "test", from: "test", to: "smoke" }]);
  const warned = new RegExp(`^⚠ the check of stage test changed and ${accepted}: test → smoke$`, "m");
  assert.match(govern(e, ["brief", "lib"]).out, warned, "shown at every stage, not only the one it checks");
  govern(e, ["cmd", "lib", "smoke", "--", "sh", "-c", "exit 0"]);
  assert.match(govern(e, ["work", "lib", "test"]).out, warned, "shown when the lane arrives");
  assert.equal(govern(e, ["check", "lib"]).code, 0);
  assert.match(govern(e, ["brief", "lib"]).out, warned, "a pass does not clear it");
  govern(e, ["work", "lib", "build"]);
  assert.match(govern(e, ["work", "lib", "test"]).out, warned, "leaving the stage and coming back does not clear it");
  assert.match(govern(e, ["advance", "lib"]).out, /lib: test → review/);
  assert.match(govern(e, ["brief", "lib"]).out, warned, "leaving the stage forward does not clear it");
  govern(e, ["check", "lib", "--set", "other", "--stage", "test"]);
  govern(e, ["check", "lib", "--set", "smoke", "--stage", "test"]);
  assert.match(govern(e, ["brief", "lib"]).out, new RegExp(`^⚠ the check of stage test changed and ${accepted}: test → smoke → other → smoke$`, "m"));

  // A stage with no check at all getting one is setup: ledgered, not flagged. Changing it afterwards is a swap.
  govern(e, ["new", "ops/x", "--kind", "ops"]);
  govern(e, ["check", "ops/x", "--set", "smoke", "--stage", "doing"]);
  assert.deepEqual(ledger(e, "ops/x").filter((x) => x.kind === "check-set").map(({ stage, from, to }) => ({ stage, from, to })), [{ stage: "doing", from: null, to: "smoke" }]);
  assert.doesNotMatch(govern(e, ["work", "ops/x", "doing"]).out, /⚠/);
  govern(e, ["check", "ops/x", "--set", "other", "--stage", "doing"]);
  assert.match(govern(e, ["brief", "ops/x"]).out, new RegExp(`^⚠ the check of stage doing changed and ${accepted}: smoke → other$`, "m"));
});

test("a gamed command stays flagged through its own pass; only the owner's accept clears it, for that stage and what came before", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo 2 failing; exit 1"]);
  govern(e, ["check", "lib", "--set", "test", "--stage", "review"]);
  assert.doesNotMatch(govern(e, ["work", "lib", "test"]).out, /⚠/, "a first definition and a first check are setup");
  assert.equal(govern(e, ["check", "lib"]).code, 1);
  govern(e, ["cmd", "lib", "test", "--", "true"]);
  assert.equal(govern(e, ["check", "lib"]).code, 0, "the gamed check passes");
  const onTest = new RegExp(`^⚠ command "test" behind the check of stage test changed and ${accepted}: sh -c echo 2 failing; exit 1 → true$`, "m");
  const onReview = new RegExp(`^⚠ command "test" behind the check of stage review changed and ${accepted}: sh -c echo 2 failing; exit 1 → true$`, "m");
  assert.match(govern(e, ["brief", "lib"]).out, onTest, "its own pass does not clear it");
  assert.match(govern(e, ["advance", "lib"]).out, /lib: test → review/);
  const b = govern(e, ["brief", "lib"]).out;
  assert.match(b, onTest, "still shown at review");
  assert.match(b, onReview, "the command is the check of every stage that names it");
  assert.match(b, /^only the owner accepts a change: govern check lib <stage> --accept --quote "<the owner's words>"$/m);

  const before = ledger(e, "lib").length;
  const bare = govern(e, ["check", "lib", "test", "--accept"]);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /--quote is required: the owner's own words accepting the change to the check of stage test \(only the owner accepts\)/);
  assert.equal(govern(e, ["check", "lib", "test", "--accept", "--quote", " "]).code, 2, "an empty quote is no quote");
  assert.match(govern(e, ["check", "lib", "--accept", "--quote", "ok"]).err, /stage must be one of: plan, build, test, review, done/);
  assert.equal(ledger(e, "lib").length, before, "a refused accept writes nothing");

  const quote = "true is fine for test while the suite is rebuilt";
  assert.match(govern(e, ["check", "lib", "test", "--accept", "--quote", quote]).out, /^lib: the owner accepted the changes to the check of stage test$/m);
  const acc = ledger(e, "lib").filter((x) => x.kind === "check-accept").map(({ stage, quote }) => ({ stage, quote }));
  assert.deepEqual(acc, [{ stage: "test", quote }]);
  const after = govern(e, ["brief", "lib"]).out;
  assert.doesNotMatch(after, onTest, "accepted for test");
  assert.match(after, onReview, "an accept clears only its own stage");
  assert.match(govern(e, ["check", "lib", "test", "--accept", "--quote", quote]).out, /^lib: stage test has no change to accept — nothing changed$/m);
  assert.equal(ledger(e, "lib").filter((x) => x.kind === "check-accept").length, 1);

  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]);
  const again = govern(e, ["brief", "lib"]).out;
  assert.match(again, new RegExp(`^⚠ command "test" behind the check of stage test changed and ${accepted}: true → sh -c exit 0$`, "m"), "a later change is flagged again, from where the accept left it");
  assert.match(again, new RegExp(`^⚠ command "test" behind the check of stage review changed and ${accepted}: sh -c echo 2 failing; exit 1 → true → sh -c exit 0$`, "m"));

  assert.match(govern(e, ["advance", "lib"]).out, /lib: review → done/);
  assert.match(govern(e, ["advance", "lib", "--note", "released"]).out, /lane finished/);
  assert.doesNotMatch(govern(e, ["brief", "lib"]).out, /⚠|only the owner accepts/, "a finished lane shows no warning");
});

test("the advance entry says what passed the stage, the check or a note, with the note's words", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["advance", "lib", "--note", "plan agreed in PLAN.md"]);
  govern(e, ["advance", "lib", "--note", "builds"]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]);
  govern(e, ["advance", "lib", "--note", "suite green"]);
  govern(e, ["advance", "lib", "--note", "reviewed"]);
  govern(e, ["advance", "lib", "--note", "released"]);
  const adv = ledger(e, "lib").filter((x) => x.kind === "advance").map(({ from, to, authority, note, check }) => ({ from, to, authority, note, check }));
  assert.deepEqual(adv, [
    { from: "plan", to: "build", authority: "note", note: "plan agreed in PLAN.md", check: undefined },
    { from: "build", to: "test", authority: "note", note: "builds", check: undefined },
    { from: "test", to: "review", authority: "check", note: "suite green", check: "test" },
    { from: "review", to: "done", authority: "note", note: "reviewed", check: undefined },
    { from: "done", to: "finished", authority: "note", note: "released", check: undefined },
  ]);
  govern(e, ["new", "lib2", "--process", "dev"]);
  govern(e, ["cmd", "lib2", "test", "--", "sh", "-c", "exit 0"]);
  govern(e, ["work", "lib2", "test"]);
  govern(e, ["advance", "lib2"]);
  const last = ledger(e, "lib2").filter((x) => x.kind === "advance").pop();
  assert.equal(last?.authority, "check");
  assert.ok(!("note" in last!), "no note given, none recorded");
});

test("a stage that requires a check cannot be passed on a note or skipped while it has none", () => {
  const e = env();
  write(join(e.root, "PALS-Notes", "processes", "strict.json"), JSON.stringify({
    version: 1, name: "strict", description: "a verified stage",
    stages: [{ name: "draft" }, { name: "verify", requires: "check" }, { name: "out" }],
  }));
  assert.match(govern(e, ["process", "show", "strict"]).out, /2 verify\s+requires a check/);
  assert.match(govern(e, ["process", "show", "dev"]).out, /3 test\s+.*check: command "test"\s+requires a check/);
  govern(e, ["new", "s", "--process", "strict"]);
  const skip = govern(e, ["work", "s", "out"]);
  assert.equal(skip.code, 4);
  assert.match(skip.err, /s: cannot skip stage verify: it requires a check and has none \(set one: govern check s --set <command> --stage verify\)/);
  assert.match(govern(e, ["advance", "s", "--note", "drafted"]).out, /s: draft → verify/);
  const r = govern(e, ["advance", "s", "--note", "looks fine to me"]);
  assert.equal(r.code, 4);
  assert.match(r.err, /s: stage verify requires a check and has none: a note cannot pass it \(set one: govern check s --set <command> --stage verify\)/);
  assert.match(govern(e, ["status"]).out, /s\s+strict\s+2\/3 verify/);
  govern(e, ["cmd", "s", "ok", "--", "sh", "-c", "exit 0"]);
  govern(e, ["check", "s", "--set", "ok", "--stage", "verify"]);
  assert.match(govern(e, ["advance", "s"]).out, /s: verify → out \(check ok ok\)/);
  assert.equal(ledger(e, "s").filter((x) => x.kind === "advance").pop()?.authority, "check");
});

test("a process whose stage requires anything but a check is refused, naming the file and stage", () => {
  const e = env();
  const f = write(join(e.root, "PALS-Notes", "processes", "loose.json"), JSON.stringify({
    version: 1, name: "loose", stages: [{ name: "a" }, { name: "b", requires: "note" }],
  }));
  const r = govern(e, ["process", "list"]);
  assert.equal(r.code, 4);
  assert.ok(r.err.includes(`${f}: stage b: requires must be "check" (got "note")`), r.err);
});

test("cmd set and rm are in the ledger with the stages they check; redefining or removing a check's command is flagged, defining it is not", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["work", "lib", "test"]);
  assert.match(govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "echo 2 failing; exit 1"]).out, /lib: test = sh -c echo 2 failing; exit 1/);
  assert.doesNotMatch(govern(e, ["brief", "lib"]).out, /⚠/, "defining the command behind a check is setup");
  assert.equal(govern(e, ["check", "lib"]).code, 1);
  // the swap: the check still names "test", and "test" now passes whatever the code does
  govern(e, ["cmd", "lib", "test", "--timeout", "5", "--", "true"]);
  assert.match(govern(e, ["brief", "lib"]).out, new RegExp(`^⚠ command "test" behind the check of stage test changed and ${accepted}: sh -c echo 2 failing; exit 1 → true \\(timeout 5s\\)$`, "m"));
  assert.match(govern(e, ["cmd", "lib", "--rm", "test"]).out, /lib: removed command test/);
  assert.match(govern(e, ["brief", "lib"]).out, /: sh -c echo 2 failing; exit 1 → true \(timeout 5s\) → \(removed\)$/m);
  govern(e, ["cmd", "lib", "lint", "--", "true"]);
  govern(e, ["cmd", "lib", "lint", "--", "false"]);
  assert.doesNotMatch(govern(e, ["brief", "lib"]).out, /command "lint"/, "a command no stage checks is ledgered, not flagged");
  const cmds = ledger(e, "lib").filter((x) => String(x.kind).startsWith("cmd-")).map(({ kind, name, from, to, stages }) => ({ kind, name, from, to, stages }));
  assert.deepEqual(cmds, [
    { kind: "cmd-set", name: "test", from: null, to: ["sh", "-c", "echo 2 failing; exit 1"], stages: ["test"] },
    { kind: "cmd-set", name: "test", from: ["sh", "-c", "echo 2 failing; exit 1"], to: { argv: ["true"], timeout: 5 }, stages: ["test"] },
    { kind: "cmd-rm", name: "test", from: { argv: ["true"], timeout: 5 }, to: undefined, stages: ["test"] },
    { kind: "cmd-set", name: "lint", from: null, to: ["true"], stages: [] },
    { kind: "cmd-set", name: "lint", from: ["true"], to: ["false"], stages: [] },
  ]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]);
  assert.match(govern(e, ["brief", "lib"]).out, /: sh -c echo 2 failing; exit 1 → true \(timeout 5s\) → \(removed\) → sh -c exit 0$/m, "defining it again after a removal does not end the warning");

  // a redefinition is flagged whatever stage the lane is at
  govern(e, ["new", "lib2", "--process", "dev"]);
  govern(e, ["cmd", "lib2", "test", "--", "true"]);
  assert.doesNotMatch(govern(e, ["brief", "lib2"]).out, /⚠/);
  govern(e, ["cmd", "lib2", "test", "--", "sh", "-c", "exit 0"]);
  assert.match(govern(e, ["brief", "lib2"]).out, new RegExp(`stage 1/5 plan[\\s\\S]*^⚠ command "test" behind the check of stage test changed and ${accepted}: true → sh -c exit 0$`, "m"));
  // the command behind a check the lane set itself
  govern(e, ["check", "lib2", "--set", "smoke", "--stage", "review"]);
  govern(e, ["cmd", "lib2", "smoke", "--", "sh", "-c", "exit 0"]);
  assert.doesNotMatch(govern(e, ["brief", "lib2"]).out, /stage review/, "a first check and its first command are setup");
  govern(e, ["cmd", "lib2", "smoke", "--", "true"]);
  assert.match(govern(e, ["brief", "lib2"]).out, new RegExp(`^⚠ command "smoke" behind the check of stage review changed and ${accepted}: sh -c exit 0 → true$`, "m"));
});

test("setting a check or a command to what it already is changes nothing: no ledger entry, no warning", () => {
  const e = env();
  govern(e, ["new", "lib", "--process", "dev"]);
  govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]);
  govern(e, ["work", "lib", "test"]);
  assert.equal(govern(e, ["check", "lib"]).code, 0);
  const before = ledger(e, "lib").length;
  const same = govern(e, ["check", "lib", "--set", "test", "--stage", "test"]);
  assert.equal(same.code, 0);
  assert.match(same.out, /^lib: stage test is already checked by "test" — nothing changed$/m, "the process's own check");
  assert.equal(JSON.parse(readFileSync(join(e.projects, "lib", "govern.json"), "utf8")).checks, undefined);
  assert.match(govern(e, ["cmd", "lib", "test", "--", "sh", "-c", "exit 0"]).out, /^lib: test is already sh -c exit 0 — nothing changed$/m);
  assert.match(govern(e, ["cmd", "lib", "--rm", "nope"]).out, /^lib: no command nope — nothing changed$/m);
  assert.equal(ledger(e, "lib").length, before, "no entry for a change that is none");
  assert.doesNotMatch(govern(e, ["brief", "lib"]).out, /⚠/);

  govern(e, ["check", "lib", "--set", "lint", "--stage", "review"]);
  assert.match(govern(e, ["check", "lib", "--set", "lint", "--stage", "review"]).out, /stage review is already checked by "lint" — nothing changed/, "the lane's own check");
  govern(e, ["cmd", "lib", "slow", "--timeout", "5", "--", "true"]);
  assert.match(govern(e, ["cmd", "lib", "slow", "--timeout", "5", "--", "true"]).out, /^lib: slow is already true \(timeout 5s\) — nothing changed$/m);
  assert.match(govern(e, ["cmd", "lib", "slow", "--", "true"]).out, /^lib: slow = true$/m, "the same argv with another timeout is a change");
  const changes = ledger(e, "lib").slice(before).map(({ kind, to }) => ({ kind, to }));
  assert.deepEqual(changes, [
    { kind: "check-set", to: "lint" },
    { kind: "cmd-set", to: { argv: ["true"], timeout: 5 } },
    { kind: "cmd-set", to: ["true"] },
  ]);
});
