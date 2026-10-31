// A lane: its folder, its govern.json (state, commands, process) and its brief. A lane follows a process (lib/process.ts).
import { existsSync, readFileSync, appendFileSync, mkdirSync, globSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { WORKFLOW, HUMAN_TASKS, VOTES, value, type Value, type Workflow, type HumanTask, type Vote } from './business-schema.ts';
import { initializeBusiness, validateCase, gateApproved, setData } from './business.ts';
import { GovernError, fail, usage, readJson, writeJson, nowIso, latest, plain, clip, readJsonl } from "./util.ts";
import type { Source } from "./approval.ts";
import { repo, projectsDir, workflowFile, config, configFile } from "./workspace.ts";
import { getProcess, processOf, processes, processName, manualOf, freezeProcess, snapshotProcess } from "./process.ts";
import { RUNTIME, EVENTS, ALERTS, SNAPSHOT, INVOCATION, type StageRuntime, type EventReceipt, type Alert, type Snapshot, type Invocation } from './lifecycle-schema.ts';
import { validateRuntime } from './lifecycle-runtime.ts';
import { obj, arr, record, emptyRecord, str, name, posInt, literal, parseFile, reject, keyPath, type Shape } from "./shape.ts";

/** Lane kinds that need no --process: a video (long, short) or ops work (engine, lab, docs, channel set-up). */
export const KINDS = ["long", "short", "ops"] as const;

/** A command with settings: its argv, how long it may run in the foreground (seconds), and the resource it runs on (so
 *  `govern run` needs no --on). A plain argv array is the same command with the default timeout and no resource. */
export interface Command { argv: string[]; timeout?: number; resource?: string }
/** A command's argv: the array itself, or the `argv` of a command with settings. */
export const argvOf = (c: string[] | Command): string[] => (Array.isArray(c) ? c : c.argv);
/** A command as one line: its argv, and its own timeout and resource when it has them. */
export const commandLine = (c: string[] | Command): string => {
  const own = Array.isArray(c) ? [] : [c.timeout ? `timeout ${c.timeout}s` : "", c.resource ? `on ${c.resource}` : ""].filter(Boolean);
  return `${argvOf(c).join(" ")}${own.length ? ` (${own.join(", ")})` : ""}`;
};

/** `by`: whose words (the gate's decision owner); `source`: where they were found (lib/approval.ts). Both absent on approvals recorded before they existed. */
export interface Approval { at: string; quote: string; by?: string; source?: Source }
export interface Note { at: string; stage: string; text: string }
/** A lane's freeze: when, who (always "owner": freezing is the owner's decision), their words and where they came from
 *  (lib/approval.ts), and, once named, a free-text pointer to where the work continued. */
export interface Frozen { at: string; by: string; quote: string; source: Source; continuedAs?: string }
/** Another lane this one waits on: met when that lane is finished, or (with `stage`) has moved past that stage. */
export interface After { lane: string; stage?: string }
/** Where an imported lane came from: the source's identity and the bundle that carried it (lib/importlane.ts; PLAN,
 *  Import). New state on every imported lane; absent on a lane never imported. */
export interface ImportedFrom { slug: string; workspace: string; exportedAt: string; ledgerOffset: number; bundleSha256: string; mode: "full" | "template" }
/** One of the source lane's approvals, carried as history only: a clone must never be a way around a gate. */
export interface ImportedApproval extends Approval { gate: string }
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
  /** name → argv, or {argv, timeout}; `{repo}`, `{dir}`, `{python}` and `{paths.NAME}` (a key of the config's "paths") are expanded. Extra args from `govern run` are appended. */
  commands: Record<string, string[] | Command>;
  /** name → path or glob relative to the project folder; a glob resolves to its newest match. */
  files: Record<string, string>;
  /** stage → command name: the lane's own exit check, over the process's. */
  checks?: Record<string, string>;
  after?: After[];
  processSnapshot?:Snapshot;
  runtime?:Record<string,StageRuntime>;
  events?:EventReceipt[];
  alerts?:Alert[];
  invocation?:Invocation;
  data?: Record<string, Value>;
  workflow?: Workflow;
  humanTasks?: Record<string, HumanTask>;
  votes?: Record<string, Vote[]>;
  approvals: Record<string, Approval>;
  notes: Note[];
  frozen?: Frozen;
  importedFrom?: ImportedFrom;
  importedApprovals?: ImportedApproval[];
}

