// Capability registry, profiles, sealed sessions, guarded classes and the grant self-test (docs/govern-features.md 3.3, 3.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  mkdirSync(join(e.root, "caps"), { recursive: true });
  return e;
}
const ANSWER = JSON.stringify({ kind: "ACK", summary: "done", body: "ok" });
const checks = (e: Env, profile: string) => JSON.parse(readFileSync(join(e.root, "queue", "checks", `${profile}.json`), "utf8"));
/** A FAKE_CLAUDE_SCRIPT: one step per call. */
function script(e: Env, name: string, steps: unknown[]) { return write(join(e.root, `${name}.json`), JSON.stringify(steps)); }
const ok = (capability: string, evidence: string) => ({ result: { capability, status: "ok", evidence } });
/** The reply of a model that correctly cannot use the capability it was asked to try (the negative probe). */
const no = (capability: string) => ({ result: { capability, status: "refused", evidence: `${capability} is not available in this session` } });
/** The passing probe replies of the researcher profile: web, gh-read, read, then the negative probe of edit. */
const RESEARCHER_OK = [ok("web", "Example Domain"), ok("gh-read", "cli"), ok("read", "NONCE"), no("edit")];
/** The built-in tools a read-only profile does not grant (lib/caps.ts CLAUDE_BUILTIN minus Read, Grep, Glob). */
const DENY_RO = ["Agent", "Bash", "Edit", "NotebookEdit", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write"];
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

test("a workspace adds capabilities and profiles, may override a built-in profile but not a built-in capability; a bad file names its path", () => {
  const e = env();
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1,
    capabilities: [
      { name: "deploy", description: "push a build to staging", call: "Bash(deploy:*)", claude: { allow: ["Bash(deploy:*)"] }, effect: "publish", resource: "staging", cost: "none", secrets: ["DEPLOY_TOKEN"], probe: { instruction: "run deploy --dry-run", expect: "dry" } },
    ],
    profiles: [{ name: "deployer", engine: "claude", capabilities: ["deploy", "read"] }] }));
  const out = govern(e, ["caps", "deployer"]).out;
  assert.match(out, /deploy\s+publish\s.*Bash\(deploy:\*\)/);
  assert.match(out, /resource: staging/);
  assert.match(out, /secrets: DEPLOY_TOKEN \(names only\)/);
  assert.match(out, /classes: publish, read/);
  // a workspace file cannot redefine a built-in capability: the name, the file and the reason are in the error
  write(join(e.root, "caps", "deploy.json"), JSON.stringify({ version: 1, capabilities: [{ name: "web", description: "no web here", call: "none", claude: { allow: ["WebFetch"] }, effect: "read" }] }));
  assert.match(govern(e, ["caps"]).err, /deploy\.json: capability "web" is a built-in and cannot be redefined/);
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
  mkdirSync(join(e.projects, "film"), { recursive: true }); // a write profile runs only in an existing project folder
  send(e, ["--to", "claude"]);
  send(e, ["--to", "claude", "--write"]);
  const r = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.equal(r.code, 0, r.err);
  const [read, wr] = jsonl(log);
  assert.deepEqual(present(read, "the read call").argv, ["-p", "--output-format", "json", "--model", "sonnet", "--allowedTools", "Read", "Grep", "Glob", "--tools", "Read", "Grep", "Glob", "--disallowedTools", ...DENY_RO, "--setting-sources", "", "--strict-mcp-config"]);
  assert.deepEqual(present(wr, "the write call").argv, ["-p", "--output-format", "json", "--model", "sonnet", "--permission-mode", "acceptEdits", "--allowedTools", "Read", "Grep", "Glob", "Edit", "Write", "--tools", "Read", "Grep", "Glob", "Edit", "Write", "--disallowedTools", "Agent", "Bash", "NotebookEdit", "Task", "TodoWrite", "WebFetch", "WebSearch", "--setting-sources", "", "--strict-mcp-config"]);
  assert.match(present(read, "the read call").input, /You are the "claude" agent/, "the prompt is on stdin: a variadic --tools would swallow a positional one");
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
  assert.deepEqual(present(a, "pinned call").argv, ["-p", "--output-format", "json", "--model", "opus", "--allowedTools", "Read", "Grep", "Glob", "--tools", "Read", "Grep", "Glob", "--disallowedTools", ...DENY_RO, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", join(e.root, "caps", "mcp", "pinned.json")]);
  assert.equal(present(b, "floating call").argv[4], "haiku");
});

