import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, basename } from "node:path";
import { tempDir, write } from "./helpers.ts";
import { findRepo, config, stateDir, capabilitiesDir, promptsDir, workflowFile, processesDir, projectsDir, declaredSetting } from "../lib/workspace.ts";
import { resources } from "../lib/resources.ts";

const KEYS = ["GOVERN_REPO", "GOVERN_PROJECTS", "GOVERN_STATE", "GOVERN_CAPABILITIES", "GOVERN_PROMPTS", "GOVERN_WORKFLOW", "GOVERN_PROCESSES", "GOVERN_RESOURCES"];
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
