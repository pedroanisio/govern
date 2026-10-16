// Profiles checked when they change and refused unchecked, the sealed Codex home, write tasks refused on read profiles at send,
// the Grok bound, and the negative probe's choice of capability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, reply, present, HERE, type Env } from "./helpers.ts";
import { asksForChanges, WRITE_RULE } from "../lib/writeask.ts";
import { negativeCandidate, type Registry, type Capability, type Profile } from "../lib/caps.ts";

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, {
    GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_ARGV_OUT: join(e.root, "claude.log"),
    GOVERN_CAPABILITIES: join(e.root, "caps"), FAKE_CLAUDE_COUNTER: join(e.root, "claude-count"),
    GOVERN_TEST_UNCHECKED: "1", // helpers.ts seeds no passing records: the dispatcher's own check runs
  });
  mkdirSync(join(e.root, "caps"), { recursive: true });
  return e;
}
const ANSWER = JSON.stringify({ kind: "ACK", summary: "done", body: "ok" });
const script = (e: Env, name: string, steps: unknown[]) => write(join(e.root, `${name}.json`), JSON.stringify(steps));
const ok = (capability: string, evidence: string) => ({ result: { capability, status: "ok", evidence } });
const no = (capability: string) => ({ result: { capability, status: "refused", evidence: `${capability} is not available in this session` } });
const record = (e: Env, profile: string) => JSON.parse(readFileSync(join(e.root, "queue", "checks", `${profile}.json`), "utf8"));
const send = (e: Env, args: string[], summary = "look at the notes") => govern(e, ["task", "send", "--project", "film", "--task", "t", "--summary", summary, ...args]);
const lookup = (e: Env) => write(join(e.root, "caps", "p.json"), JSON.stringify({ version: 1, profiles: [{ name: "lookup", engine: "claude", capabilities: ["read"] }] }));
const claudeCalls = (e: Env) => jsonl(join(e.root, "claude.log")).length;

// ---------------------------------------------------------------- 1. no profile runs unchecked

test("a built-in profile with no check is checked by the dispatcher itself, then runs; the check carries the profile's own grant", () => {
  const e = env();
  assert.equal(send(e, ["--to", "claude"]).code, 0);
  const r = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_SCRIPT: script(e, "ok", [ok("read", "NONCE"), no("edit"), { result: ANSWER }]) });
  assert.match(r.out, /→ claude: ACK/, r.out + r.err);
  const calls = jsonl(join(e.root, "claude.log"));
  assert.equal(calls.length, 3, "two probes, then the task");
  assert.match(calls[0].cwd, /checks\/claude-read\/run-/);
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--model") + 1], "haiku");
  assert.equal(record(e, "claude-read").ok, true);
  assert.match(govern(e, ["caps", "claude-read"]).out, /check: passed/);
});

test("a failed automatic check holds the message open, names the capability and the command, and tells the sender once", () => {
  const e = env();
  send(e, ["--to", "claude"]);
  const first = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out;
  assert.match(first, /→ claude: held: the self-test of profile claude-read failed \(read, not-edit\); fix the grant and run govern caps --check claude-read/);
  assert.equal(readdirSync(join(e.root, "queue", "open")).filter((f) => f.includes("-claude-")).length, 1, "the message is still open");
  assert.equal(record(e, "claude-read").ok, false);
  const blocked = govern(e, ["task", "list", "--to", "owner"]).out.split("\n").filter((l) => /BLOCKED.*held: the self-test of profile claude-read failed/.test(l));
  assert.equal(blocked.length, 1, "one BLOCKED notice to the sender");
  // a second message on the same failed hash is refused without another check
  const before = claudeCalls(e);
  send(e, ["--to", "claude"]);
  const second = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out;
  assert.match(second, /→ claude: refused: the last self-test of profile claude-read failed/);
  assert.equal(claudeCalls(e), before, "no model call: the failed hash is not checked again");
});

