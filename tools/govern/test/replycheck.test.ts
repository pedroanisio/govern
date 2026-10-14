// Content checks on queue replies (docs/govern-features.md 3.5): a command run against the reply after the headless session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const sendTo = (e: Env, args: string[] = []) => govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "t", "--summary", "s", ...args]);
const dispatch = (e: Env, kind: string, body: string) => govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind, summary: "an answer", body }) });
const filed = (e: Env) => JSON.parse(readFileSync(join(e.root, "queue", "open", present(readdirSync(join(e.root, "queue", "open")).find((f) => f.includes("-owner-")), "the reply file")), "utf8"));
const refs = (e: Env, body: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", FILE_REFS, write(join(e.root, "r.txt"), body), e.root], { encoding: "utf8" });
/** A stand-in for a research-URL check: fails when the reply mentions a URL on a dead host. No network. */
const FAKE_URLS = (e: Env) => write(join(e.root, "fake-urls.mjs"), `import { readFileSync } from "node:fs";\nconst t = readFileSync(process.argv[2], "utf8");\nconst dead = t.match(/https?:\\/\\/dead\\.invalid\\S*/);\nif (dead) { console.error("does not resolve: " + dead[0]); process.exit(1); }\nconsole.log("all urls resolve");\n`);

// ---------------------------------------------------------------- the built-in check

test("file-refs passes when every file:line reference exists and fails naming each one that does not", () => {
  const e = env();
  assert.equal(refs(e, "see src/a.ts:2 and src/a.ts:1-3").status, 0);
  const bad = refs(e, "see src/a.ts:9, src/none.ts:1 and ../outside.ts:1 and src/a.ts:2");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /src\/a\.ts:9: the file has 3 lines/);
  assert.match(bad.stderr, /src\/none\.ts:1: no such file/);
  assert.match(bad.stderr, /\.\.\/outside\.ts:1: outside the repo/);
  assert.doesNotMatch(bad.stderr, /a\.ts:2:/);
});

test("file-refs fails a reply with no reference to check, and ignores URLs and times", () => {
  const e = env();
  const none = refs(e, "looks fine, see https://example.com:8080/x.html and 10:30");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no file:line references to check/);
});

// ---------------------------------------------------------------- the queue

test("a REVIEW reply passes the built-in check: the reply is marked checked, with its log", () => {
  const e = env();
  sendTo(e);
  const r = dispatch(e, "REVIEW", "Bug at src/a.ts:2.");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REVIEW in \d+s.* · reply \S+ · checked/);
  const m = filed(e);
  assert.equal(m.verification.state, "checked");
  assert.equal(m.verification.exit, 0);
  assert.ok(existsSync(m.verification.log), "the check's log is kept");
  assert.match(govern(e, ["task", "list"]).out, /open\s+REVIEW\s.*\[checked: refs exist \(1\)\]/);
  assert.match(govern(e, ["task", "show", m.id]).out, /check: checked: refs exist \(1\) \(exit 0\) · log /);
});

test("a failing check marks the reply unverified, keeps its content and the desk says so", () => {
  const e = env();
  sendTo(e);
  dispatch(e, "REVIEW", "Bug at src/gone.ts:4 explains it.");
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /src\/gone\.ts:4: no such file/);
  assert.match(m.body, /Bug at src\/gone\.ts:4/);
  const show = govern(e, ["task", "show", m.id]).out;
  assert.match(show, /UNVERIFIED: .*no such file/);
  assert.match(show, /Bug at src\/gone\.ts:4/);
  assert.doesNotMatch(show, /check: checked/);
  assert.match(govern(e, ["task", "list"]).out, /open\s+REVIEW\s.*\[unverified\]/);
  const d = govern(e, ["desk"]).out;
  assert.match(d, /\[unverified\]/);
  assert.match(d, /unverified replies: 1/);
});

test("a kind with no check is shown as shape only, never as checked", () => {
  const e = env();
  sendTo(e);
  dispatch(e, "HANDOFF", "Nothing to run against.");
  const m = filed(e);
  assert.equal(m.verification.state, "shape only");
  assert.match(govern(e, ["task", "list"]).out, /open\s+HANDOFF\s.*\[shape only\]/);
  assert.match(govern(e, ["desk"]).out, /\[shape only\]/);
  assert.doesNotMatch(govern(e, ["task", "show", m.id]).out, /UNVERIFIED|checked/);
});