/** Lane `slug`'s folder under the lanes folder. */
export const projectDir = (slug: string) => join(projectsDir(), slug);
/** Lane `slug`'s govern.json path. */
export const stateFile = (slug: string) => join(projectDir(slug), "govern.json");
/** Lane `slug`'s `govern/` subfolder, where its ledger and job records live. */
export const governDir = (slug: string) => join(projectDir(slug), "govern");
/** Lane `slug`'s append-only ledger: `govern/ledger.jsonl` in its folder. */
export const ledgerFile = (slug: string) => join(governDir(slug), "ledger.jsonl");

/** A slug as its lane's folder names it: `.` segments dropped (`./l1`, `l1/.` and `a/./b` are the folders l1, l1 and a/b).
 *  Null for a slug that is no folder under the lanes folder: a leading "/", a ".." or empty segment, or nothing left (`.`). */
const laneSlug = (slug: string): string | null => {
  if (slug.startsWith("/")) return null;
  const parts = slug.split("/").filter((p) => p !== ".");
  return parts.length && !parts.some((p) => p === ".." || p === "") ? parts.join("/") : null;
};
/** The lane's slug as its folder names it (see laneSlug); a missing or bad slug is a usage error (exit 2). */
export function checkSlug(slug: string | undefined): string {
  if (!slug) usage(`missing <slug> (a folder under ${relative(repo(), projectsDir()) || projectsDir()}, e.g. a-millionth-apart or ops/engine)`);
  return laneSlug(slug!) ?? usage(`bad slug: ${slug}`);
}

/** A timestamp as nowIso() writes it (an offset is accepted too). */
const iso: Shape<string> = (v, at) =>
  (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))
    ? v : reject(at, `must be an ISO timestamp (got ${JSON.stringify(v)})`));
const ARGV = arr(str, { nonEmpty: true });
const COMMAND_OBJ = obj({ argv: ARGV }, { timeout: posInt, resource: name });
/** A command: a plain argv array, or {argv, timeout?}. */
const COMMAND: Shape<string[] | Command> = (v, at) =>
  (Array.isArray(v) ? ARGV(v, at) : typeof v === "object" && v !== null ? COMMAND_OBJ(v, at)
    : reject(at, `must be an argv array or {argv, timeout?} (got ${JSON.stringify(v)})`));