test("a lock held by a live dispatcher keeps a second one from running the same check, and a lock whose holder is gone is taken over", () => {
  const e = env();
  lookup(e);
  send(e, ["--to", "lookup"]);
  // hash of the definition: find the lock name the dispatcher would use by letting a failing check create the record
  govern(e, ["task", "dispatch", "--max", "0"]);
  const hash = (() => {
    govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER });
    const h = record(e, "lookup").hash as string;
    writeFileSync(join(e.root, "queue", "checks", "lookup.json"), "not json"); // forget the record: the profile is unchecked again
    return h;
  })();
  const lock = join(e.root, "queue", "checks", `lookup.${hash.slice(0, 16)}.lock`);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  const before = claudeCalls(e);
  const held = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out;
  assert.match(held, /held: profile lookup is being self-tested by another dispatcher/);
  assert.equal(claudeCalls(e), before, "the other dispatcher's check is not repeated");
  assert.equal(existsSync(lock), true, "its lock is left alone");
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345 })); // no such process
  const taken = govern(e, ["task", "dispatch"], { FAKE_CLAUDE_SCRIPT: script(e, "ok", [ok("read", "NONCE"), no("edit"), { result: ANSWER }]) }).out;
  assert.match(taken, /→ lookup: ACK/);
  assert.equal(existsSync(lock), false, "the lock is released after the check");
});

test("caps --check --all checks every profile without a current passing check; caps tells not run, stale and failed apart", () => {
  const e = env();
  lookup(e);
  const list0 = govern(e, ["caps"]).out;
  assert.match(list0, /^  claude-read .* check: not run/m);
  assert.match(list0, /^  lookup .* check: not run/m);
  assert.doesNotMatch(list0, /not run \(required\)/);
  const pass = script(e, "all", [ok("read", "NONCE"), no("edit")]);
  assert.equal(govern(e, ["caps", "--check", "lookup"], { FAKE_CLAUDE_SCRIPT: pass }).code, 0);
  write(join(e.root, "caps", "p.json"), JSON.stringify({ version: 1, profiles: [{ name: "lookup", engine: "claude", model: "opus", capabilities: ["read"] }] }));
  assert.match(govern(e, ["caps"]).out, /^  lookup .* check: stale \(profile changed\)/m);
  const all = govern(e, ["caps", "--check", "--all"], { FAKE_CLAUDE_RESULT: ANSWER });
  assert.equal(all.code, 1, "the fake model answers no probe, so every check fails closed");
  for (const p of ["claude-read", "claude-write", "codex-read", "grok-read", "lookup", "researcher"]) assert.match(all.out, new RegExp(`^${p}:$`, "m"), p);
  const list = govern(e, ["caps"]).out;
  assert.match(list, /^  lookup .* check: failed/m);
  assert.doesNotMatch(list, /check: not run|check: stale/);
  assert.match(govern(e, ["caps", "--check", "--all"]).out, /^every profile has a current passing check$|^claude-read:$/m);
  assert.match(govern(e, ["caps", "--all"]).err, /--all goes with --check/);
  assert.match(govern(e, ["caps", "--check", "--all", "lookup"]).err, /takes no profile name/);
});

// ---------------------------------------------------------------- 2. the codex home

test("a codex run gets a private CODEX_HOME (mode 700) with a link to the login and a minimal config, never ~/.codex", () => {
  const e = env();
  delete e.env.GOVERN_TEST_UNCHECKED;
  const real = join(e.env.HOME, ".codex");
  write(join(real, "auth.json"), "{\"dummy\":true}");
  write(join(real, "config.toml"), "[projects.\"/x\"]\ntrust_level = \"trusted\"\n[mcp_servers.evil]\ncommand = \"x\"\n");
  assert.equal(send(e, ["--to", "codex"]).code, 0);
  const seen = join(e.root, "codex-home.log");
  const r = govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind: "ACK", summary: "done", body: "ok" }), FAKE_CODEX_HOME_OUT: seen });
  assert.match(r.out, /→ codex: ACK/, r.out + r.err);
  const home = join(e.env.HOME, ".local", "state", "govern", "codex-home");
  const call = present(jsonl(seen)[0], "the child's view of CODEX_HOME");
  assert.equal(call.home, home);
  assert.deepEqual(call.files, ["auth.json", "config.toml"]);
  assert.equal(call.authIsLink, true);
  assert.equal(readlinkSync(join(home, "auth.json")), join(real, "auth.json"));
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.doesNotMatch(call.config, /trust_level|mcp_servers|instructions/);
  assert.match(call.config, /cli_auth_credentials_store = "file"/);
  assert.doesNotMatch(readFileSync(join(home, "config.toml"), "utf8"), /evil/);
});

