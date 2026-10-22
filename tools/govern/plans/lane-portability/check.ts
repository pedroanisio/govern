#!/usr/bin/env node
// The exit check of each build stage of the lane-portability plan (PLAN.md). It runs from the main checkout against the
// lane's worktree, so the agents that write the code cannot edit the check or the list of tests it demands.
//
//   node check.ts <stage> --root <worktree> [--spec <file>]
//
// A stage passes only when: the TypeScript project type-checks (when asked), every required Node and Gradle test exists
// and passes, no test anywhere in the run is skipped or todo, the listed make targets pass, the worktree has no
// uncommitted change (when asked), and the branch is merged (done stage). Exit 0 pass, 1 fail, 2 usage or bad spec.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class Usage extends Error {}

export interface Spec {
  stage: string;
  typecheck?: boolean;
  clean?: boolean;
  node?: { files: string[]; required: string[] };
  gradle?: { project: string; required: string[] };
  make?: string[];
  merged?: { remote: string; branch: string };
  /** Paths the branch must not change since `base` (the plan's own folder: the rules may not be edited by the work they judge). */
  untouched?: { base: string; paths: string[] };
}

const KEYS = ["stage", "typecheck", "clean", "node", "gradle", "make", "merged", "untouched"];
const strings = (v: unknown, at: string, nonEmpty: boolean): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new Usage(`${at} must be a list of non-empty strings`);
  if (nonEmpty && !v.length) throw new Usage(`${at} must not be empty`);
  return v as string[];
};
const only = (v: unknown, at: string, keys: string[]): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Usage(`${at} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Usage(`${at}.${k} is not a known key (${keys.join(", ")})`);
  return v as Record<string, unknown>;
};

/** The acceptance spec of a stage: typed, unknown keys refused, every list of required tests non-empty. */
export function parseSpec(file: string, text: string): Spec {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Usage(`${file}: not JSON (${(e as Error).message})`); }
  const o = only(raw, file, KEYS);
  if (typeof o["stage"] !== "string" || !o["stage"]) throw new Usage(`${file}.stage must be a stage name`);
  const spec: Spec = { stage: o["stage"] };
  for (const k of ["typecheck", "clean"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") throw new Usage(`${file}.${k} must be true or false`);
    spec[k] = o[k] as boolean;
  }
  if (o["node"] !== undefined) {
    const n = only(o["node"], `${file}.node`, ["files", "required"]);
    spec.node = { files: strings(n["files"], `${file}.node.files`, true), required: strings(n["required"], `${file}.node.required`, true) };
  }
  if (o["gradle"] !== undefined) {
    const g = only(o["gradle"], `${file}.gradle`, ["project", "required"]);
    if (typeof g["project"] !== "string" || !g["project"]) throw new Usage(`${file}.gradle.project must be a path`);
    spec.gradle = { project: g["project"], required: strings(g["required"], `${file}.gradle.required`, true) };
  }
  if (o["make"] !== undefined) spec.make = strings(o["make"], `${file}.make`, true);
  if (o["merged"] !== undefined) {
    const m = only(o["merged"], `${file}.merged`, ["remote", "branch"]);
    if (typeof m["remote"] !== "string" || typeof m["branch"] !== "string") throw new Usage(`${file}.merged needs remote and branch`);
    spec.merged = { remote: m["remote"], branch: m["branch"] };
  }
  if (o["untouched"] !== undefined) {
    const u = only(o["untouched"], `${file}.untouched`, ["base", "paths"]);
    if (typeof u["base"] !== "string" || !u["base"]) throw new Usage(`${file}.untouched.base must be a git ref`);
    spec.untouched = { base: u["base"], paths: strings(u["paths"], `${file}.untouched.paths`, true) };
  }
  if (!spec.node && !spec.gradle && !spec.make && !spec.merged && !spec.typecheck && !spec.untouched) throw new Usage(`${file} checks nothing`);
  return spec;
}

export interface TapResult { title: string; ok: boolean; directive: "skip" | "todo" | undefined }
/** The top-level results of a node --test TAP stream (subtests are indented and belong to their parent). */
export function parseTap(text: string): TapResult[] {
  const out: TapResult[] = [];
  for (const line of text.split("\n")) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!m) continue;
    const d = /^(.*?) # (SKIP|TODO)\b.*$/i.exec(m[2]!);
    out.push({ title: d ? d[1]! : m[2]!, ok: m[1] === "ok", directive: d ? (d[2]!.toLowerCase() as "skip" | "todo") : undefined });
  }
  return out;
}

export interface JUnitCase { name: string; outcome: "passed" | "failed" | "skipped" }
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The test cases of a JUnit XML report (Gradle's), named SimpleClass.method. */
export function parseJUnit(xml: string): JUnitCase[] {
  const out: JUnitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attr = (k: string) => unescape(new RegExp(`\\b${k}="([^"]*)"`).exec(m![1]!)?.[1] ?? "");
    const body = m[3] ?? "";
    const cls = attr("classname").split(".").pop();
    out.push({ name: `${cls}.${attr("name")}`, outcome: /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed" });
  }
  return out;
}

