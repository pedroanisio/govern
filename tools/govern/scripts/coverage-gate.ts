import type { FileCoverage, Metric } from "./coverage-merge.ts";

type CoverageClass = "library" | "cli";
type Floors = Partial<Record<CoverageClass, number>>;

/** The coverage driver starts the measured run, so it is outside what that run can observe. */
const DRIVER = "scripts/coverage.ts";

/** Whether a root-relative path is a source the coverage gate measures: govern.ts and non-test TypeScript under lib/, ext/, checks/ and scripts/. */
export function measuredSource(path: string): boolean {
  if (path === "govern.ts") return true;
  return path !== DRIVER && /^(lib|ext|checks|scripts)\//.test(path) && path.endsWith(".ts") && !path.endsWith(".test.ts");
}

/** Aggregate merged branch counts by code class and determine the coverage exit status. */
export function coverageGate(files: FileCoverage[], unreadable: string[], floors: Floors = {}) {
  const totals: Record<CoverageClass, Metric & { floor: number }> = {
    library: { covered: 0, total: 0, percent: null, floor: Math.max(80, floors.library ?? 80) },
    cli: { covered: 0, total: 0, percent: null, floor: Math.max(60, floors.cli ?? 60) },
  };
  const errors: string[] = [];
  const observed = { library: false, cli: false };
  const incomplete = { library: false, cli: false };
  if (unreadable.length) errors.push(`unreadable V8 profiles: ${unreadable.join(", ")}`);
  for (const row of files) {
    const kind = row.file === "govern.ts" || row.file.startsWith("scripts/") ? "cli" :
      /^(lib|ext|checks)\//.test(row.file) ? "library" : null;
    if (!kind) continue;
    observed[kind] = true;
    if (!row.observed || row.branches.percent === null) {
      incomplete[kind] = true;
      errors.push(`incomplete ${kind} branch coverage: ${row.file} is unobserved`);
    }
    const total = totals[kind];
    total.covered += row.branches.covered;
    total.total += row.branches.total;
  }
  for (const kind of ["library", "cli"] as const) {
    const total = totals[kind];
    if (!observed[kind]) errors.push(`incomplete ${kind} branch coverage: no sources measured`);
    total.percent = total.total ? total.covered / total.total * 100 : !observed[kind] || incomplete[kind] ? null : 100;
    if (total.percent !== null && total.percent < total.floor) {
      errors.push(`${kind} branch coverage ${total.percent.toFixed(2)}% is below the ${total.floor}% floor`);
    }
  }
  return { totals, errors, exitCode: errors.length ? 1 : 0 };
}
