// The README's documentation index against the files: every govern Markdown document a reader can land on is linked
// from tools/govern/README.md, so a new document cannot ship without an entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERE } from "./helpers.ts";

const GOVERN_DIR = resolve(HERE, "..");
const README = readFileSync(join(GOVERN_DIR, "README.md"), "utf8");
const linked = new Set([...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].flatMap((m) => (m[1] ? [m[1].replace(/^\.\//, "")] : [])));

/** Top-level documents, each process manual, and the Android app's README. */
function documents(): string[] {
  const top = readdirSync(GOVERN_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  const processes = join(GOVERN_DIR, "processes");
  const manuals = readdirSync(processes, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(processes, d.name, "MANUAL.md")))
    .map((d) => `processes/${d.name}/MANUAL.md`);
  return [...top, ...manuals, "android/README.md"];
}

test("every govern document is linked from the README's documentation index", () => {
  const missing = documents().filter((d) => !linked.has(d));
  assert.deepEqual(missing, [], `README.md does not link: ${missing.join(", ")}`);
});