test("codex profiles keep the old sandbox mapping; a profile's -c settings and add-dir reach codex exec", () => {
  const e = env();
  mkdirSync(join(e.projects, "film"), { recursive: true });
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
  assert.match(send(e, ["--to", "deployer", "--lane", "nolane"]).err, /--lane nolane must be the message's project \(film\) or its parent lane \(it has none\)/);
  assert.match(govern(e, ["task", "send", "--to", "deployer", "--project", "nolane", "--lane", "nolane", "--task", "t", "--summary", "s"]).err, /--lane nolane: no such lane/);
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
  assert.match(govern(e, ["task", "send", "--to", "deployer", "--project", "docs", "--task", "t", "--summary", "s"]).err, /lane docs's process "dev" has no "publish" gate/);
  approve(e, "film", "publish");
  // a lane that is neither the message's project nor its parent cannot authorise it
  const stray = govern(e, ["task", "send", "--to", "deployer", "--project", "elsewhere", "--task", "t", "--summary", "s", "--lane", "film"]);
  assert.notEqual(stray.code, 0);
  assert.match(stray.err, /--lane film must be the message's project \(elsewhere\) or its parent lane/);
  govern(e, ["new", "film-ep", "--kind", "long", "--title", "Episode", "--parent", "film"]);
  const r = govern(e, ["task", "send", "--to", "deployer", "--project", "film-ep", "--task", "t", "--summary", "s", "--lane", "film"]);
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
  assert.match(r.out, /researcher: check passed \(4 probes\)/);
  const calls = jsonl(join(e.root, "claude.log"));
  assert.equal(calls.length, 4, "three grants and one negative probe");
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
  assert.deepEqual(rec.results.map((x: { capability: string; status: string }) => [x.capability, x.status]), [["web", "ok"], ["gh-read", "ok"], ["read", "ok"], ["not-edit", "ok"]]);
  assert.equal(rec.model, "haiku");
  assert.deepEqual(readdirSync(join(e.root, "queue", "checks")), ["researcher.json"], "the probe folders are removed");
  assert.match(govern(e, ["caps", "researcher"]).out, /check: passed/);
});

test("a refused probe is a failed check: the dispatcher refuses the profile, naming the failing capability", () => {
  const e = env();
  const bad = script(e, "refused", [ok("web", "Example Domain"), { result: { capability: "gh-read", status: "refused", evidence: "gh requires approval" } }, ok("read", "NONCE"), no("edit")]);
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

test("the negative probe fails the check when a capability the profile lacks works anyway", () => {
  const e = env();
  const leak = script(e, "leak", [...RESEARCHER_OK.slice(0, 3), ok("edit", "wrote it")]);
  const r = govern(e, ["caps", "--check", "researcher"], { FAKE_CLAUDE_SCRIPT: leak });
  assert.equal(r.code, 1);
  assert.match(r.out, /not-edit\s+leaked\s+edit is not granted/);
  assert.match(r.out, /researcher: check FAILED \(not-edit\)/);
  assert.equal(checks(e, "researcher").ok, false);
});

test("the negative probe passes when the model reports an error for the missing tool and leaves no trace of it", () => {
  const e = env();
  const missing = { result: { capability: "edit", status: "error", evidence: "Write tool not available in function list" } };
  const r = govern(e, ["caps", "--check", "researcher"], { FAKE_CLAUDE_SCRIPT: script(e, "missing", [...RESEARCHER_OK.slice(0, 3), missing]) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /not-edit\s+ok/);
  assert.match(r.out, /researcher: check passed \(4 probes\)/);
});

const MINE = (probe: Record<string, unknown> | undefined, selfTest: "required" | "optional" = "required") => JSON.stringify({ version: 1,
  capabilities: [{ name: "mine", description: "a custom grant", call: "Read", claude: { allow: ["Read"] }, effect: "read", ...(probe ? { probe } : {}) }],
  profiles: [{ name: "mine-only", engine: "claude", capabilities: ["mine"], selfTest }] });

test("codex profiles are labelled not sealed in the listing, the detail and nowhere on claude profiles", () => {
  const e = env();
  const list = govern(e, ["caps"]).out;
  assert.match(list, /^  codex-write .*not sealed \(inherits ~\/\.codex\)/m);
  assert.match(list, /^  codex-read .*not sealed \(inherits ~\/\.codex\)/m);
  assert.doesNotMatch(list, /^  (claude-read|claude-write|researcher) .*not sealed/m);
  assert.match(govern(e, ["caps", "codex-read"]).out, /^codex: .*not sealed \(inherits ~\/\.codex\)/m);
  assert.doesNotMatch(govern(e, ["caps", "researcher"]).out, /not sealed/);
});

test("an explicitly set GOVERN_CAPABILITIES that does not exist is an error; an unset one keeps the default", () => {
  const e = env();
  const gone = join(e.root, "no-such-caps");
  const r = govern(e, ["caps"], { GOVERN_CAPABILITIES: gone });
  assert.notEqual(r.code, 0);
  assert.match(r.err, new RegExp(`GOVERN_CAPABILITIES=${gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} does not exist`));
  delete e.env.GOVERN_CAPABILITIES;
  assert.equal(govern(e, ["caps"]).code, 0, "unset: the default folder, which may be absent");
});

test("an allow pattern for a push, publish or spend command must come with that guarded effect, or the file is rejected", () => {
  const cap = (allow: string, effect: string) => JSON.stringify({ version: 1, capabilities: [{ name: "ship", description: "d", call: "c", claude: { allow: [allow] }, effect }] });
  const e = env();
  for (const [allow, effect, why] of [["Bash(git push:*)", "read", "git push"], ["Bash(npm publish:*)", "write", "npm publish"], ["Bash(git:*)", "read", "git push"], ["Bash", "read", "git push"]] as const) {
    write(join(e.root, "caps", "s.json"), cap(allow, effect));
    const r = govern(e, ["caps"]);
    assert.notEqual(r.code, 0, allow);
    assert.match(r.err, new RegExp(`s\\.json: capability ship: .*${why}.*declare`), allow);
  }
  write(join(e.root, "caps", "s.json"), cap("Bash(git push:*)", "push"));
  assert.equal(govern(e, ["caps"]).code, 0);
  write(join(e.root, "caps", "s.json"), cap("Bash(git log:*)", "read"));
  assert.equal(govern(e, ["caps"]).code, 0, "a read-only git pattern needs no guarded effect");
});

test("an untested capability fails the check of a profile that requires one, and is shown prominently; an optional profile may keep it", () => {
  const e = env();
  write(join(e.root, "caps", "m.json"), MINE(undefined));
  const r = govern(e, ["caps", "--check", "mine-only"], { FAKE_CLAUDE_SCRIPT: script(e, "m", [no("read")]) });
  assert.equal(r.code, 1);
  assert.match(r.out, /mine\s+untested\s+the capability defines no probe/);
  assert.match(r.out, /mine-only: check FAILED \(mine\)/);
  assert.equal(checks(e, "mine-only").ok, false);
  assert.match(govern(e, ["caps"]).out, /mine-only .*UNTESTED: mine/);
  assert.match(govern(e, ["caps", "mine-only"]).out, /mine\s+read\s+Read\s+NOT TESTED: no probe/);
  assert.match(govern(e, ["task", "dispatch"]).out, /^(?!.*→ mine-only: ACK)/s);
  write(join(e.root, "caps", "m.json"), MINE(undefined, "optional"));
  const o = govern(e, ["caps", "--check", "mine-only"], { FAKE_CLAUDE_SCRIPT: script(e, "m2", [no("read")]) });
  assert.equal(o.code, 0, o.out);
  assert.match(o.out, /mine\s+untested/);
});

test("a probe's expectCmd runs under govern and its output must appear in the reply; a failing command is an error, not a refusal", () => {
  const e = env();
  const probe = (cmd: string[]) => ({ instruction: "Report the value.", expectCmd: cmd });
  write(join(e.root, "caps", "m.json"), MINE(probe(["node", "-e", "console.log('value-' + 6 * 7)"])));
  const good = govern(e, ["caps", "--check", "mine-only"], { FAKE_CLAUDE_SCRIPT: script(e, "g", [ok("mine", "it is value-42"), no("read")]) });
  assert.equal(good.code, 0, good.out);
  const wrong = govern(e, ["caps", "--check", "mine-only"], { FAKE_CLAUDE_SCRIPT: script(e, "w", [ok("mine", "it is value-41"), no("read")]) });
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /mine\s+invalid reply: evidence does not contain the output of the probe's expectCmd/);
  write(join(e.root, "caps", "m.json"), MINE(probe(["node", "-e", "process.exit(3)"])));
  const broken = govern(e, ["caps", "--check", "mine-only"], { FAKE_CLAUDE_SCRIPT: script(e, "b", [ok("mine", "anything"), no("read")]) });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /mine\s+error\s+expectCmd failed: exit 3/);
  write(join(e.root, "caps", "m.json"), MINE({ instruction: "x", expectCmd: "node -v" }));
  const bad = govern(e, ["caps"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /m\.json.*expectCmd/);
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
  const fenced = govern(e, ["caps", "--check", "claude-read"], { FAKE_CLAUDE_SCRIPT: script(e, "fenced", [{ result: "```json\n" + JSON.stringify({ capability: "read", status: "ok", evidence: "NONCE" }) + "\n```" }, no("edit")]) });
  assert.equal(fenced.code, 0, fenced.out);
});

test("govern verifies a write probe on disk, whatever the model claims", () => {
  const e = env();
  const claims = { result: { capability: "edit", status: "ok", evidence: "wrote NONCE to written.txt" } };
  const liar = govern(e, ["caps", "--check", "claude-write"], { FAKE_CLAUDE_SCRIPT: script(e, "liar", [ok("read", "NONCE"), claims, no("web")]) });
  assert.equal(liar.code, 1);
  assert.match(liar.out, /edit\s+invalid reply: written\.txt was not written with the probe's text/);
  const honest = govern(e, ["caps", "--check", "claude-write"], { FAKE_CLAUDE_SCRIPT: script(e, "honest", [ok("read", "NONCE"), { ...claims, write: { path: "written.txt", text: "NONCE" } }, no("web")]) });
  assert.equal(honest.code, 0, honest.out);
});

test("the dispatcher refuses a profile whose definition changed since its last passing check, and one never checked when a check is required", () => {
  const e = env();
  write(join(e.root, "caps", "p.json"), JSON.stringify({ version: 1, profiles: [{ name: "lookup", engine: "claude", capabilities: ["read"] }] }));
  // never checked, check required
  send(e, ["--to", "lookup"]);
  assert.match(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out, /→ lookup: refused: profile lookup has not passed a self-test; run govern caps --check lookup/);
  assert.equal(govern(e, ["caps", "--check", "lookup"], { FAKE_CLAUDE_SCRIPT: script(e, "p", [ok("read", "NONCE"), no("edit")]) }).code, 0);
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

// ---------------------------------------------------------------- grok profiles

test("grok-read and grok-write are built in, listed with the engines each capability supports, and shown with their grok flags", () => {
  const e = env();
  const list = govern(e, ["caps"]).out;
  assert.match(list, /^  read\s+read\s+claude, codex, grok\s/m);
  assert.match(list, /^  web\s+read\s+claude only\s/m);
  assert.match(list, /^  grok-read\s+grok\s+read\s.*check: not run/m);
  assert.match(list, /^  grok-write\s+grok\s+read\+edit\s/m);
  const r = govern(e, ["caps", "grok-write"]).out;
  assert.match(r, /engine: grok/);
  assert.match(r, /^grok: --tools Read,Grep,Glob,Edit,Write · --permission-mode acceptEdits · --allow Edit --allow Write · private HOME · GROK_CLAUDE_(MCPS|SKILLS|HOOKS)_ENABLED=0/m);
  assert.match(govern(e, ["caps", "grok-read"]).out, /^grok: --tools Read,Grep,Glob · --permission-mode dontAsk · private HOME/m);
  assert.match(govern(e, ["caps", "researcher"]).out, /^grok: not available on grok \(web, gh-read\)/m);
  assert.match(govern(e, ["caps", "grok-read"]).out, /^grok: .*not fully sealed \(project-level config under the cwd, built-in agents and bundled skills still load\)/m);
});

test("a grok profile that holds a capability grok cannot honour fails to load with a clear message; grok names are reserved", () => {
  const e = env();
  write(join(e.root, "caps", "bad.json"), JSON.stringify({ version: 1, profiles: [{ name: "grok-web", engine: "grok", capabilities: ["web"] }] }));
  const r = govern(e, ["caps"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /profile grok-web: capability web is not available on grok/);
  write(join(e.root, "caps", "bad.json"), JSON.stringify({ version: 1, profiles: [{ name: "grok", engine: "grok", capabilities: ["read"] }] }));
  assert.match(govern(e, ["caps"]).err, /profile name "grok" is reserved/);
});

test("an allow pattern that can run grok must come with the spend effect", () => {
  const e = env();
  write(join(e.root, "caps", "g.json"), JSON.stringify({ version: 1, capabilities: [{ name: "gk", description: "d", call: "Bash(grok:*)", claude: { allow: ["Bash(grok:*)"] }, effect: "read" }] }));
  assert.match(govern(e, ["caps"]).err, /can run grok; declare effect spend \(it says read\)/);
});

test("the check runs the same probes for a grok profile, including the negative probe, with the profile's own flags", () => {
  const e = env();
  const probes = script(e, "gk", [ok("read", "NONCE"), no("edit")]);
  const r = govern(e, ["caps", "--check", "grok-read"], { FAKE_GROK_SCRIPT: probes, FAKE_GROK_COUNTER: join(e.root, "grok-count") });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /grok-read: check passed \(2 probes\)/);
  const calls = jsonl(join(e.root, "grok.log"));
  assert.equal(calls.length, 2, "one grant and one negative probe");
  for (const c of calls) {
    assert.equal(c.argv[c.argv.indexOf("--tools") + 1], "Read,Grep,Glob", "the probe runs under the profile's own grant");
    assert.match(c.cwd, /checks\/grok-read\/run-/);
  }
  const rec = checks(e, "grok-read");
  assert.deepEqual(rec.results.map((x: { capability: string; status: string }) => [x.capability, x.status]), [["read", "ok"], ["not-edit", "ok"]]);
  assert.match(govern(e, ["caps", "grok-read"]).out, /check: passed/);
});

test("the negative probe fails a grok check when a capability the profile lacks works anyway", () => {
  const e = env();
  const leak = script(e, "gk-leak", [ok("read", "NONCE"), ok("edit", "wrote it")]);
  const r = govern(e, ["caps", "--check", "grok-read"], { FAKE_GROK_SCRIPT: leak, FAKE_GROK_COUNTER: join(e.root, "grok-count") });
  assert.equal(r.code, 1);
  assert.match(r.out, /not-edit\s+leaked/);
});

// ---------------------------------------------------------------- the dispatcher never crashes on a message it cannot seal

/** A message written straight into the queue, as an older sender or a hand edit would leave it (no profile unless given). */
function rawMessage(e: Env, id: string, over: Record<string, unknown>) {
  const m = { id, project: "film", task: "t", kind: "TASK", from: "owner", to: "claude", summary: "s", body: "b", files: [], created: "2026-10-14T00:00:00.000Z", access: "read-only", ...over };
  write(join(e.root, "queue", "open", `${id}.json`), JSON.stringify(m));
}

test("a queued message to claude without a profile runs under the default profile of its access, never crashes the dispatcher", () => {
  const e = env();
  rawMessage(e, "20261014-000001-claude-aaaa", {});
  rawMessage(e, "20261014-000002-claude-bbbb", { access: "write" });
  govern(e, ["new", "film", "--kind", "long", "--title", "Film"]);
  const d = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.equal(d.code, 0, d.err);
  const [ro, rw] = jsonl(join(e.root, "claude.log"));
  assert.deepEqual(present(ro, "read call").argv.slice(5, 8), ["--allowedTools", "Read", "Grep"]);
  assert.ok(present(rw, "write call").argv.includes("Edit"));
});

test("a queued message whose profile no longer exists fails cleanly with a plain reason and the next message still runs", () => {
  const e = env();
  rawMessage(e, "20261014-000001-claude-aaaa", { profile: "gone" });
  rawMessage(e, "20261014-000002-claude-bbbb", { profile: "claude-read" });
  govern(e, ["new", "film", "--kind", "long", "--title", "Film"]);
  const d = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /20261014-000001-claude-aaaa → claude: refused: profile gone does not exist/);
  assert.match(d.out, /20261014-000002-claude-bbbb → claude: ACK/);
  assert.ok(existsSync(join(e.root, "queue", "failed", "20261014-000001-claude-aaaa.json")));
  assert.equal(jsonl(join(e.root, "claude.log")).length, 1);
});

test("a write profile runs only in an existing project folder; a read profile may fall back to the repo", () => {
  const e = env();
  rawMessage(e, "20261014-000001-claude-aaaa", { project: "nolane", access: "write", profile: "claude-write" });
  rawMessage(e, "20261014-000002-claude-bbbb", { project: "nolane", profile: "claude-read" });
  const d = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /20261014-000001-claude-aaaa → claude: refused: profile claude-write may change files, and the project folder .*nolane does not exist/);
  assert.match(d.out, /20261014-000002-claude-bbbb → claude: ACK/);
  assert.equal(jsonl(join(e.root, "claude.log")).length, 1, "only the read run started a session");
});
