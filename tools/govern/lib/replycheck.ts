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

/** "checked": the check ran and passed. "unverified": it failed or could not run. "shape only": the kind declares no check. */
export interface Verification {
  state: "checked" | "unverified" | "shape only";
  /** Why it is unverified (the check's own words, or why it could not run). */
  reason?: string; /** What a pass covers, e.g. "refs exist (2)". */ label?: string; argv?: string[]; exit?: number; seconds?: number; log?: string; source?: string;
}

const BUILTIN: Record<string, CheckDef> = {
  REVIEW: { argv: ["{node}", "--disable-warning=ExperimentalWarning", "{govern}/checks/file-refs.ts", "{reply}", "{repo}"], label: "refs exist" },
};

/** The checks of a queue's config.json, parsed; a wrong entry or a key that is no message kind fails naming the file. */
export function configChecks(file: string, raw: unknown, kinds: readonly string[]): Record<string, CheckDef> {
  if (raw === undefined) return {};
  const shape: Shape<Record<string, CheckDef>> = (v, p) => {
    const m = record(CHECK)(v, p);
    for (const k of Object.keys(m)) if (!kinds.includes(k)) reject(keyPath(p, k), `not a message kind (${kinds.join(", ")})`);
    return m;
  };
  return check(file, { checks: raw }, obj({ checks: shape })).checks;
}

/** The checks that apply to a task of kind `taskKind` answered with a reply of `replyKind`: for each kind the profile's (content kinds
 *  only), else the config's, else the built-in; the union, each distinct check once. Empty: shape only. */
export function declared(taskKind: string, replyKind: string, profileCheck: CheckDef | undefined, fromConfig: Record<string, CheckDef>): Declared[] {
  const out: Declared[] = [];
  for (const kind of new Set([taskKind, replyKind])) {
    const one: Declared | undefined = profileCheck && CONTENT_KINDS.includes(kind) ? { def: profileCheck, source: "profile" }
      : Object.hasOwn(fromConfig, kind) ? { def: fromConfig[kind]!, source: "config.json" }
      : Object.hasOwn(BUILTIN, kind) ? { def: BUILTIN[kind]!, source: "built-in" } : undefined;
    if (one && !out.some((x) => x.def === one.def)) out.push(one);
  }
  return out;
}
export interface Declared { def: CheckDef; source: string }

interface Reply { id: string; summary: string; body: string; kinds: string[]; dir: string; logDir: string }

/** Run the checks against the reply's summary and body. Anything but a clean exit 0 is "unverified", and so is a checker that throws:
 *  the reply is still sent, never lost to a failing check. */
export function verify(ds: Declared[], o: Reply): Verification {
  if (!ds.length) return { state: "shape only" };
  try { return run(ds, o); } catch (e) { return { state: "unverified", reason: `the check could not run: ${e instanceof Error ? e.message : String(e)}` }; }
}

function run(ds: Declared[], o: Reply): Verification {
  if (o.kinds.some((k) => CONTENT_KINDS.includes(k)) && !o.body.trim()) return { state: "unverified", reason: "the reply body is empty" };
  const labels: string[] = [];
  let last: Verification | undefined;
  for (const [i, d] of ds.entries()) {
    const v = runOne(d, { ...o, id: o.id, n: ds.length > 1 ? `.${i + 1}` : "" });
    if (v.state !== "checked") return v;
    labels.push(v.label ?? "check passed");
    last = v;
  }
  return { ...last!, label: labels.join(", ") };
}

function runOne(d: Declared, o: Reply & { n: string }): Verification {
  const base = join(o.logDir, o.id);
  const replyFile = `${base}${o.n}.reply.txt`, log = `${base}${o.n}.check.log`;
  mkdirSync(o.logDir, { recursive: true });
  writeFileSync(replyFile, `${o.summary}\n\n${o.body}`);
  const root = repo();
  const subst: Record<string, string> = { reply: replyFile, dir: o.dir, repo: root, node: process.execPath, govern: GOVERN_DIR };
  const argv = d.def.argv.map((a) => a.replace(/\{(reply|dir|repo|node|govern)\}/g, (_, k: string) => subst[k]!));
  const [bin, ...args] = argv;
  const timeout = d.def.timeout ?? DEFAULT_TIMEOUT;
  const t0 = Date.now();
  const r = spawnSync(bin!, args, { cwd: root, encoding: "utf8", timeout: timeout * 1000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, env: { ...process.env, GOVERN_REPLY_FILE: replyFile } });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  writeFileSync(log, `$ ${argv.join(" ")}\n${said}\n`);
  const base2 = { argv, seconds, log, source: d.source };
  const code = r.error as NodeJS.ErrnoException | undefined;
  if (code?.code === "ETIMEDOUT") return { state: "unverified", reason: `the check timed out after ${timeout}s`, ...base2 };
  if (code) return { state: "unverified", reason: `the check could not run: ${code.code ?? ""} ${code.message}`.replace("  ", " "), ...base2 };
  if (r.signal) return { state: "unverified", reason: `the check was killed by ${r.signal}`, ...base2 };
  if (r.status !== 0) return { state: "unverified", reason: clip(said || `the check exited ${r.status} without a word`, 300), exit: r.status ?? -1, ...base2 };
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
