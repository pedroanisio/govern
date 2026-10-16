import { test } from "node:test";
import { grokResult } from "../lib/queue.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, childEnv, jsonl, write, reply, present, HERE, tempDir, setConfig } from "./helpers.ts";

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  require("node:fs").chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_ARGV_OUT: join(e.root, "claude.log") });
  return e;
}
const answer = { kind: "REVIEW", summary: "two claims unsupported", body: "Claim 3 and 7 have no source." };

test("dispatch caps inlined files at GOVERN_QUEUE_MAX_INLINE chars and refuses a value that is not a whole number", () => {
  const e = env();
  write(join(e.root, "notes", "claims.md"), "CLAIM-TEXT-123 and more");
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check the claims", "--file", "notes/claims.md"]);
  const bad = govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer), GOVERN_QUEUE_MAX_INLINE: "lots" });
  assert.notEqual(bad.code, 0);
  assert.match(bad.err + bad.out, /GOVERN_QUEUE_MAX_INLINE must be a whole number of characters/);
  assert.equal(existsSync(join(e.root, "stdin.log")), false, "no model call");
  assert.equal(readdirSync(join(e.root, "queue", "open")).filter((f) => f.endsWith(".json")).length, 1, "the message is not claimed: it stays open for the next dispatch");
  const r = govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer), GOVERN_QUEUE_MAX_INLINE: "5" });
  assert.equal(r.code, 0, r.err);
  const prompt = JSON.parse(present(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[0], "the prompt sent"));
  assert.match(prompt, /<file path="notes\/claims\.md" truncated="18 chars">\nCLAIM\n<\/file>/);
});

test("send validates and queues a message as a file in open/", () => {
  const e = env();
  assert.match(govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--kind", "NOPE", "--summary", "x"]).err, /--kind must be one of/);
  assert.match(govern(e, ["task", "send", "--to", "Codex!", "--project", "film", "--task", "check", "--summary", "x"]).err, /--to must be lowercase/);
  assert.match(govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "x", "--file", "nope.md"]).err, /--file not found/);
  const r = govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check the claims", "--body", "please"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued \S+-codex-\w+ \(TASK to codex\)/);
  assert.match(govern(e, ["task", "list", "--state", "open"]).out, /open\s+TASK\s+owner→codex \[film\/check\] check the claims/);
});

test("dispatch runs codex once per message, files the verified reply to the sender and closes the original", () => {
  const e = env();
  write(join(e.root, "notes", "claims.md"), "CLAIM-TEXT-123");
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check the claims", "--body", "BODY-XYZ", "--file", "notes/claims.md"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ codex: REVIEW in \d+s, 20k in \(60% cached\), 300 out · reply /);
  const prompt = JSON.parse(present(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[0], "the prompt sent"));
  assert.match(prompt, /BODY-XYZ/);
  assert.match(prompt, /CLAIM-TEXT-123/);
  assert.match(prompt, /this task is read-only/);
  const argv = jsonl(join(e.root, "argv.log"))[0];
  assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
  assert.ok(argv.includes("--output-schema"));
  const list = govern(e, ["task", "list"]).out;
  assert.match(list, /done\s+TASK\s+owner→codex/);
  assert.match(list, /open\s+REVIEW\s+codex→owner \[film\/check\] two claims unsupported/);
  const ledger = jsonl(join(e.root, "queue", "ledger.jsonl"));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].ok, true);
  assert.equal(ledger[0].usage.input, 20000);
  // the owner's reply is not run by the dispatcher
  assert.equal(govern(e, ["task", "dispatch"]).out.trim(), "");
});

test("an unverified reply fails the message and the sender gets a BLOCKED notice, not the text as an answer", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "bad", "Sure, the claims look fine!") });
  assert.match(r.out, /FAILED/);
  const list = govern(e, ["task", "list"]).out;
  assert.match(list, /failed\s+TASK/);
  assert.match(list, /open\s+BLOCKED\s+dispatcher→owner \[film\/check\] codex reply failed verification/);
  const id = present(list.split("\n").find((l) => /BLOCKED/.test(l))?.split(" ")[0], "the BLOCKED reply's id");
  assert.match(govern(e, ["task", "show", id]).out, /reply is not JSON[\s\S]*whole reply: .*\.reply\.txt/);
});

