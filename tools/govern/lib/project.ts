// A video project: its folder, its govern.json (state + commands) and its brief.
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, readJson, writeJson, nowIso, latest, plain, clip, readJsonl } from "./util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The nearest folder at or above `dir` that holds PALS-Notes/projects, or undefined. */
function workspaceAbove(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, "PALS-Notes", "projects"))) return d;
    if (dirname(d) === d) return undefined;
  }
}
/** The workspace (render-frontend-js). super-tools sits beside it (~/src/super-tools since 2026-10-13), so: GOVERN_REPO,
 *  else the workspace above the cwd, else the sibling render-frontend-js (the dispatcher service), else the old parent. */
export const REPO = process.env.GOVERN_REPO
  ?? workspaceAbove(process.cwd())
  ?? [resolve(HERE, "..", "..", "..", "..", "render-frontend-js"), resolve(HERE, "..", "..", "..", "..")].find((d) => existsSync(join(d, "PALS-Notes", "projects")))
  ?? resolve(HERE, "..", "..", "..", "..", "render-frontend-js");
export const PROJECTS = process.env.GOVERN_PROJECTS ?? join(REPO, "PALS-Notes", "projects");
export const WORKFLOW = process.env.GOVERN_WORKFLOW ?? join(REPO, "var", "media-business", "channels", "palsnotes", "workflow", "WORKFLOW.md");
export const FILM_BUILD = join(REPO, "PALS-Notes", "videos", "lib", "tools", "film_build.py");

/** The eight stages of WORKFLOW.md, in order. */
export const STAGES = ["plan", "script", "script-check", "sound", "preview", "produce", "final", "deliver"] as const;
export type Stage = (typeof STAGES)[number];
/** Work that is not a video (engine, lab, docs, channel set-up): a short life cycle and no owner gates. */
export const OPS_STAGES = ["plan", "doing", "review", "done"] as const;
export const KINDS = ["long", "short", "ops"] as const;
export const stagesOf = (kind: string): readonly string[] => (kind === "ops" ? OPS_STAGES : STAGES);
export const GATES = ["script", "final", "publish"] as const;

export interface Approval { at: string; quote: string }
export interface Note { at: string; stage: string; text: string }
export interface Project {
  version: 1;
  slug: string;
  title: string;
  kind: "long" | "short" | "ops";
  lang: string;
  parent?: string;
  stage: string;
  created: string;
  /** name → argv; `{repo}`, `{dir}`, `{python}` are expanded. Extra args from `govern run` are appended. */
  commands: Record<string, string[]>;
  /** name → path or glob relative to the project folder; a glob resolves to its newest match. */
  files: Record<string, string>;
  approvals: Partial<Record<(typeof GATES)[number], Approval>>;
  notes: Note[];
}

export const projectDir = (slug: string) => join(PROJECTS, slug);
export const stateFile = (slug: string) => join(projectDir(slug), "govern.json");
export const governDir = (slug: string) => join(projectDir(slug), "govern");
export const ledgerFile = (slug: string) => join(governDir(slug), "ledger.jsonl");

export function checkSlug(slug: string | undefined): string {
  if (!slug) fail("missing <slug> (a folder under PALS-Notes/projects, e.g. a-millionth-apart or a-millionth-apart/shorts)");
  if (slug!.split("/").some((p) => p === ".." || p === "") || slug!.startsWith("/")) fail(`bad slug: ${slug}`);
  return slug!;
}

export function load(slug: string): Project {
  const f = stateFile(checkSlug(slug));
  if (!existsSync(f)) fail(`${slug}: no govern.json — start it with: govern new ${slug} --kind long|short|ops --title "…"`);
  return readJson<Project>(f);
}
export const save = (p: Project) => writeJson(stateFile(p.slug), p);

export function create(slug: string, o: { kind: string; title?: string; lang?: string; parent?: string }): Project {
  checkSlug(slug);
  if (existsSync(stateFile(slug))) fail(`${slug}: govern.json already exists`);
  if (!(KINDS as readonly string[]).includes(o.kind)) fail("--kind must be long, short or ops");
  const dir = projectDir(slug);
  mkdirSync(dir, { recursive: true });
  const commands: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  if (o.kind !== "ops" && existsSync(join(dir, "film.json"))) {
    commands.fb = ["{python}", "{repo}/PALS-Notes/videos/lib/tools/film_build.py", "film.json"];
    files.timings = "timings.json";
  }
  if (o.kind !== "ops") {
    files.approval = "APPROVAL.md";
    files.sheet = "**/*sheet*.png";
  }
  const p: Project = {
    version: 1, slug, title: o.title ?? slug, kind: o.kind as Project["kind"], lang: o.lang ?? "en", ...(o.parent ? { parent: o.parent } : {}),
    stage: "plan", created: nowIso(), commands, files, approvals: {}, notes: [],
  };
  save(p);
  return p;
}

export function stageOf(s: string | undefined, kind = "long"): string {
  const list = stagesOf(kind);
  if (!s || !list.includes(s)) fail(`stage must be one of: ${list.join(", ")}`);
  return s!;
}

export function appendLedger(slug: string, entry: Record<string, unknown>): void {
  mkdirSync(governDir(slug), { recursive: true });
  appendFileSync(ledgerFile(slug), JSON.stringify({ t: nowIso(), slug, ...entry }) + "\n");
}

/** The "Exit when" cell of a stage's row in WORKFLOW.md (the digest the AI works against). */
export function exitCondition(stage: string): string | undefined {
  if (!existsSync(WORKFLOW) || !(STAGES as readonly string[]).includes(stage)) return undefined;
  const n = STAGES.indexOf(stage as Stage) + 1;
  const row = readFileSync(WORKFLOW, "utf8").split("\n").find((l) => l.startsWith(`| ${n} |`));
  if (!row) return undefined;
  const cells = row.split(/(?<!\\)\|/).map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
  return cells.length >= 4 ? plain(cells[3]) : undefined;
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
  const list = stagesOf(p.kind);
  const n = list.indexOf(p.stage) + 1;
  L.push(`# ${p.slug} — ${p.title}`);
  L.push(`kind ${p.kind}${p.kind === "ops" ? "" : ` · lang ${p.lang}`}${p.parent ? ` · from ${p.parent}` : ""} · stage ${n}/${list.length} ${p.stage} · folder ${rel(dir)}`);
  const ex = exitCondition(p.stage);
  if (ex) L.push(`exit when: ${ex}`);
  if (p.kind !== "ops") L.push(`approvals: ${GATES.map((g) => (p.approvals[g] ? `${g} ✓ ${p.approvals[g]!.at.slice(0, 10)}` : `${g} –`)).join(" · ")}`);
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
