// install-skill: an atomic, read-back-verified copy of SKILL.md, and --check that says whether the installed copy is current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, tempDir, write, HERE } from "./helpers.ts";
import { installSkill } from "../lib/skill.ts";
import { GovernError } from "../lib/util.ts";

const SRC = join(HERE, "..", "SKILL.md");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const e = makeEnv();

test("install-skill installs SKILL.md byte for byte, leaves no temp file, and --check passes on it", () => {
  const dir = tempDir("skills");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 0, r.err);
  const dest = join(dir, "govern", "SKILL.md");
  assert.equal(sha(readFileSync(dest)), sha(readFileSync(SRC)));
  assert.match(r.out, new RegExp(`installed ${dest} \\(sha256 ${sha(readFileSync(SRC))}\\)`));
  assert.deepEqual(readdirSync(join(dir, "govern")), ["SKILL.md"], "only the installed file is left in the destination");
  const c = govern(e, ["install-skill", dir, "--check"]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, new RegExp(`${dest} is current \\(sha256 ${sha(readFileSync(SRC))}\\)`));
});

test("install-skill --check on a stale copy exits 1 naming both paths and both sha256s", () => {
  const dir = tempDir("skills");
  const dest = write(join(dir, "govern", "SKILL.md"), "an old manual\n");
  const c = govern(e, ["install-skill", dir, "--check"]);
  assert.equal(c.code, 1);
  assert.match(c.err, /differs/);
  assert.ok(c.err.includes(`${dest} sha256 ${sha("an old manual\n")}`), c.err);
  assert.ok(c.err.includes(`${SRC} sha256 ${sha(readFileSync(SRC))}`), c.err);
  assert.equal(readFileSync(dest, "utf8"), "an old manual\n", "--check changes nothing");
});

test("install-skill --check with nothing installed exits 1 naming the missing path and the source's sha256", () => {
  const dir = tempDir("skills");
  const dest = join(dir, "govern", "SKILL.md");
  const c = govern(e, ["install-skill", dir, "--check"]);
  assert.equal(c.code, 1);
  assert.ok(c.err.includes(`${dest} is missing`), c.err);
  assert.ok(c.err.includes(`${SRC} sha256 ${sha(readFileSync(SRC))}`), c.err);
  assert.equal(existsSync(dest), false, "--check installs nothing");
});

test("install: a write that does not read back as the source fails loudly and never replaces the installed copy", () => {
  const dir = tempDir("skills");
  const src = write(join(dir, "src.md"), "the new manual\n");
  const dest = write(join(dir, "govern", "SKILL.md"), "the old manual\n");
  const corrupt = (p: string, b: Buffer) => writeFileSync(p, b.subarray(0, 4));
  assert.throws(() => installSkill(src, dest, { writeFile: corrupt }), (err: unknown) => {
    assert.ok(err instanceof GovernError);
    assert.equal(err.code, 1);
    assert.match(err.message, new RegExp(`read back sha256 ${sha("the ")}, expected ${sha("the new manual\n")}`));
    return true;
  });
  assert.equal(readFileSync(dest, "utf8"), "the old manual\n", "the installed copy is untouched");
  assert.deepEqual(readdirSync(join(dir, "govern")), ["SKILL.md"], "the temp file is removed");
});

test("install: a destination that does not read back as the source after the rename fails loudly", () => {
  const dir = tempDir("skills");
  const src = write(join(dir, "src.md"), "the new manual\n");
  const dest = join(dir, "govern", "SKILL.md");
  const badRename = (_from: string, to: string) => writeFileSync(to, "something else\n");
  assert.throws(() => installSkill(src, dest, { rename: badRename }), (err: unknown) => {
    assert.ok(err instanceof GovernError);
    assert.equal(err.code, 1);
    assert.ok(err.message.includes(`${dest}: read back sha256 ${sha("something else\n")}, expected ${sha("the new manual\n")}`), err.message);
    return true;
  });
  assert.deepEqual(readdirSync(join(dir, "govern")), ["SKILL.md"], "the temp file is removed");
});