test("dispatch runs claude -p with read-only tools, outside this session's env, and reads its usage", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "claude", "--project", "film", "--task", "review", "--summary", "review the hook"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: JSON.stringify({ kind: "ACK", summary: "looks right", body: "ok" }), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ claude: ACK in \d+s, 10k in \(90% cached\), 200 out, \$0\.012/);
  const call = jsonl(join(e.root, "claude.log"))[0];
  assert.equal(call.nested, false);
  assert.deepEqual(call.argv.slice(0, 5), ["-p", "--output-format", "json", "--model", "sonnet"]);
  assert.deepEqual(call.argv.slice(5), ["--json-schema", readFileSync(join(HERE, "..", "schemas", "queue-reply.json"), "utf8"), "--allowedTools", "Read", "Grep", "Glob", "--tools", "Read", "Grep", "Glob", "--disallowedTools", "Agent", "Bash", "Edit", "NotebookEdit", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write", "--setting-sources", "", "--strict-mcp-config"], "sealed to the claude-read profile");
});

const GROK_TOGGLES = ["CLAUDE", "CURSOR"].flatMap((v) => ["AGENTS", "HOOKS", "MCPS", "RULES", "SKILLS"].map((k) => `GROK_${v}_${k}_ENABLED`));
const privateHome = (e: ReturnType<typeof env>) => join(e.env.XDG_STATE_HOME!, "govern", "grok-home");
const realAuth = (e: ReturnType<typeof env>) => write(join(e.env.HOME!, ".grok", "auth.json"), "DUMMY-NOT-A-TOKEN");

test("dispatch runs grok --prompt-file sealed to grok-read: private HOME and a private GROK_HOME holding only the login, every loader off, cost and cache read from its json", () => {
  const e = env();
  realAuth(e);
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "review", "--summary", "review the hook", "--body", "BODY-GROK"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "looks right", body: "ok" }), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", GROK_CONFIG: "/x/evil.toml", GROK_CONFIG_PATH: "/x/evil2.toml" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ grok: ACK in \d+s, 10k in \(90% cached\), 200 out, \$0\.012/);
  const call = jsonl(join(e.root, "grok.log"))[0];
  assert.equal(call.argv[0], "--prompt-file");
  assert.deepEqual(call.argv.slice(2), ["--output-format", "streaming-messages-json", "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--deny", "MCPTool(*)", "--deny", "Read(**/auth.json)", "--max-turns", "25", "--cwd", call.cwd], "sealed to the grok-read profile");
  assert.match(call.prompt, /BODY-GROK/);
  for (const k of GROK_TOGGLES) assert.equal(call.env[k], "0", k);
  assert.equal(call.env.GROK_MEMORY, "0");
  assert.equal(call.env.GROK_CONFIG, null, "a config pointed at by the parent is not followed");
  assert.equal(call.env.GROK_CONFIG_PATH, null);
  assert.equal(call.env.CLAUDECODE, null, "the child does not think it runs inside this Claude Code session");
  assert.equal(call.env.GROK_HOME, privateHome(e), "a govern-owned GROK_HOME, not the user's: its config, plugins and MCP servers are not found");
  assert.notEqual(call.env.GROK_HOME, join(e.env.HOME!, ".grok"));
  assert.deepEqual(call.homeInfo.files, ["auth.json", "config.toml"], "only the login and a minimal config");
  assert.equal(call.homeInfo.authIsLink, true, "the login is linked, so a refresh by in-place write reaches the real file");
  assert.equal(call.homeInfo.authTarget, join(e.env.HOME!, ".grok", "auth.json"));
  assert.match(call.homeInfo.config, /\[compat\.claude\][^[]*mcps = false/);
  assert.notEqual(call.env.HOME, e.env.HOME, "a private HOME hides the user's skills, plugins and Claude settings");
  assert.equal(call.homeExists, true);
  assert.equal(existsSync(call.env.HOME), false, "the private HOME is removed after the run");
  assert.equal(existsSync(privateHome(e)), true, "the private GROK_HOME persists (grok keeps its sessions there)");
  const ledger = jsonl(join(e.root, "queue", "ledger.jsonl"))[0];
  assert.equal(ledger.agent, "grok");
  assert.equal(ledger.profile, "grok-read");
  assert.equal(ledger.usage.input, 10000);
  assert.equal(ledger.usage.cached, 9000);
  assert.equal(ledger.usage.costUsd, 0.0123);
});

