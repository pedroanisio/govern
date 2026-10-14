import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, childEnv, jsonl, write, reply, present, HERE, tempDir } from "./helpers.ts";

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  require("node:fs").chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_ARGV_OUT: join(e.root, "claude.log") });
  return e;
}
const answer = { kind: "REVIEW", summary: "two claims unsupported", body: "Claim 3 and 7 have no source." };

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
  assert.match(govern(e, ["task", "show", id]).out, /reply is not JSON[\s\S]*unverified, not an answer/);
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
  assert.deepEqual(call.argv.slice(5), ["--allowedTools", "Read", "Grep", "Glob", "--tools", "Read", "Grep", "Glob", "--disallowedTools", "Agent", "Bash", "Edit", "NotebookEdit", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write", "--setting-sources", "", "--strict-mcp-config"], "sealed to the claude-read profile");
});

test("dispatch runs grok --prompt-file sealed to grok-read: private HOME, compat loaders closed, real GROK_HOME, cost and cache read from its json", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "grok", "--project", "film", "--task", "review", "--summary", "review the hook", "--body", "BODY-GROK"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "looks right", body: "ok" }), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ grok: ACK in \d+s, 10k in \(90% cached\), 200 out, \$0\.012/);
  const call = jsonl(join(e.root, "grok.log"))[0];
  assert.equal(call.argv[0], "--prompt-file");
  assert.deepEqual(call.argv.slice(2), ["--output-format", "json", "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--cwd", call.cwd], "sealed to the grok-read profile");
  assert.match(call.prompt, /BODY-GROK/);
  assert.equal(call.env.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.equal(call.env.GROK_CLAUDE_SKILLS_ENABLED, "0");
  assert.equal(call.env.GROK_CLAUDE_HOOKS_ENABLED, "0");
  assert.equal(call.env.GROK_MEMORY, "0");
  assert.equal(call.env.CLAUDECODE, null, "the child does not think it runs inside this Claude Code session");
  assert.equal(call.env.GROK_HOME, join(e.env.HOME!, ".grok"), "auth stays in the real grok home");
  assert.notEqual(call.env.HOME, e.env.HOME, "a private HOME hides the user's skills, plugins and Claude settings");
  assert.equal(call.homeExists, true);
  assert.equal(existsSync(call.env.HOME), false, "the private HOME is removed after the run");
  const ledger = jsonl(join(e.root, "queue", "ledger.jsonl"))[0];
  assert.equal(ledger.agent, "grok");
  assert.equal(ledger.profile, "grok-read");
  assert.equal(ledger.usage.input, 10000);
  assert.equal(ledger.usage.cached, 9000);
  assert.equal(ledger.usage.costUsd, 0.0123);
});

test("grok --write maps to grok-write, which may edit; a grok run that fails is reported like claude's", () => {
  const e = env();
  mkdirSync(join(e.projects, "film"), { recursive: true });
  govern(e, ["task", "send", "--to", "grok", "--write", "--project", "film", "--task", "fix", "--summary", "fix it"]);
  assert.match(govern(e, ["task", "list"]).out, /TASK\s+owner→grok/);
  const r = govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: JSON.stringify({ kind: "ACK", summary: "done", body: "ok" }) });
  assert.match(r.out, /→ grok: ACK/);
  const call = jsonl(join(e.root, "grok.log"))[0];
  assert.deepEqual(call.argv.slice(2, 12), ["--output-format", "json", "--tools", "Read,Grep,Glob,Edit,Write", "--permission-mode", "acceptEdits", "--allow", "Edit", "--allow", "Write"]);
  assert.equal(call.cwd, join(e.projects, "film"));
  assert.equal(jsonl(join(e.root, "queue", "ledger.jsonl"))[0].profile, "grok-write");
  for (const [name, extra, why] of [
    ["exit", { FAKE_GROK_EXIT: "3", FAKE_GROK_RAW: "" }, /grok: no JSON result \(exit 3\)/],
    ["raw", { FAKE_GROK_RAW: "not json at all" }, /grok: no JSON result/],
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
