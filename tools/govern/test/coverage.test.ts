// Hand-written V8 profiles: no subprocess is needed to verify the merger.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCoverage, readCoverageProfiles, type CoverageProfile, type FunctionCoverage } from "../scripts/coverage-merge.ts";

const source = "first();\nleft();\nright();\nlast();\n";
const root = { startOffset: 0, endOffset: source.length, count: 1 };
const left = { startOffset: 9, endOffset: 16, count: 0 };
const right = { startOffset: 17, endOffset: 25, count: 0 };
const fn = (ranges: FunctionCoverage["ranges"], isBlockCoverage = true): FunctionCoverage => ({ functionName: "", isBlockCoverage, ranges });
const profile = (...functions: FunctionCoverage[]): CoverageProfile => ({ result: [{ url: "lib/example.ts", functions }] });
const merge = (...profiles: CoverageProfile[]) => mergeCoverage({ "lib/example.ts": source }, profiles)[0]!;

test("coverage unions counts across processes and deduplicates branch ranges", () => {
  const a = profile(fn([root, left, right]));
  const b = profile(fn([root, { ...left, count: 2 }, right]));
  const row = merge(a, b, a);
  assert.deepEqual(row.branches, { covered: 1, total: 2, percent: 50 });
  assert.deepEqual(row.lines, { covered: 3, total: 4, percent: 75 });
  assert.deepEqual(row.uncoveredBranchLines, [3]);
  assert.deepEqual(merge(b, a), row);
});

test("an omitted block inherits its enclosing count in another profile", () => {
  const row = merge(profile(fn([root, left, right])), profile(fn([root])));
  assert.deepEqual(row.branches, { covered: 2, total: 2, percent: 100 });
  assert.equal(row.lines.percent, 100);
});

test("nested zero blocks override parents, while uncalled functions are not branches", () => {
  const row = merge(profile(fn([root, left]), fn([{ ...right, count: 0 }], false)));
  assert.equal(row.branches.total, 1);
  assert.deepEqual(row.uncoveredBranchLines, [2]);
  assert.equal(row.lines.covered, 2);
});

test("a coarse uncalled function does not erase later block coverage", () => {
  const row = merge(profile(fn([{ ...root, count: 0 }], false)), profile(fn([root, left])));
  assert.equal(row.branches.percent, 0);
  assert.equal(row.lines.covered, 3);
});

test("unobserved files are explicit and reports sort lowest branch coverage first", () => {
  const rows = mergeCoverage({ "govern.ts": "run();\n", "lib/example.ts": source, "lib/empty.ts": "\n" }, [profile(fn([root, left]))]);
  assert.equal(rows[0]!.file, "lib/example.ts");
  assert.deepEqual(rows.find((r) => r.file === "govern.ts")!.lines, { covered: 0, total: 1, percent: 0 });
  assert.equal(rows.find((r) => r.file === "govern.ts")!.branches.percent, null);
  assert.equal(rows.find((r) => r.file === "lib/empty.ts")!.lines.percent, 100);
});

test("distinct branches on one line count separately but locations are deduplicated", () => {
  const row = merge(profile(fn([root, { startOffset: 1, endOffset: 3, count: 0 }, { startOffset: 4, endOffset: 6, count: 0 }])));
  assert.deepEqual(row.branches, { covered: 0, total: 2, percent: 0 });
  assert.deepEqual(row.uncoveredBranchLines, [1]);
  assert.equal(row.lines.percent, 100);
});

test("missing nested blocks inherit a zero enclosing block rather than the root", () => {
  const nested = { startOffset: 10, endOffset: 13, count: 0 };
  const row = merge(profile(fn([root, left, nested])), profile(fn([root, left])));
  assert.deepEqual(row.branches, { covered: 0, total: 2, percent: 0 });
  assert.deepEqual(row.uncoveredBranchLines, [2]);
});

test("coverage reader reports empty and truncated profiles while retaining valid profiles", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "govern-coverage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const valid = profile(fn([root, left]));
  writeFileSync(join(directory, "empty.json"), "");
  writeFileSync(join(directory, "truncated.json"), '{"result":[');
  writeFileSync(join(directory, "valid.json"), JSON.stringify(valid));
  assert.deepEqual(readCoverageProfiles(directory), {
    profiles: [valid], unreadable: ["empty.json", "truncated.json"],
  });
});
