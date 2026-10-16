// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// Content checks on queue replies (docs/govern-features.md 3.5). The dispatcher's reply passes the reply schema (shape only);
// a check goes further: a command run against the reply's text (summary and body) after the session ends. Selected by two kinds:
// the kind of the TASK (what the sender asked for) and the kind the reply claims, so a reply cannot opt out by claiming another
// kind; the checks of both run. For each kind, first wins: the task's profile (`check` in its capabilities file; only for the
// content kinds HANDOFF, REVIEW and DECISION), the queue's config.json (`checks`, by message kind), the built-ins here (REVIEW:
// the cited file references exist).
//
// The five controls (CLAUDE.md): 1 typed parse: a check declaration is parsed with CHECK, which rejects unknown keys, and a
// config kind must be a reply kind; 2 semantic validation: the command itself, which sees the reply and the repo, decides, and
// only exit 0 is a pass; 3 defined failure path: a failing or unrunnable check (missing binary, timeout, signal, output flood)
// marks the reply "unverified", never a pass, and the reply is kept whole; 4 tests: test/replycheck.test.ts feeds wrong
// references, a dead URL, a missing binary, a hang and a kill; 5 deterministic bounds: one run per reply, a timeout (default
// 60 s, killed with SIGKILL), output read up to a fixed size, and no retry.
//
// Beyond the kind checks, the sender can name checks (`--check NAME`, resolved: the profile's capabilities file `checks`, the queue's
// config.json `checks.named`, the built-ins) and one command (`--verify -- ARGV`) that govern runs after every other check passed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clip } from "./util.ts";
import { obj, arr, str, posInt, record, check, reject, keyPath, type Shape } from "./shape.ts";
import { repo } from "./workspace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOVERN_DIR = resolve(HERE, "..");

/** A check: argv with {reply} (the reply's text as a file), {dir} (the task's project folder), {repo}, {node} and {govern}
 *  (tools/govern) expanded; exit 0 passes. timeout: seconds (default 60). */
export interface CheckDef { argv: string[]; timeout?: number; label?: string }
export const CHECK: Shape<CheckDef> = obj({ argv: arr(str, { nonEmpty: true }) }, { timeout: posInt, label: str });
/** Kinds whose replies carry content to check; a profile's `check` applies to these only. */
export const CONTENT_KINDS: readonly string[] = ["HANDOFF", "REVIEW", "DECISION"];

export const DEFAULT_TIMEOUT = 60;
const MAX_OUTPUT = 1 << 20;
/** Most seconds the sender's `--verify` command may run, and how many of its last output lines the log keeps. */
export const VERIFY_TIMEOUT = 600;
const VERIFY_TAIL = 12;

/** "checked": the check ran and passed. "unverified": it failed or could not run. "shape only": the kind declares no check. */
export interface Verification {
  state: "checked" | "unverified" | "shape only";
  /** Why it is unverified (the check's own words, or why it could not run). */
  reason?: string; /** What a pass covers, e.g. "refs exist (2)". */ label?: string; argv?: string[]; exit?: number; seconds?: number; log?: string; source?: string;
}

const script = (name: string, ...args: string[]): string[] => ["{node}", "--disable-warning=ExperimentalWarning", `{govern}/checks/${name}.ts`, ...args];
const FILE_REFS: CheckDef = { argv: script("file-refs", "{reply}", "{repo}"), label: "refs exist" };
const COMMIT_REFS: CheckDef = { argv: script("commit-refs", "{reply}", "{dir}"), label: "commits exist" };
const BUILTIN: Record<string, CheckDef> = { REVIEW: FILE_REFS, HANDOFF: COMMIT_REFS };
/** What commit-refs exits with when the reply names no commit: applied by default (not asked for) the reply then stays shape only. */
const NOTHING_TO_CHECK = 3;
/** The built-in checks a sender can name with `--check`. */
export const BUILTIN_NAMED: Record<string, CheckDef> = {
  "file-refs": FILE_REFS, "commit-refs": COMMIT_REFS,
  "claims-cited": { argv: script("claims-cited", "{reply}"), label: "claims addressed" },
};
const CHECK_NAME = /^[a-z0-9][a-z0-9.-]*$/;

