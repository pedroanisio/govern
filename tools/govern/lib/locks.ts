// Slots on a shared resource: crash-safe, with no daemon. A slot is a file in <dir>/held, a place in line a file in
// <dir>/queue (numbered in the order they came), and both name the process they belong to by pid and start time, so a
// holder that died without releasing (SIGKILL, power cut) is noticed and its slot reclaimed by the next caller.
// Node has no flock: one directory, made with mkdir (atomic), guards each change instead, and a guard left by a dead
// caller is broken once it is older than a few seconds (a change takes milliseconds).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { procOf, exited, sleepSync, nowIso } from "./util.ts";

/** Who asks for or holds a slot: `id` is unique across lanes, `label` is what people read, pid and start name the process. */
export interface Who { id: string; label: string; pid: number; start?: string }
export interface Entry extends Who { at: string }

const STALE_MUTEX_MS = 10_000;
const MUTEX_WAIT_MS = 30_000;
const file = (id: string) => `${Buffer.from(id).toString("base64url")}.json`;

/** The identity of the process `pid` now ({start}), or undefined when it does not run. */
export function identity(pid: number): { start: string } | undefined {
  const s = procOf(pid);
  return s && !exited(s) ? { start: s.start } : undefined;
}
/** Whether the process the entry names still runs (and is that process, when it recorded a start time). */
function live(e: Entry): boolean {
  const s = procOf(e.pid);
  return !!s && !exited(s) && (e.start === undefined || s.start === e.start);
}

function withMutex<T>(dir: string, f: () => T): T {
  mkdirSync(dir, { recursive: true });
  const m = join(dir, "mutex");
  for (const end = Date.now() + MUTEX_WAIT_MS; ; sleepSync(10)) {
    try { mkdirSync(m); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(m).mtimeMs > STALE_MUTEX_MS) {
        // renamed away, not removed in place: of two callers breaking the same dead guard, one rename wins
        const gone = `${m}.stale-${process.pid}-${Date.now()}`;
        renameSync(m, gone);
        rmSync(gone, { recursive: true, force: true });
      }
    } catch { /* another caller broke it first */ }
    if (Date.now() > end) throw new Error(`lock ${dir}: the guard did not free up in ${MUTEX_WAIT_MS / 1000}s`);
  }
  try { return f(); } finally { rmSync(m, { recursive: true, force: true }); }
}

const sub = (dir: string, name: string) => join(dir, name);
function read(dir: string, name: string): { path: string; e: Entry }[] {
  const d = sub(dir, name);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    try { return [{ path: join(d, f), e: JSON.parse(readFileSync(join(d, f), "utf8")) as Entry }]; } catch { return []; }
  });
}
const drop = (path: string) => { try { unlinkSync(path); } catch { /* already gone */ } };
const put = (path: string, e: Entry) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(`${path}.tmp-${process.pid}`, JSON.stringify(e) + "\n"); renameSync(`${path}.tmp-${process.pid}`, path); };

/** The holders and the line, with every entry of a dead process (and a ticket of one that already holds) removed. Under the guard. */
function sweep(dir: string): { held: { path: string; e: Entry }[]; line: { path: string; e: Entry }[] } {
  const held = read(dir, "held").filter((x) => (live(x.e) ? true : (drop(x.path), false)));
  const ids = new Set(held.map((x) => x.e.id));
  const line = read(dir, "queue").filter((x) => (live(x.e) && !ids.has(x.e.id) ? true : (drop(x.path), false)));
  return { held, line };
}

/** Take a place in line (a no-op for one already in line or holding). */
export function enqueue(dir: string, who: Who): void {
  withMutex(dir, () => {
    const { held, line } = sweep(dir);
    if ([...held, ...line].some((x) => x.e.id === who.id)) return;
    const seqFile = join(dir, "seq");
    const n = (existsSync(seqFile) ? Number(readFileSync(seqFile, "utf8")) || 0 : 0) + 1;
    writeFileSync(seqFile, String(n));
    put(join(sub(dir, "queue"), `${String(n).padStart(12, "0")}-${file(who.id)}`), { ...who, at: nowIso() });
  });
}

/** Take a slot if the caller is in line within the free ones (`max` slots in all): true once it holds one (asking again
 *  while holding is true), false while others are ahead. A caller that is not in line never gets a slot. */
export function tryAcquire(dir: string, id: string, max: number): boolean {
  return withMutex(dir, () => {
    const { held, line } = sweep(dir);
    if (held.some((x) => x.e.id === id)) return true;
    const i = line.findIndex((x) => x.e.id === id);
    const mine = line[i];
    if (!mine || held.length + i >= max) return false;
    put(join(sub(dir, "held"), file(id)), { ...mine.e, at: nowIso() });
    drop(mine.path);
    return true;
  });
}

/** Give back the slot, or the place in line, of `id`. */
export function release(dir: string, id: string): void {
  withMutex(dir, () => { for (const x of [...read(dir, "held"), ...read(dir, "queue")]) if (x.e.id === id) drop(x.path); });
}

/** Hand the entry of `id` (held or in line) to another process: the one that will run the job. */
export function adopt(dir: string, id: string, to: { pid: number; start?: string }): void {
  withMutex(dir, () => {
    for (const x of [...read(dir, "held"), ...read(dir, "queue")]) if (x.e.id === id) {
      const { start: _, ...rest } = x.e;
      put(x.path, { ...rest, pid: to.pid, ...(to.start ? { start: to.start } : {}) });
    }
  });
}

/** Who holds the resource and who waits, in order; entries of dead processes left out (not removed: see tryAcquire). */
export function inspect(dir: string): { holders: Entry[]; queue: Entry[] } {
  const ids = new Set<string>();
  const holders = read(dir, "held").filter((x) => live(x.e)).map((x) => (ids.add(x.e.id), x.e));
  return { holders, queue: read(dir, "queue").filter((x) => live(x.e) && !ids.has(x.e.id)).map((x) => x.e) };
}

/** How many are ahead of `id`: every holder, and every live entry in line before it. Undefined when it is not in line. */
export function ahead(dir: string, id: string): number | undefined {
  const { holders, queue } = inspect(dir);
  const i = queue.findIndex((x) => x.id === id);
  return i < 0 ? undefined : holders.length + i;
}
/** Whether `id` holds a slot or is in line. */
export const known = (dir: string, id: string): boolean => { const { holders, queue } = inspect(dir); return [...holders, ...queue].some((x) => x.id === id); };