const SOURCE: Shape<Source> = (v, at) => {
  const k = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  return k === "terminal" ? obj({ kind: literal("terminal"), user: str })(v, at) : k === "session" ? obj({ kind: literal("session"), sessionId: str, message: str, messageAt: str })(v, at)
    : k === "device" ? obj({ kind: literal("device"), device: str, signedBody: str, signature: str })(v, at)
    : k === "slack" ? obj({ kind: literal("slack"), team: str, user: str, timestamp: str, signedBody: str, signature: str })(v, at)
    : reject(at, `must be {kind: "terminal", user}, {kind: "session", sessionId, message, messageAt}, {kind: "device", device, signedBody, signature} or {kind: "slack", team, user, timestamp, signedBody, signature}`);
};
const FROZEN: Shape<Frozen> = obj({ at: iso, by: name, quote: str, source: SOURCE }, { continuedAs: str });
/** A whole number, 0 or more: ledgerOffset carries no sign and may be 0 (nothing exported yet). */
const nat: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a whole number, 0 or more"));
const IMPORTED_FROM: Shape<ImportedFrom> = obj({ slug: name, workspace: str, exportedAt: iso, ledgerOffset: nat, bundleSha256: str, mode: literal("full", "template") });
const IMPORTED_APPROVAL: Shape<ImportedApproval> = obj({ gate: name, at: iso, quote: str }, { by: name, source: SOURCE });
const PROJECT = obj(
  { version: literal(1), slug: name, title: str, kind: name, lang: name, stage: name, created: iso,
    commands: record(COMMAND), files: record(str), approvals: record(obj({ at: iso, quote: str }, { by: name, source: SOURCE })),
    notes: arr(obj({ at: iso, stage: name, text: str })) },
  {processSnapshot:SNAPSHOT, runtime:RUNTIME, events:EVENTS, alerts:ALERTS, invocation:INVOCATION, data: record(value), workflow: WORKFLOW, humanTasks: HUMAN_TASKS, votes: VOTES, process: name, parent: str, finished: iso, checks: record(name), after: arr(obj({ lane: name }, { stage: name })), frozen: FROZEN,
   importedFrom: IMPORTED_FROM, importedApprovals: arr(IMPORTED_APPROVAL) },
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
    const all = p.processSnapshot ? new Map([[pname,snapshotProcess(p.processSnapshot)]]) : processes();
    const pr = all.get(pname) ?? reject(p.process !== undefined ? `${at}.process` : `${at}.kind`, `no process "${pname}" (have: ${[...all.keys()].join(", ")})`);
    if (p.process === undefined && !(KINDS as readonly string[]).includes(p.kind)) reject(`${at}.kind`, `must be long, short or ops when there is no process (got ${JSON.stringify(p.kind)})`);
    if (pr.kinds && !pr.kinds.includes(p.kind)) reject(`${at}.kind`, `must be ${pr.kinds.join(" or ")} for process ${pr.name} (got ${JSON.stringify(p.kind)})`);
    const stages = pr.stages.map((s) => s.name);
    if (!stages.includes(p.stage)) reject(`${at}.stage`, `no stage "${p.stage}" in process ${pr.name}`);
    for (const s of Object.keys(p.checks ?? {})) if (!stages.includes(s)) reject(keyPath(`${at}.checks`, s), `no stage "${s}" in process ${pr.name}`);
    (p.after ?? []).forEach((x, i) => { x.lane = laneSlug(x.lane) ?? reject(`${at}.after[${i}].lane`, `bad slug: ${x.lane}`); });
    if(pr.name!==pname)reject(at+".processSnapshot","snapshot names a different process");
    if(p.invocation) {p.invocation.parent=checkSlug(p.invocation.parent); if(p.invocation.parent===p.slug)reject(at+".invocation","lane cannot call itself");}
    validateCase(p, pr, at);
    validateRuntime(p, at);
    return p;
  });
}

/** Read and parse lane `given`'s govern.json (see parseProject). A bad slug is a usage error (exit 2); a missing file or
 *  a failed parse is a GovernError (exit 4), and a missing file's message says how to start the lane. */
export function load(given: string | undefined): Project {
  const slug = checkSlug(given);
  const f = stateFile(slug);
  if (!existsSync(f)) fail(`${slug}: no govern.json — start it with: govern new ${slug} --process NAME (or --kind long|short|ops) --title "…"`);
  return parseProject(f, readFileSync(f, "utf8"), slug);
}
/** The message every freeze refusal gives, naming the freeze and how to lift it. */
export const frozenMessage = (slug: string, f: Frozen): string =>
  `${slug} is frozen since ${f.at} ("${f.quote}")${f.continuedAs ? `; continued as ${f.continuedAs}` : ""}: govern unfreeze ${slug} --quote "…" to change it`;

/** Write lane `p`'s govern.json, only after the same parse load() runs (shape and the semantic checks) passes over the
 *  exact text: govern never writes a file it would then refuse to read. A failure is that GovernError, and nothing is
 *  written. What is written is that parse's result, so the slugs in it are the folders' (no `.` segments).
 *  Refuses to write a lane whose state (the one being written) is frozen, unless `allowFrozen`: only the freeze command
 *  itself (setting or lifting the freeze) passes that, so every other command is refused in this one place. */
