// Lane discovery must stay inside the workspace, even when lanes contain source checkouts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { laneSlugs, create } from "../lib/project.ts";
import { makeEnv, write } from "./helpers.ts";

for (const boundary of ["checkout", "linked-checkout", "_tmp", "node_modules"]) {
  test(`discovery excludes lanes inside ${boundary} and preserves nested lanes`, () => {
    const e = makeEnv();
    const previous = process.env;
    process.env = { ...previous, ...e.env };
    try {
      create("graphics/topic", { process: "dev" });
      const nested = join(e.projects, "graphics/topic", boundary);
      if (boundary === "checkout") mkdirSync(join(nested, ".git"), { recursive: true });
      if (boundary === "linked-checkout") write(join(nested, ".git"), "gitdir: /unused/gitdir\n");
      // Invalid state would also make desk fail if discovery enters this directory.
      write(join(nested, "govern.json"), "{}");
      write(join(nested, "projects/residue/govern.json"), "{}");
      assert.deepEqual(laneSlugs(), ["graphics/topic"]);
    } finally { process.env = previous; }
  });
}
