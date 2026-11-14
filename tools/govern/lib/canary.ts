// A canary of a process revision (BUSINESS.md "Canary revisions"): while one runs, each new case of the process falls,
// by a hash of the canary and the lane's name, in the candidate arm (the new revision) or the base arm (the revision
// that was current when it started), and keeps that arm's definition for its whole life. This module holds the canary's
// state and that assignment, which lib/project.ts create() asks for; starting, judging, promoting and reverting are
// ext/business/canary.ts's.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./workspace.ts";
import { fail, nowIso } from "./util.ts";
import type { Snapshot } from "./lifecycle-schema.ts";

export type Arm = "candidate" | "base";

/** One canary of process `process`. `fraction`: the share of new cases the candidate gets. It is judged once `min`
 *  candidate cases finished; `tolerance` is how far its correct and exception rates may fall behind the base arm's.
 *  `kind`: "heuristic" when the candidate changes only what an agent is told and how a stage retries, "policy" otherwise
 *  (a person started it, with their quoted words in `source`). */
export interface Canary {
  id: string; process: string; base: Snapshot; candidate: Snapshot;
  fraction: number; min: number; tolerance: number;
  kind: "heuristic" | "policy"; changes: string[];
  started: string; by: string; source?: unknown;
  status: "running" | "promoted" | "reverted"; ended?: string; reason?: string;
}

/** The canaries' folder in the workspace runtime state: one `<process>.json` each, the log, the files a promotion replaced. */
export const canaryDir = () => join(stateDir(), "canary");
const fileOf = (name: string) => join(canaryDir(), `${name}.json`);

/** Process `name`'s last canary (running or ended), or undefined when it never had one. */
export function readCanary(name: string): Canary | undefined {
  const f = fileOf(name);
  if (!existsSync(f)) return undefined;
  let c: Canary;
  try { c = JSON.parse(readFileSync(f, "utf8")) as Canary; } catch (e) { return fail(`${f}: not JSON (${(e as Error).message})`); }
  if (!c || typeof c.id !== "string" || c.process !== name || !["running", "promoted", "reverted"].includes(c.status)) fail(`${f}: not a canary of ${name}`);
  return c;
}

/** Write `c` whole (a temporary file renamed over the old one). */
export function writeCanary(c: Canary): void {
  mkdirSync(canaryDir(), { recursive: true, mode: 0o700 });
  const f = fileOf(c.process), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, f);
}

/** Append `row` to the canaries' log, `canary.jsonl`. */
export function canaryLog(row: Record<string, unknown>): void {
  mkdirSync(canaryDir(), { recursive: true, mode: 0o700 });
  appendFileSync(join(canaryDir(), "canary.jsonl"), JSON.stringify({ at: nowIso(), ...row }) + "\n", { mode: 0o600 });
}

/** The arm lane `slug` falls in: the first 32 bits of sha256(canary id, slug) as a fraction of 2^32, below `fraction`
 *  for the candidate. The same lane name always falls in the same arm of one canary. */
export function armOf(c: Pick<Canary, "id" | "fraction">, slug: string): Arm {
  const h = createHash("sha256").update(`${c.id}:${slug}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < c.fraction ? "candidate" : "base";
}

/** For a new case `slug` of process `name`: the running canary, the arm the case falls in and the definition it runs;
 *  undefined when no canary of `name` runs. */
export function assignment(name: string, slug: string): { canary: Canary; arm: Arm; snapshot: Snapshot } | undefined {
  const c = readCanary(name);
  if (!c || c.status !== "running") return undefined;
  const arm = armOf(c, slug);
  return { canary: c, arm, snapshot: arm === "candidate" ? c.candidate : c.base };
}
