// Capability registry, profiles, sealed sessions, guarded classes and the grant self-test (docs/govern-features.md 3.3, 3.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, reply, present, HERE, type Env } from "./helpers.ts";

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, {
    GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_ARGV_OUT: join(e.root, "claude.log"),
    GOVERN_CAPABILITIES: join(e.root, "caps"), FAKE_CLAUDE_COUNTER: join(e.root, "claude-count"),
  });
  return e;
}
const ANSWER = JSON.stringify({ kind: "ACK", summary: "done", body: "ok" });
const checks = (e: Env, profile: string) => JSON.parse(readFileSync(join(e.root, "queue", "checks", `${profile}.json`), "utf8"));
/** A FAKE_CLAUDE_SCRIPT: one step per call. */
function script(e: Env, name: string, steps: unknown[]) { return write(join(e.root, `${name}.json`), JSON.stringify(steps)); }
const ok = (capability: string, evidence: string) => ({ result: { capability, status: "ok", evidence } });
/** The three passing probe replies of the researcher profile, in capability order (web, gh-read, read). */
const RESEARCHER_OK = [ok("web", "Example Domain"), ok("gh-read", "cli"), ok("read", "NONCE")];
const send = (e: Env, args: string[]) => govern(e, ["task", "send", "--project", "film", "--task", "t", "--summary", "s", ...args]);

// ---------------------------------------------------------------- the registry and `govern caps`

test("govern caps lists the built-in capabilities and profiles; a profile shows its patterns, Codex mapping, classes and secret names", () => {
  const e = env();
  const list = govern(e, ["caps"]);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^CAPABILITIES/m);
  for (const c of ["read", "edit", "web", "gh-read"]) assert.match(list.out, new RegExp(`^  ${c}\\s`, "m"), c);
  for (const p of ["claude-read", "claude-write", "codex-read", "codex-write", "researcher"]) assert.match(list.out, new RegExp(`^  ${p}\\s`, "m"), p);
  const r = govern(e, ["caps", "researcher"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /engine: claude/);
  assert.match(r.out, /web\s+read\s.*WebSearch, WebFetch/);
  assert.match(r.out, /gh-read\s+read\s.*Bash\(gh repo view:\*\)/);
  assert.match(r.out, /codex: not available on codex/);
  assert.match(r.out, /classes: read/);
  assert.match(r.out, /secrets: \(none\)/);
  const w = govern(e, ["caps", "codex-write"]).out;
  assert.match(w, /codex: sandbox workspace-write/);
  assert.match(w, /classes: read, write/);
  assert.match(govern(e, ["caps", "nope"]).err, /no profile "nope" \(have: .*researcher/);
});

test("a workspace adds capabilities and profiles, and overrides a built-in of the same name; a bad file names its path", () => {
  const e = env();
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1,
    capabilities: [
      { name: "deploy", description: "push a build to staging", call: "Bash(deploy:*)", claude: { allow: ["Bash(deploy:*)"] }, effect: "publish", resource: "staging", cost: "none", secrets: ["DEPLOY_TOKEN"], probe: { instruction: "run deploy --dry-run", expect: "dry" } },
      { name: "web", description: "no web here", call: "none", claude: { allow: ["WebFetch"] }, effect: "read", secrets: [] },
    ],
    profiles: [{ name: "deployer", engine: "claude", capabilities: ["deploy", "read"] }] }));
  const out = govern(e, ["caps", "deployer"]).out;
  assert.match(out, /deploy\s+publish\s.*Bash\(deploy:\*\)/);
  assert.match(out, /resource: staging/);
  assert.match(out, /secrets: DEPLOY_TOKEN \(names only\)/);
  assert.match(out, /classes: publish, read/);
  assert.match(govern(e, ["caps", "researcher"]).out, /web\s+read\s.*WebFetch\b(?!.*WebSearch)/);
  // a secret must be a NAME, never a value
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1, capabilities: [{ name: "x", description: "d", call: "c", claude: { allow: [] }, effect: "read", secrets: ["sk-live-abc123"] }] }));
  assert.match(govern(e, ["caps"]).err, /deploy\.json: \$\.capabilities\[0\]\.secrets\[0\]: .*environment variable NAME/);
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1, profiles: [{ name: "p", engine: "claude", capabilities: ["ghost"] }] }));
  assert.match(govern(e, ["caps"]).err, /profile p: unknown capability ghost/);
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1, profiles: [{ name: "p", engine: "codex", capabilities: ["web"] }] }));
  assert.match(govern(e, ["caps"]).err, /profile p: capability web is not available on codex/);
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1, profiles: [{ name: "claude", engine: "claude", capabilities: ["read"] }] }));
  assert.match(govern(e, ["caps"]).err, /profile name "claude" is reserved/);
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1, capabilities: [{ name: "x", description: "d", call: "c", claude: { allow: [] }, effect: "read", extra: 1 }] }));
  assert.match(govern(e, ["caps"]).err, /unknown key "extra"/);
});

