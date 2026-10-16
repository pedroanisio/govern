// install-skill: <skills dir>/govern is a symbolic link to the tool's tracked folder, never a copy; --check says whether it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, lstatSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeEnv, govern, tempDir, write, HERE } from "./helpers.ts";
import { installSkill, skillDrift } from "../lib/skill.ts";
import { GovernError } from "../lib/util.ts";

const TOOL = resolve(HERE, "..");
const e = makeEnv();
const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;

test("install-skill on a fresh dir creates a symlink to the tool folder, and --check passes on it", () => {
  const dir = tempDir("skills");
  const link = join(dir, "govern");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 0, r.err);
  assert.ok(isLink(link), "the entry is a symlink, not a copy");
  assert.equal(realpathSync(link), realpathSync(TOOL));
  assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), readFileSync(join(TOOL, "SKILL.md"), "utf8"));
  assert.ok(existsSync(join(link, "REFERENCE.md")), "the reference is beside the core");
  assert.match(r.out, /^installed: /);
  assert.deepEqual(readdirSync(dir), ["govern"], "nothing else is created");
  const c = govern(e, ["install-skill", dir, "--check"]);
  assert.equal(c.code, 0, c.err);
  assert.ok(c.out.includes(`${link} is a link to`), c.out);
  assert.match(c.out, /SKILL\.md is current \(sha256 [0-9a-f]{64}\), REFERENCE\.md sha256 [0-9a-f]{64}/);
});

test("install-skill creates the skills dir when it is missing", () => {
  const dir = join(tempDir("skills"), "deep", "skills");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 0, r.err);
  assert.ok(isLink(join(dir, "govern")));
});

test("install-skill with a correct link already there leaves it alone (exit 0, already installed)", () => {
  const dir = tempDir("skills");
  symlinkSync(TOOL, join(dir, "govern"), "dir");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^already installed: /);
  assert.equal(readlinkSync(join(dir, "govern")), TOOL);
  assert.deepEqual(readdirSync(dir), ["govern"]);
});

test("install-skill replaces a link that points elsewhere, leaving no temp link", () => {
  const dir = tempDir("skills");
  const other = tempDir("other");
  symlinkSync(other, join(dir, "govern"), "dir");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^replaced a link elsewhere: /);
  assert.equal(realpathSync(join(dir, "govern")), realpathSync(TOOL));
  assert.deepEqual(readdirSync(dir), ["govern"]);
  assert.deepEqual(readdirSync(other), [], "the old target is untouched");
});

test("install-skill replaces a dangling link", () => {
  const dir = tempDir("skills");
  symlinkSync(join(dir, "no-such-folder"), join(dir, "govern"), "dir");
  assert.equal(govern(e, ["install-skill", dir]).code, 0);
  assert.equal(realpathSync(join(dir, "govern")), realpathSync(TOOL));
});

test("install-skill refuses a real directory (exit 1, naming it and the fix) and changes nothing; --replace removes it and links", () => {
  const dir = tempDir("skills");
  const link = join(dir, "govern");
  write(join(link, "SKILL.md"), "an old copy\n");
  const sibling = write(join(dir, "other-skill", "SKILL.md"), "not govern's\n");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`${link} is a directory, not a link to`), r.err);
  assert.match(r.err, /install-skill --replace/);
  assert.doesNotMatch(r.err, /\n\s+at /, "no stack trace");
  assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "an old copy\n", "the copy is left alone");
  const f = govern(e, ["install-skill", dir, "--replace"]);
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /^replaced a copy: /);
  assert.ok(isLink(link));
  assert.equal(readFileSync(sibling, "utf8"), "not govern's\n", "nothing outside <skills dir>/govern is touched");
});

test("install-skill refuses a plain file at the entry, and --replace replaces it", () => {
  const dir = tempDir("skills");
  const link = write(join(dir, "govern"), "a file\n");
  const r = govern(e, ["install-skill", dir]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`${link} is a file, not a link to`), r.err);
  assert.equal(govern(e, ["install-skill", dir, "--replace"]).code, 0);
  assert.ok(isLink(link));
});

test("install-skill --check on each state: missing, a copy, a link elsewhere, a stale sha", () => {
  const missing = tempDir("skills");
  let c = govern(e, ["install-skill", missing, "--check"]);
  assert.equal(c.code, 1);
  assert.ok(c.err.includes(`${join(missing, "govern")} is missing`), c.err);
  assert.match(c.err, /run govern install-skill/);
  assert.equal(existsSync(join(missing, "govern")), false, "--check installs nothing");

  const copy = tempDir("skills");
  write(join(copy, "govern", "SKILL.md"), readFileSync(join(TOOL, "SKILL.md"), "utf8"));
  c = govern(e, ["install-skill", copy, "--check"]);
  assert.equal(c.code, 1);
  assert.ok(c.err.includes(`${join(copy, "govern")} is a directory (a copy), not a link to`), c.err);
  assert.match(c.err, /--replace/);
  assert.ok(!isLink(join(copy, "govern")), "--check changes nothing");

  const elsewhere = tempDir("skills");
  const other = tempDir("other");
  write(join(other, "SKILL.md"), "somebody else's\n");
  symlinkSync(other, join(elsewhere, "govern"), "dir");
  c = govern(e, ["install-skill", elsewhere, "--check"]);
  assert.equal(c.code, 1);
  assert.ok(c.err.includes(`${join(elsewhere, "govern")} is a link elsewhere: it points to ${other}`), c.err);
  assert.equal(readlinkSync(join(elsewhere, "govern")), other, "--check changes nothing");

  const dangling = tempDir("skills");
  symlinkSync(join(dangling, "gone"), join(dangling, "govern"), "dir");
  c = govern(e, ["install-skill", dangling, "--check"]);
  assert.equal(c.code, 1);
  assert.match(c.err, /is a link elsewhere/);
});

test("an edit to the tracked SKILL.md is live through the link, and skillDrift stays null", () => {
  const tool = tempDir("tool");
  write(join(tool, "SKILL.md"), "the manual\n");
  const skills = tempDir("skills");
  assert.equal(installSkill(tool, skills), "installed");
  assert.equal(installSkill(tool, skills), "already installed");
  assert.equal(skillDrift(tool, skills), null);
  writeFileSync(join(tool, "SKILL.md"), "changed\n");
  assert.equal(readFileSync(join(skills, "govern", "SKILL.md"), "utf8"), "changed\n");
  assert.equal(skillDrift(tool, skills), null);
});

test("installSkill and skillDrift on a tool folder without SKILL.md are a GovernError, exit 1, naming it, and create nothing", () => {
  const dir = tempDir("skills");
  const tool = tempDir("tool");
  for (const run of [() => installSkill(tool, dir), () => skillDrift(tool, dir)]) {
    assert.throws(run, (err: unknown) => err instanceof GovernError && err.code === 1 && err.message.includes(`${tool} has no SKILL.md`));
  }
  assert.equal(existsSync(join(dir, "govern")), false);
});

test("install-skill --check --replace is a usage error", () => {
  const r = govern(e, ["install-skill", tempDir("skills"), "--check", "--replace"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--check installs nothing/);
});