const HOUR = 3_600_000;
/** The environment of a child run: without NODE_TEST_CONTEXT, which a parent `node --test` sets and which would switch the
 *  child's reporter away from the TAP this file reads. */
function childEnv(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return env;
}
function sh(cmd: string, args: string[], cwd: string, timeout = HOUR) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 256 << 20, env: childEnv() });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error?.message };
}
const tail = (s: string, n = 40) => s.trimEnd().split("\n").slice(-n).join("\n");

/** Runs every check the spec names; returns the problems found (empty: the stage passes) and progress lines. */
export function runChecks(spec: Spec, root: string): { problems: string[]; lines: string[] } {
  const problems: string[] = [], lines: string[] = [];
  if (spec.typecheck) {
    const dir = join(root, "tools", "govern"), tsc = join(dir, "node_modules", ".bin", "tsc");
    if (!existsSync(tsc)) problems.push(`no tsc at ${tsc}: run npm ci --ignore-scripts --prefix ${dir}`);
    else {
      const r = sh(tsc, ["-p", join(dir, "tsconfig.json")], root);
      if (r.code === 0) lines.push("typecheck: ok");
      else problems.push(`typecheck failed:\n${tail(r.out)}`);
    }
  }
  if (spec.node) {
    const missing = spec.node.files.filter((f) => !existsSync(join(root, f)));
    for (const f of missing) problems.push(`test file missing: ${f}`);
    if (!missing.length) {
      const r = sh(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", "--test-timeout=300000", ...spec.node.files], root);
      const results = parseTap(r.out);
      if (r.error) problems.push(`node tests did not finish: ${r.error}`);
      const byTitle = new Map(results.map((x) => [x.title, x]));
      for (const t of spec.node.required) {
        const x = byTitle.get(t);
        if (!x) problems.push(`required test missing: ${t}`);
        else if (x.directive) problems.push(`required test ${x.directive === "skip" ? "skipped" : "todo"}: ${t}`);
        else if (!x.ok) problems.push(`required test failed: ${t}`);
      }
      const deferred = results.filter((x) => x.directive).length;
      if (deferred) problems.push(`${deferred} test(s) skipped or todo: every test must run`);
      const failed = results.filter((x) => !x.ok && !x.directive && !spec.node!.required.includes(x.title));
      for (const x of failed) problems.push(`test failed: ${x.title}`);
      if (r.code !== 0 && !problems.length) problems.push(`node --test exited ${r.code}:\n${tail(r.out)}`);
      if (!problems.length) lines.push(`node: ${results.length} tests passed, ${spec.node.required.length} required`);
    }
  }
  if (spec.gradle) {
    const project = join(root, spec.gradle.project), results = join(project, "app", "build", "test-results", "testDebugUnitTest");
    rmSync(results, { recursive: true, force: true }); // stale reports must not pass a stage
    const r = sh(join(project, "gradlew"), ["--no-daemon", "-q", "testDebugUnitTest"], project);
    const cases = existsSync(results) ? readdirSync(results).filter((f) => f.endsWith(".xml")).flatMap((f) => parseJUnit(readFileSync(join(results, f), "utf8"))) : [];
    const byName = new Map(cases.map((c) => [c.name, c]));
    for (const t of spec.gradle.required) {
      const c = byName.get(t);
      if (!c) problems.push(`required Android test missing: ${t}`);
      else if (c.outcome !== "passed") problems.push(`required Android test ${c.outcome}: ${t}`);
    }
    const skipped = cases.filter((c) => c.outcome === "skipped").length;
    if (skipped) problems.push(`${skipped} Android test(s) skipped: every test must run`);
    if (r.code !== 0 && !problems.length) problems.push(`gradle testDebugUnitTest exited ${r.code}:\n${tail(r.out)}`);
    if (!problems.length) lines.push(`android: ${cases.length} tests passed, ${spec.gradle.required.length} required`);
  }
  for (const target of spec.make ?? []) {
    const r = sh("make", ["-C", root, target], root);
    if (r.code === 0) lines.push(`make ${target}: ok`);
    else problems.push(`make ${target} failed:\n${tail(r.out)}`);
  }
  if (spec.clean) {
    const r = sh("git", ["status", "--porcelain"], root, 60_000);
    if (r.code !== 0) problems.push(`git status failed in ${root}: ${tail(r.out, 5)}`);
    else if (r.out.trim()) problems.push(`uncommitted changes in ${root} (commit the stage's work, then check again):\n${tail(r.out, 20)}`);
    else lines.push("worktree: committed");
  }
  if (spec.untouched) {
    const { base, paths } = spec.untouched;
    const r = sh("git", ["diff", "--name-only", `${base}...HEAD`, "--", ...paths], root, 60_000);
    if (r.code !== 0) problems.push(`cannot compare with ${base}: ${tail(r.out, 5)}`);
    else if (r.out.trim()) problems.push(`the branch changes files it must not (since ${base}):\n${tail(r.out, 20)}`);
    else lines.push(`untouched since ${base}: ${paths.join(", ")}`);
  }
  if (spec.merged) {
    const { remote, branch } = spec.merged;
    const f = sh("git", ["fetch", "-q", remote, branch], root, 300_000);
    const m = f.code === 0 ? sh("git", ["merge-base", "--is-ancestor", "HEAD", `${remote}/${branch}`], root, 60_000) : f;
    if (m.code === 0) lines.push(`merged: HEAD is in ${remote}/${branch}`);
    else problems.push(f.code !== 0 ? `cannot fetch ${remote} ${branch}: ${tail(f.out, 5)}` : `HEAD is not merged into ${remote}/${branch}`);
  }
  return { problems, lines };
}

function main(argv: string[]): number {
  const [stage, ...rest] = argv;
  const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (!stage || stage.startsWith("-")) throw new Usage("usage: check.ts <stage> --root <worktree> [--spec <file>]");
    const root = opt("--root");
    if (!root) throw new Usage("--root <worktree> is required");
    if (!existsSync(root)) throw new Usage(`--root ${root} does not exist`);
    const here = dirname(fileURLToPath(import.meta.url));
    const file = opt("--spec") ?? join(here, "acceptance", `${stage}.json`);
    if (!existsSync(file)) throw new Usage(`no acceptance spec for stage ${stage} (${file})`);
    const spec = parseSpec(file, readFileSync(file, "utf8"));
    if (spec.stage !== stage) throw new Usage(`${file} is the spec of stage ${spec.stage}, not ${stage}`);
    const { problems, lines } = runChecks(spec, resolve(root));
    for (const l of lines) process.stdout.write(`${l}\n`);
    if (problems.length) {
      process.stdout.write(`acceptance ${stage}: FAILED\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`acceptance ${stage}: ok\n`);
    return 0;
  } catch (e) {
    if (e instanceof Usage) { process.stderr.write(`check: ${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
