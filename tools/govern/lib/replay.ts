// A replay run (BUSINESS.md "Replaying past cases"): past finished cases of a process are run again, as replay lanes
// named `replay/<run>/<case>`, on a candidate definition. Agents work as they would; a command (a service stage) is never
// run: its outputs are the original case's, recorded here when the run started, so a replay has no effect outside its
// lane. This module holds the run's state; ext/business/replay.ts starts runs and reports them, and ext/business/drive.ts
// moves replay lanes on.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./workspace.ts";
import { fail } from "./util.ts";
import type { Snapshot } from "./lifecycle-schema.ts";
import type { Value } from "./business-schema.ts";

/** One past case replayed. `data`: the original's final case data, where a replayed command's outputs come from.
 *  `completed`: the stages the original advanced from (a command it never completed has no outputs to reuse).
 *  `escalated`: a person decided or worked on the original (an approval, a rejection, a human task). `refused`: why the
 *  replay lane could not be made. */
export interface ReplayCase {
  slug: string; of: string; data: Record<string, Value>; completed: string[]; escalated: boolean; refused?: string;
}

/** A replay run of process `process`: its candidate definition and the cases it replays. `key`: the idempotency key of
 *  the service stage that started it, which starts no second run when it runs again. */
export interface Replay {
  id: string; process: string; revision: number; candidate: Snapshot; file?: string; key?: string;
  started: string; by: string; cases: ReplayCase[];
}

/** The replay runs' folder in the workspace runtime state: one `<run>.json` each. */
export const replayDir = () => join(stateDir(), "replay");
const fileOf = (id: string) => join(replayDir(), `${id}.json`);

/** Replay run `id`; a usage-level failure when there is none. */
export function readReplay(id: string): Replay {
  const f = fileOf(id);
  if (!/^[A-Za-z0-9._-]+$/.test(id) || !existsSync(f)) return fail(`no replay run ${id} (govern replay start)`);
  let r: Replay;
  try { r = JSON.parse(readFileSync(f, "utf8")) as Replay; } catch (e) { return fail(`${f}: not JSON (${(e as Error).message})`); }
  if (!r || r.id !== id || !Array.isArray(r.cases)) fail(`${f}: not replay run ${id}`);
  return r;
}

/** Write `r` whole (a temporary file renamed over the old one). */
export function writeReplay(r: Replay): void {
  mkdirSync(replayDir(), { recursive: true, mode: 0o700 });
  const f = fileOf(r.id), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, f);
}

/** The record of replay lane `slug` in run `run`, or undefined when the run or the case is gone. */
export function replayCase(run: string, slug: string): ReplayCase | undefined {
  try { return readReplay(run).cases.find((c) => c.slug === slug); } catch { return undefined; }
}

/** The replay run a service stage with idempotency key `key` already started, if any. */
export function replayByKey(key: string): Replay | undefined {
  if (!existsSync(replayDir())) return undefined;
  for (const f of readdirSync(replayDir())) {
    if (!f.endsWith(".json")) continue;
    try { const r = readReplay(f.slice(0, -5)); if (r.key === key) return r; } catch { /* an unreadable run is not this one */ }
  }
  return undefined;
}