test("GOVERN_GROK_HOME relocates the private GROK_HOME, and --max-turns follows GOVERN_GROK_MAX_TURNS", () => {
  const e = env();
  realAuth(e);
  const where = join(e.root, "my-grok-home");
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", "s"]);
  assert.equal(govern(e, ["task", "dispatch"], { GOVERN_GROK_HOME: where, GOVERN_GROK_MAX_TURNS: "7", FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "s", body: "b" }) }).code, 0);
  const call = jsonl(join(e.root, "grok.log"))[0];
  assert.equal(call.env.GROK_HOME, where);
  assert.equal(call.argv[call.argv.indexOf("--max-turns") + 1], "7");
});

test("the private GROK_HOME is closed to the world and re-pointed at the real login each run; a login that grok replaced by rename is copied back, never left stale", () => {
  const e = env();
  const real = realAuth(e);
  const send = () => govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", "s"]);
  send();
  assert.equal(govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "s", body: "b" }), FAKE_GROK_REFRESH: "1" }).code, 0);
  assert.equal(statSync(privateHome(e)).mode & 0o777, 0o700);
  assert.equal(readFileSync(real, "utf8"), "REFRESHED-DUMMY", "the refreshed login reached the real auth file");
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(privateHome(e), "auth.json")).isSymbolicLink(), true, "and the link is back for the next run");
  send();
  govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "s", body: "b" }) });
  assert.equal(jsonl(join(e.root, "grok.log"))[1].homeInfo.authIsLink, true);
});

test("a grok run with no login file still runs sealed: the private home holds the config only and grok reports its own error", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", "s"]);
  govern(e, ["task", "dispatch"], { FAKE_GROK_ERRJSON: "not logged in" });
  assert.deepEqual(jsonl(join(e.root, "grok.log"))[0].homeInfo.files, ["config.toml"]);
});

const budget = (e: ReturnType<typeof env>) => {
  e.env.GOVERN_STATE = join(e.root, "state");
  setConfig(e, { allowances: [{ name: "gb", consumer: "profile:grok-read", unit: "model-usd", limit: 10, taskEstimate: 2 }] });
  return () => (existsSync(join(e.root, "state", "allowances", "gb", "spent.jsonl")) ? jsonl(join(e.root, "state", "allowances", "gb", "spent.jsonl")) : []);
};

test("a grok run whose usage is missing or incomplete settles as reserved, never as 0, and records no zero usage; a complete run settles at its own cost", () => {
  for (const [name, mode, extra] of [["omitted", "1", {}], ["incomplete", "incomplete", {}]] as const) {
    const e = env();
    const spent = budget(e);
    govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", name]);
    const r = govern(e, ["task", "dispatch"], { FAKE_GROK_NOUSAGE: mode, FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "s", body: "b" }), ...extra });
    assert.equal(r.code, 0, r.err);
    assert.equal(present(spent()[0], "a spent row").actual, 2, `${name}: charged as reserved`);
    const led = jsonl(join(e.root, "queue", "ledger.jsonl"))[0];
    assert.equal(led.usage, undefined, `${name}: no usage is better than zero usage`);
    assert.doesNotMatch(r.out, /0k in/, name);
  }
  const e = env();
  const spent = budget(e);
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", "ok"]);
  govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "s", body: "b" }) });
  assert.equal(present(spent()[0], "a spent row").actual, 0.0123);
});

test("a grok error with grok's own json reports its message, and still settles as reserved (what it spent is unknown)", () => {
  const e = env();
  const spent = budget(e);
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", "s"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_GROK_ERRJSON: "model grok-9 is not available" });
  assert.match(r.out, /→ grok: FAILED/);
  const failed = readdirSync(join(e.root, "queue", "failed")).filter((x) => x.endsWith(".json")).map((x) => JSON.parse(readFileSync(join(e.root, "queue", "failed", x), "utf8")));
  assert.match(present(failed[0], "the failed message").result.error, /^grok: model grok-9 is not available/);
  assert.equal(present(spent()[0], "a spent row").actual, 2);
});

