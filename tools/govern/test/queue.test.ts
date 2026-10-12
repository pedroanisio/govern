import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, reply, HERE } from "./helpers.ts";

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
  const prompt = JSON.parse(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[0]);
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
  const id = list.split("\n").find((l) => /BLOCKED/.test(l))!.split(" ")[0];
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
  assert.equal(call.argv[call.argv.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
});

test("--write gives the runner write access; replies thread back to the original", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "fix", "--summary", "fix scene 3", "--write"]);
  govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind: "HANDOFF", summary: "fixed", body: "changed scene_03.py" }) });
  const argv = jsonl(join(e.root, "argv.log"))[0];
  assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
  const handoff = govern(e, ["task", "list", "--state", "open"]).out.split(" ")[0];
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
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, "..", "govern.ts"), "task", "dispatch"], { env: { ...process.env, ...e.env, FAKE_CODEX_SCRIPTS: s } });
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