test("GOVERN_CODEX_HOME moves the private home; with no login in ~/.codex the home holds the config alone", () => {
  const e = env();
  delete e.env.GOVERN_TEST_UNCHECKED;
  const mine = join(e.root, "my-codex-home");
  send(e, ["--to", "codex"]);
  const seen = join(e.root, "codex-home.log");
  govern(e, ["task", "dispatch"], { GOVERN_CODEX_HOME: mine, FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind: "ACK", summary: "done", body: "ok" }), FAKE_CODEX_HOME_OUT: seen });
  const call = present(jsonl(seen)[0], "the child's view");
  assert.equal(call.home, mine);
  assert.deepEqual(call.files, ["config.toml"], "no login in ~/.codex: nothing to link");
  assert.equal(lstatSync(mine).isDirectory(), true);
});

test("govern caps no longer says a codex profile inherits ~/.codex, and says what remains", () => {
  const e = env();
  const out = govern(e, ["caps", "codex-write"]).out;
  assert.doesNotMatch(out, /inherits/);
  assert.match(out, /private CODEX_HOME \(login only\); not closed: AGENTS\.md/);
});

// ---------------------------------------------------------------- 3. write tasks at send

test("asksForChanges: an edit verb within six words of a file word, any case and form; nothing else", () => {
  for (const t of ["Fix the failing test", "please EDIT the file lib/x.ts now", "implement a new module for parsing", "we should rename the function foo", "Delete branch old-stuff", "add a test", "refactored caps.ts", "I wrote the commit message", "modify README.md", "create the .py script", "changes to the files"])
    assert.ok(asksForChanges(t), t);
  for (const t of ["review the notes and report", "check the claims against the sources", "what is a function of two variables", "files are fine", "", "address the tests and say whether they pass"])
    assert.equal(asksForChanges(t), undefined, t);
  assert.deepEqual(asksForChanges("fix one two three four five test"), { verb: "fix", object: "test" }, "five words between: within six");
  assert.equal(asksForChanges("fix one two three four five six test"), undefined, "six words between: too far");
  assert.deepEqual(asksForChanges("the file needs a fix"), { verb: "fix", object: "file" }, "the object may come first");
  assert.match(WRITE_RULE, /within 6 words/);
});

test("task send to a read profile refuses (exit 2) a message that asks for file changes, naming the rule, the matched words and the fix", () => {
  const e = env();
  const r = send(e, ["--to", "codex"], "fix the failing test in lib/x.ts");
  assert.equal(r.code, 2);
  assert.match(r.err, /profile codex-read cannot change files, but the message asks for it/);
  assert.match(r.err, /rule: an edit verb .* within 6 words of file/);
  assert.match(r.err, /matched "fix" and "test"/);
  assert.match(r.err, /--write \(or --profile codex-write\)/);
  assert.equal(existsSync(join(e.root, "queue", "open")) ? readdirSync(join(e.root, "queue", "open")).length : 0, 0, "nothing was queued");
  // the body counts too
  assert.equal(send(e, ["--to", "claude", "--body", "then refactor the module"], "look at the notes").code, 2);
  // --write and a write profile fix it
  for (const via of [["--to", "codex", "--write"], ["--to", "codex", "--profile", "codex-write"]]) {
    const w = send(e, via, "fix the failing test");
    assert.equal(w.code, 0, `${via.join(" ")}: ${w.err}`);
  }
  // a message that does not ask for changes goes through
  const fine = send(e, ["--to", "codex"], "report on the failing test");
  assert.equal(fine.code, 0, fine.err);
});

