// The content checks a reply can be given beyond file references: commit-refs (every HANDOFF), claims-cited (--check) and verify-cmd (--verify).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, reply, present, HERE, type Env } from "./helpers.ts";

const COMMIT_REFS = join(HERE, "..", "checks", "commit-refs.ts");
const CLAIMS_CITED = join(HERE, "..", "checks", "claims-cited.ts");
/** git in a throwaway repo: its own identity, and no hooks (a machine-wide hook may insist on its owner's identity). */
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

/** A workspace whose repo folder is a git repository with one commit; returns the commit's full hash. */
function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, GOVERN_CAPABILITIES: join(e.root, "caps") });
  mkdirSync(join(e.root, "caps"), { recursive: true });
  git(e.root, "init", "-q");
  write(join(e.root, "src", "a.ts"), "one\n");
  git(e.root, "add", "src/a.ts");
  assert.equal(git(e.root, "commit", "-q", "-m", "first").status, 0);
  return { e, head: git(e.root, "rev-parse", "HEAD").stdout.trim() };
}
const commits = (e: Env, body: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", COMMIT_REFS, write(join(e.root, "r.txt"), body), e.root], { encoding: "utf8" });
const claims = (e: Env, body: string, files: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLAIMS_CITED, write(join(e.root, "r.txt"), body)],
  { encoding: "utf8", env: { ...process.env, GOVERN_TASK_FILES: JSON.stringify(files) } });
const dispatch = (e: Env, kind: string, body: string) => govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind, summary: "an answer", body }) });
const filed = (e: Env) => JSON.parse(readFileSync(join(e.root, "queue", "open", present(readdirSync(join(e.root, "queue", "open")).find((f) => f.includes("-owner-")), "the reply file")), "utf8"));
const sendTo = (e: Env, args: string[] = []) => govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "t", "--summary", "s", ...args]);

// ---------------------------------------------------------------- commit-refs

test("commit-refs passes commits that exist, in each of the three places a reply names one", () => {
  const { e, head } = env();
  const short = head.slice(0, 9);
  assert.equal(commits(e, `The work is in commit ${short}.`).status, 0);
  assert.equal(commits(e, `branch: feat/x\n- ${short} first\n- \`${head}\` again`).status, 0);
  assert.equal(commits(e, `branch: feat/x (${short})`).status, 0);
  const r = commits(e, `commits ${short}, ${head} and ${short}`);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^2 commit references exist/, "each distinct token is counted once");
});

test("commit-refs fails naming a commit that does not exist, and counts what it checked", () => {
  const { e, head } = env();
  const bad = commits(e, `branch: feat/x\n- ${head.slice(0, 8)} first\n- deadbee0 a commit nobody made\n\ncommit 1234567890abcdef`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no such commit in .*: .*deadbee0/);
  assert.match(bad.stderr, /1234567890abcdef/);
  assert.doesNotMatch(bad.stderr, new RegExp(head.slice(0, 8)));
  const ok = commits(e, `commit ${head.slice(0, 8)}`);
  assert.match(ok.stdout, /^1 commit reference exist/);
});

test("commit-refs ignores what is no hash: a branch name with hex in it, a number, a word, a hash with no subject", () => {
  const { e } = env();
  const r = commits(e, "branch: feat/abc12345\n1234567 tokens were used\ndefaced the page\nsee abc1234567");
  assert.equal(r.status, 3, "nothing to check");
  assert.match(r.stderr, /no commit references to check/);
});

test("commit-refs cannot run git where there is no repository: the commit is reported missing", () => {
  const { e, head } = env();
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", COMMIT_REFS, write(join(e.root, "r.txt"), `commit ${head.slice(0, 8)}`), join(e.root, "no-such-folder")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 3);
});

