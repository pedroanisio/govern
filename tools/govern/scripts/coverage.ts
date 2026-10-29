// Child Node processes inherit NODE_V8_COVERAGE, including CLI and worker entry points.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeCoverage, readCoverageProfiles } from "./coverage-merge.ts";
import { coverageGate, measuredSource } from "./coverage-gate.ts";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const generated = resolve(process.env.ST_VAR || join(root, "..", "..", "var"), "out", "govern", "coverage");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--json" || !args[1])) {
  console.error(`Usage: npm run coverage -- [--json path] (default JSON: ${join(generated, "coverage.json")})`);
  process.exit(2);
}
// Restrict raw V8 profiles and newly created output directories as well as the report.
process.umask(0o077);
mkdirSync(generated, { recursive: true, mode: 0o700 });
chmodSync(generated, 0o700);
const directory = mkdtempSync(join(generated, "v8-"));
const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "test/*.test.ts"], {
  cwd: root, env: { ...process.env, NODE_V8_COVERAGE: directory }, stdio: "inherit",
});
if (result.error) console.error(`Could not run suite: ${result.error.message}`);
if (result.signal) console.error(`Suite terminated by ${result.signal}`);

const sources: Record<string, string> = {};
const collect = (path: string) => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) collect(full);
    else {
      const path = relative(root, full).split(sep).join("/");
      if (measuredSource(path)) sources[path] = readFileSync(full, "utf8");
    }
  }
};
sources["govern.ts"] = readFileSync(join(root, "govern.ts"), "utf8");
collect(join(root, "lib"));
collect(join(root, "ext"));
collect(join(root, "checks"));
collect(join(root, "scripts"));
const { profiles, empty, unreadable } = readCoverageProfiles(directory);
console.log(`empty V8 profiles (process killed before writing): ${empty.length} (${empty.join(", ")})`);
console.log(`unreadable V8 profiles: ${unreadable.length} (${unreadable.join(", ")})`);
for (const profile of profiles) {
  profile.result = profile.result.flatMap((script) => {
    if (!script.url.startsWith("file:")) return [];
    const path = relative(root, fileURLToPath(script.url)).split(sep).join("/");
    return Object.hasOwn(sources, path) ? [{ ...script, url: path }] : [];
  });
}
if (!profiles.length && !unreadable.length) throw new Error(`No V8 coverage profiles written to ${directory}`);
const files = mergeCoverage(sources, profiles);
const gate = coverageGate(files, unreadable);
const percent = (value: number | null) => value === null ? "unobserved" : `${value.toFixed(2)}%`;
console.log("\nFile\tLine %\tBranch %\tUncovered branches (file:line)");
for (const row of files) console.log(`${row.file}\t${percent(row.lines.percent)}\t${percent(row.branches.percent)}\t${row.uncoveredBranchLines.map((line) => `${row.file}:${line}`).join(", ")}`);
for (const [kind, total] of Object.entries(gate.totals)) console.log(`${kind} branch coverage: ${percent(total.percent)} (${total.covered}/${total.total}; floor ${total.floor}%)`);
for (const error of gate.errors) console.error(error);
const output = resolve(args[1] ?? join(generated, "coverage.json"));
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, JSON.stringify({ profiles: profiles.length, emptyProfiles: empty, unreadableProfiles: unreadable, suite: { status: result.status, signal: result.signal, error: result.error?.message }, files, gate }, null, 2) + "\n", { mode: 0o600 });
chmodSync(output, 0o600);
console.log(`JSON: ${output}\nV8 profiles: ${directory}`);
process.exitCode = result.error || result.signal ? 1 : ((result.status ?? 1) || gate.exitCode);
