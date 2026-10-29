import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "../ext/conversation/conversation-adapters.ts";
import * as sessions from "../lib/conversation.ts";
import { CODEX_CONFIG_TOML, prepareCodexHome } from "../lib/codexhome.ts";
import { childEnv, fixture, makeEnv, write, type Env } from "./helpers.ts";

function isolated(f: (e: Env) => void) {
  const e = makeEnv("conversation-codex-home"), previous = process.env;
  process.env = childEnv(e);
  process.env.CODEX_HOME = join(e.root, "user-codex");
  write(join(process.env.CODEX_HOME, "auth.json"), "original login");
  write(join(process.env.CODEX_HOME, "config.toml"), "user config must not load");
  try { f(e); } finally { process.env = previous; }
}

for (const override of [false, true]) test(`Codex conversation seals ${override ? "overridden" : "default"} home and preserves conversation env`, () => isolated((e) => {
  if (override) process.env.GOVERN_CODEX_HOME = join(e.root, "private-codex");
  const home = override ? process.env.GOVERN_CODEX_HOME! : join(e.env.XDG_STATE_HOME!, "govern", "codex-home");
  Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_TEST: "1", CODEX_TEST: "1", GROK_AGENT: "1", GROK_SESSION_ID: "session" });
  const s = sessions.create("chat", { profile: "codex-read" }), run = sessions.send(s.id, "question").run;
  const a = build(s, run, [{ role: "user", content: "question" }]);
  try {
    assert.equal(a.env.CODEX_HOME, home);
    assert.notEqual(a.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(readFileSync(join(home, "config.toml"), "utf8"), CODEX_CONFIG_TOML);
    assert.equal(a.env.CODEX_HOME, prepareCodexHome());
    assert.equal(a.env.GOVERN_CONVERSATION_RUN, run.id);
    assert.equal(a.bin, e.env.GOVERN_CODEX_BIN);
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_TEST", "CODEX_TEST", "GROK_AGENT", "GROK_SESSION_ID"])
      assert.equal(a.env[key], undefined, key);
  } finally { a.finish(); }
}));

test("Codex conversation finish syncs refreshed auth and removes temporary files", () => isolated((e) => {
  process.env.GOVERN_CODEX_HOME = join(e.root, "private-codex");
  const home = prepareCodexHome(), real = join(process.env.CODEX_HOME!, "auth.json");
  utimesSync(real, 1, 1);
  const s = sessions.create("chat", { profile: "codex-read" }), a = build(s, sessions.send(s.id, "question").run, []);
  const temp = dirname(a.args[a.args.indexOf("-o") + 1]!);
  try {
    rmSync(join(home, "auth.json"));
    write(join(home, "auth.json"), "refreshed login");
    utimesSync(join(home, "auth.json"), 2, 2);
  } finally { a.finish(); }
  assert.equal(readFileSync(real, "utf8"), "refreshed login");
  assert.equal(existsSync(temp), false);
}));

test("fake Codex conversation child receives the sealed home", () => isolated((e) => {
  process.env.FAKE_CODEX_HOME_OUT = join(e.root, "home.jsonl");
  process.env.FAKE_CODEX_SCRIPTS = fixture("exec-ok-simple.jsonl");
  const s = sessions.create("chat", { profile: "codex-read" }), a = build(s, sessions.send(s.id, "question").run, []);
  try {
    const result = spawnSync(a.bin, a.args, { env: a.env, input: a.input, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(readFileSync(process.env.FAKE_CODEX_HOME_OUT!, "utf8"));
    assert.equal(seen.home, prepareCodexHome());
    assert.equal(seen.config, CODEX_CONFIG_TOML);
    assert.deepEqual(seen.files, ["auth.json", "config.toml"]);
  } finally { a.finish(); }
}));