export function save(p: Project, o: { allowFrozen?: boolean } = {}): void {
  const slug = checkSlug(p.slug);
  const f = stateFile(slug);
  let q: Project;
  try { q = parseProject(f, JSON.stringify(p), slug); }
  catch (e) {
    if (e instanceof GovernError) fail(`${e.message} (not saved: govern writes no govern.json it would refuse to read)`, e.code);
    throw e;
  }
  if (q.frozen && !o.allowFrozen) fail(frozenMessage(slug, q.frozen));
  writeJson(f, q);
}

/** Create and save a new lane's govern.json from a process (or a frozen snapshot of one) or a legacy kind: commands and
 *  files from the process setup, the first stage, initial business state and optional case data. Fails when the lane
 *  exists or the kind does not fit the process; warns on stderr about {paths.NAME} keys the config lacks. */
export function create(given: string, o: { kind?: string; process?: string; title?: string; lang?: string; parent?: string; pin?:boolean; data?:Record<string,Value>; snapshot?:Snapshot; invocation?:Invocation }): Project {
  const slug = checkSlug(given);
  if (existsSync(stateFile(slug))) fail(`${slug}: govern.json already exists`);
  let kind: string, proc: string;
  if (o.process) {
    const pr = o.snapshot ? snapshotProcess(o.snapshot) : getProcess(o.process);
    if(pr.name!==o.process)fail("snapshot names a different process");
    proc = pr.name;
    if (pr.kinds) {
      if (!o.kind || !pr.kinds.includes(o.kind)) usage(`--kind must be ${pr.kinds.join(" or ")}`);
      kind = o.kind!;
    } else kind = pr.name;
  } else {
    if (!o.kind || !(KINDS as readonly string[]).includes(o.kind)) usage("--kind must be long, short or ops (or name a --process)");
    kind = o.kind!;
    proc = kind === "ops" ? "ops" : "video";
  }
  const definition = o.snapshot ? snapshotProcess(o.snapshot) : getProcess(proc);
  const dir = projectDir(slug);
  const commands = emptyRecord<string[]>();
  const files = emptyRecord<string>();
  for (const g of definition.setup ?? []) {
    if (g.ifFile !== undefined && !existsSync(join(dir, g.ifFile))) continue;
    for (const [k, argv] of Object.entries(g.commands ?? {})) commands[k] = [...argv];
    for (const [k, pat] of Object.entries(g.files ?? {})) files[k] = pat;
  }
  warnMissingPaths(commands);
  const p: Project = {
    version: 1, slug, title: o.title ?? slug, kind, process: proc, lang: o.lang ?? "en", ...(o.parent ? { parent: o.parent } : {}),
    stage: definition.stages[0].name, created: nowIso(), commands, files, approvals: emptyRecord<Approval>(), notes: [],
  };
  if(o.snapshot || o.pin || definition.revision!==undefined)p.processSnapshot=o.snapshot??freezeProcess(definition);
  if(o.invocation)p.invocation=o.invocation;
  initializeBusiness(p);
  if(o.data)setData(p,o.data);
  save(p);
  return p;
}

/** A new lane's commands that use a {paths.NAME} the config lacks: a warning on stderr naming each key (the lane is still made). */
function warnMissingPaths(commands: Record<string, string[]>): void {
  const known = config().paths ?? {}, missing = new Set<string>();
  for (const argv of Object.values(commands)) for (const a of argv) for (const m of a.matchAll(/\{paths\.([^{}]+)\}/g)) if (!Object.hasOwn(known, m[1]!)) missing.add(m[1]!);
  for (const n of missing) process.stderr.write(`warning: a command of this process uses {paths.${n}}, but ${configFile()} has no paths.${n} (it fails when run)\n`);
}

/** The stage names of the lane's process, in order. */
export const stagesOf = (p: Pick<Project, "process" | "kind">): string[] => processOf(p).stages.map((s) => s.name);