test("--read-only overrides the rule and records readOnlyConfirmed; it cannot be combined with --write", () => {
  const e = env();
  const r = send(e, ["--to", "codex", "--read-only"], "fix the failing test");
  assert.equal(r.code, 0, r.err);
  const id = present(r.out.match(/queued (\S+)/)?.[1], "id");
  const m = JSON.parse(readFileSync(join(e.root, "queue", "open", `${id}.json`), "utf8"));
  assert.equal(m.readOnlyConfirmed, true);
  assert.equal(m.access, "read-only");
  const plain = send(e, ["--to", "codex"], "report on the failing test").out.match(/queued (\S+)/)?.[1];
  assert.equal("readOnlyConfirmed" in JSON.parse(readFileSync(join(e.root, "queue", "open", `${plain}.json`), "utf8")), false);
  const both = send(e, ["--to", "codex", "--read-only", "--write"], "report");
  assert.equal(both.code, 2);
  assert.match(both.err, /--read-only and --write contradict/);
});

test("a reply is never subject to the write rule", () => {
  const e = env();
  const sent = send(e, ["--to", "owner", "--from", "alice"], "can you report");
  const id = present(sent.out.match(/queued (\S+)/)?.[1], "id");
  const r = govern(e, ["task", "reply", id, "--as", "owner", "--kind", "ACK", "--summary", "fix the failing test in lib/x.ts", "--body", "I will edit the file and add a test"]);
  assert.equal(r.code, 0, r.err);
});

// ---------------------------------------------------------------- 4. the Grok bound

test("task show prints bound: N turns · T s for a recorded grok run, and for no other", () => {
  const e = env();
  delete e.env.GOVERN_TEST_UNCHECKED;
  const g = send(e, ["--to", "grok"]).out.match(/queued (\S+)/)?.[1];
  const c = send(e, ["--to", "codex"]).out.match(/queued (\S+)/)?.[1];
  const gr = govern(e, ["task", "show", present(g, "grok id")]);
  assert.doesNotMatch(gr.out, /bound:/, "a message not yet run has no bound");
  govern(e, ["task", "dispatch", "--max", "0"]);
  const run = govern(e, ["task", "dispatch"], { FAKE_GROK_RESULT: ANSWER, FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind: "ACK", summary: "done", body: "ok" }),
    FAKE_CLAUDE_RESULT: ANSWER, GOVERN_GROK_MAX_TURNS: "7", GOVERN_QUEUE_TIMEOUT_SEC: "120" });
  assert.match(run.out, /→ grok:/, run.out + run.err);
  assert.match(govern(e, ["task", "show", present(g, "grok id")], { GOVERN_GROK_MAX_TURNS: "7", GOVERN_QUEUE_TIMEOUT_SEC: "120" }).out, /^bound: 7 turns · 120 s$/m);
  assert.match(govern(e, ["task", "show", present(g, "grok id")]).out, /^bound: 25 turns · 900 s$/m, "the defaults");
  assert.doesNotMatch(govern(e, ["task", "show", present(c, "codex id")]).out, /bound:/);
});

// ---------------------------------------------------------------- 5. the negative probe

const cap = (name: string, allow: string[], probe = true, grokTools?: string[]): Capability => ({
  name, description: name, call: name, claude: { allow }, effect: "read", secrets: [], file: "t.json",
  ...(grokTools ? { grok: { tools: grokTools } } : {}), ...(probe ? { probe: { instruction: "x", expect: "y" } } : {}),
});
const reg = (caps: Capability[], profile: Partial<Profile>): { reg: Registry; prof: Profile } => {
  const prof: Profile = { name: "p", description: "", engine: "claude", capabilities: [], selfTest: "required", file: "t.json", ...profile };
  return { reg: { caps: new Map(caps.map((c) => [c.name, c])), profiles: new Map([[prof.name, prof]]) }, prof };
};

