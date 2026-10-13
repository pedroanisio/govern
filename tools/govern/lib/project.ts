// A lane: its folder, its govern.json (state, commands, process) and its brief. A lane follows a process (lib/process.ts).
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, readJson, writeJson, nowIso, latest, plain, clip, readJsonl } from "./util.ts";
import { getProcess, processOf } from "./process.ts";

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
  /** name → argv; `{repo}`, `{dir}`, `{python}` are expanded. Extra args from `govern run` are appended. */
  commands: Record<string, string[]>;
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

export function checkSlug(slug: string | undefined): string {
  if (!slug) fail(`missing <slug> (a folder under ${relative(REPO, PROJECTS) || PROJECTS}, e.g. a-millionth-apart or ops/engine)`);
  if (slug!.split("/").some((p) => p === ".." || p === "") || slug!.startsWith("/")) fail(`bad slug: ${slug}`);
  return slug!;
}

export function load(slug: string): Project {
  const f = stateFile(checkSlug(slug));
  if (!existsSync(f)) fail(`${slug}: no govern.json — start it with: govern new ${slug} --process NAME (or --kind long|short|ops) --title "…"`);
  return readJson<Project>(f);
}
export const save = (p: Project) => writeJson(stateFile(p.slug), p);

export function create(slug: string, o: { kind?: string; process?: string; title?: string; lang?: string; parent?: string }): Project {
  checkSlug(slug);
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
  mkdirSync(dir, { recursive: true });
  const commands: Record<string, string[]> = {};
  const files: Record<string, string> = {};
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
    stage: getProcess(proc).stages[0].name, created: nowIso(), commands, files, approvals: {}, notes: [],
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
  return cells.length >= 4 ? plain(cells[3]) : undefined;
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
  if (pr.gates.length) L.push(`approvals: ${pr.gates.map((g) => (p.approvals[g.name] ? `${g.name} ✓ ${p.approvals[g.name].at.slice(0, 10)}` : `${g.name} –`)).join(" · ")}`);
  if (p.after?.length) L.push(`after: ${p.after.map(afterMet).map((x) => `${x.label} (${x.met ? "done" : "waiting"})`).join(" · ")}`);
  const files = Object.keys(p.files).map((k) => { const f = resolveFile(p, k); return `${k}=${f ? rel(f) : "(none)"}`; });
  if (files.length) L.push(`files: ${files.join(" · ")}`);
  const cmds = Object.keys(p.commands);
  L.push(`commands: ${cmds.length ? cmds.join(", ") : "(none — add with govern cmd)"}`);
  const jobs = readJsonl(ledgerFile(p.slug)).filter((e) => e.kind === "job").slice(-3);
  if (jobs.length) L.push(`last jobs: ${jobs.map((j) => `${j.id} ${j.status ?? "started"}${j.exit != null ? ` exit ${j.exit}` : ""}`).join(" · ")}`);
  const notes = p.notes.slice(-(o.notes ?? 8));
  if (notes.length) {
    L.push(`decisions (last ${notes.length} of ${p.notes.length}):`);
    for (const x of notes) L.push(`- ${x.at.slice(0, 16).replace("T", " ")} [${x.stage}] ${clip(x.text, 240)}`);
  }
  return L.join("\n");
}
