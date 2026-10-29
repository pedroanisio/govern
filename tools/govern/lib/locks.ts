// Slots on a shared resource: crash-safe, with no daemon. A slot is a file in <dir>/held, a place in line a file in
// <dir>/queue (numbered in the order they came), and both name the process they belong to by pid and start time, so a
// holder that died without releasing (SIGKILL, power cut) is noticed and its slot reclaimed by the next caller.
// Node has no flock: a file, claimed with a hard link (atomic), guards each change instead. A guard is broken when its
// owner is gone; only guards without a readable owner expire by age. The guard is a
// file holding its owner's token (pid, start time, random nonce): a breaker removes only the token it judged stale, and a
// holder releases only its own.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, renameSync, rmSync, existsSync, linkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, basename, dirname } from "node:path";
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
export function live(e: { pid: number; start?: string }): boolean {
  const s = procOf(e.pid);
  return !!s && !exited(s) && (e.start === undefined || s.start === e.start);
}

/** The text of the guard file, or undefined when there is none; "" for one that cannot be read as a file (an older
 *  govern made a directory). It is the owner token: {pid, start, nonce}. */
export function readMutex(m: string): string | undefined {
  try { return readFileSync(m, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : ""; }
}
/** Reservations and displaced tokens also exclude acquirers while their owners live. */
const displacedGuards = (m: string): string[] => readdirSync(dirname(m)).filter((f) => f.startsWith(`${basename(m)}.stale-`)).map((f) => join(dirname(m), f));

/** Reserve recovery before checking and renaming `m`; remove only `seen`, restoring or preserving any other token. */
export function breakStale(m: string, seen: string): boolean {
  const gone = `${m}.stale-${randomBytes(6).toString("hex")}`;
  const reservation = `${gone}.owner`, me = procOf(process.pid);
  writeFileSync(reservation, JSON.stringify({ pid: process.pid, ...(me ? { start: me.start } : {}), nonce: randomBytes(8).toString("hex") }), { flag: "wx" });
  try {
    if (readMutex(m) !== seen) return false;
    try { renameSync(m, gone); } catch { return false; }
    const moved = readMutex(gone);
    if (moved !== seen) {
      try { linkSync(gone, m); } catch {
        console.warn(`lock ${m}: could not restore displaced guard; preserved at ${gone}`);
        return false;
      }
    }
    rmSync(gone, { recursive: true, force: true });
    return moved === seen;
  } finally { rmSync(reservation, { force: true }); }
}
/** Release this holder's guard, including a displaced token, without removing another holder's token. */
export function releaseMutex(m: string, nonce: string): boolean {
  let released = false;
  for (const path of [m, ...displacedGuards(m)]) {
    const raw = readMutex(path);
    if (!raw) continue;
    try { if ((JSON.parse(raw) as { nonce?: string }).nonce !== nonce) continue; } catch { continue; }
    rmSync(path, { force: true });
    released = true;
  }
  return released;
}
/** A named live owner never expires; age reclaims only guards without a readable owner. */
function staleGuard(m: string, raw: string): boolean {
  try {
    const t = JSON.parse(raw) as { pid?: number; start?: string } | null;
    if (typeof t?.pid === "number") return !live({ pid: t.pid, ...(t.start !== undefined ? { start: t.start } : {}) });
  } catch { /* an unparseable guard is reclaimed by age */ }
  try { return Date.now() - statSync(m).mtimeMs > STALE_MUTEX_MS; } catch { return false; }
}

/** Run `f` holding the guard of `dir` (other callers wait, up to 30 s). */
export function withMutex<T>(dir: string, f: () => T): T {
  mkdirSync(dir, { recursive: true });
  const m = join(dir, "mutex");
  const me = procOf(process.pid), nonce = randomBytes(8).toString("hex");
  const tmp = `${m}.own-${nonce}`;
  const token = JSON.stringify({ pid: process.pid, ...(me ? { start: me.start } : {}), nonce }) + "\n";
  writeFileSync(tmp, token);
  try {
    for (const end = Date.now() + MUTEX_WAIT_MS; ; sleepSync(10)) {
      // a hard link is atomic and arrives with the token in it: no guard exists without its owner's name
      let claimed = false;
      try { linkSync(tmp, m); claimed = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      if (claimed) {
        const blocked = displacedGuards(m).some((p) => { const raw = readMutex(p); return raw !== undefined && !staleGuard(p, raw); });
        if (!blocked && readMutex(m) === token) break;
        releaseMutex(m, nonce);
      }
      const seen = readMutex(m);
      if (seen !== undefined && staleGuard(m, seen)) breakStale(m, seen);
      if (Date.now() > end) throw new Error(`lock ${dir}: the guard did not free up in ${MUTEX_WAIT_MS / 1000}s`);
    }
  } finally { rmSync(tmp, { force: true }); }
  try { return f(); } finally { releaseMutex(m, nonce); }
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
/** Write `text` to `path` by writing a temp file and renaming it over: a reader never sees a half-written file. */
const putText = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(`${path}.tmp-${process.pid}`, text); renameSync(`${path}.tmp-${process.pid}`, path); };
const put = (path: string, e: Entry) => putText(path, JSON.stringify(e) + "\n");

/** The holders and the line, with every entry of a dead process (and a ticket of one that already holds) removed. Under the guard. */
function sweep(dir: string): { held: { path: string; e: Entry }[]; line: { path: string; e: Entry }[] } {
  const held = read(dir, "held").filter((x) => (live(x.e) ? true : (drop(x.path), false)));
  const ids = new Set(held.map((x) => x.e.id));
  const line = read(dir, "queue").filter((x) => (live(x.e) && !ids.has(x.e.id) ? true : (drop(x.path), false)));
  return { held, line };
}

/** Take a place in line (a no-op for one already in line or holding) and return its ticket: the number it holds in line,
 *  or undefined for one that holds a slot. `ticket` asks for a place held before (a waiter swept while its process was
 *  between owners comes back where it stood, not at the back). */
export function enqueue(dir: string, who: Who, ticket?: number): number | undefined {
  return withMutex(dir, () => {
    const { held, line } = sweep(dir);
    if (held.some((x) => x.e.id === who.id)) return undefined;
    const have = line.find((x) => x.e.id === who.id);
    if (have) return Number(basename(have.path).slice(0, 12));
    const seqFile = join(dir, "seq");
    const last = existsSync(seqFile) ? Number(readFileSync(seqFile, "utf8")) || 0 : 0;
    const n = ticket ?? last + 1;
    if (n > last) putText(seqFile, String(n));
    put(join(sub(dir, "queue"), `${String(n).padStart(12, "0")}-${file(who.id)}`), { ...who, at: nowIso() });
    return n;
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