/** The checks of a queue's config.json: `byKind` (a key per message kind) and `named` (the `named` sub-map: a check per name, for `--check`). */
export interface ConfigChecks { byKind: Record<string, CheckDef>; named: Record<string, CheckDef> }
/** The checks of a queue's config.json, parsed; a wrong entry, a key that is no message kind (`named` apart) or a bad check name fails naming the file. */
export function configChecks(file: string, raw: unknown, kinds: readonly string[]): ConfigChecks {
  if (raw === undefined) return { byKind: {}, named: {} };
  const named: Shape<Record<string, CheckDef>> = (v, p) => {
    const m = record(CHECK)(v, p);
    for (const k of Object.keys(m)) if (!CHECK_NAME.test(k)) reject(keyPath(p, k), "a check name is lowercase letters, digits, dots and dashes");
    return m;
  };
  const shape: Shape<ConfigChecks> = (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return record(CHECK)(v, p) as never; // throws, wording the error as ever
    const { named: n, ...kindsOnly } = v as Record<string, unknown>;
    const byKind = record(CHECK)(kindsOnly, p);
    for (const k of Object.keys(byKind)) if (!kinds.includes(k)) reject(keyPath(p, k), `not a message kind (${kinds.join(", ")}; "named" holds the checks chosen with --check)`);
    return { byKind, named: n === undefined ? {} : named(n, keyPath(p, "named")) };
  };
  return check(file, { checks: raw }, obj({ checks: shape })).checks;
}

/** Every name `--check` accepts for a task under a profile with `profileChecks`: the profile's, the config's, then the built-ins. */
export const checkNames = (profileChecks: Record<string, CheckDef> | undefined, named: Record<string, CheckDef>): string[] =>
  [...new Set([...Object.keys(profileChecks ?? {}), ...Object.keys(named), ...Object.keys(BUILTIN_NAMED)])].sort();

/** The checks the names stand for, first wins: the profile's capabilities file, the config's `named`, the built-ins; `missing` lists names none defines. */
export function resolveNamed(names: readonly string[], profileChecks: Record<string, CheckDef> | undefined, named: Record<string, CheckDef>): { found: Declared[]; missing: string[] } {
  const found: Declared[] = [], missing: string[] = [];
  for (const n of names) {
    if (profileChecks && Object.hasOwn(profileChecks, n)) found.push({ def: profileChecks[n]!, source: `profile (${n})` });
    else if (Object.hasOwn(named, n)) found.push({ def: named[n]!, source: `config.json (${n})` });
    else if (Object.hasOwn(BUILTIN_NAMED, n)) found.push({ def: BUILTIN_NAMED[n]!, source: `built-in (${n})` });
    else missing.push(n);
  }
  return { found, missing };
}

/** The sender's `--verify` argv as a check: run literally (no placeholders, no shell) in the task's folder, after every other check passed. */
export const verifyDeclared = (argv: string[]): Declared => ({ def: { argv, timeout: VERIFY_TIMEOUT, label: "verify (exit 0)" }, source: "sender (--verify)", verify: true });

/** The checks that apply to a task of kind `taskKind` answered with a reply of `replyKind`: for each kind the profile's (content kinds
 *  only), else the config's, else the built-in; the union, each distinct check once. Empty: shape only. */
export function declared(taskKind: string, replyKind: string, profileCheck: CheckDef | undefined, fromConfig: Record<string, CheckDef>, chosen: Declared[] = []): Declared[] {
  const out: Declared[] = [];
  for (const kind of new Set([taskKind, replyKind])) {
    const one: Declared | undefined = profileCheck && CONTENT_KINDS.includes(kind) ? { def: profileCheck, source: "profile" }
      : Object.hasOwn(fromConfig, kind) ? { def: fromConfig[kind]!, source: "config.json" }
      : Object.hasOwn(BUILTIN, kind) ? { def: BUILTIN[kind]!, source: "built-in", ...(kind === "HANDOFF" ? { na: true } : {}) } : undefined;
    if (one && !out.some((x) => x.def === one.def)) out.push(one);
  }
  // the sender's checks follow the kind's (one the kind already runs is not run twice); the --verify command, when given, is last
  for (const c of chosen.filter((x) => !x.verify)) if (!out.some((x) => x.def === c.def)) out.push(c);
  out.push(...chosen.filter((x) => x.verify));
  return out;
}
/** `na`: a built-in applied by default to a kind; when it finds nothing to check (exit 3) the reply stays shape only.
 *  `verify`: the sender's own command, run literally in the task's folder. */
export interface Declared { def: CheckDef; source: string; na?: boolean; verify?: boolean }

interface Reply { id: string; summary: string; body: string; kinds: string[]; dir: string; logDir: string;
  /** The task's attached files, absolute: a check reads them from GOVERN_TASK_FILES (a JSON array). */ files?: string[];
  /** Names the sender asked for that nothing defines: the reply is then unverified, saying so. */ missing?: string[] }

/** Run the checks against the reply's summary and body. Anything but a clean exit 0 is "unverified", and so is a checker that throws:
 *  the reply is still sent, never lost to a failing check. */
export function verify(ds: Declared[], o: Reply): Verification {
  if (o.missing?.length) return { state: "unverified", reason: `check ${o.missing.join(", ")} is not defined (have: ${checkNames(undefined, {}).join(", ")}, and those of the profile and config.json)` };
  if (!ds.length) return { state: "shape only" };
  try { return run(ds, o); } catch (e) { return { state: "unverified", reason: `the check could not run: ${e instanceof Error ? e.message : String(e)}` }; }
}

