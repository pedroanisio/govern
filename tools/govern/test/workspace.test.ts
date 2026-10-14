import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, basename } from "node:path";
import { tempDir, write } from "./helpers.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { findRepo, repo, config, stateDir, capabilitiesDir, promptsDir, workflowFile, processesDir, projectsDir, queueDir, tuningLogFile, declaredSetting, initWorkspace, pathNamed, expandPlaceholders } from "../lib/workspace.ts";
import { resources } from "../lib/resources.ts";

const KEYS = ["GOVERN_REPO", "GOVERN_PROJECTS", "GOVERN_STATE", "GOVERN_CAPABILITIES", "GOVERN_PROMPTS", "GOVERN_WORKFLOW", "GOVERN_PROCESSES", "GOVERN_RESOURCES", "GOVERN_QUEUE", "GOVERN_TUNING_LOG"];
/** Run `f` with exactly these GOVERN_* variables set (and the cwd, when given); everything is restored afterwards. */
function withEnv<T>(env: Record<string, string>, f: () => T, cwd?: string): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])), was = process.cwd();
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  if (cwd) process.chdir(cwd);
  try { return f(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    process.chdir(was);
  }
}
const ws = (cfg: unknown): string => { const d = tempDir("wsu"); write(join(d, "govern.config.json"), JSON.stringify(cfg)); return d; };

test("the config's state and capabilities keys say where state and capabilities are; GOVERN_STATE and GOVERN_CAPABILITIES win", () => {
  const d = ws({ projects: "lanes", state: "var/state", capabilities: "grants" });
  withEnv({ GOVERN_REPO: d }, () => {
    assert.equal(stateDir(), join(d, "var", "state"));
    assert.equal(capabilitiesDir(), join(d, "grants"));
  });
  withEnv({ GOVERN_REPO: d, GOVERN_STATE: "/elsewhere/s", GOVERN_CAPABILITIES: "/elsewhere/c" }, () => {
    assert.equal(stateDir(), "/elsewhere/s");
    assert.equal(capabilitiesDir(), "/elsewhere/c");
  });
  const bare = ws({ projects: "lanes" });
  withEnv({ GOVERN_REPO: bare }, () => {
    assert.equal(stateDir(), join(bare, "govern-state"));
    assert.equal(capabilitiesDir(), join(bare, "capabilities"));
  });
});

test("with no workspace, the optional folders are undefined (or the env's), never an error", () => {
  const lonely = tempDir("nows");
  withEnv({}, () => {
    assert.equal(findRepo(), undefined);
    assert.equal(promptsDir(), undefined);
    assert.equal(workflowFile(), undefined);
    assert.equal(capabilitiesDir(), undefined);
    assert.equal(processesDir(), undefined);
  }, lonely);
  withEnv({ GOVERN_PROMPTS: "/p", GOVERN_WORKFLOW: "/w.md", GOVERN_CAPABILITIES: "/c" }, () => {
    assert.equal(promptsDir(), "/p");
    assert.equal(workflowFile(), "/w.md");
    assert.equal(capabilitiesDir(), "/c");
  }, lonely);
});

test("GOVERN_REPO is made absolute and loses a trailing slash", () => {
  const d = ws({ projects: "lanes" });
  const parent = resolve(d, "..");
  withEnv({ GOVERN_REPO: `${d}/` }, () => assert.equal(projectsDir(), join(d, "lanes")));
  withEnv({ GOVERN_REPO: `./${basename(d)}//` }, () => {
    assert.equal(findRepo(), d);
    assert.equal(projectsDir(), join(d, "lanes"));
  }, parent);
});

test("config 'resources' is checked where the config is read: a path string or the list shape, nothing else", () => {
  const bad = (resources: unknown, re: RegExp) => {
    const d = ws({ projects: "lanes", resources });
    withEnv({ GOVERN_REPO: d }, () => assert.throws(() => config(), re));
  };
  bad(7, /govern\.config\.json: \$\.resources: must be/);
  bad({ name: "x" }, /\$\.resources/);
  bad([{ name: "m", kind: "vm" }], /\$\.resources\[0\]\.sharing: missing/);
  bad([{ name: "m", kind: "vm", sharing: "shared", extra: 1 }], /unknown key "extra"/);
  const ok = ws({ projects: "lanes", resources: [{ name: "m", kind: "vm", sharing: "shared" }] });
  withEnv({ GOVERN_REPO: ok }, () => { assert.ok(declaredSetting("resources")); assert.deepEqual(Object.keys(resources()), ["m"]); });
  const file = ws({ projects: "lanes", resources: "res.json" });
  withEnv({ GOVERN_REPO: file }, () => assert.equal(config().resources, "res.json"));
});

