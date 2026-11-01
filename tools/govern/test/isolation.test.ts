// A test run cannot reach live state: the session-lane index stays inside lanes, and the helpers sandbox every test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { makeEnv, govern, parentEnv, tempDir, use, write, HERE, GOVERN, type Env } from "./helpers.ts";
import { recordedLanes, recordLane, indexFile } from "../lib/attribution.ts";
import { segments } from "../lib/usage.ts";
import { findRepo, stateDir, queueDir, projectsDir } from "../lib/workspace.ts";

const LANE = "ops/film";
const FIXTURE_SLUG = "ops/film/super-tools/_tmp/test-tmp/govern-test-R0UY7W/PALS-Notes/projects/ops/film";
const hookEntry = (slug: string, session: string) => JSON.stringify({ t: "2026-10-31T16:40:52.479Z", slug, kind: "work", stage: "plan", engine: "claude", session, openedBy: "hook", via: "GOVERN_LANE" }) + "\n";
const lane = (e: Env, slug: string) => assert.equal(govern(e, ["new", slug, "--kind", "ops", "--title", slug]).code, 0);

/** Every file under `root` with its bytes, so a change anywhere shows as a difference. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (relative(root, p) === "_tmp") continue;
      if (statSync(p).isDirectory()) walk(p); else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

test("the session-lane index never takes a ledger left in a test's temp folder inside a lane", () => {
  const e = makeEnv(); use(e);
  lane(e, LANE);
  // A clone kept in a lane's folder whose test run keeps its temp folder there: the exact path found in a live index.
  write(join(e.projects, FIXTURE_SLUG, "govern", "ledger.jsonl"), hookEntry(FIXTURE_SLUG, "S1"));
  assert.deepEqual([...recordedLanes()], []);
  assert.deepEqual(segments().filter((s) => s.slug === FIXTURE_SLUG), []);
});

test("the session-lane index never takes a ledger inside a checkout kept in a lane", () => {
  const e = makeEnv(); use(e);
  lane(e, LANE);
  const checkout = "ops/film/source/tree";
  mkdirSync(join(e.projects, checkout, ".git"), { recursive: true });
  write(join(e.projects, checkout, "fixture", "govern", "ledger.jsonl"), hookEntry(`${checkout}/fixture`, "S2"));
  assert.deepEqual([...recordedLanes()], []);
});

test("a recorded session lane whose folder is gone is no lane, and the next record drops it", () => {
  const e = makeEnv(); use(e);
  lane(e, LANE);
  write(indexFile(), JSON.stringify({ version: 1, sessions: {
    S1: { lane: FIXTURE_SLUG, at: "2026-10-31T16:40:52.479Z" }, S2: { lane: LANE, at: "2026-10-31T16:40:52.479Z" },
  } }));
  assert.deepEqual([...recordedLanes()], [["S2", LANE]]);
  recordLane("S3", LANE);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(indexFile(), "utf8")).sessions).sort(), ["S2", "S3"]);
});

/** A workspace with the shape of a live one, and the environment of a shell inside it: every GOVERN_* variable, HOME and
 *  the working directory point into it, and TMPDIR sits inside it, as for a clone kept under a workspace. */