function run(ds: Declared[], o: Reply): Verification {
  if (o.kinds.some((k) => CONTENT_KINDS.includes(k)) && !o.body.trim()) return { state: "unverified", reason: "the reply body is empty" };
  const labels: string[] = [];
  let last: Verification | undefined;
  for (const [i, d] of ds.entries()) {
    const v = runOne(d, { ...o, id: o.id, n: ds.length > 1 ? `.${i + 1}` : "" });
    if (v.state === "shape only") continue; // a default check that found nothing to check
    if (v.state !== "checked") return v;
    labels.push(v.label ?? "check passed");
    last = v;
  }
  return last ? { ...last, label: labels.join(", ") } : { state: "shape only" };
}

function runOne(d: Declared, o: Reply & { n: string }): Verification {
  const base = join(o.logDir, o.id);
  const replyFile = `${base}${o.n}.reply.txt`, log = `${base}${o.n}.check.log`;
  mkdirSync(o.logDir, { recursive: true });
  writeFileSync(replyFile, `${o.summary}\n\n${o.body}`);
  const root = repo();
  const subst: Record<string, string> = { reply: replyFile, dir: o.dir, repo: root, node: process.execPath, govern: GOVERN_DIR };
  // the sender's --verify argv is run as given: no placeholder is expanded in it
  const argv = d.verify ? d.def.argv : d.def.argv.map((a) => a.replace(/\{(reply|dir|repo|node|govern)\}/g, (_, k: string) => subst[k]!));
  const [bin, ...args] = argv;
  const timeout = d.def.timeout ?? DEFAULT_TIMEOUT;
  const t0 = Date.now();
  const r = spawnSync(bin!, args, { cwd: d.verify ? o.dir : root, encoding: "utf8", timeout: timeout * 1000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, env: { ...process.env, GOVERN_REPLY_FILE: replyFile, GOVERN_TASK_FILES: JSON.stringify(o.files ?? []) } });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const tail = said.split("\n").slice(-VERIFY_TAIL).join("\n");
  writeFileSync(log, `$ ${argv.join(" ")}\n${d.verify ? tail : said}\n`); // a verify command may print a lot: its log keeps the last lines
  const base2 = { argv, seconds, log, source: d.source };
  const code = r.error as NodeJS.ErrnoException | undefined;
  const what = d.verify ? "the verify command" : "the check";
  if (code?.code === "ETIMEDOUT") return { state: "unverified", reason: `${what} timed out after ${timeout}s`, ...base2 };
  if (code) return { state: "unverified", reason: `${what} could not run: ${code.code ?? ""} ${code.message}`.replace("  ", " "), ...base2 };
  if (r.signal) return { state: "unverified", reason: `${what} was killed by ${r.signal}`, ...base2 };
  if (r.status === NOTHING_TO_CHECK && d.na) return { state: "shape only" };
  if (r.status !== 0) return { state: "unverified", reason: d.verify ? `verify exited ${r.status}: ${clip(tail.split("\n").slice(-3).join(" | ") || "no output", 240)}` : clip(said || `the check exited ${r.status} without a word`, 300), exit: r.status ?? -1, ...base2 };
  if (d.verify) return { state: "checked", exit: 0, label: d.def.label ?? "verify (exit 0)", ...base2 };
  const fraction = /^(\d+\/\d+) /.exec(said)?.[1]; // "3/3 claims addressed": the label leads with it
  if (fraction) return { state: "checked", exit: 0, label: `${fraction} ${d.def.label ?? "checked"}`, ...base2 };
  const count = /^(\d+) /.exec(said)?.[1];
  return { state: "checked", exit: 0, label: `${d.def.label ?? "check passed"}${count ? ` (${count})` : ""}`, ...base2 };
}

/** The mark shown next to a reply: [checked: what was checked], [unverified] or [shape only]; nothing for a message no check was asked of. */
export const tag = (v: Verification | undefined): string => (v ? `[${v.state}${v.state === "checked" && v.label ? `: ${v.label}` : ""}]` : "");

/** The lines `govern task show` prints for a reply: what the check said, and where its log is. */
export const verdict = (v: Verification): string =>
  v.state === "checked" ? `check: checked${v.label ? `: ${v.label}` : ""} (exit ${v.exit ?? 0})${v.log ? ` · log ${v.log}` : ""}`
  : v.state === "unverified" ? `UNVERIFIED: ${v.reason ?? "check failed"}${v.log ? ` · log ${v.log}` : ""}\nthe content below is kept, but nothing checked it`
  : "check: none declared for this kind (shape only)";
