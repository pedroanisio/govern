import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, govern } from "./helpers.ts";
import { EXIT_USAGE, EXIT_STATE, GovernError, fail, usage } from "../lib/util.ts";
import { jsonValue } from "../lib/cli.ts";

// The repository's exit convention: 2 is a usage error only (the command line is wrong); a refusal by the workspace's
// state exits 4, the lowest code govern does not already give another meaning (1 failed check, 3 failed Codex reply).

test("usage and state errors carry distinct codes: usage() is 2, fail() defaults to 4, an explicit code wins", () => {
  assert.equal(EXIT_USAGE, 2);
  assert.equal(EXIT_STATE, 4);
  const code = (f: () => never) => { try { f(); } catch (e) { assert.ok(e instanceof GovernError); return e.code; } return -1; };
  assert.equal(code(() => usage("govern x <slug>")), 2);
  assert.equal(code(() => fail("no such lane")), 4);
  assert.equal(code(() => fail("check failed", 1)), 1);
  assert.equal(new GovernError("m").code, 4);
});

test("a wrong command line exits 2: unknown command, unknown flag, a value flag without its value, a missing positional", () => {
  const e = makeEnv();
  for (const args of [["frobnicate"], ["status", "--nope"], ["new", "ops/x", "--kind"], ["note"], ["task"], ["task", "frobnicate"]]) {
    const r = govern(e, args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
  }
});

test("a refusal by the workspace's state exits 4: an unknown lane, an unknown process", () => {
  const e = makeEnv();
  for (const args of [["status", "ops/none"], ["note", "ops/none", "x"], ["new", "ops/x", "--process", "nosuchprocess", "--title", "x"]]) {
    const r = govern(e, args);
    assert.equal(r.code, 4, `${args.join(" ")}: ${r.err}`);
  }
});

test("a flag's JSON value that does not parse is a usage error", () => {
  assert.throws(() => jsonValue("{not json"), (e) => e instanceof GovernError && e.code === EXIT_USAGE);
  assert.deepEqual(jsonValue('{"a":1}'), { a: 1 });
});
