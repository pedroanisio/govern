// The acceptance checker of the lane-portability plan (plans/lane-portability/check.ts): a stage passes only when every
// required test exists and passes, nothing is skipped or left as todo, and the worktree is committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, tempDir } from "./helpers.ts";
import { parseTap, parseJUnit, parseSpec } from "../plans/lane-portability/check.ts";

const CHECK = join(HERE, "..", "plans", "lane-portability", "check.ts");

function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CHECK, ...args], { encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** A git worktree stand-in: a repository with one test file and one acceptance spec, committed unless `dirty`. */
function root(testBody: string, spec: Record<string, unknown>, o: { dirty?: boolean } = {}): { root: string; spec: string } {
  const r = tempDir("plan-check");
  // hooks off: the operator's global commit hooks are not part of the stand-in
  const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...a], { cwd: r, encoding: "utf8" }).status, 0, `git ${a.join(" ")}`);
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  mkdirSync(join(r, "t"), { recursive: true });
  writeFileSync(join(r, "t", "a.test.ts"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${testBody}\n`);
  git("add", "-A");
  git("commit", "-qm", "init");
  if (o.dirty) writeFileSync(join(r, "t", "extra.txt"), "uncommitted");
  const specFile = join(tempDir("plan-spec"), "stage.json");
  writeFileSync(specFile, JSON.stringify(spec));
  return { root: r, spec: specFile };
}
const node = (required: string[]) => ({ stage: "s", clean: true, node: { files: ["t/a.test.ts"], required } });

test("a stage passes when every required test passes and the worktree is committed", () => {
  const r = root(`test("does one", () => assert.ok(true));\ntest("does two", () => assert.ok(true));`, node(["does one", "does two"]));
  const x = run(["s", "--root", r.root, "--spec", r.spec]);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /acceptance s: ok/);
});

test("a required test that is missing, failing or skipped fails the stage and is named", () => {
  const r = root(`test("does one", () => assert.ok(true));\ntest("fails", () => assert.ok(false));\ntest("skipped", { skip: true }, () => {});`,
    node(["does one", "fails", "skipped", "absent"]));
  const x = run(["s", "--root", r.root, "--spec", r.spec]);
  assert.equal(x.code, 1, x.out);
  assert.match(x.out, /required test failed: fails/);
  assert.match(x.out, /required test skipped: skipped/);
  assert.match(x.out, /required test missing: absent/);
});

test("any skipped or todo test fails the stage, required or not", () => {
  const r = root(`test("does one", () => assert.ok(true));\ntest("later", { todo: true }, () => {});`, node(["does one"]));
  const x = run(["s", "--root", r.root, "--spec", r.spec]);
  assert.equal(x.code, 1, x.out);
  assert.match(x.out, /1 test\(s\) skipped or todo/);
});

test("uncommitted changes fail a stage that requires a clean worktree", () => {
  const r = root(`test("does one", () => assert.ok(true));`, node(["does one"]), { dirty: true });
  const x = run(["s", "--root", r.root, "--spec", r.spec]);
  assert.equal(x.code, 1, x.out);
  assert.match(x.out, /uncommitted changes/);
});

test("a malformed spec or a wrong stage name is a usage error, never a pass", () => {
  assert.throws(() => parseSpec("x.json", JSON.stringify({ stage: "s", node: { files: [], required: [] }, extra: 1 })), /extra/);
  assert.throws(() => parseSpec("x.json", JSON.stringify({ stage: "s", node: { files: ["a"], required: [] } })), /required/);
  assert.throws(() => parseSpec("x.json", "{"), /not JSON/);
  const r = root(`test("does one", () => assert.ok(true));`, node(["does one"]));
  assert.equal(run(["other", "--root", r.root, "--spec", r.spec]).code, 2);
  assert.equal(run(["s", "--spec", r.spec]).code, 2, "no --root");
});

test("the TAP reader keeps top-level results with their directives", () => {
  const tap = ["TAP version 13", "# Subtest: a", "ok 1 - a", "    ok 1 - inner", "not ok 2 - b # TODO", "ok 3 - c # SKIP", "ok 4 - d # odd title", "# todo 1"].join("\n");
  assert.deepEqual(parseTap(tap), [
    { title: "a", ok: true, directive: undefined }, { title: "b", ok: false, directive: "todo" },
    { title: "c", ok: true, directive: "skip" }, { title: "d # odd title", ok: true, directive: undefined },
  ]);
});

test("the JUnit reader names each case Class.method and its outcome", () => {
  const xml = `<testsuite name="dev.x.ModelTest" tests="3"><testcase name="parses" classname="dev.x.ModelTest" time="0.1"/>` +
    `<testcase name="breaks" classname="dev.x.ModelTest"><failure message="no">trace</failure></testcase>` +
    `<testcase name="later" classname="dev.x.ModelTest"><skipped/></testcase></testsuite>`;
  assert.deepEqual(parseJUnit(xml), [
    { name: "ModelTest.parses", outcome: "passed" }, { name: "ModelTest.breaks", outcome: "failed" }, { name: "ModelTest.later", outcome: "skipped" },
  ]);
});

test("a branch that edits a protected path fails the stage", () => {
  const r = root(`test("does one", () => assert.ok(true));`, { stage: "s", untouched: { base: "HEAD~1", paths: ["rules"] } });
  const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...a], { cwd: r.root, encoding: "utf8" }).status, 0, `git ${a.join(" ")}`);
  writeFileSync(join(r.root, "other.txt"), "fine");
  git("add", "-A");
  git("commit", "-qm", "unrelated");
  assert.equal(run(["s", "--root", r.root, "--spec", r.spec]).code, 0, "a change elsewhere passes");
  mkdirSync(join(r.root, "rules"));
  writeFileSync(join(r.root, "rules", "spec.json"), "{}");
  git("add", "-A");
  git("commit", "-qm", "weaken the rules");
  writeFileSync(r.spec, JSON.stringify({ stage: "s", untouched: { base: "HEAD~2", paths: ["rules"] } }));
  const x = run(["s", "--root", r.root, "--spec", r.spec]);
  assert.equal(x.code, 1, x.out);
  assert.match(x.out, /rules\/spec\.json/);
});