// ---------------------------------------------------------------- sealed sessions, exact argv

test("the built-in claude profiles run sealed: exact argv, no inherited settings, no MCP servers", () => {
  const e = env();
  const log = join(e.root, "claude.log");
  send(e, ["--to", "claude"]);
  send(e, ["--to", "claude", "--write"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.equal(r.code, 0, r.err);
  const [read, wr] = jsonl(log);
  assert.deepEqual(present(read, "the read call").argv, ["-p", "--output-format", "json", "--model", "sonnet", "--allowedTools", "Read", "Grep", "Glob", "--setting-sources", "", "--strict-mcp-config"]);
  assert.deepEqual(present(wr, "the write call").argv, ["-p", "--output-format", "json", "--model", "sonnet", "--permission-mode", "acceptEdits", "--allowedTools", "Read", "Grep", "Glob", "Edit", "Write", "--setting-sources", "", "--strict-mcp-config"]);
});

test("a profile's own model and MCP config reach the argv; GOVERN_QUEUE_CLAUDE_MODEL is the fallback", () => {
  const e = env();
  write(join(e.root, "caps", "mcp", "pinned.json"), JSON.stringify({ mcpServers: {} }));
  write(join(e.root, "caps", "p.json"), JSON.stringify({ version: 1, profiles: [
    { name: "pinned", engine: "claude", model: "opus", capabilities: ["read"], mcpConfig: "mcp/pinned.json", selfTest: "optional" },
    { name: "floating", engine: "claude", capabilities: ["read"], selfTest: "optional" }] }));
  send(e, ["--to", "pinned"]);
  send(e, ["--to", "floating"]);
  const d = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER, GOVERN_QUEUE_CLAUDE_MODEL: "haiku" });
  assert.equal(d.code, 0, d.err);
  const [a, b] = jsonl(join(e.root, "claude.log"));
  assert.deepEqual(present(a, "pinned call").argv, ["-p", "--output-format", "json", "--model", "opus", "--allowedTools", "Read", "Grep", "Glob", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", join(e.root, "caps", "mcp", "pinned.json")]);
  assert.equal(present(b, "floating call").argv[4], "haiku");
});

test("codex profiles keep the old sandbox mapping; a profile's -c settings and add-dir reach codex exec", () => {
  const e = env();
  send(e, ["--to", "codex"]);
  send(e, ["--to", "codex", "--write"]);
  write(join(e.root, "caps", "c.json"), JSON.stringify({ version: 1,
    capabilities: [{ name: "scratch", description: "a scratch dir", call: "files", claude: { allow: ["Write"] }, codex: { sandbox: "workspace-write", config: ["sandbox_workspace_write.network_access=false"], addDirs: ["/tmp/scratch"] }, effect: "write" }],
    profiles: [{ name: "cx", engine: "codex", capabilities: ["read", "scratch"], selfTest: "optional" }] }));
  send(e, ["--to", "cx"]);
  govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", JSON.parse(ANSWER)) });
  const [ro, rw, cx] = jsonl(join(e.root, "argv.log"));
  const s = (a: string[]) => a[a.indexOf("-s") + 1];
  assert.equal(s(present(ro, "ro")), "read-only");
  assert.equal(s(present(rw, "rw")), "workspace-write");
  assert.equal(s(present(cx, "cx")), "workspace-write");
  assert.ok(present(cx, "cx").includes("sandbox_workspace_write.network_access=false"));
  assert.equal(present(cx, "cx")[present(cx, "cx").indexOf("--add-dir") + 1], "/tmp/scratch");
  assert.ok(!present(ro, "ro").includes("--add-dir"));
});

// ---------------------------------------------------------------- profiles on tasks

test("a task records its profile: task send resolves it, task show and desk display it, access follows the capabilities", () => {
  const e = env();
  assert.match(send(e, ["--to", "claude", "--write"]).out, /queued \S+-claude-\w+ \(TASK to claude, profile claude-write\)/);
  const id = present(govern(e, ["task", "list"]).out.split(" ")[0], "the id");
  const m = JSON.parse(readFileSync(join(e.root, "queue", "open", `${id}.json`), "utf8"));
  assert.equal(m.profile, "claude-write");
  assert.equal(m.access, "write");
  assert.match(govern(e, ["task", "show", id]).out, /profile: claude-write/);
  assert.match(govern(e, ["desk"]).out, /PROFILES\s+claude-write: 1 queued/);
  // --profile on a runner, and a mismatched engine
  assert.match(send(e, ["--to", "claude", "--profile", "claude-read"]).out, /profile claude-read/);
  assert.match(send(e, ["--to", "codex", "--profile", "claude-read"]).err, /profile claude-read is a claude profile; --to codex runs codex/);
  assert.match(send(e, ["--to", "claude", "--profile", "claude-read", "--write"]).err, /--write cannot be combined with --profile/);
  assert.match(send(e, ["--to", "claude", "--profile", "nope"]).err, /no profile "nope"/);
  // forward keeps the profile when the engine matches and re-derives it otherwise
  const fwd = govern(e, ["task", "forward", id, "--to", "codex", "--as", "owner"]);
  assert.equal(fwd.code, 0, fwd.err);
  const copy = present(govern(e, ["task", "list", "--to", "codex"]).out.split(" ")[0], "forwarded id");
  const c = JSON.parse(readFileSync(join(e.root, "queue", "open", `${copy}.json`), "utf8"));
  assert.equal(c.profile, "codex-write");
  assert.equal(c.access, "write");
});

test("a queue config runner of the same name as a built-in profile keeps working, and caps warns about the shadowing", () => {
  const e = env();
  const bin = write(join(e.root, "legacy.sh"), `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"kind":"ACK","summary":"legacy ran","body":"ok"}'\n`);
  chmodSync(bin, 0o755);
  write(join(e.root, "queue", "config.json"), JSON.stringify({ runners: { researcher: { argv: [bin], format: "text" } } }));
  assert.match(govern(e, ["caps"]).out, /warning: the queue's config.json runner "researcher" shadows the built-in profile researcher \(it runs unsealed\)/);
  const q = send(e, ["--to", "researcher"]);
  assert.equal(q.code, 0, q.err);
  assert.doesNotMatch(q.out, /profile/);
  assert.match(govern(e, ["task", "dispatch"]).out, /→ researcher: ACK/);
  assert.ok(!existsSync(join(e.root, "claude.log")), "the sealed claude was not used");
});

// ---------------------------------------------------------------- guarded classes

function deployWorkspace(e: Env) {
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1,
    capabilities: [{ name: "deploy", description: "push a build", call: "Bash(deploy:*)", claude: { allow: ["Bash(deploy:*)"] }, effect: "publish", secrets: ["DEPLOY_TOKEN"] }],
    profiles: [{ name: "deployer", engine: "claude", capabilities: ["deploy", "read"], selfTest: "optional" }] }));
  govern(e, ["new", "film", "--kind", "long", "--title", "Film"]);
}
const approve = (e: Env, lane: string, gate: string | null) => {
  const f = join(e.projects, lane, "govern.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.approvals = gate ? { [gate]: { at: "2026-10-14T00:00:00Z", quote: "go" } } : {};
  writeFileSync(f, JSON.stringify(j, null, 2));
};

test("a profile with a publish, spend or push capability runs only for a lane whose matching gate is approved", () => {
  const e = env();
  deployWorkspace(e);
  const no = send(e, ["--to", "deployer"]);
  assert.notEqual(no.code, 0);
  assert.match(no.err, /lane film has not approved its "publish" gate/);
  assert.match(send(e, ["--to", "deployer", "--lane", "nolane"]).err, /--lane nolane: no such lane/);
  assert.match(govern(e, ["task", "send", "--to", "deployer", "--project", "elsewhere", "--task", "t", "--summary", "s"]).err, /needs a lane: pass --lane <slug>/);
  approve(e, "film", "publish");
  const yes = send(e, ["--to", "deployer"]);
  assert.equal(yes.code, 0, yes.err);
  // the approval is withdrawn before the dispatcher runs it: the dispatcher re-checks and refuses
  approve(e, "film", null);
  const d = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.match(d.out, /→ deployer: refused: lane film has not approved its "publish" gate/);
  assert.ok(!existsSync(join(e.root, "claude.log")), "no session started");
  assert.match(govern(e, ["task", "list"]).out, /BLOCKED\s+dispatcher→owner \[film\/t\] deployer refused: .*"publish" gate/);
  assert.match(govern(e, ["task", "list", "--state", "failed"]).out, /TASK/);
});

test("--lane names a different lane than --project, and a gate the lane's process does not declare cannot authorise", () => {
  const e = env();
  deployWorkspace(e);
  govern(e, ["new", "docs", "--process", "dev"]);
  assert.match(send(e, ["--to", "deployer", "--lane", "docs"]).err, /lane docs's process "dev" has no "publish" gate/);
  approve(e, "film", "publish");
  const r = govern(e, ["task", "send", "--to", "deployer", "--project", "elsewhere", "--task", "t", "--summary", "s", "--lane", "film"]);
  assert.equal(r.code, 0, r.err);
  const id = present(r.out.match(/queued (\S+)/)?.[1], "id");
  assert.equal(JSON.parse(readFileSync(join(e.root, "queue", "open", `${id}.json`), "utf8")).lane, "film");
  assert.equal(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).code, 0);
  assert.equal(jsonl(join(e.root, "claude.log")).length, 1);
});

// ---------------------------------------------------------------- the grant self-test

test("caps --check runs one sealed probe per capability with haiku, verifies each reply and records the result with the profile's hash", () => {
  const e = env();
  const r = govern(e, ["caps", "--check", "researcher"], { FAKE_CLAUDE_SCRIPT: script(e, "pass", RESEARCHER_OK) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /web\s+ok/);
  assert.match(r.out, /gh-read\s+ok/);
  assert.match(r.out, /researcher: check passed \(3 capabilities\)/);
  const calls = jsonl(join(e.root, "claude.log"));
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.argv[c.argv.indexOf("--model") + 1], "haiku");
    assert.ok(c.argv.includes("--strict-mcp-config") && c.argv.includes("--setting-sources"));
    assert.equal(c.argv[c.argv.indexOf("--allowedTools") + 1], "WebSearch", "the probe runs under the profile's own grant");
    assert.match(c.cwd, /checks\/researcher\/run-/);
  }
  const rec = checks(e, "researcher");
  assert.equal(rec.ok, true);
  assert.equal(rec.profile, "researcher");
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(rec.results.map((x: { capability: string; status: string }) => [x.capability, x.status]), [["web", "ok"], ["gh-read", "ok"], ["read", "ok"]]);
  assert.equal(rec.model, "haiku");
  assert.deepEqual(readdirSync(join(e.root, "queue", "checks")), ["researcher.json"], "the probe folders are removed");
  assert.match(govern(e, ["caps", "researcher"]).out, /check: passed/);
});

