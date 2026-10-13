// A lane: its folder, its govern.json (state, commands, process) and its brief. A lane follows a process (lib/process.ts).
import { existsSync, readFileSync, appendFileSync, mkdirSync, globSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GovernError, fail, readJson, writeJson, nowIso, latest, plain, clip, readJsonl } from "./util.ts";
import { getProcess, processOf, processes, processName } from "./process.ts";
import { obj, arr, record, emptyRecord, str, name, posInt, literal, parseFile, reject, keyPath, type Shape } from "./shape.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Settings a workspace keeps in govern.config.json: where its lanes, queue and processes live (relative to the file). */
export interface WorkspaceConfig { projects?: string; queue?: string; processes?: string }
/** The nearest folder at or above `dir` that holds govern.config.json or PALS-Notes/projects, or undefined. */
function workspaceAbove(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, "govern.config.json")) || existsSync(join(d, "PALS-Notes", "projects"))) return d;
    if (dirname(d) === d) return undefined;
  }
}
/** The workspace. GOVERN_REPO, else the nearest workspace above the cwd, else the sibling render-frontend-js (the
 *  dispatcher service; super-tools sits beside it since 2026-10-13), else the old parent. */
export const REPO = process.env.GOVERN_REPO
  ?? workspaceAbove(process.cwd())
  ?? [resolve(HERE, "..", "..", "..", "..", "render-frontend-js"), resolve(HERE, "..", "..", "..", "..")].find((d) => existsSync(join(d, "PALS-Notes", "projects")))
  ?? resolve(HERE, "..", "..", "..", "..", "render-frontend-js");
function readConfig(): WorkspaceConfig {
  const f = join(REPO, "govern.config.json");
  if (!existsSync(f)) return {};
  const c = readJson<WorkspaceConfig>(f);
  const abs = (v?: string) => (v ? resolve(REPO, v) : undefined);
  return { projects: abs(c.projects), queue: abs(c.queue), processes: abs(c.processes) };
}
/** The workspace's govern.config.json, paths made absolute; {} when there is none. Environment variables win over it. */
export const CONFIG = readConfig();
export const PROJECTS = process.env.GOVERN_PROJECTS ?? CONFIG.projects ?? join(REPO, "PALS-Notes", "projects");
export const WORKFLOW = process.env.GOVERN_WORKFLOW ?? join(REPO, "var", "media-business", "channels", "palsnotes", "workflow", "WORKFLOW.md");
export const FILM_BUILD = join(REPO, "PALS-Notes", "videos", "lib", "tools", "film_build.py");

/** The eight stages of WORKFLOW.md, in order (the built-in "video" process). */
export const STAGES = ["plan", "script", "script-check", "sound", "preview", "produce", "final", "deliver"] as const;
export type Stage = (typeof STAGES)[number];
/** Lane kinds that need no --process: a video (long, short) or ops work (engine, lab, docs, channel set-up). */
export const KINDS = ["long", "short", "ops"] as const;
/** The video process's owner gates, in order (other processes name their own). */
export const GATES = ["script", "final", "publish"] as const;

/** A command with settings: its argv and how long it may run in the foreground (seconds). A plain argv array is the same
 *  command with the default timeout. */
export interface Command { argv: string[]; timeout?: number }
export const argvOf = (c: string[] | Command): string[] => (Array.isArray(c) ? c : c.argv);
/** A command as one line: its argv, and its own timeout when it has one. */
export const commandLine = (c: string[] | Command): string => `${argvOf(c).join(" ")}${!Array.isArray(c) && c.timeout ? ` (timeout ${c.timeout}s)` : ""}`;

export interface Approval { at: string; quote: string }
export interface Note { at: string; stage: string; text: string }
/** Another lane this one waits on: met when that lane is finished, or (with `stage`) has moved past that stage. */
export interface After { lane: string; stage?: string }
export interface Project {
  version: 1;
  slug: string;
  title: string;
  /** long or short for a video, ops, or the process name for any other process. */
  kind: string;
  /** The process the lane follows (processes/*.json); absent on old lanes: ops → ops, else video. */
  process?: string;
  lang: string;
  parent?: string;
  stage: string;
  created: string;
  /** Set when `govern advance` moves past the last stage. */
  finished?: string;
  /** name → argv, or {argv, timeout}; `{repo}`, `{dir}`, `{python}` are expanded. Extra args from `govern run` are appended. */
  commands: Record<string, string[] | Command>;
  /** name → path or glob relative to the project folder; a glob resolves to its newest match. */
  files: Record<string, string>;
  /** stage → command name: the lane's own exit check, over the process's. */
  checks?: Record<string, string>;
  after?: After[];
  approvals: Record<string, Approval>;
  notes: Note[];
}