/** A folder holding a .govern/ workspace (with .govern/config.json when `cfg` is given). */
const dot = (cfg?: unknown): string => {
  const d = tempDir("dotws");
  mkdirSync(join(d, ".govern"), { recursive: true });
  if (cfg !== undefined) write(join(d, ".govern", "config.json"), JSON.stringify(cfg));
  return d;
};

test(".govern/ marks a workspace: its parent is the root, found from below, and every folder defaults inside .govern/", () => {
  const d = dot(), g = join(d, ".govern"), sub = join(d, "a", "b");
  mkdirSync(sub, { recursive: true });
  withEnv({}, () => {
    assert.equal(findRepo(), d);
    assert.equal(repo(), d);
    assert.equal(projectsDir(), join(g, "projects"));
    assert.equal(queueDir(), join(g, "queue"));
    assert.equal(processesDir(), join(g, "processes"));
    assert.equal(capabilitiesDir(), join(g, "capabilities"));
    assert.equal(stateDir(), join(g, "state"));
    assert.equal(tuningLogFile(), join(g, "tuning.jsonl"));
    assert.deepEqual(config(), {});
  }, sub);
  withEnv({ GOVERN_REPO: d }, () => assert.equal(stateDir(), join(g, "state")));
});

test(".govern/config.json overrides the defaults, its paths relative to .govern/; env overrides still win", () => {
  const d = dot({ projects: "../lanes", state: "run" }), g = join(d, ".govern");
  withEnv({ GOVERN_REPO: d }, () => {
    assert.equal(projectsDir(), join(d, "lanes"));
    assert.equal(stateDir(), join(g, "run"));
    assert.equal(queueDir(), join(g, "queue"));
  });
  withEnv({ GOVERN_REPO: d, GOVERN_QUEUE: "/q" }, () => assert.equal(queueDir(), "/q"));
});

test("a folder with both .govern/ and govern.config.json is refused, never a silent pick; the nearest marker wins", () => {
  const both = dot();
  write(join(both, "govern.config.json"), JSON.stringify({ projects: "lanes" }));
  withEnv({}, () => assert.throws(() => findRepo(), /both \.govern\/ and govern\.config\.json/), both);
  withEnv({ GOVERN_REPO: both }, () => assert.throws(() => projectsDir(), /both \.govern\/ and govern\.config\.json/));
  const outer = ws({ projects: "lanes" }), inner = join(outer, "inner");
  mkdirSync(join(inner, ".govern"), { recursive: true });
  withEnv({}, () => assert.equal(findRepo(), inner), inner);
  withEnv({}, () => assert.equal(findRepo(), outer), outer);
});

test("a .govern file (not a folder) marks nothing", () => {
  const d = tempDir("dotfile");
  write(join(d, ".govern"), "");
  withEnv({}, () => assert.equal(findRepo(), undefined), d);
});

test("initWorkspace creates .govern/ with its folders and a .gitignore for run state, and refuses an existing workspace", () => {
  const d = tempDir("init");
  const made = initWorkspace(d);
  assert.equal(made, join(d, ".govern"));
  for (const f of ["projects", "queue", "processes"]) assert.ok(existsSync(join(made, f)), f);
  const ignore = readFileSync(join(made, ".gitignore"), "utf8");
  assert.match(ignore, /^state\/$/m);
  assert.match(ignore, /^projects\/\*\*\/govern\/jobs\/$/m);
  withEnv({}, () => assert.equal(findRepo(), d), d);
  assert.throws(() => initWorkspace(d), /already a govern workspace/);
  const old = ws({ projects: "lanes" });
  assert.throws(() => initWorkspace(old), /already a govern workspace/);
});

test("initWorkspace inside an existing workspace is refused (naming it) unless nested is asked for", () => {
  for (const outer of [dot(), ws({ projects: "lanes" })]) {
    const sub = join(outer, "a", "b");
    mkdirSync(sub, { recursive: true });
    assert.throws(() => initWorkspace(sub), new RegExp(`inside the govern workspace at ${outer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(!existsSync(join(sub, ".govern")), "nothing created on refusal");
    assert.equal(initWorkspace(sub, { nested: true }), join(sub, ".govern"));
    withEnv({}, () => assert.equal(findRepo(), sub), sub);
  }
});

test("{paths.NAME} in .govern/config.json resolves relative to .govern/; {repo} is still the folder holding it", () => {
  const d = dot({ paths: { tool: "../bin/tool", inside: "scripts/x" } });
  withEnv({ GOVERN_REPO: d }, () => {
    assert.equal(pathNamed("tool"), join(d, "bin", "tool"));
    assert.equal(pathNamed("inside"), join(d, ".govern", "scripts", "x"));
    assert.equal(expandPlaceholders("{repo}|{paths.tool}", "/w"), `${d}|${join(d, "bin", "tool")}`);
    assert.throws(() => pathNamed("nope"), /\.govern\/config\.json has no paths\.nope/);
  });
});