test("a HANDOFF naming a missing commit is [unverified] with the hash; one naming a real commit is [checked]; one naming none stays shape only", () => {
  const { e, head } = env();
  sendTo(e);
  dispatch(e, "HANDOFF", "branch: feat/x\n- deadbee1 something");
  let m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /deadbee1/);
  assert.equal(govern(e, ["task", "list", "--state", "open"]).out.includes("[unverified]"), true);
  govern(e, ["task", "close", m.id, "--as", "owner"]);

  sendTo(e);
  dispatch(e, "HANDOFF", `commit ${head.slice(0, 9)} holds it`);
  m = filed(e);
  assert.equal(m.verification.state, "checked");
  assert.equal(m.verification.label, "commits exist (1)");
  govern(e, ["task", "close", m.id, "--as", "owner"]);

  sendTo(e);
  dispatch(e, "HANDOFF", "nothing was committed");
  assert.equal(filed(e).verification.state, "shape only");
});

test("--check commit-refs on a DECISION that names no commit is unverified, not a pass", () => {
  const { e } = env();
  sendTo(e, ["--check", "commit-refs"]);
  dispatch(e, "DECISION", "we go with option A");
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /no commit references to check/);
});

// ---------------------------------------------------------------- claims-cited

const LEDGER = { claims: [{ id: "C1", text: "a" }, { id: "C2", text: "b" }, { id: "C10" }] };

test("claims-cited passes when every claim id is in the reply and names each that is not", () => {
  const { e } = env();
  const ledger = write(join(e.root, "notes", "claims.json"), JSON.stringify(LEDGER));
  const ok = claims(e, "C1: true. C2: false. C10: unverifiable.", [join(e.root, "notes", "readme.md"), ledger]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^3\/3 claims addressed/);
  const bad = claims(e, "C1 true, C10 false, and C20 is extra", [ledger]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\(2\/3\).*: C2$/m, "C1 does not stand in for C10, C10 does not stand in for C2");
});

test("claims-cited takes the first .json file that has claims, and fails plainly on any other shape", () => {
  const { e } = env();
  const other = write(join(e.root, "n", "other.json"), JSON.stringify({ items: [] }));
  const ledger = write(join(e.root, "n", "claims.json"), JSON.stringify(LEDGER));
  assert.equal(claims(e, "C1 C2 C10", [other, ledger]).status, 0);
  const wrong: [string, unknown, RegExp][] = [
    ["no claims key anywhere", { items: [] }, /no attached \.json file has a top-level `claims`/],
    ["claims not an array", { claims: { C1: 1 } }, /`claims` must be a non-empty array/],
    ["claims empty", { claims: [] }, /`claims` must be a non-empty array/],
    ["claim not an object", { claims: ["C1"] }, /claims\[0\] must be an object/],
    ["id missing", { claims: [{ text: "x" }] }, /claims\[0\]\.id must be a non-empty string/],
    ["id a number", { claims: [{ id: 1 }] }, /claims\[0\]\.id must be a non-empty string/],
    ["id twice", { claims: [{ id: "C1" }, { id: "C1" }] }, /used twice/],
  ];
  for (const [what, ledgerValue, why] of wrong) {
    const f = write(join(e.root, "n", "bad.json"), JSON.stringify(ledgerValue));
    const r = claims(e, "C1 C2 C10", [f]);
    assert.equal(r.status, 2, what);
    assert.match(r.stderr, /^could not run: /, what);
    assert.match(r.stderr, why, what);
  }
  assert.equal(claims(e, "C1", [write(join(e.root, "n", "broken.json"), "{not json")]).status, 2);
  assert.equal(claims(e, "C1", []).status, 2, "no file attached");
});

test("a task sent with --check claims-cited --file LEDGER is checked against that ledger, and a reply that skips a claim is unverified", () => {
  const { e } = env();
  write(join(e.root, "notes", "claims.json"), JSON.stringify(LEDGER));
  sendTo(e, ["--kind", "TASK", "--check", "claims-cited", "--file", "notes/claims.json"]);
  dispatch(e, "REVIEW", "src/a.ts:1 C1 true, C2 false, C10 true");
  let m = filed(e);
  assert.equal(m.verification.state, "checked");
  assert.match(m.verification.label, /refs exist \(1\), 3\/3 claims addressed/);
  govern(e, ["task", "close", m.id, "--as", "owner"]);

  sendTo(e, ["--check", "claims-cited", "--file", "notes/claims.json"]);
  dispatch(e, "REVIEW", "src/a.ts:1 C1 true, C10 true");
  m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /C2/);
});

