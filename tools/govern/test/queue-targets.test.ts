import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, childEnv, govern } from "./helpers.ts";
import { checkRecipient } from "../lib/sessions.ts";
import { GovernError } from "../lib/util.ts";

const SEND = ["task", "send", "--project", "film", "--task", "check", "--summary", "review"];

for (const engine of ["claude", "codex", "grok"]) for (const access of ["read", "write"]) {
  const profile = `${engine}-${access}`, alternative = `--to ${engine}${access === "write" ? " --write" : ""}`;
  test(`legacy target ${profile} refusal names the equivalent target and profile`, (t) => {
    const back = process.env;
    process.env = childEnv(makeEnv("legacy-target"));
    t.after(() => { process.env = back; });
    assert.throws(() => checkRecipient(profile, ["claude", "codex", "grok", "researcher"]), (e: unknown) => {
      assert.ok(e instanceof GovernError);
      assert.equal(e.code, 4);
      assert.match(e.message, /profile.*not.*--to/);
      assert.ok(e.message.includes(alternative), e.message);
      assert.ok(e.message.includes(`--profile ${profile}`), e.message);
      return true;
    });
  });
  test(`task send legacy target ${profile} names ${alternative}`, { timeout: 10000 }, () => {
    const r = govern(makeEnv("legacy-target-cli"), [...SEND, "--to", profile]);
    assert.equal(r.code, 4, r.err);
    assert.ok(r.err.includes(alternative), r.err);
    assert.ok(r.err.includes(`--profile ${profile}`), r.err);
  });
}