export const projectDir = (slug: string) => join(PROJECTS, slug);
export const stateFile = (slug: string) => join(projectDir(slug), "govern.json");
export const governDir = (slug: string) => join(projectDir(slug), "govern");
export const ledgerFile = (slug: string) => join(governDir(slug), "ledger.jsonl");

/** A slug as its lane's folder names it: `.` segments dropped (`./l1`, `l1/.` and `a/./b` are the folders l1, l1 and a/b).
 *  Null for a slug that is no folder under PROJECTS: a leading "/", a ".." or empty segment, or nothing left (`.`). */
const laneSlug = (slug: string): string | null => {
  if (slug.startsWith("/")) return null;
  const parts = slug.split("/").filter((p) => p !== ".");
  return parts.length && !parts.some((p) => p === ".." || p === "") ? parts.join("/") : null;
};
/** The lane's slug as its folder names it (see laneSlug); a missing or bad slug is a GovernError (exit 2). */
export function checkSlug(slug: string | undefined): string {
  if (!slug) fail(`missing <slug> (a folder under ${relative(REPO, PROJECTS) || PROJECTS}, e.g. a-millionth-apart or ops/engine)`);
  return laneSlug(slug!) ?? fail(`bad slug: ${slug}`);
}

/** A timestamp as nowIso() writes it (an offset is accepted too). */
const iso: Shape<string> = (v, at) =>
  (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))
    ? v : reject(at, `must be an ISO timestamp (got ${JSON.stringify(v)})`));
const ARGV = arr(str, { nonEmpty: true });
const COMMAND_OBJ = obj({ argv: ARGV }, { timeout: posInt });
/** A command: a plain argv array, or {argv, timeout?}. */
const COMMAND: Shape<string[] | Command> = (v, at) =>
  (Array.isArray(v) ? ARGV(v, at) : typeof v === "object" && v !== null ? COMMAND_OBJ(v, at)
    : reject(at, `must be an argv array or {argv, timeout?} (got ${JSON.stringify(v)})`));
const PROJECT = obj(
  { version: literal(1), slug: name, title: str, kind: name, lang: name, stage: name, created: iso,
    commands: record(COMMAND), files: record(str), approvals: record(obj({ at: iso, quote: str })),
    notes: arr(obj({ at: iso, stage: name, text: str })) },
  { process: name, parent: str, finished: iso, checks: record(name), after: arr(obj({ lane: name }, { stage: name })) },
);

/** Parse the text of lane `slug`'s govern.json (`file`): typed, unknown keys refused, then checked against what the types
 *  cannot say: the slug is the lane's folder, the process exists and the kind fits it, the stage and every stage a check
 *  is set for are the process's, and every lane waited on is a valid slug. Every failure is a GovernError naming the
 *  file and the JSON path of the wrong field. `slug` is the folder's slug (checkSlug's); a stored slug or lane waited on
 *  with `.` segments (`./l1`, which `govern new ./l1` and `dep --after ./l1` once stored) names the same folder and is
 *  returned as the folder's slug. */
export function parseProject(file: string, text: string, slug: string): Project {
  return parseFile(file, text, (v, at) => {
    const p: Project = PROJECT(v, at);
    if (laneSlug(p.slug) !== slug) reject(`${at}.slug`, `is ${JSON.stringify(p.slug)}, but the lane is ${JSON.stringify(slug)} (its folder)`);
    p.slug = slug;
    const pname = processName(p);
    const all = processes();
    const pr = all.get(pname) ?? reject(p.process !== undefined ? `${at}.process` : `${at}.kind`, `no process "${pname}" (have: ${[...all.keys()].join(", ")})`);
    if (p.process === undefined && !(KINDS as readonly string[]).includes(p.kind)) reject(`${at}.kind`, `must be long, short or ops when there is no process (got ${JSON.stringify(p.kind)})`);
    if (pr.kinds && !pr.kinds.includes(p.kind)) reject(`${at}.kind`, `must be ${pr.kinds.join(" or ")} for process ${pr.name} (got ${JSON.stringify(p.kind)})`);
    const stages = pr.stages.map((s) => s.name);
    if (!stages.includes(p.stage)) reject(`${at}.stage`, `no stage "${p.stage}" in process ${pr.name}`);
    for (const s of Object.keys(p.checks ?? {})) if (!stages.includes(s)) reject(keyPath(`${at}.checks`, s), `no stage "${s}" in process ${pr.name}`);
    (p.after ?? []).forEach((x, i) => { x.lane = laneSlug(x.lane) ?? reject(`${at}.after[${i}].lane`, `bad slug: ${x.lane}`); });
    return p;
  });
}