test("a claims ledger of the wrong shape makes the reply unverified: could not run, never checked", () => {
  const { e } = env();
  write(join(e.root, "notes", "claims.json"), JSON.stringify({ claims: "none" }));
  sendTo(e, ["--check", "claims-cited", "--file", "notes/claims.json"]);
  dispatch(e, "NOTICE", "C1 C2");
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /could not run: .*must be a non-empty array/);
});

// ---------------------------------------------------------------- verify-cmd

test("--verify runs the argv in the project folder after the reply is filed: exit 0 is [checked: verify (exit 0)]", () => {
  const { e } = env();
  const folder = join(e.projects, "film");
  write(join(folder, "marker.txt"), "here");
  const script = write(join(e.root, "tools", "ok.mjs"), `import { existsSync } from "node:fs"; console.log("cwd has marker: " + existsSync("marker.txt")); process.exit(existsSync("marker.txt") ? 0 : 1);`);
  const sent = sendTo(e, ["--verify", "--", process.execPath, script]);
  assert.equal(sent.code, 0, sent.err);
  dispatch(e, "HANDOFF", "all done, tests pass");
  const m = filed(e);
  assert.equal(m.verification.state, "checked");
  assert.equal(m.verification.label, "verify (exit 0)");
  assert.match(govern(e, ["task", "list", "--state", "open"]).out, /\[checked: verify \(exit 0\)\]/);
  const task = readdirSync(join(e.root, "queue", "done")).map((f) => JSON.parse(readFileSync(join(e.root, "queue", "done", f), "utf8")))[0];
  assert.deepEqual(task.verify, [process.execPath, script], "the message records the argv");
  assert.match(govern(e, ["task", "show", task.id]).out, /verify: .*ok\.mjs/);
});

test("--verify exiting nonzero is [unverified] with the exit code and the last 12 lines kept under queue/replychecks", () => {
  const { e } = env();
  write(join(e.projects, "film", "x"), "");
  const script = write(join(e.root, "tools", "bad.mjs"), `for (let i = 1; i <= 30; i++) console.log("line " + i); process.exit(7);`);
  sendTo(e, ["--verify", "--", process.execPath, script]);
  dispatch(e, "HANDOFF", "all done, tests pass");
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.equal(m.verification.exit, 7);
  assert.match(m.verification.reason, /verify exited 7/);
  const log = readFileSync(m.verification.log, "utf8");
  assert.ok(m.verification.log.includes(join("queue", "replychecks")));
  assert.match(log, /line 30/);
  assert.match(log, /line 19/);
  assert.doesNotMatch(log, /line 18\n/, "only the last 12 lines are kept");
});

test("--verify is not run through a shell, and does not run when an earlier check failed", () => {
  const { e } = env();
  const flag = join(e.root, "ran.txt");
  const script = write(join(e.root, "tools", "touch.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(flag)}, process.argv.slice(2).join("|"));`);
  sendTo(e, ["--verify", "--", process.execPath, script, "a;b", "$(echo hi)"]);
  dispatch(e, "NOTICE", "done");
  assert.equal(filed(e).verification.state, "checked");
  assert.equal(readFileSync(flag, "utf8"), "a;b|$(echo hi)", "the arguments reached the program as they were");

  const e2 = env().e;
  const flag2 = join(e2.root, "ran.txt");
  const script2 = write(join(e2.root, "tools", "touch.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(flag2)}, "ran");`);
  sendTo(e2, ["--verify", "--", process.execPath, script2]);
  dispatch(e2, "HANDOFF", "branch: x\n- deadbee2 nothing");
  assert.equal(filed(e2).verification.state, "unverified");
  assert.equal(existsSync(flag2), false, "the commit check failed first");
});

test("--verify with a missing program is unverified, and --verify with no command is refused", () => {
  const { e } = env();
  sendTo(e, ["--verify", "--", "/no/such/program-xyz"]);
  dispatch(e, "NOTICE", "done");
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /the verify command could not run: .*ENOENT/);
  const refused = sendTo(e, ["--verify"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--verify needs the command after --/);
});