test("negativeCandidate skips an absent capability whose tools a held one already grants, and asks for one it really lacks", () => {
  const caps = [cap("read", ["Read"]), cap("wt-edit", ["Edit", "Write"]), cap("edit", ["Edit", "Write"]), cap("web", ["WebSearch"])];
  const a = reg(caps, { capabilities: ["read", "wt-edit"] });
  assert.equal(negativeCandidate(a.reg, a.prof)?.name, "web", "edit is absent but wt-edit grants the same tools");
  const b = reg(caps, { capabilities: ["read", "wt-edit", "web"] });
  assert.equal(negativeCandidate(b.reg, b.prof), undefined, "nothing left to ask for");
  const bare = reg([cap("shell", ["Bash"]), cap("ls", ["Bash(ls:*)"])], { capabilities: ["shell"] });
  assert.equal(negativeCandidate(bare.reg, bare.prof), undefined, "Bash(ls) is already granted by Bash");
  const g = reg([cap("read", ["Read"], true, ["Read"]), cap("wt-edit", ["Edit"], true, ["Edit", "Write"]), cap("edit", ["Edit"], true, ["Edit", "Write"])], { engine: "grok", capabilities: ["read", "wt-edit"] });
  assert.equal(negativeCandidate(g.reg, g.prof), undefined, "grok: the same tools are held");
  const cx = reg(caps, { engine: "codex", capabilities: ["read"] });
  assert.equal(negativeCandidate(cx.reg, cx.prof), undefined, "codex has no per-tool grant");
});

const EDIT_PROBE = { instruction: "Create the file written.txt in the current folder containing exactly the contents of probe.txt, then say in evidence what you wrote.", file: { path: "written.txt", contains: "{nonce}" } };
const wtEdit = { name: "wt-edit", description: "edit under another name", call: "Edit, Write", claude: { allow: ["Edit", "Write"], permissionMode: "acceptEdits" }, effect: "write", probe: EDIT_PROBE };

test("a profile holding wt-edit but not edit passes its self-test: edit is not asked as the negative probe", () => {
  const e = env();
  write(join(e.root, "caps", "wt.json"), JSON.stringify({ version: 1, capabilities: [wtEdit], profiles: [{ name: "wt", engine: "claude", capabilities: ["read", "wt-edit"] }] }));
  const claims = { result: { capability: "wt-edit", status: "ok", evidence: "wrote NONCE" } };
  const r = govern(e, ["caps", "--check", "wt"], { FAKE_CLAUDE_SCRIPT: script(e, "wt", [ok("read", "NONCE"), { ...claims, write: { path: "written.txt", text: "NONCE" } }, no("web")]) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /not-web\s+ok/);
  assert.doesNotMatch(r.out, /not-edit|leaked/);
  assert.deepEqual(record(e, "wt").results.map((x: { capability: string }) => x.capability), ["read", "wt-edit", "not-web"]);
});

test("when no capability is left to ask for, the record and the output say negative: none applicable; it is never a leak", () => {
  const e = env();
  write(join(e.root, "caps", "wt.json"), JSON.stringify({ version: 1, capabilities: [wtEdit], profiles: [{ name: "everything", engine: "claude", capabilities: ["read", "wt-edit", "web", "gh-read", "edit"] }] }));
  const claims = { result: { capability: "wt-edit", status: "ok", evidence: "wrote NONCE" } };
  const r = govern(e, ["caps", "--check", "everything"], { FAKE_CLAUDE_SCRIPT: script(e, "all", [ok("read", "NONCE"), { ...claims, write: { path: "written.txt", text: "NONCE" } },
    ok("web", "Example Domain"), ok("gh-read", "cli"), { result: { capability: "edit", status: "ok", evidence: "wrote NONCE" }, write: { path: "written.txt", text: "NONCE" } }]) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /negative: none applicable/);
  const rec = record(e, "everything");
  assert.equal(rec.negative, "none applicable");
  assert.equal(rec.results.length, 5, "one probe per held capability and no negative probe");
  assert.match(govern(e, ["caps", "everything"]).out, /^negative: none applicable$/m);
});

test("a check record with an unknown negative value is unreadable, never trusted", () => {
  const e = env();
  lookup(e);
  govern(e, ["caps", "--check", "lookup"], { FAKE_CLAUDE_SCRIPT: script(e, "ok", [ok("read", "NONCE"), no("edit")]) });
  const f = join(e.root, "queue", "checks", "lookup.json");
  writeFileSync(f, JSON.stringify({ ...record(e, "lookup"), negative: "maybe" }));
  assert.match(govern(e, ["caps", "lookup"]).out, /check: not run/);
  send(e, ["--to", "lookup"]);
  assert.match(govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: ANSWER }).out, /→ lookup: held: the self-test of profile lookup failed/, "an unreadable record is checked again, and this fake model fails it");
});
