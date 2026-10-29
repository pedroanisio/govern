import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageGate, measuredSource } from "../scripts/coverage-gate.ts";
import { mergeCoverage, type FileCoverage } from "../scripts/coverage-merge.ts";

const row = (file: string, covered: number, total: number, observed = true): FileCoverage => ({
  file, observed, lines: { covered: 1, total: 1, percent: 100 },
  branches: { covered, total, percent: observed ? (total ? covered / total * 100 : 100) : null }, uncoveredBranchLines: [],
});
const passing = () => [row("lib/a.ts", 80, 100), row("govern.ts", 60, 100)];

test("coverage gate rejects library totals below 80% with the measured percentage", () => {
  const result = coverageGate([row("lib/a.ts", 79, 100), row("govern.ts", 60, 100)], []);
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /library.*79\.00%.*80%/);
});

test("coverage gate rejects CLI totals below 60% with the measured percentage", () => {
  const result = coverageGate([row("lib/a.ts", 80, 100), row("govern.ts", 59, 100)], []);
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /cli.*59\.00%.*60%/);
});

test("coverage gate passes at and above both floors", () => {
  for (const rows of [passing(), [row("ext/a.ts", 81, 100), row("scripts/a.ts", 61, 100)]]) {
    assert.equal(coverageGate(rows, []).exitCode, 0);
    assert.deepEqual(coverageGate(rows, []).errors, []);
  }
});

test("coverage gate rejects unreadable profiles even when both floors pass", () => {
  const result = coverageGate(passing(), ["truncated.json"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /unreadable.*truncated\.json/);
});

test("coverage gate rejects unobserved sources and absent classes as incomplete", () => {
  const rows = mergeCoverage({ "govern.ts": "run();", "lib/a.ts": "run();" }, []);
  for (const files of [rows, [row("govern.ts", 1, 1)], [row("lib/a.ts", 1, 1)], []]) {
    const result = coverageGate(files, []);
    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /incomplete/);
  }
  assert.match(coverageGate(rows, []).errors.join("\n"), /govern\.ts/);
});

test("coverage gate weights merged branch counts and classifies all production roots", () => {
  const result = coverageGate([
    row("lib/a.ts", 0, 1), row("ext/a.ts", 4, 4), row("checks/a.ts", 4, 5),
    row("govern.ts", 0, 1), row("scripts/a.ts", 6, 9), row("test/a.test.ts", 0, 1000),
  ], []);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.totals.library, { covered: 8, total: 10, percent: 80, floor: 80 });
  assert.deepEqual(result.totals.cli, { covered: 6, total: 10, percent: 60, floor: 60 });
});

test("coverage gate honors higher floors and never lowers repository floors", () => {
  const higher = coverageGate(passing(), [], { library: 90, cli: 70 });
  assert.equal(higher.exitCode, 1);
  assert.match(higher.errors.join("\n"), /library.*80\.00%.*90%/);
  assert.match(higher.errors.join("\n"), /cli.*60\.00%.*70%/);
  assert.equal(coverageGate([row("lib/a.ts", 79, 100), row("govern.ts", 59, 100)], [], { library: 1, cli: 1 }).exitCode, 1);
});

test("coverage gate accepts observed sources without branches", () => {
  assert.equal(coverageGate([row("lib/a.ts", 0, 0), row("govern.ts", 0, 0)], []).exitCode, 0);
});

test("coverage gate compares unrounded percentages against the floor", () => {
  const result = coverageGate([row("lib/a.ts", 79999, 100000), row("govern.ts", 59999, 100000)], []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errors.length, 2);
});

test("coverage measures govern.ts and library, extension, check and script sources, but not tests or the coverage driver", () => {
  for (const path of ["govern.ts", "lib/queue.ts", "ext/conversation/conversation-cli.ts", "checks/refs.ts", "scripts/coverage-gate.ts"]) {
    assert.equal(measuredSource(path), true, path);
  }
  // The driver starts the measured run, so that run can never observe it.
  for (const path of ["lib/queue.test.ts", "scripts/coverage.ts", "test/helpers.ts", "lib/readme.md", "site/app.ts"]) {
    assert.equal(measuredSource(path), false, path);
  }
});