export function load(given: string | undefined): Project {
  const slug = checkSlug(given);
  const f = stateFile(slug);
  if (!existsSync(f)) fail(`${slug}: no govern.json — start it with: govern new ${slug} --process NAME (or --kind long|short|ops) --title "…"`);
  return parseProject(f, readFileSync(f, "utf8"), slug);
}
/** Write lane `p`'s govern.json, only after the same parse load() runs (shape and the semantic checks) passes over the
 *  exact text: govern never writes a file it would then refuse to read. A failure is that GovernError, and nothing is
 *  written. What is written is that parse's result, so the slugs in it are the folders' (no `.` segments). */
export function save(p: Project): void {
  const slug = checkSlug(p.slug);
  const f = stateFile(slug);
  let q: Project;
  try { q = parseProject(f, JSON.stringify(p), slug); }
  catch (e) {
    if (e instanceof GovernError) fail(`${e.message} (not saved: govern writes no govern.json it would refuse to read)`, e.code);
    throw e;
  }
  writeJson(f, q);
}

export function create(given: string, o: { kind?: string; process?: string; title?: string; lang?: string; parent?: string }): Project {
  const slug = checkSlug(given);
  if (existsSync(stateFile(slug))) fail(`${slug}: govern.json already exists`);
  let kind: string, proc: string;
  if (o.process) {
    const pr = getProcess(o.process);
    proc = pr.name;
    if (pr.kinds) {
      if (!o.kind || !pr.kinds.includes(o.kind)) fail(`--kind must be ${pr.kinds.join(" or ")}`);
      kind = o.kind!;
    } else kind = pr.name;
  } else {
    if (!o.kind || !(KINDS as readonly string[]).includes(o.kind)) fail("--kind must be long, short or ops (or name a --process)");
    kind = o.kind!;
    proc = kind === "ops" ? "ops" : "video";
  }
  const dir = projectDir(slug);
  const commands = emptyRecord<string[]>();
  const files = emptyRecord<string>();
  if (proc === "video") {
    if (existsSync(join(dir, "film.json"))) {
      commands.fb = ["{python}", "{repo}/PALS-Notes/videos/lib/tools/film_build.py", "film.json"];
      files.timings = "timings.json";
    }
    files.approval = "APPROVAL.md";
    files.sheet = "**/*sheet*.png";
  }
  const p: Project = {
    version: 1, slug, title: o.title ?? slug, kind, process: proc, lang: o.lang ?? "en", ...(o.parent ? { parent: o.parent } : {}),
    stage: getProcess(proc).stages[0].name, created: nowIso(), commands, files, approvals: emptyRecord<Approval>(), notes: [],
  };
  save(p);
  return p;
}

export const stagesOf = (p: Pick<Project, "process" | "kind">): string[] => processOf(p).stages.map((s) => s.name);

export function stageOf(s: string | undefined, p: Pick<Project, "process" | "kind">): string {
  const list = stagesOf(p);
  if (!s || !list.includes(s)) fail(`stage must be one of: ${list.join(", ")}`);
  return s!;
}

/** The command that checks a stage's exit condition: the lane's own, else the process's; undefined when none. */
export function checkOf(p: Project, stage = p.stage): string | undefined {
  return p.checks?.[stage] ?? processOf(p).stages.find((s) => s.name === stage)?.check;
}

/** Every lane's slug under PROJECTS, sorted. */
export const laneSlugs = (): string[] => globSync("**/govern.json", { cwd: PROJECTS }).map((f) => dirname(f)).sort();

/** The rows of a command that lists every lane (status, desk): `row` formats a lane that loads; a lane whose
 *  govern.json (or a lane its row reads, through `after`) fails its parse becomes one row, `<slug> ✖ <file>: <path>:
 *  <message>`, and the other lanes still show. `failed` counts those rows; the caller exits 1 after printing them.
 *
 *  Process files are not degraded per lane: they are read once here, before any lane, and a bad one stops the whole
 *  listing (exit 2). Every lane's stages, gates and checks come from that shared config, so with a broken process
 *  file no lane's row would be trustworthy. */
export function laneRows(slugs: string[], row: (slug: string, p: Project) => string, indent = ""): { rows: string[]; failed: number } {
  processes();
  let failed = 0;
  const rows = slugs.map((s) => {
    try { return row(s, load(s)); } catch (e) {
      if (!(e instanceof GovernError)) throw e;
      failed++;
      return `${indent}${s} ✖ ${e.message}`;
    }
  });
  return { rows, failed };
}

