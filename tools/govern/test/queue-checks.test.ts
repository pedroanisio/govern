// A check chosen by the sender (`task send --check NAME`): how NAME is resolved, refused, recorded and shown, and the desk's count of replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, reply, present, HERE, type Env } from "./helpers.ts";

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, GOVERN_CAPABILITIES: join(e.root, "caps") });
  mkdirSync(join(e.root, "caps"), { recursive: true });
  return e;
}
const config = (e: Env, v: unknown) => write(join(e.root, "queue", "config.json"), JSON.stringify(v));
const pass = { argv: [process.execPath, "-e", "console.log('2 things fine')"], label: "things" };
const fail = { argv: [process.execPath, "-e", "console.error('nope'); process.exit(1)"] };
const sendTo = (e: Env, args: string[] = [], to = "codex") => govern(e, ["task", "send", "--to", to, "--project", "film", "--task", "t", "--summary", "s", ...args]);
const dispatch = (e: Env, body = "an answer", kind = "NOTICE") => govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", { kind, summary: "an answer", body }) });
const opened = (e: Env) => !existsSync(join(e.root, "queue", "open")) ? [] : readdirSync(join(e.root, "queue", "open")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(e.root, "queue", "open", f), "utf8")));
const filed = (e: Env) => present(opened(e).find((m) => m.from === "codex" || m.from === "scout"), "the reply");

test("an unknown check name is refused at send with exit 4, listing the names there are", () => {
  const e = env();
  config(e, { checks: { named: { "my-lint": pass } } });
  const r = sendTo(e, ["--check", "nope"]);
  assert.equal(r.code, 4);
  assert.match(r.err, /--check nope: no such check \(have: claims-cited, commit-refs, file-refs, my-lint\)/);
  assert.equal(opened(e).length, 0, "nothing was queued");
  assert.equal(sendTo(e, ["--check", "my-lint", "--check", "my-lint"]).code, 0, "the same name twice is one check");
});

test("a named check is resolved: the profile's capabilities file first, then config.json named, then the built-ins", () => {
  const e = env();
  write(join(e.root, "caps", "scout.json"), JSON.stringify({ version: 1, profiles: [{ name: "scout", engine: "claude", capabilities: ["read"], selfTest: "optional" }], checks: { "file-refs": fail, "from-profile": pass } }));
  // built-in only: file-refs finds no reference in the reply, so it is unverified
  sendTo(e, ["--check", "file-refs"]);
  dispatch(e);
  assert.equal(filed(e).verification.state, "unverified");
  assert.match(filed(e).verification.source, /built-in \(file-refs\)/);
  for (const f of readdirSync(join(e.root, "queue", "open"))) rmSync(join(e.root, "queue", "open", f));
  // config.json named wins over the built-in
  config(e, { checks: { named: { "file-refs": pass } } });
  sendTo(e, ["--check", "file-refs"]);
  dispatch(e);
  assert.equal(filed(e).verification.state, "checked");
  assert.match(filed(e).verification.source, /config\.json \(file-refs\)/);
  assert.equal(filed(e).verification.label, "things (2)");
  for (const f of readdirSync(join(e.root, "queue", "open"))) rmSync(join(e.root, "queue", "open", f));
  // the profile's file wins over both, and is the only place "from-profile" exists
  assert.match(sendTo(e, ["--check", "from-profile"]).err, /no such check/, "a codex task has no profile that defines it");
  sendTo(e, ["--check", "file-refs"], "scout");
  govern(e, ["task", "dispatch"], { FAKE_CLAUDE_RESULT: JSON.stringify({ kind: "NOTICE", summary: "an answer", body: "an answer" }) });
  assert.equal(filed(e).verification.state, "unverified");
  assert.match(filed(e).verification.source, /profile \(file-refs\)/);
  for (const f of readdirSync(join(e.root, "queue", "open"))) rmSync(join(e.root, "queue", "open", f));
  assert.equal(sendTo(e, ["--check", "from-profile"], "scout").code, 0);
});

