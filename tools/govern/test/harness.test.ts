// The test harness itself: what a govern child can see of the developer's machine, what a test file leaves behind,
// and which files the `test/*.test.ts` glob runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { makeEnv, govern, write, HERE, parentEnv } from "./helpers.ts";

test("a govern child sees none of the parent's GOVERN_* variables and a HOME inside the test's root", () => {
  const e = makeEnv();
  const was = process.env.GOVERN_QUEUE;
  process.env.GOVERN_QUEUE = join(e.root, "leaked"); // as if exported by the developer's shell
  try {
    assert.ok(e.env.HOME.startsWith(e.root + sep));
    const unit = join(e.env.HOME, ".config", "systemd", "user", "govern-dispatch.service"); // install-service writes under homedir()
    const r = govern(e, ["task", "install-service"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split("\n")[0], `wrote ${unit}`);
    assert.ok(readFileSync(unit, "utf8").split("\n").includes(`Environment="GOVERN_QUEUE=${join(e.root, "PALS-Notes", "queue")}"`));
    // a test still sets one explicitly
    assert.equal(govern(e, ["task", "install-service"], { GOVERN_QUEUE: join(e.root, "q") }).code, 0);
    assert.ok(readFileSync(unit, "utf8").split("\n").includes(`Environment="GOVERN_QUEUE=${join(e.root, "q")}"`));
  } finally {
    if (was === undefined) delete process.env.GOVERN_QUEUE; else process.env.GOVERN_QUEUE = was;
  }
});

test("parentEnv drops every GOVERN_* and the compaction window the session running the tests exported", () => {
  const set = { GOVERN_SESSIONS_DIR: "/leak", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1" };
  const was = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    const p = parentEnv();
    assert.deepEqual(Object.keys(p).filter((k) => k.startsWith("GOVERN_") || k === "CLAUDE_CODE_AUTO_COMPACT_WINDOW"), []);
    assert.equal(p.PATH, process.env.PATH);
  } finally {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("makeEnv's roots and tempDir's dirs are removed when the test file that made them finishes", () => {
  const e = makeEnv();
  const probe = write(join(e.root, "probe.test.ts"), [
    `import { test } from "node:test";`, `import { existsSync } from "node:fs";`,
    `import { makeEnv, tempDir } from ${JSON.stringify(join(HERE, "helpers.ts"))};`,
    `test("probe", () => { const r = makeEnv().root, d = tempDir("probe"); if (!existsSync(r) || !existsSync(d)) throw new Error("no dir"); console.log("ROOT=" + r + "\\nDIR=" + d); });`, "",
  ].join("\n"));
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", probe], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const root = /^ROOT=(.+)$/m.exec(r.stdout)?.[1];
  assert.ok(root?.includes("govern-test-"), r.stdout);
  assert.equal(existsSync(root!), false);
  const dir = /^DIR=(.+)$/m.exec(r.stdout)?.[1];
  assert.ok(dir?.includes("govern-probe-"), r.stdout);
  assert.equal(existsSync(dir!), false);
  assert.equal(existsSync(e.root), true); // only the roots that file made
});

test("every file in test/ is a test the glob runs, the helpers, a fake agent or the fixtures", () => {
  const known = (f: string) => /\.test\.ts$/.test(f) || f === "helpers.ts" || /^fake-[\w-]+\.ts$/.test(f) || (f === "fixtures" && statSync(join(HERE, f)).isDirectory());
  assert.deepEqual(readdirSync(HERE).filter((f) => !known(f)), []);
});