/** Whether one `after` entry is met, with a label for it. */
export function afterMet(a: After): { label: string; met: boolean } {
  const label = a.stage ? `${a.lane}:${a.stage}` : a.lane;
  if (!existsSync(stateFile(a.lane))) return { label, met: false };
  const o = load(a.lane);
  if (o.finished) return { label, met: true };
  if (!a.stage) return { label, met: false };
  const list = stagesOf(o);
  return { label, met: list.indexOf(o.stage) > list.indexOf(a.stage) };
}
/** The labels of the lanes this one still waits on. */
export const blockedBy = (p: Project): string[] => (p.after ?? []).map(afterMet).filter((x) => !x.met).map((x) => x.label);
/** "finished", "ready" / "blocked by …" for a lane with dependencies, else "". */
export function laneState(p: Project): string {
  if (p.finished) return "finished";
  if (!p.after?.length) return "";
  const b = blockedBy(p);
  return b.length ? `blocked by ${b.join(", ")}` : "ready";
}

export function appendLedger(slug: string, entry: Record<string, unknown>): void {
  mkdirSync(governDir(slug), { recursive: true });
  appendFileSync(ledgerFile(slug), JSON.stringify({ t: nowIso(), slug, ...entry }) + "\n");
}

/** The "Exit when" cell of a stage's row in WORKFLOW.md (the digest the AI works against). */
function workflowExit(stage: string): string | undefined {
  if (!existsSync(WORKFLOW) || !(STAGES as readonly string[]).includes(stage)) return undefined;
  const n = STAGES.indexOf(stage as Stage) + 1;
  const row = readFileSync(WORKFLOW, "utf8").split("\n").find((l) => l.startsWith(`| ${n} |`));
  if (!row) return undefined;
  const cells = row.split(/(?<!\\)\|/).map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
  const exit = cells[3];
  return exit === undefined ? undefined : plain(exit);
}
/** What "done" means for the lane's current stage: the process's text, or WORKFLOW.md's for the video process. */
export function exitCondition(p: Project, stage = p.stage): string | undefined {
  const pr = processOf(p);
  return pr.stages.find((s) => s.name === stage)?.exit ?? (pr.exitFrom === "workflow" ? workflowExit(stage) : undefined);
}