test("a refused probe is a failed check: the dispatcher refuses the profile, naming the failing capability", () => {
  const e = env();
  const bad = script(e, "refused", [ok("web", "Example Domain"), { result: { capability: "gh-read", status: "refused", evidence: "gh requires approval" } }, ok("read", "NONCE")]);
  const r = govern(e, ["caps", "--check", "researcher"], { FAKE_CLAUDE_SCRIPT: bad });
  assert.equal(r.code, 1);
  assert.match(r.out, /gh-read\s+refused\s+gh requires approval/);
  assert.match(r.out, /researcher: check FAILED \(gh-read\)/);
  assert.equal(checks(e, "researcher").ok, false);
  const before = jsonl(join(e.root, "claude.log")).length;
  assert.equal(send(e, ["--to", "researcher"]).code, 0);
  const d = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.match(d.out, /→ researcher: refused: the last self-test of profile researcher failed \(gh-read\); fix the grant and run govern caps --check researcher/);
  assert.equal(jsonl(join(e.root, "claude.log")).length, before, "no session started");
});

test("an unparseable, unknown-key, wrong-capability or unsupported reply fails the check (strict parse)", () => {
  const e = env();
  const cases: [string, unknown, RegExp][] = [
    ["prose", "I could read the file, it says hello", /invalid reply: not JSON/],
    ["extra key", { capability: "read", status: "ok", evidence: "NONCE", note: "hi" }, /invalid reply: .*unknown key "note"/],
    ["bad status", { capability: "read", status: "fine", evidence: "NONCE" }, /invalid reply: .*"ok" or "refused" or "error"/],
    ["wrong capability", { capability: "web", status: "ok", evidence: "NONCE" }, /invalid reply: answered for web, asked about read/],
    ["no evidence of the nonce", { capability: "read", status: "ok", evidence: "I read it, trust me" }, /invalid reply: evidence does not contain the probe's expected text/],
  ];
  for (const [label, result, re] of cases) {
    const r = govern(e, ["caps", "--check", "claude-read"], { FAKE_CLAUDE_SCRIPT: script(e, "case", [{ result }]) });
    assert.equal(r.code, 1, label);
    assert.match(r.out, re, label);
    assert.equal(checks(e, "claude-read").ok, false, label);
  }
  // a fenced reply is accepted: the model's habit, not a violation
  const fenced = govern(e, ["caps", "--check", "claude-read"], { FAKE_CLAUDE_SCRIPT: script(e, "fenced", [{ result: "```json\n" + JSON.stringify({ capability: "read", status: "ok", evidence: "NONCE" }) + "\n```" }]) });
  assert.equal(fenced.code, 0, fenced.out);
});

test("govern verifies a write probe on disk, whatever the model claims", () => {
  const e = env();
  const claims = { result: { capability: "edit", status: "ok", evidence: "wrote NONCE to written.txt" } };
  const liar = govern(e, ["caps", "--check", "claude-write"], { FAKE_CLAUDE_SCRIPT: script(e, "liar", [ok("read", "NONCE"), claims]) });
  assert.equal(liar.code, 1);
  assert.match(liar.out, /edit\s+invalid reply: written\.txt was not written with the probe's text/);
  const honest = govern(e, ["caps", "--check", "claude-write"], { FAKE_CLAUDE_SCRIPT: script(e, "honest", [ok("read", "NONCE"), { ...claims, write: { path: "written.txt", text: "NONCE" } }]) });
  assert.equal(honest.code, 0, honest.out);
});

test("the dispatcher refuses a profile whose definition changed since its last passing check, and one never checked when a check is required", () => {
  const e = env();
  write(join(e.root, "caps", "p.json"), JSON.stringify({ version: 1, profiles: [{ name: "lookup", engine: "claude", capabilities: ["read"] }] }));
  // never checked, check required
  send(e, ["--to", "lookup"]);
  assert.match(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out, /→ lookup: refused: profile lookup has not passed a self-test; run govern caps --check lookup/);
  assert.equal(govern(e, ["caps", "--check", "lookup"], { FAKE_CLAUDE_SCRIPT: script(e, "p", [ok("read", "NONCE")]) }).code, 0);
  send(e, ["--to", "lookup"]);
  assert.match(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out, /→ lookup: ACK/);
  // the definition changes: the record is older than it
  write(join(e.root, "caps", "p.json"), JSON.stringify({ version: 1, profiles: [{ name: "lookup", engine: "claude", model: "opus", capabilities: ["read"] }] }));
  assert.match(govern(e, ["caps", "lookup"]).out, /check: stale/);
  send(e, ["--to", "lookup"]);
  assert.match(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out, /→ lookup: refused: profile lookup changed since its last self-test; run govern caps --check lookup/);
  // the same applies to a built-in profile that has a record, and the legacy four need none
  send(e, ["--to", "claude"]);
  assert.match(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out, /→ claude: ACK/);
});

test("the check works for codex profiles through the same sealed runner", () => {
  const e = env();
  const probe = reply(e, "cx", { capability: "read", status: "ok", evidence: "x" });
  const r = govern(e, ["caps", "--check", "codex-read"], { FAKE_CODEX_SCRIPTS: probe });
  assert.equal(r.code, 1, "the fake codex cannot read probe.txt, so the nonce is missing: the check fails closed");
  assert.match(r.out, /read\s+invalid reply: evidence does not contain/);
  const argv = present(jsonl(join(e.root, "argv.log"))[0], "codex call");
  assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
});