test("a grok run that times out is an error and is charged as reserved, not as nothing", () => {
  const e = env();
  const spent = budget(e);
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "t", "--summary", "s"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_GROK_SLEEP: "5", GOVERN_QUEUE_TIMEOUT_SEC: "1" });
  assert.match(r.out, /→ grok: FAILED/);
  assert.equal(present(spent()[0], "a spent row").actual, 2);
});

test("grok --write maps to grok-write, which may edit; a grok run that fails is reported like claude's", () => {
  const e = env();
  mkdirSync(join(e.projects, "film"), { recursive: true });
  govern(e, ["task", "send", "--to", "grok", "--write", "--project", "film", "--task", "fix", "--summary", "fix it"]);
  assert.match(govern(e, ["task", "list"]).out, /TASK\s+owner→grok/);
  const r = govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "done", body: "ok" }) });
  assert.match(r.out, /→ grok: ACK/);
  const call = jsonl(join(e.root, "grok.log"))[0];
  assert.deepEqual(call.argv.slice(2, 12), ["--output-format", "streaming-messages-json", "--tools", "Read,Grep,Glob,Edit,Write", "--permission-mode", "acceptEdits", "--allow", "Edit(./**)", "--allow", "Write(./**)"], "edits are scoped to the task's folder, never a bare Edit/Write");
  assert.ok(!call.argv.includes("--json-schema"));
  assert.ok(!call.argv.includes("Edit") && !call.argv.includes("Write"));
  const denies = call.argv.flatMap((x: string, i: number) => (call.argv[i - 1] === "--deny" ? [x] : []));
  for (const d of ["Edit(**/.grok/**)", "Write(**/.grok/**)", "Edit(**/.mcp.json)", "Write(**/.mcp.json)", "Edit(**/.claude/**)", "Write(**/.claude/**)", "Edit(**/.cursor/**)", "Write(**/.cursor/**)", "MCPTool(*)", "Read(**/auth.json)"])
    assert.ok(denies.includes(d), `denied: ${d}`);
  assert.equal(call.cwd, join(e.projects, "film"));
  assert.equal(jsonl(join(e.root, "queue", "ledger.jsonl"))[0].profile, "grok-write");
  for (const [name, extra, why] of [
    ["exit", { FAKE_GROK_EXIT: "3", FAKE_GROK_RAW: "" }, /grok: no result line \(exit 3\)/],
    ["raw", { FAKE_GROK_RAW: "not json at all" }, /grok: invalid JSON on line 1/],
    ["stop", { FAKE_GROK_STOP: "cancelled", FAKE_GROK_RESULT: "" }, /grok: stopped with cancelled/],
  ] as const) {
    govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", `t-${name}`, "--summary", name]);
    const f = govern(e, ["task", "dispatch"], extra);
    assert.match(f.out, /→ grok: FAILED/, name);
    const failed = readdirSync(join(e.root, "queue", "failed")).filter((x) => x.endsWith(".json")).map((x) => JSON.parse(readFileSync(join(e.root, "queue", "failed", x), "utf8")));
    const m = present(failed.find((x) => x.task === `t-${name}`), `the failed ${name} message`);
    assert.match(m.result.error, why, name);
  }
});

test("--write gives the runner write access; replies thread back to the original", () => {
  const e = env();
  mkdirSync(join(e.projects, "film"), { recursive: true });
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "fix", "--summary", "fix scene 3", "--write"]);
  govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind: "HANDOFF", summary: "fixed", body: "changed scene_03.py" }) });
  const argv = jsonl(join(e.root, "argv.log"))[0];
  assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
  const handoff = present(govern(e, ["task", "list", "--state", "open"]).out.split(" ")[0], "the HANDOFF's id");
  const shown = govern(e, ["task", "show", handoff]).out;
  assert.match(shown, /\[TASK\] owner→codex[\s\S]*\[HANDOFF\] codex→owner/);
});