/** `s` when it is a stage of the lane's process; otherwise a GovernError (exit 4) listing the valid stages. */
export function stageOf(s: string | undefined, p: Pick<Project, "process" | "kind">): string {
  const list = stagesOf(p);
  if (!s || !list.includes(s)) fail(`stage must be one of: ${list.join(", ")}`);
  return s!;
}

/** The command that checks a stage's exit condition: the lane's own, else the process's; undefined when none. */
export function checkOf(p: Project, stage = p.stage): string | undefined {
  return p.checks?.[stage] ?? processOf(p).stages.find((s) => s.name === stage)?.check;
}

/** Every lane's slug under the lanes folder, sorted. */
export const laneSlugs = (): string[] => globSync("**/govern.json", { cwd: projectsDir() }).map((f) => dirname(f)).sort();

/** The rows of a command that lists every lane (status, desk): `row` formats a lane that loads; a lane whose
 *  govern.json (or a lane its row reads, through `after`) fails its parse becomes one row, `<slug> ✖ <file>: <path>:
 *  <message>`, and the other lanes still show. `failed` counts those rows; the caller exits 1 after printing them.
 *
 *  Process files are not degraded per lane: they are read once here, before any lane, and a bad one stops the whole
 *  listing (exit 4). Every lane's stages, gates and checks come from that shared config, so with a broken process
 *  file no lane's row would be trustworthy. */
export function laneRows(slugs: string[], row: (slug: string, p: Project) => string, indent = ""): { rows: string[]; failed: number } {
  if(slugs.some(s=>{try{return !JSON.parse(readFileSync(stateFile(s),"utf8")).processSnapshot;}catch{return true;}}))processes();
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
  if (o.workflow && a.stage) return { label, met: o.workflow.completed.includes(a.stage) };
  if (o.finished) return { label, met: true };
  if (!a.stage) return { label, met: false };
  const list = stagesOf(o);
  return { label, met: list.indexOf(o.stage) > list.indexOf(a.stage) };
}
/** The labels of the lanes this one still waits on. */
export const blockedBy = (p: Project): string[] => (p.after ?? []).map(afterMet).filter((x) => !x.met).map((x) => x.label);
/** How a frozen lane shows in brief, status and desk: the time, and the pointer once one is named. */
export const frozenNote = (f: Frozen): string => `frozen since ${f.at}${f.continuedAs ? ` · continued as ${f.continuedAs}` : ""}`;

/** "frozen since …", "finished", "ready" / "blocked by …" for a lane with dependencies, else "". A frozen lane shows that
 *  before anything else: it is read-only regardless of what its stage or dependencies say. */
export function laneState(p: Project): string {
  if (p.frozen) return frozenNote(p.frozen);
  if (p.finished) return "finished";
  if (!p.after?.length) return "";
  const b = blockedBy(p);
  return b.length ? `blocked by ${b.join(", ")}` : "ready";
}

/** A lane is flagged as possibly behind its work when at least this many jobs, notes and asks were recorded since its last advance... */
export const DRIFT_MIN_ENTRIES = 20;
/** ...and that advance (or, for a lane never advanced, its creation) is at least this many hours old. */
export const DRIFT_MIN_HOURS = 24;
/** What a lane's ledger recorded since its last `advance` (or since creation): distinct jobs, notes and asks, and the hours since. */
export interface Drift { jobs: number; notes: number; asks: number; hours: number; since: "advance" | "creation" }

/** The jobs (counted once by id, so a background job's start and end line are one), notes and asks recorded since the lane's last
 *  advance, and the whole hours since that advance; counted from the lane's creation when it never advanced. */