test("a research-URL check is declared per kind in the queue config and run with {reply}, {dir}, {repo}", () => {
  const e = env();
  config(e, { checks: { HANDOFF: { argv: [process.execPath, FAKE_URLS(e), "{reply}", "{dir}", "{repo}"] } } });
  sendTo(e);
  dispatch(e, "HANDOFF", "Source: https://good.invalid/a");
  assert.equal(filed(e).verification.state, "checked");
  sendTo(e);
  const r = dispatch(e, "HANDOFF", "Source: https://dead.invalid/gone");
  assert.match(r.out, /unverified/);
  const bad = readdirSync(join(e.root, "queue", "open")).map((f) => JSON.parse(readFileSync(join(e.root, "queue", "open", f), "utf8"))).find((x) => x.verification?.state === "unverified");
  assert.match(present(bad, "the unverified reply").verification.reason, /does not resolve: https:\/\/dead\.invalid\/gone/);
});

test("a workspace config overrides the built-in check of a kind", () => {
  const e = env();
  config(e, { checks: { REVIEW: { argv: [process.execPath, "-e", "process.exit(0)"] } } });
  sendTo(e);
  dispatch(e, "REVIEW", "no references at all");
  assert.equal(filed(e).verification.state, "checked");
});

test("a profile declares its own check, which wins over the kind's", () => {
  const e = env();
  write(join(e.root, "caps", "scout.json"), JSON.stringify({ version: 1, profiles: [{ name: "scout", engine: "claude", capabilities: ["read"], selfTest: "optional",
    check: { argv: [process.execPath, FAKE_URLS(e), "{reply}"] } }] }));
  govern(e, ["task", "send", "--to", "scout", "--project", "film", "--task", "t", "--summary", "s"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: JSON.stringify({ kind: "REVIEW", summary: "an answer", body: "see https://dead.invalid/x and src/a.ts:1" }) });
  assert.equal(r.code, 0, r.err);
  assert.equal(filed(e).verification.state, "unverified");
});

test("a check that cannot run is a failure, never a pass: missing binary, timeout, killed", () => {
  const e = env();
  for (const [def, why] of [
    [{ argv: ["/no/such/binary-xyz"] }, /could not run: .*ENOENT/],
    [{ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeout: 1 }, /timed out after 1s/],
    [{ argv: [process.execPath, "-e", "process.kill(process.pid,'SIGKILL')"] }, /killed by SIGKILL/],
  ] as const) {
    config(e, { checks: { HANDOFF: def } });
    sendTo(e);
    dispatch(e, "HANDOFF", "x");
    const m = readdirSync(join(e.root, "queue", "open")).map((f) => JSON.parse(readFileSync(join(e.root, "queue", "open", f), "utf8"))).filter((x) => x.verification?.state === "unverified").at(-1);
    assert.match(present(m, "an unverified reply").verification.reason, why);
    for (const f of readdirSync(join(e.root, "queue", "open")).filter((x) => x.includes("-owner-"))) rmSync(join(e.root, "queue", "open", f));
  }
});

test("a bad checks entry in the queue config is refused with its path", () => {
  const e = env();
  config(e, { checks: { REVIEW: { argv: [] } } });
  sendTo(e);
  assert.match(dispatch(e, "REVIEW", "x").err, /config\.json: \$\.checks\.REVIEW\.argv/);
  config(e, { checks: { NOPE: { argv: ["true"] } } });
  assert.match(dispatch(e, "REVIEW", "x").err, /config\.json: \$\.checks\.NOPE: not a message kind/);
});

test("a reply the owner wrote by hand, and a BLOCKED notice, carry no verification mark", () => {
  const e = env();
  sendTo(e);
  const id = present(readdirSync(join(e.root, "queue", "open"))[0], "the task").replace(".json", "");
  govern(e, ["task", "reply", id, "--as", "codex", "--kind", "ACK", "--summary", "hand", "--body", "by hand"]);
  assert.equal(filed(e).verification, undefined);
  assert.doesNotMatch(govern(e, ["task", "list"]).out, /\[(checked|unverified|shape only)\]/);
});