test("two dispatchers never run the same message (claim is an atomic rename)", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "a", "--summary", "one"]);
  govern(e, ["task", "dispatch", "--max", "0"]); // records the profile's self-test (helpers.ts seedChecks), so both dispatchers go straight to the claim
  const s = reply(e, "ok", answer);
  const { spawn } = require("node:child_process");
  return Promise.all([0, 1].map(() => new Promise<string>((res) => {
    let out = "";
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, "..", "govern.ts"), "task", "dispatch"], { env: childEnv(e, { FAKE_CODEX_SCRIPTS: s }) });
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.on("close", () => res(out));
  }))).then((outs) => {
    assert.equal(outs.join("").split("\n").filter((l) => /→ codex/.test(l)).length, 1);
    assert.equal(jsonl(join(e.root, "argv.log")).length, 1);
  });
});

test("a project slug may hold a folder path but not escape it", () => {
  const e = env();
  assert.equal(govern(e, ["task", "send", "--to", "codex", "--project", "film/shorts", "--task", "a", "--summary", "one"]).code, 0);
  assert.match(govern(e, ["task", "send", "--to", "codex", "--project", "film/../x", "--task", "a", "--summary", "one"]).err, /--project must be a project slug/);
});

// ---------------------------------------------------------------- named sessions: recipient check, inbox, close, reply, forward

import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

function sess(names: string[], dead: string[] = []) {
  const dir = tempDir("sessions");
  const gone = spawnSync("true").pid!;
  for (const n of names) writeFileSync(join(dir, `${process.pid}-${n}.json`), JSON.stringify({ pid: process.pid, name: n, cwd: "/x", kind: "interactive", status: "idle" }));
  for (const n of dead) writeFileSync(join(dir, `${gone}-${n}.json`), JSON.stringify({ pid: gone, name: n, cwd: "/x", kind: "interactive" }));
  writeFileSync(join(dir, `${process.pid}.cafe.key`), "TOP-SECRET-KEY");
  return dir;
}
const SEND = ["task", "send", "--project", "film", "--task", "check", "--summary", "look at this", "--body", "BODY"];
const idOf = (out: string) => present(out.match(/queued (\S+)/)?.[1], `a queued id in ${JSON.stringify(out)}`);

test("send checks --to: runners, auto and owner pass; a live session passes with a reminder; unknown or dead names fail listing live names", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["render-frontend-js-e4", "sr-core-d4"], ["old-one"]) };
  for (const to of ["codex", "claude", "owner"]) assert.equal(govern(e, [...SEND, "--to", to], S).code, 0, to);
  const r = govern(e, [...SEND, "--to", "sr-core-d4"], S);
  assert.equal(r.code, 0, r.err);
  const id = idOf(r.out);
  assert.match(r.out, /sessions are not woken by the queue: also tell sr-core-d4 "govern task show \S+" \(SendMessage\)/);
  assert.ok(r.out.includes(`govern task show ${id}`));
  for (const to of ["e4", "old-one"]) {
    const f = govern(e, [...SEND, "--to", to], S);
    assert.equal(f.code, 2, to);
    assert.match(f.err, /no live session "[^"]+"/);
    assert.match(f.err, /render-frontend-js-e4/);
    assert.match(f.err, /sr-core-d4/);
    assert.ok(!f.err.includes("TOP-SECRET-KEY"));
  }
  assert.doesNotMatch(govern(e, ["task", "list", "--to", "e4"], S).out, /e4/);
});

test("inbox lists the open messages for NAME, oldest first; --all adds closed ones; the name comes from --as, GOVERN_AS or fails", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice", "bob"]) };
  const a = idOf(govern(e, [...SEND, "--to", "alice", "--from", "bob"], S).out);
  const b = idOf(govern(e, [...SEND, "--to", "alice", "--from", "bob", "--summary", "second"], S).out);
  govern(e, [...SEND, "--to", "bob", "--from", "alice"], S);
  const inbox = govern(e, ["task", "inbox", "--as", "alice"], S);
  assert.equal(inbox.code, 0, inbox.err);
  const lines = inbox.out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(present(lines[0], "inbox line 1"), new RegExp(`^${a} open\\s+TASK\\s+bob→alice \\[film/check\\] look at this`));
  assert.ok(present(lines[1], "inbox line 2").startsWith(b));
  assert.equal(govern(e, ["task", "inbox"], { ...S, GOVERN_AS: "alice" }).out, inbox.out);
  govern(e, ["task", "close", a, "--as", "alice"], S);
  assert.equal(govern(e, ["task", "inbox", "--as", "alice"], S).out.trim().split("\n").length, 1);
  assert.match(govern(e, ["task", "inbox", "--as", "alice", "--all"], S).out, /done\s+TASK/);
  assert.match(govern(e, ["task", "inbox", "--as", "carol"], S).out, /\(no messages\)/);
  const nameless = govern(e, ["task", "inbox"], { GOVERN_SESSIONS_DIR: sess([]), GOVERN_AS: "" }); // the test process itself is a registered session in S
  assert.equal(nameless.code, 2);
  assert.match(nameless.err, /--as/);
});

