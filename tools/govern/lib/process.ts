// A process: the stages a lane goes through, what "done" means for each, which command checks it, and which owner
// gates hold it. Built-ins live in tools/govern/processes/*.json; a workspace adds or overrides its own in its
// processes folder (GOVERN_PROCESSES, else govern.config.json "processes", else PALS-Notes/processes beside projects).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./util.ts";
import { PROJECTS, CONFIG, type Project } from "./project.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN = resolve(HERE, "..", "processes");

/** `requires: "check"`: only a passing check moves a lane past the stage, never a note, never a skip. */
export interface StageDef { name: string; exit?: string; check?: string; requires?: "check" }
export interface GateDef { name: string; stage?: string; needs?: string[]; message?: string }
export interface Process {
  version: 1;
  name: string;
  description: string;
  /** For a process that keeps the lane's --kind (video: long or short). */
  kinds?: string[];
  /** "workflow": the exit conditions come from WORKFLOW.md's stage table. */
  exitFrom?: "workflow";
  stages: StageDef[];
  gates: GateDef[];
}

export const extraDir = () => process.env.GOVERN_PROCESSES ?? CONFIG.processes ?? join(PROJECTS, "..", "processes");

function readDir(dir: string): Process[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    let p: Process;
    try { p = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch (e) { return fail(`${join(dir, f)}: not JSON (${(e as Error).message})`); }
    const bad = !p || typeof p.name !== "string" || !Array.isArray(p.stages) || !p.stages.length || p.stages.some((s) => typeof s?.name !== "string")
      || (p.gates !== undefined && !Array.isArray(p.gates));
    if (bad) fail(`${join(dir, f)}: a process needs a name and a non-empty stages list of {name}`);
    const names = p.stages.map((s) => s.name);
    for (const s of p.stages) if (s.requires !== undefined && s.requires !== "check") fail(`${join(dir, f)}: stage ${s.name}: requires must be "check" (got ${JSON.stringify(s.requires)})`);
    for (const g of p.gates ?? []) if (g.stage && !names.includes(g.stage)) fail(`${join(dir, f)}: gate ${g.name} names unknown stage ${g.stage}`);
    return { ...p, description: p.description ?? "", gates: p.gates ?? [] };
  });
}

/** Every process by name; a workspace process overrides a built-in of the same name. */
export function processes(): Map<string, Process> {
  const m = new Map<string, Process>();
  for (const p of [...readDir(BUILTIN), ...readDir(extraDir())]) m.set(p.name, p);
  return m;
}

export function getProcess(name: string): Process {
  const all = processes();
  return all.get(name) ?? fail(`no process "${name}" (have: ${[...all.keys()].join(", ")})`);
}

export const processName = (p: Pick<Project, "process" | "kind">) => p.process ?? (p.kind === "ops" ? "ops" : "video");
export const processOf = (p: Pick<Project, "process" | "kind">) => getProcess(processName(p));

export function listLine(p: Process): string {
  return `${p.name.padEnd(8)} ${p.description} · ${p.stages.map((s) => s.name).join(" → ")}`;
}

export function show(p: Process): string {
  const L = [`${p.name}: ${p.description}`];
  p.stages.forEach((s, i) => {
    const bits = [s.exit ? `exit: ${s.exit}` : p.exitFrom === "workflow" ? "exit: from WORKFLOW.md" : "", s.check ? `check: command "${s.check}"` : "",
      s.requires ? "requires a check" : ""].filter(Boolean);
    L.push(`  ${i + 1} ${s.name.padEnd(14)} ${bits.join("  ")}`.trimEnd());
  });
  L.push(p.gates.length ? `gates: ${p.gates.map((g) => `${g.name}${g.stage ? ` (holds ${g.stage})` : ""}${g.needs?.length ? ` after ${g.needs.join(", ")}` : ""}`).join(" · ")}` : "gates: none");
  return L.join("\n");
}