function hostile(): { live: string; tmp: string; env: NodeJS.ProcessEnv; before: Record<string, string> } {
  const live = tempDir("live"), home = join(live, "home"), tmp = join(live, "_tmp", "test-tmp");
  write(join(live, "govern.config.json"), JSON.stringify({ projects: "projects", queue: "queue", state: "state" }));
  write(join(live, "state", "session-lanes.json"), JSON.stringify({ version: 1, sessions: {} }) + "\n");
  write(join(live, "projects", "ops", "film", "govern.json"), "{}\n");
  mkdirSync(join(live, "queue"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const before = snapshot(live);
  mkdirSync(tmp, { recursive: true });
  const { NODE_TEST_CONTEXT: _, ...inherited } = parentEnv();
  const { GOVERN_CEILING: __, ...env } = inherited;
  return { live, tmp, before, env: { ...env, TMPDIR: tmp, HOME: home, GOVERN_REPO: live, GOVERN_PROJECTS: join(live, "projects"), GOVERN_QUEUE: join(live, "queue"), GOVERN_STATE: join(live, "state"), GOVERN_SESSIONS_DIR: join(home, "sessions") } };
}

test("importing the helpers puts a test file in a temp workspace, whatever the environment it inherited", () => {
  const { live, tmp, env, before } = hostile();
  const url = (p: string) => pathToFileURL(join(HERE, p)).href;
  const child = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { homedir } from "node:os";
    import { join } from "node:path";
    await import(${JSON.stringify(url("helpers.ts"))});
    const w = await import(${JSON.stringify(url("../lib/workspace.ts"))});
    const a = await import(${JSON.stringify(url("../lib/attribution.ts"))});
    const p = await import(${JSON.stringify(url("../lib/project.ts"))});
    const q = await import(${JSON.stringify(url("../lib/queue.ts"))});
    const s = await import(${JSON.stringify(url("../lib/sessions.ts"))});
    mkdirSync(join(w.projectsDir(), "ops", "film", "govern"), { recursive: true });
    writeFileSync(join(w.projectsDir(), "ops", "film", "govern.json"), "{}");
    a.recordLane("S1", "ops/film");
    p.appendLedger("ops/film", { kind: "note" });
    q.send({ project: "p", task: "t", kind: "TASK", from: "alice", to: "owner", summary: "s", body: "b", files: [], access: "read-only" });
    mkdirSync(join(homedir(), ".config"), { recursive: true });
    writeFileSync(join(homedir(), ".config", "written"), "x");
    console.log(JSON.stringify({ repo: w.findRepo(), state: w.stateDir(), queue: w.queueDir(), projects: w.projectsDir(), home: homedir(), sessions: s.SESSIONS_DIR(), cwd: process.cwd() }));
  `;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", child], { cwd: live, encoding: "utf8", timeout: 60000, env });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split("\n").find((l) => l.startsWith('{"repo"'));
  assert.ok(line, r.stdout);
  const seen = JSON.parse(line) as Record<string, string>;
  for (const [k, v] of Object.entries(seen)) assert.ok(v.startsWith(tmp + "/"), `${k} is under the run's temp folder: ${v}`);
  assert.deepEqual(snapshot(live), before, "the live workspace is byte for byte what it was");
});

test("a real test file run from inside a live workspace leaves that workspace untouched", () => {
  const { live, env, before } = hostile();
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", join(HERE, "attribution.test.ts")], { cwd: live, encoding: "utf8", timeout: 120000, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(live), before);
});

test("a command run from a temp folder inside a workspace does not walk up into it", () => {
  const live = tempDir("live-walk");
  write(join(live, "govern.config.json"), JSON.stringify({ projects: "projects" }));
  const inner = join(live, "_tmp", "test-tmp", "lonely");
  mkdirSync(inner, { recursive: true });
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "status"], {
    cwd: inner, encoding: "utf8", timeout: 60000, env: { ...parentEnv(), GOVERN_CEILING: join(live, "_tmp") },
  });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /no govern\.config\.json/);
});

test("the ceiling is the only limit: with none, the same folder finds the workspace above it", () => {
  const live = tempDir("live-found");
  write(join(live, "govern.config.json"), JSON.stringify({ projects: "projects" }));
  const inner = join(live, "deep", "er");
  mkdirSync(inner, { recursive: true });
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "status"], {
    cwd: inner, encoding: "utf8", timeout: 60000, env: { ...parentEnv(), GOVERN_CEILING: join(live, "deep", "elsewhere") },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("this file's own workspace is a temp folder", () => {
  for (const p of [findRepo()!, stateDir(), queueDir(), projectsDir()]) assert.ok(p.startsWith(resolve(tmpdir()) + "/"), p);
});

test("every test file imports the helpers: that import is what sandboxes it", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const imports = /^import (?:[^;]*from )?["']\.\/helpers\.ts["']/m;
  assert.deepEqual(readdirSync(here).filter((f) => f.endsWith(".test.ts") && !imports.test(readFileSync(join(here, f), "utf8"))), []);
});