test("every named check must pass for [checked]; one failure makes the reply unverified; the labels add up", () => {
  const e = env();
  config(e, { checks: { named: { a: pass, b: { ...pass, label: "other things" }, c: fail } } });
  sendTo(e, ["--check", "a", "--check", "b"]);
  dispatch(e);
  assert.equal(filed(e).verification.state, "checked");
  assert.equal(filed(e).verification.label, "things (2), other things (2)");
  for (const f of readdirSync(join(e.root, "queue", "open"))) rmSync(join(e.root, "queue", "open", f));
  sendTo(e, ["--check", "a", "--check", "c"]);
  dispatch(e);
  assert.equal(filed(e).verification.state, "unverified");
  assert.match(filed(e).verification.reason, /nope/);
});

test("the message records its checks; task show, task list and the desk show them", () => {
  const e = env();
  config(e, { checks: { named: { a: pass, b: pass } } });
  const sent = sendTo(e, ["--check", "a", "--check", "b"]);
  const id = present(/queued (\S+)/.exec(sent.out)?.[1], "the id");
  assert.deepEqual(opened(e)[0].check, ["a", "b"]);
  assert.match(govern(e, ["task", "show", id]).out, /\ncheck: a, b/);
  assert.match(govern(e, ["task", "list"]).out, /\[check: a, b\]/);
  assert.match(govern(e, ["desk"]).out, new RegExp(`checks asked of replies .*${id}: a\\+b`));
  const fwd = govern(e, ["task", "forward", id, "--to", "grok", "--as", "owner"]);
  assert.equal(fwd.code, 0, fwd.err);
  assert.deepEqual(opened(e).find((m) => m.to === "grok")?.check, ["a", "b"], "a forwarded task keeps its checks");
});

test("a name that no longer exists at dispatch makes the reply unverified, saying which", () => {
  const e = env();
  config(e, { checks: { named: { gone: pass } } });
  sendTo(e, ["--check", "gone"]);
  config(e, {});
  dispatch(e);
  const m = filed(e);
  assert.equal(m.verification.state, "unverified");
  assert.match(m.verification.reason, /check gone is not defined/);
});

test("config.json named checks are parsed strictly: names, shape and unknown kinds name their path", () => {
  const e = env();
  for (const [what, value, path] of [
    ["a name with capitals", { checks: { named: { Bad_Name: pass } } }, "$.checks.named.Bad_Name"],
    ["a check with no argv", { checks: { named: { ok: {} } } }, "$.checks.named.ok"],
    ["a wrong argv", { checks: { named: { ok: { argv: "node" } } } }, "$.checks.named.ok.argv"],
    ["an unknown field", { checks: { named: { ok: { argv: ["node"], shell: true } } } }, "$.checks.named.ok"],
    ["named not an object", { checks: { named: ["x"] } }, "$.checks.named"],
    ["a kind that is none", { checks: { NOPE: pass } }, "$.checks.NOPE"],
  ] as const) {
    config(e, value);
    const r = sendTo(e, ["--check", "ok"]);
    assert.notEqual(r.code, 0, what);
    assert.ok(r.err.includes(path), `${what}: ${r.err}`);
  }
  config(e, { checks: { HANDOFF: pass, named: { ok: pass } } });
  assert.equal(sendTo(e, ["--check", "ok"]).code, 0, "kind checks and named checks sit together");
});

test("a capabilities file with a malformed checks map is refused, naming the path", () => {
  const e = env();
  write(join(e.root, "caps", "bad.json"), JSON.stringify({ version: 1, checks: { x: { argv: [] } } }));
  const r = govern(e, ["caps"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /bad\.json.*\$\.checks\.x\.argv/);
});

test("the desk counts today's replies: checked, shape only, unverified, repaired", () => {
  const e = env();
  config(e, { checks: { named: { a: pass, c: fail } } });
  sendTo(e, ["--check", "a"]);
  dispatch(e);
  sendTo(e);
  dispatch(e);
  sendTo(e, ["--check", "c"]);
  dispatch(e);
  assert.match(govern(e, ["desk"]).out, /QUEUE .*replies today: 1 checked · 1 shape only · 1 unverified · 0 repaired/);
});