export function resolveFile(p: Project, name: string): string | undefined {
  const pat = p.files[name];
  if (!pat) return undefined;
  const dir = projectDir(p.slug);
  if (/[*?[]/.test(pat)) return latest(dir, pat);
  const f = join(dir, pat);
  return existsSync(f) ? f : undefined;
}

type Entry = Record<string, unknown>;
/** A stage's changes that wait on the owner: `sets`, its check-set entries, and `cmds`, per command name, the cmd-set /
 *  cmd-rm entries of a command that was the stage's check when it changed. Each list starts at its first swap. */
export interface PendingChanges { stage: string; sets: Entry[]; cmds: { name: string; changes: Entry[] }[] }
/** The stages a ledgered change concerns: a check-set its own stage; a cmd-set or cmd-rm the stages whose effective
 *  check named the command when it changed (recorded in the entry as `stages`). */
const stagesOfChange = (e: Entry): string[] =>
  e.kind === "check-set" ? [String(e.stage)] : (e.kind === "cmd-set" || e.kind === "cmd-rm") && Array.isArray(e.stages) ? e.stages.map(String) : [];
/** The changes from the first swap on; [] when there is none. */
function fromFirstSwap(xs: Entry[]): Entry[] {
  const i = xs.findIndex((e) => e.from != null);
  return i < 0 ? [] : xs.slice(i);
}
/** The check changes that wait on the owner, per stage of the lane's process, in process order.
 *  Rule: a change is a swap when what it replaces existed — a check-set whose `from` (the stage's effective check before
 *  it: the lane's own, else the process's) is not null, or a cmd-set / cmd-rm of a command that existed and was then the
 *  effective check of some stage. A swap is pending for its stages until (a) the lane is finished or (b) the owner
 *  accepts it: a `check-accept` entry for a stage clears every change for that stage ledgered before it. Nothing else
 *  clears it: not a passing check (a gamed check is what produces that pass), not moving back and forth, not leaving the
 *  stage. Setup — a stage with no check getting one, a command defined for the first time — is ledgered but is no swap;
 *  after a pending swap it still shows in the chain, which runs from the first swap on. */
export function pendingCheckChanges(p: Project, led: Entry[]): PendingChanges[] {
  if (p.finished) return [];
  const res: PendingChanges[] = [];
  for (const stage of stagesOf(p)) {
    let accepted = -1;
    led.forEach((e, i) => { if (e.kind === "check-accept" && e.stage === stage) accepted = i; });
    const since = led.slice(accepted + 1).filter((e) => stagesOfChange(e).includes(stage));
    const sets = fromFirstSwap(since.filter((e) => e.kind === "check-set"));
    const names = [...new Set(since.filter((e) => e.kind !== "check-set").map((e) => String(e.name)))];
    const cmds = names.map((name) => ({ name, changes: fromFirstSwap(since.filter((e) => e.kind !== "check-set" && e.name === name)) })).filter((x) => x.changes.length);
    if (sets.length || cmds.length) res.push({ stage, sets, cmds });
  }
  return res;
}
const shownCommand = (c: unknown) => (c == null ? "none" : commandLine(c as string[] | Command));

/** The compact context an AI session starts from instead of exploring the repo. */
export function brief(p: Project, o: { notes?: number } = {}): string {
  const dir = projectDir(p.slug);
  const rel = (f: string) => relative(REPO, f);
  const L: string[] = [];
  const pr = processOf(p);
  const list = stagesOf(p);
  const n = list.indexOf(p.stage) + 1;
  const video = pr.name === "video";
  L.push(`# ${p.slug} — ${p.title}`);
  const label = video || pr.name === "ops" ? `kind ${p.kind}` : `process ${pr.name}`;
  L.push(`${label}${video ? ` · lang ${p.lang}` : ""}${p.parent ? ` · from ${p.parent}` : ""} · stage ${n}/${list.length} ${p.stage}${p.finished ? " (finished)" : ""} · folder ${rel(dir)}`);
  const ex = exitCondition(p);
  if (ex) L.push(`exit when: ${ex}`);
  const chk = checkOf(p);
  if (chk) L.push(`check: command "${chk}"${p.commands[chk] ? "" : ` (not set: govern cmd ${p.slug} ${chk} -- …)`}`);
  const led = readJsonl(ledgerFile(p.slug));
  const pending = pendingCheckChanges(p, led), unaccepted = "changed and the owner has not accepted it";
  for (const { stage, sets, cmds } of pending) {
    const [firstSet] = sets;
    if (firstSet) L.push(`⚠ the check of stage ${stage} ${unaccepted}: ${[firstSet.from ?? "none", ...sets.map((x) => x.to ?? "none")].join(" → ")}`);
    for (const { name, changes } of cmds) {
      const [first] = changes; // pendingCheckChanges keeps only commands with changes: always there
      if (first) L.push(`⚠ command "${name}" behind the check of stage ${stage} ${unaccepted}: ${[shownCommand(first.from), ...changes.map((x) => (x.kind === "cmd-rm" ? "(removed)" : shownCommand(x.to)))].join(" → ")}`);
    }
  }
  if (pending.length) L.push(`only the owner accepts a change: govern check ${p.slug} <stage> --accept --quote "<the owner's words>"`);
  if (pr.gates.length) L.push(`approvals: ${pr.gates.map((g) => { const a = p.approvals[g.name]; return a ? `${g.name} ✓ ${a.at.slice(0, 10)}` : `${g.name} –`; }).join(" · ")}`);
  if (p.after?.length) L.push(`after: ${p.after.map(afterMet).map((x) => `${x.label} (${x.met ? "done" : "waiting"})`).join(" · ")}`);
  const files = Object.keys(p.files).map((k) => { const f = resolveFile(p, k); return `${k}=${f ? rel(f) : "(none)"}`; });
  if (files.length) L.push(`files: ${files.join(" · ")}`);
  const cmds = Object.keys(p.commands);
  L.push(`commands: ${cmds.length ? cmds.join(", ") : "(none — add with govern cmd)"}`);
  const jobs = led.filter((e) => e.kind === "job").slice(-3);
  if (jobs.length) L.push(`last jobs: ${jobs.map((j) => `${j.id} ${j.status ?? "started"}${j.exit != null ? ` exit ${j.exit}` : ""}`).join(" · ")}`);
  const notes = p.notes.slice(-(o.notes ?? 8));
  if (notes.length) {
    L.push(`decisions (last ${notes.length} of ${p.notes.length}):`);
    for (const x of notes) L.push(`- ${x.at.slice(0, 16).replace("T", " ")} [${x.stage}] ${clip(x.text, 240)}`);
  }
  return L.join("\n");
}