export function stageDrift(p: Project, led: Record<string, any>[], now = Date.now()): Drift {
  const last = led.findLastIndex((e) => e.kind === "advance");
  const at = last < 0 ? Date.parse(p.created) : Date.parse(String(led[last]!.t));
  const after = led.slice(last + 1);
  return {
    jobs: new Set(after.filter((e) => e.kind === "job").map((e) => String(e.id))).size,
    notes: after.filter((e) => e.kind === "note").length,
    asks: after.filter((e) => e.kind === "ask").length,
    hours: Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 3600_000)) : 0,
    since: last < 0 ? "creation" : "advance",
  };
}
/** The warning line for a lane that is not finished, has at least DRIFT_MIN_ENTRIES such entries and no advance in DRIFT_MIN_HOURS; undefined otherwise. */
export function driftWarning(p: Project, led: Record<string, any>[], now = Date.now()): string | undefined {
  if (p.finished) return undefined;
  const d = stageDrift(p, led, now);
  if (d.jobs + d.notes + d.asks < DRIFT_MIN_ENTRIES || d.hours < DRIFT_MIN_HOURS) return undefined;
  const what = [[d.jobs, "jobs"], [d.notes, "notes"], [d.asks, "asks"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(", ");
  return `⚠ stage may be behind: ${what} since ${d.since === "advance" ? "the last advance" : "the lane was created"} ${d.hours} h ago`;
}

/** Ledger kinds recorded for a frozen lane: freezing it, lifting the freeze, and exporting it (lib/project.ts plan, Freeze). */
const FROZEN_LEDGER_KINDS = new Set(["freeze", "unfreeze", "export"]);
/** The lane's stored `frozen` field, read directly off its govern.json (no full parse): what a caller with only the
 *  slug checks (appendLedger here; queue dispatch and a bound conversation's send elsewhere). Undefined when the lane
 *  has none, is unfrozen, or its file cannot be read or parsed as JSON. */
export function frozenOf(slug: string): Frozen | undefined {
  try { return (JSON.parse(readFileSync(stateFile(slug), "utf8")) as { frozen?: Frozen }).frozen; }
  catch { return undefined; }
}

/** Append `entry` to the lane's ledger as one JSON line, stamped with the time and slug; creates `govern/` when missing.
 *  Refuses any entry but freeze, unfreeze or export for a frozen lane. */
export function appendLedger(slug: string, entry: Record<string, unknown>): void {
  if (!FROZEN_LEDGER_KINDS.has(String(entry.kind))) {
    const frozen = frozenOf(slug);
    if (frozen) fail(frozenMessage(slug, frozen));
  }
  mkdirSync(governDir(slug), { recursive: true });
  appendFileSync(ledgerFile(slug), JSON.stringify({ t: nowIso(), slug, ...entry }) + "\n");
}

/** The "Exit when" cell of the stage's row (numbered by its place in the process) in the workspace's workflow document. */
function workflowExit(stages: string[], stage: string): string | undefined {
  const wf = workflowFile(), i = stages.indexOf(stage);
  if (!wf || !existsSync(wf) || i < 0) return undefined;
  const row = readFileSync(wf, "utf8").split("\n").find((l) => l.startsWith(`| ${i + 1} |`));
  if (!row) return undefined;
  const cells = row.split(/(?<!\\)\|/).map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
  const exit = cells[3];
  return exit === undefined ? undefined : plain(exit);
}
/** What "done" means for the lane's current stage: the process's text, or the workflow document's when the process says so. */
export function exitCondition(p: Project, stage = p.stage): string | undefined {
  const pr = processOf(p);
  return pr.stages.find((s) => s.name === stage)?.exit ?? (pr.exitFrom === "workflow" ? workflowExit(pr.stages.map((s) => s.name), stage) : undefined);
}

/** The path of the lane's file `name`: a glob resolves to its newest match in the lane's folder, a plain path only when it
 *  exists. Undefined when the name is not declared or nothing matches. */
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
/** The ledger index of `stage`'s last check-accept entry, or of a later lane-wide `import-accept` (govern check
 *  --accept-import clears every stage's imported check changes in one decision), or -1 when neither ever happened. */
function lastAccepted(led: Entry[], stage: string): number {
  let accepted = -1;
  led.forEach((e, i) => { if ((e.kind === "check-accept" && e.stage === stage) || e.kind === "import-accept") accepted = i; });
  return accepted;
}
/** The check changes that wait on the owner, per stage of the lane's process, in process order.
 *  Rule: a change is a swap when what it replaces existed — a check-set whose `from` (the stage's effective check before
 *  it: the lane's own, else the process's) is not null, or a cmd-set / cmd-rm of a command that existed and was then the
 *  effective check of some stage. A swap is pending for its stages until (a) the lane is finished or (b) the owner
 *  accepts it: a `check-accept` entry for a stage clears every change for that stage ledgered before it. Nothing else
 *  clears it: not a passing check (a gamed check is what produces that pass), not moving back and forth, not leaving the
 *  stage. Setup — a stage with no check getting one, a command defined for the first time — is ledgered but is no swap;
 *  after a pending swap it still shows in the chain, which runs from the first swap on.
 *  An `import` entry (lib/importlane.ts; PLAN, Import) is different: every check and command the import wrote is
 *  untrusted regardless of whether it replaced anything in this (new) lane, so once one sits in the window the usual
 *  "first swap" filter is skipped and every check-set / cmd-set since it is flagged, `from: null` included. */
export function pendingCheckChanges(p: Project, led: Entry[]): PendingChanges[] {
  if (p.finished) return [];
  const res: PendingChanges[] = [];
  for (const stage of stagesOf(p)) {
    const accepted = lastAccepted(led, stage);
    const sinceAll = led.slice(accepted + 1);
    const imported = sinceAll.some((e) => e.kind === "import");
    const since = sinceAll.filter((e) => stagesOfChange(e).includes(stage));
    const sets = imported ? since.filter((e) => e.kind === "check-set") : fromFirstSwap(since.filter((e) => e.kind === "check-set"));
    const names = [...new Set(since.filter((e) => e.kind !== "check-set").map((e) => String(e.name)))];
    const cmds = names
      .map((name) => ({ name, changes: imported ? since.filter((e) => e.kind !== "check-set" && e.name === name) : fromFirstSwap(since.filter((e) => e.kind !== "check-set" && e.name === name)) }))
      .filter((x) => x.changes.length);
    if (sets.length || cmds.length) res.push({ stage, sets, cmds });
  }
  return res;
}
/** Whether `stage`'s effective check still carries an unaccepted import: an `import` ledger entry sits since the
 *  stage's last accept, and pendingCheckChanges still has something to accept for it. An imported check must not pass
 *  a stage until the owner accepts it (PLAN, Import: "no stage can pass on one until the owner accepts it"). */
export function importUnaccepted(p: Project, led: Entry[], stage = p.stage): boolean {
  const accepted = lastAccepted(led, stage);
  if (!led.slice(accepted + 1).some((e) => e.kind === "import")) return false;
  return pendingCheckChanges(p, led).some((x) => x.stage === stage);
}

/** Whether the lane is quarantined: its ledger holds an `import` entry (not a clone's — a clone's bundle is one this
 *  workspace wrote to itself and ran here already, ledgered `via: "clone"`) with no later `import-accept` entry.
 *  `jobs.start` refuses every command of a quarantined lane: check, advance, run, slice, compensate and anything
 *  else, until the owner accepts the import (govern check <slug> --accept-import --quote "…"). */
export function importQuarantined(led: Entry[]): boolean {
  const imported = led.findLastIndex((e) => e.kind === "import" && e.via !== "clone");
  if (imported < 0) return false;
  return !led.slice(imported + 1).some((e) => e.kind === "import-accept");
}

const shownCommand = (c: unknown) => (c == null ? "none" : commandLine(c as string[] | Command));
/** While a lane sits quarantined (importQuarantined): what the owner reviews before `--accept-import` — every
 *  command it carries with its full argv, the pinned process's name and snapshot hash, and every command the
 *  process names outside a stage check (today, a stage's `onError.compensate`), each marked by where it is used. */
export function quarantineDetail(p: Project): string[] {
  const pr = processOf(p);
  const L: string[] = [`⚠ imported lane, not accepted: govern check ${p.slug} --accept-import --quote "<the owner's own words>"`];
  L.push(`process: ${pr.name}${p.processSnapshot ? ` (pinned ${p.processSnapshot.hash.slice(0, 12)})` : ""}`);
  const cmds = Object.entries(p.commands);
  L.push(`commands: ${cmds.length ? cmds.map(([n, c]) => `${n} = ${commandLine(c)}`).join(" · ") : "(none)"}`);
  for (const s of pr.stages) {
    if (s.check) L.push(`  stage ${s.name} check: "${s.check}"`);
    if (s.onError?.compensate) L.push(`  stage ${s.name} onError.compensate: "${s.onError.compensate}"`);
  }
  return L;
}

/** The compact context an AI session starts from instead of exploring the repo. */
export function brief(p: Project, o: { notes?: number } = {}): string {
  const dir = projectDir(p.slug);
  const rel = (f: string) => relative(repo(), f);
  const L: string[] = [];
  const pr = processOf(p);
  const list = stagesOf(p);
  const n = list.indexOf(p.stage) + 1;
  const kinded = pr.kinds !== undefined;
  L.push(`# ${p.slug} — ${p.title}`);
  const label = kinded || pr.name === "ops" ? `kind ${p.kind}` : `process ${pr.name}`;
  L.push(`${label}${kinded ? ` · lang ${p.lang}` : ""}${p.parent ? ` · from ${p.parent}` : ""} · stage ${n}/${list.length} ${p.stage}${p.finished ? " (finished)" : ""} · folder ${rel(dir)}`);
  if (p.frozen) L.push(`⚠ ${frozenNote(p.frozen)}`);
  const led = readJsonl(ledgerFile(p.slug));
  if (importQuarantined(led)) L.push(...quarantineDetail(p));
  const drift = driftWarning(p, led);
  if (drift) L.push(drift);
  if (manualOf(pr)) L.push(`manual: govern manual ${pr.name}`);
  if(p.workflow?.loops)L.push(`loop repeats: ${JSON.stringify(p.workflow.loops)}`);
  if (p.workflow) L.push(`active: ${p.workflow.active.join(', ') || '(none)'}${p.workflow.waiting.length ? ` · joins waiting: ${p.workflow.waiting.join(', ')}` : ''}`);
  if (p.data) L.push(`case data: ${JSON.stringify(p.data)}`);
  for (const [stage,t] of Object.entries(p.humanTasks ?? {})) L.push(`human task ${stage}: ${t.completedAt ? `completed by ${t.completedBy}` : t.assignee ? `assigned to ${t.assignee}` : 'unclaimed'}`);
  if(p.processSnapshot)L.push(`process revision: ${p.processSnapshot.revision} (pinned ${p.processSnapshot.hash.slice(0,12)})`);
  for(const stage of p.workflow?.active??(p.finished?[]:[p.stage])) {const r=p.runtime?.[stage];if(r)L.push(`runtime ${stage}: generation ${r.generation}${r.deadlines.due?` · due ${r.deadlines.due}`:''}${r.retryAt?` · retry ${r.retryAt}`:''}${r.failure?` · failure ${clip(r.failure,120)}`:''}${r.batch?` · items ${Object.keys(r.batch.children).length}/${r.batch.items.length}${r.batch.synced?" (synced)":""}`:""}${r.child?` · child ${r.child}${r.childSynced?' (synced)':''}`:''}${r.eventId?` · event ${r.eventId}`:''}`);}
  const alerts=(p.alerts??[]).filter(a=>!a.acknowledgedAt);if(alerts.length)L.push(`alerts: ${alerts.length} unacknowledged (govern alerts ${p.slug})`);
  const ex = exitCondition(p);
  if (ex) L.push(`exit when: ${ex}`);
  const chk = checkOf(p);
  if (chk) L.push(`check: command "${chk}"${p.commands[chk] ? "" : ` (not set: govern cmd ${p.slug} ${chk} -- …)`}`);
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
  if (pr.gates.length) L.push(`approvals: ${pr.gates.map((g) => { const a = p.approvals[g.name]; return gateApproved(p, g) && a ? `${g.name} ✓ ${a.at.slice(0, 10)}` : `${g.name} –`; }).join(" · ")}`);
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