test("close moves an open message to done with the closer recorded; anything else fails", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice"]) };
  const id = idOf(govern(e, [...SEND, "--to", "alice"], S).out);
  const r = govern(e, ["task", "close", id, "--as", "alice", "--note", "done by hand"], S);
  assert.equal(r.code, 0, r.err);
  assert.match(govern(e, ["task", "list", "--state", "done"]).out, new RegExp(id));
  const shown = govern(e, ["task", "show", id]).out;
  assert.match(shown, /"closedBy":"alice"/);
  assert.match(shown, /"note":"done by hand"/);
  assert.match(shown, /"ok":true/);
  assert.match(govern(e, ["task", "close", id, "--as", "alice"], S).err, /not open \(it is done\)/);
  assert.match(govern(e, ["task", "close", "nope", "--as", "alice"], S).err, /no message nope/);
});

test("send without --from is from the sending session, never silently the owner; unresolved fails asking for --from", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice"]) };
  const id = idOf(govern(e, [...SEND, "--to", "codex"], { ...S, GOVERN_AS: "alice" }).out);
  assert.match(govern(e, ["task", "show", id]).out, /\[TASK\] alice→codex/);
  const none = govern(e, [...SEND, "--to", "codex"], { GOVERN_SESSIONS_DIR: sess([]), GOVERN_AS: "" });
  assert.equal(none.code, 2);
  assert.match(none.err, /--from/);
  const explicit = govern(e, [...SEND, "--to", "codex", "--from", "owner"], { GOVERN_SESSIONS_DIR: sess([]), GOVERN_AS: "" });
  assert.equal(explicit.code, 0, explicit.err);
});

test("a message is found by its full id, a prefix of it, or the short code after the last dash", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice"]) };
  const id = idOf(govern(e, [...SEND, "--to", "alice"], S).out);
  const code = id.slice(id.lastIndexOf("-") + 1);
  for (const ref of [id, id.slice(0, 20), code]) {
    const r = govern(e, ["task", "show", ref]);
    assert.equal(r.code, 0, `${ref}: ${r.err}`);
    assert.ok(r.out.includes(id), ref);
  }
  assert.match(govern(e, ["task", "show", "alice"]).err, /no message alice/); // a recipient name is not a code
  const r = govern(e, ["task", "close", code, "--as", "alice"], S);
  assert.equal(r.code, 0, r.err);
});

test("reply files an answer to the sender, threaded to the original, and closes the original", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice", "bob"]) };
  const id = idOf(govern(e, [...SEND, "--to", "alice", "--from", "bob"], S).out);
  assert.match(govern(e, ["task", "reply", id, "--as", "alice", "--kind", "TASK", "--summary", "s", "--body", "b"], S).err, /--kind must be one of ACK/);
  assert.match(govern(e, ["task", "reply", id, "--as", "alice", "--kind", "ACK", "--summary", "s"], S).err, /--body or --body-file/);
  const bf = write(join(e.root, "reply.txt"), "FROM-FILE");
  const r = govern(e, ["task", "reply", id, "--as", "alice", "--kind", "REVIEW", "--summary", "found two", "--body-file", bf], S);
  assert.equal(r.code, 0, r.err);
  const list = govern(e, ["task", "list"], S).out;
  assert.match(list, new RegExp(`${id} done`));
  assert.match(list, /open\s+REVIEW\s+alice→bob \[film\/check\] found two/);
  const rid = present(list.split("\n").find((l) => /REVIEW/.test(l))?.split(" ")[0], "the REVIEW's id");
  assert.match(govern(e, ["task", "show", rid]).out, /\[TASK\] bob→alice[\s\S]*\[REVIEW\] alice→bob[\s\S]*FROM-FILE/);
  assert.match(govern(e, ["task", "reply", id, "--as", "alice", "--kind", "ACK", "--summary", "s", "--body", "b"], S).err, /not open/);
});

