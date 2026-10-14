// Second-review fixes for reply checks (docs/govern-features.md 3.5): the task's kind selects the check too, profile checks are
// for content kinds, the label says what was checked, the checker cannot lose a reply, summary and empty body are covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, reply, present, HERE, type Env } from "./helpers.ts";

const FILE_REFS = join(HERE, "..", "checks", "file-refs.ts");

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, GOVERN_CAPABILITIES: join(e.root, "caps") });
  write(join(e.root, "src", "a.ts"), "one\ntwo\nthree\n");
  return e;
}
const config = (e: Env, v: unknown) => write(join(e.root, "queue", "config.json"), JSON.stringify(v));
const sendTo = (e: Env, kind = "TASK") => govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "t", "--kind", kind, "--summary", "s"]);
const dispatch = (e: Env, kind: string, body: string, summary = "an answer") => govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind, summary, body }) });
const filed = (e: Env) => JSON.parse(readFileSync(join(e.root, "queue", "open", present(readdirSync(join(e.root, "queue", "open")).find((f) => f.includes("-owner-")), "the reply file")), "utf8"));
const refs = (e: Env, body: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", FILE_REFS, write(join(e.root, "r.txt"), body), e.root], { encoding: "utf8" });

test("a REVIEW task is checked whatever kind the reply claims", () => {
  for (const claimed of ["HANDOFF", "NOTICE", "BLOCKED", "ACK"]) {
    const e = env();
    sendTo(e, "REVIEW");
    dispatch(e, claimed, "Found a bug at src/gone.ts:4.");
    const m = filed(e);
    assert.equal(m.verification.state, "unverified", claimed);
    assert.match(m.verification.reason, /no such file/);
  }
});

test("a config check keyed by the task's kind applies to every reply to it", () => {
  const e = env();
  config(e, { checks: { TASK: { argv: [process.execPath, "-e", "process.exit(1)"], label: "always fails" } } });
  sendTo(e);
  dispatch(e, "ACK", "fine");
  assert.equal(filed(e).verification.state, "unverified");
});

test("a profile check runs for content kinds only, not for ACK or BLOCKED", () => {
  for (const [kind, state] of [["ACK", "shape only"], ["BLOCKED", "shape only"], ["HANDOFF", "unverified"]] as const) {
    const e = env();
    write(join(e.root, "caps", "scout.json"), JSON.stringify({ version: 1, profiles: [{ name: "scout", engine: "claude", capabilities: ["read"], selfTest: "optional",
      check: { argv: [process.execPath, "-e", "process.exit(1)"] } }] }));
    govern(e, ["task", "send", "--to", "scout", "--project", "film", "--task", "t", "--summary", "s"]);
    const r = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: JSON.stringify({ kind, summary: "an answer", body: "text" }) });
    assert.equal(r.code, 0, r.err);
    assert.equal(filed(e).verification.state, state, kind);
  }
});

test("the mark says what was checked, with the number of references", () => {
  const e = env();
  sendTo(e);
  dispatch(e, "REVIEW", "Bug at src/a.ts:2 and src/a.ts:3.");
  const m = filed(e);
  assert.equal(m.verification.state, "checked");
  assert.match(govern(e, ["task", "list"]).out, /\[checked: refs exist \(2\)\]/);
  assert.match(govern(e, ["task", "show", m.id]).out, /check: checked: refs exist \(2\)/);
});

test("file-refs parses path#L12, path:L12, path:12 and path line 12", () => {
  const e = env();
  assert.equal(refs(e, "src/a.ts#L2 src/a.ts:L3 src/a.ts:1 src/a.ts line 2 src/a.ts#L1-L3").status, 0);
  for (const bad of ["src/a.ts#L99", "src/a.ts:L99", "src/a.ts line 99", "src/none.ts#L1", "src/a.ts#L2-L9"]) {
    const r = refs(e, `real src/a.ts:2 then ${bad}`);
    assert.equal(r.status, 1, bad);
  }
  assert.match(refs(e, "src/a.ts#L1 src/a.ts line 2").stdout, /^2 /);
});

test("file-refs rejects a symlink that leaves the repo", () => {
  const e = env();
  write(join(e.root, "outside.txt"), "x\n");
  symlinkSync(join(e.root, "outside.txt"), join(e.root, "src", "link.ts"));
  const sub = join(e.root, "repo2");
  mkdirSync(join(sub, "src"), { recursive: true });
  writeFileSync(join(sub, "src", "ok.ts"), "a\n");
  symlinkSync(join(e.root, "outside.txt"), join(sub, "src", "link.ts"));
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", FILE_REFS, write(join(e.root, "r2.txt"), "src/ok.ts:1 src/link.ts:1"), sub], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/link\.ts:1: outside the repo/);
});

test("a checker that throws still sends the reply, labelled could not run, never checked", () => {
  const e = env();
  mkdirSync(join(e.root, "queue"), { recursive: true });
  writeFileSync(join(e.root, "queue", "replychecks"), "a file where the log folder should be");
  sendTo(e);
  const r = dispatch(e, "REVIEW", "Bug at src/a.ts:2.");
  assert.equal(r.code, 0, r.err);
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /could not run: /);
  assert.match(m.body, /src\/a\.ts:2/);
});

test("the summary is checked too, and an empty body on a content kind is unverified", () => {
  const e = env();
  sendTo(e);
  dispatch(e, "REVIEW", "Real: src/a.ts:2.", "see src/gone.ts:7");
  assert.equal(filed(e).verification.state, "unverified");
  assert.match(filed(e).verification.reason, /src\/gone\.ts:7/);
  const e2 = env();
  config(e2, { checks: { HANDOFF: { argv: [process.execPath, "-e", "process.exit(0)"] } } });
  sendTo(e2);
  dispatch(e2, "HANDOFF", "  ");
  assert.equal(filed(e2).verification.state, "unverified");
  assert.match(filed(e2).verification.reason, /body is empty/);
});
