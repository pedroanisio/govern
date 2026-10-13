// A process: the stages a lane goes through, what "done" means for each, which command checks it, and which owner
// gates hold it. Built-ins live in tools/govern/processes/*.json; a workspace adds or overrides its own in its
// processes folder (GOVERN_PROCESSES, else govern.config.json "processes", else PALS-Notes/processes beside projects).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./util.ts";
import { obj, arr, str, name, literal, check, reject } from "./shape.ts";
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
  /** At least one: the process file's check refuses an empty list. */
  stages: [StageDef, ...StageDef[]];
  gates: GateDef[];
}

export const extraDir = () => process.env.GOVERN_PROCESSES ?? CONFIG.processes ?? join(PROJECTS, "..", "processes");

const STAGE = obj({ name }, { exit: str, check: name, requires: literal("check") });
const GATE = obj({ name }, { stage: name, needs: arr(name), message: str });
const PROCESS = obj({ version: literal(1), name, stages: arr(STAGE, { nonEmpty: true }) },
  { description: str, kinds: arr(name, { nonEmpty: true }), exitFrom: literal("workflow"), gates: arr(GATE) });

/** Names unique within a list: the second one is refused at its path. */
function unique(items: { name: string }[], what: string, at: string): void {
  const seen = new Set<string>();
  items.forEach((x, i) => { if (seen.has(x.name)) reject(`${at}[${i}].name`, `${what} "${x.name}" is already defined`); seen.add(x.name); });
}

/** What a process file must be beyond its types: unique stage and gate names, a gate's stage and needs exist, and no gate
 *  waits (directly or through others) on itself, which would leave it and every gate after it unapprovable. */
function resolveRefs(p: ReturnType<typeof PROCESS>): void {
  const stages = p.stages, gates = p.gates ?? [];
  unique(stages, "stage", "$.stages");
  unique(gates, "gate", "$.gates");
  const names = new Set(stages.map((s) => s.name)), byName = new Map(gates.map((g) => [g.name, g]));
  gates.forEach((g, i) => {
    if (g.stage !== undefined && !names.has(g.stage)) reject(`$.gates[${i}].stage`, `gate ${g.name} names unknown stage ${g.stage}`);
    (g.needs ?? []).forEach((n, j) => {
      if (n === g.name) reject(`$.gates[${i}].needs[${j}]`, `gate ${g.name} needs itself`);
      if (!byName.has(n)) reject(`$.gates[${i}].needs[${j}]`, `gate ${g.name} needs unknown gate ${n}`);
    });
  });
  // a cycle through needs, reported at the first gate (in file order) on it, at the need that starts the loop
  gates.forEach((g, i) => {
    const walk = (at: string, path: string[]): void => {
      for (const n of byName.get(at)?.needs ?? []) {
        if (n === g.name) reject(`$.gates[${i}].needs[${g.needs!.indexOf(path[1] ?? n)}]`, `gates ${[...path, n].join(" → ")} need each other: none can be approved`);
        if (!path.includes(n)) walk(n, [...path, n]);
      }
    };
    walk(g.name, [g.name]);
  });
}

/** Parse a process file's text: typed (unknown keys refused), version 1, names unique, references resolved. Every failure
 *  is a GovernError naming `file` and the JSON path of the wrong field. */
export function parseProcess(file: string, text: string): Process {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return fail(`${file}: not JSON (${(e as Error).message})`); }
  // a stage that requires anything but a check keeps the message it has always had: it names the stage
  const st = (raw as { stages?: unknown })?.stages;
  if (Array.isArray(st)) for (const s of st as { name?: unknown; requires?: unknown }[]) {
    if (s && typeof s === "object" && "requires" in s && s.requires !== "check") fail(`${file}: stage ${String(s.name)}: requires must be "check" (got ${JSON.stringify(s.requires)})`);
  }
  const p = check(file, raw, (v, at) => { const x = PROCESS(v, at); resolveRefs(x); return x; });
  return { ...p, description: p.description ?? "", gates: p.gates ?? [] };
}

function readDir(dir: string): Process[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => parseProcess(join(dir, f), readFileSync(join(dir, f), "utf8")));
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