test("forward sends a copy to the right name and closes the original with a note", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice", "bob", "real-e4"]) };
  const id = idOf(govern(e, [...SEND, "--to", "bob", "--from", "alice", "--write"], S).out);
  assert.equal(govern(e, ["task", "forward", id, "--to", "e4", "--as", "bob"], S).code, 2);
  assert.equal(govern(e, ["task", "list", "--state", "open"], S).out.trim().split("\n").length, 1); // nothing was queued for e4
  const r = govern(e, ["task", "forward", id, "--to", "real-e4", "--as", "bob"], S);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sessions are not woken by the queue: also tell real-e4/);
  const rows = govern(e, ["task", "list"], S).out.trim().split("\n");
  const orig = rows.find((l) => l.startsWith(id))!;
  assert.match(orig, /done/);
  const copy = rows.find((l) => /alice→real-e4/.test(l))!;
  const nid = present(copy.split(" ")[0], "the copy's id");
  assert.match(copy, /open\s+TASK/);
  assert.match(govern(e, ["task", "show", id]).out, new RegExp(`forwarded to real-e4 as ${nid}`));
  const file = JSON.parse(readFileSync(join(e.root, "queue", "open", `${nid}.json`), "utf8"));
  assert.equal(file.forwardedFrom, id);
  assert.equal(file.from, "alice");
  assert.equal(file.access, "write");
  assert.equal(file.body, "BODY");
  assert.equal(file.project, "film");
  assert.match(govern(e, ["task", "forward", id, "--to", "real-e4", "--as", "bob"], S).err, /not open/);
});

test("inbox --hook prints nothing when empty or unresolved, never fails, and otherwise a short block of at most 5 lines plus +M more", () => {
  const e = env();
  const S = { GOVERN_SESSIONS_DIR: sess(["alice"]) };
  for (const env2 of [{ ...S, GOVERN_AS: "alice" }, { ...S, GOVERN_AS: "" }, { GOVERN_SESSIONS_DIR: "/nonexistent-dir", GOVERN_AS: "" }]) {
    const r = govern(e, ["task", "inbox", "--hook"], env2);
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  }
  for (let i = 0; i < 7; i++) govern(e, [...SEND, "--to", "alice", "--summary", `msg ${i}`], S);
  const r = govern(e, ["task", "inbox", "--hook"], { ...S, GOVERN_AS: "alice" });
  assert.equal(r.code, 0);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 1 + 5 + 1);
  const [head, first, , , , , more] = lines;
  assert.match(present(head, "the hook's header"), /^govern queue: 7 open message\(s\) for alice:/);
  assert.match(present(first, "the hook's first message"), /^\s*\S+-alice-\w+ \[TASK\] msg 0/);
  assert.match(present(more, "the hook's +M more line"), /\+2 more/);
  // a broken queue still exits 0
  const broken = govern(e, ["task", "inbox", "--hook"], { ...S, GOVERN_AS: "alice", GOVERN_QUEUE: "/proc/nope/x" });
  assert.equal(broken.code, 0);
});


