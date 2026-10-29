import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, childEnv, govern } from "./helpers.ts";
import { checkRecipient } from "../lib/sessions.ts";
import { GovernError } from "../lib/util.ts";
import { asksForChanges } from "../lib/writeask.ts";

const SEND = ["task", "send", "--project", "film", "--task", "check", "--summary", "review"];
const NEGATED = ["do not change any file", "don't change any file", "never edit tests", "no changes to files", "without modifying files", "do not change files or edit tests", "never edit tests and modify files", "This is READ-ONLY: do not change, create or delete any file."];
const POSITIVE = ["change the file", "please fix the test", "edit module X and do not touch Y", "do not change files; edit tests", "never edit tests. Change the file", "without modifying files, fix the test", "do not change files but edit tests"];

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

for (const text of NEGATED) test(`write detector ignores negated instruction: ${text}`, () => {
  assert.equal(asksForChanges(text), undefined);
});
for (const text of POSITIVE) test(`write detector catches positive instruction: ${text}`, () => {
  assert.ok(asksForChanges(text), text);
});

test("task send accepts negated file changes and refuses positive changes in summary or body", { timeout: 60000 }, () => {
  const e = makeEnv("negated-write-cli");
  for (const text of [...NEGATED, ...POSITIVE]) for (const field of ["--summary", "--body"]) {
    const r = govern(e, [...SEND, "--to", "codex", field, text]);
    assert.equal(r.code, NEGATED.includes(text) ? 0 : 4, `${field} ${text}: ${r.err}`);
    if (POSITIVE.includes(text)) assert.match(r.err, /profile codex-read cannot change files/);
  }
});
