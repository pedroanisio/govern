import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeEnv, govern, childEnv, GOVERN } from "./helpers.ts";

// super-tools lives beside the workspace (~/src/super-tools, ~/src/render-frontend-js), not inside it:
// without GOVERN_REPO, govern finds the workspace from the directory it is run in.
test("without GOVERN_REPO the workspace is the nearest folder above the cwd that holds PALS-Notes/projects", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "demo", "--kind", "short", "--title", "Demo"]).code, 0);
  const deep = join(e.root, "PALS-Notes", "projects", "demo", "work");
  mkdirSync(deep, { recursive: true });
  const { GOVERN_REPO: _r, GOVERN_PROJECTS: _p, ...env } = childEnv(e);
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "status"], { cwd: deep, env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /demo/);
});