const streamFixture = (name: string) => readFileSync(join(HERE, "fixtures/grok-stream", name), "utf8");
const streamResult = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn", result: "final", ...extra });
test("grokResult reads the captured final turn and maps usage", () => {
  const out = grokResult(streamFixture("stream-success-2turns.ndjson"), 0, "", undefined, 30);
  assert.equal(out.text, '{"capability": "read", "status": "ok", "evidence": "chk-feedface00112233"}');
  assert.equal(out.error, undefined);
  assert.equal(out.turns, 2);
  assert.deepEqual(out.usage, { input: 29570, cached: 17024, cacheWrite: 0, output: 577, reasoning: 0, costUsd: 0.01260244 });
});
test("grokResult preserves captured bad-model and max-turns errors and spend", () => {
  for (const [name, pattern, cost] of [["bad-model", /unknown model id/, 0], ["max-turns", /maximum number of turns/, 0.00920312]] as const) {
    const out = grokResult(streamFixture(`stream-error-${name}.ndjson`), name === "bad-model" ? 1 : 0, name === "bad-model" ? streamFixture("stream-error-bad-model.stderr") : "", undefined, 30);
    assert.match(out.error!, pattern);
    assert.equal(out.usage?.costUsd, cost);
    assert.equal(out.spendUnknown, undefined);
  }
});
test("grokResult rejects missing results and malformed lines without extraction", () => {
  for (const raw of [undefined, "", "null\n42\n[]\n", '{"type":"system"}\n']) {
    const out = grokResult(raw, 1, "diagnostic", undefined, 30);
    assert.match(out.error!, /no result line \(exit 1\): diagnostic/);
    assert.equal(out.spendUnknown, true);
  }
  for (const raw of ['{}\ngarbage\n' + streamResult(), streamResult() + '\nprose {"x":1}']) {
    const out = grokResult(raw, 0, "", undefined, 30);
    assert.match(out.error!, /invalid JSON on line 2/);
    assert.equal(out.spendUnknown, true);
  }
});
test("grokResult checks terminal status, result type, and process errors", () => {
  for (const [extra, pattern] of [
    [{ is_error: true, errors: ["reported"] }, /reported/],
    [{ subtype: "error_max_turns", errors: [""] }, /error_max_turns/],
    [{ subtype: "error", errors: [42] }, /error/],
    // an empty or missing subtype must still give a non-empty error, or the failed run would be accepted
    [{ subtype: "" }, /grok failed: subtype ""/],
    [{ subtype: undefined }, /grok failed: subtype null/],
    [{ is_error: true, subtype: "success", errors: [] }, /grok failed: subtype "success", is_error/],
    [{ stop_reason: "cancelled" }, /stopped with cancelled/],
    [{ stop_reason: null }, /stopped with/],
    [{ result: null }, /result.*string/],
    [{ result: {} }, /result.*string/]
  ] as const) assert.match(grokResult(streamResult(extra), 0, "", undefined, 30).error!, pattern);
  assert.match(grokResult(streamResult(), 7, "stderr", undefined, 30).error!, /exit 7: stderr/);
  assert.match(grokResult(streamResult(), 0, "", new Error("spawn failure"), 30).error!, /spawn failure/);
  // an empty process-error message must not read as success: dispatch treats a falsy error as none
  for (const [err, status, pattern] of [[new Error(""), 7, /exit 7: stderr/], [new Error("  "), 0, /process error/], [Object.assign(new Error(""), { code: "ENOENT" }), null, /ENOENT/]] as const)
    assert.match(grokResult(streamResult(), status, "stderr", err, 30).error!, pattern);
  for (const code of ["ETIMEDOUT", "ENOENT", "EACCES"]) {
    const out = grokResult(undefined, null, "", Object.assign(new Error(code), { code }), 30);
    assert.match(out.error!, code === "ETIMEDOUT" ? /timed out after 30s/ : new RegExp(code));
    assert.equal(out.spendUnknown, code === "ETIMEDOUT" ? true : undefined);
  }
  for (const message of ["early failure", "", null]) {
    const out = grokResult(JSON.stringify({ type: "error", message }), 1, "", undefined, 30);
    assert.equal(out.error, message || "exit 1");
    assert.equal(out.spendUnknown, true);
  }
});
test("grokResult takes the last result and treats incomplete usage as unknown", () => {
  assert.equal(grokResult(streamResult({ result: "first" }) + '\n\n' + streamResult(), 0, "", undefined, 30).text, "final");
  for (const extra of [{}, { usage: null }, { usage: {}, usage_is_incomplete: true }, { usage: {}, cost_is_partial: true }]) {
    const out = grokResult(streamResult(extra), 0, "", undefined, 30);
    assert.equal(out.error, undefined);
    assert.equal(out.usage, undefined);
    assert.equal(out.spendUnknown, true);
  }
  assert.deepEqual(grokResult(streamResult({ usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, reasoning_tokens: 5 }, total_cost_usd: 0.1 }), 0, "", undefined, 30).usage,
    { input: 6, cached: 2, cacheWrite: 3, output: 4, reasoning: 5, costUsd: 0.1 });
});
