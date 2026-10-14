// Doc-sync: the route table in REMOTE.md lists exactly the routes lib/remote.ts serves.
// lib/remote.ts exports no route list (its handler matches `route === "METHOD /path"`), so the source is parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HERE } from "./helpers.ts";

const GOVERN_DIR = resolve(HERE, "..");
const SOURCE = readFileSync(resolve(GOVERN_DIR, "lib/remote.ts"), "utf8");
const DOC = readFileSync(resolve(GOVERN_DIR, "REMOTE.md"), "utf8");

/** Every `route === "METHOD /path"` comparison in the server's request handler. */
function servedRoutes(): string[] {
  const routes = [...SOURCE.matchAll(/\broute === "([A-Z]+ \/[^"]*)"/g)].map((m) => m[1]!);
  assert.ok(routes.length > 0, "lib/remote.ts has no `route === \"METHOD /path\"` comparisons; update this test's parser");
  return routes;
}

/** The first cell of each row of the REMOTE.md table headed `| Method and path |`, without backticks or query string. */
function documentedRoutes(): string[] {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Method and path\s*\|/.test(l));
  assert.ok(start >= 0, "REMOTE.md has no `| Method and path | ...` route table");
  const routes: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const m = /^\|\s*`([A-Z]+) (\/[^`?\s]*)(\?[^`]*)?`\s*\|/.exec(line);
    assert.ok(m, `route table row does not start with a backticked \`METHOD /path\`: ${line}`);
    routes.push(`${m[1]} ${m[2]}`);
  }
  return routes;
}

test("REMOTE.md documents each route lib/remote.ts serves, once", () => {
  const doc = documentedRoutes();
  assert.deepEqual(doc.filter((r, i) => doc.indexOf(r) !== i), [], "routes documented twice");
  assert.deepEqual(servedRoutes().filter((r) => !doc.includes(r)), [], "routes served but missing from REMOTE.md");
});

test("REMOTE.md documents no route lib/remote.ts does not serve", () => {
  const served = new Set(servedRoutes());
  assert.deepEqual(documentedRoutes().filter((r) => !served.has(r)), [], "routes documented in REMOTE.md but not served");
});
