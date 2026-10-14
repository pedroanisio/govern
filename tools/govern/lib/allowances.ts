// Allowances: what a lane (or a folder of lanes) or a profile may spend, declared in the workspace (govern.config.json
// "allowances": a path or the list itself; GOVERN_ALLOWANCES names a file instead). Before a queued task or a machine
// job starts, govern reserves its estimate here; at the end the unused part is released and the actual recorded. A
// request that does not fit is refused with who decides; only a recorded approval (`govern allow`) raises the limit.
// State: <govern state>/allowances/<name>/{reserved/*.json, spent.jsonl, extras.jsonl}. One guard (lib/locks.ts) covers
// every change, so reserving against several allowances is all or nothing; a reservation whose holder died is swept.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, nowIso } from "./util.ts";
import { obj, arr, emptyRecord, str, literal, reject, check, type Shape } from "./shape.ts";
import { readDeclared, NAME_CHARS, nonNegative, stateDir } from "./resources.ts";
import * as locks from "./locks.ts";
import type { Source } from "./approval.ts";

export type Unit = "model-usd" | "machine-hours" | "money";
export interface Allowance {
  name: string;
  consumer: { kind: "lane" | "profile"; name: string };
  unit: Unit;
  limit: number;
  /** total: one budget for ever; day: starts over each UTC day. */
  period: "total" | "day";
  /** The queue name of whoever decides an overrun (3.2). */
  owner: string;
  /** model-usd only: what a task reserves when it declares no estimate. */
  taskEstimate?: number;
  /** money only. */
  currency?: string;
}

const CONSUMER: Shape<Allowance["consumer"]> = (v, p) => {
  const m = typeof v === "string" ? /^(lane|profile):([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(v) : null;
  return m ? { kind: m[1] as "lane" | "profile", name: m[2]! } : reject(p, `must be "lane:<lane or folder>" or "profile:<name>" (got ${JSON.stringify(v)})`);
};
const OWNER: Shape<string> = (v, p) => (typeof v === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(v) ? v : reject(p, `must be a queue name: lower-case letters, digits, "." "-" (got ${JSON.stringify(v)})`));
const RAW = obj({ name: NAME_CHARS, consumer: CONSUMER, unit: literal("model-usd", "machine-hours", "money"), limit: nonNegative },
  { currency: str, period: literal("total", "day"), owner: OWNER, taskEstimate: nonNegative });
const ALLOWANCES: Shape<Record<string, Allowance>> = (v, at) => {
  const out = emptyRecord<Allowance>();
  arr(RAW)(v, at).forEach((r, i) => {
    const p = `${at}[${i}]`;
    if (out[r.name]) reject(`${p}.name`, `allowance "${r.name}" is already defined`);
    if (r.unit === "money" && r.currency === undefined) reject(`${p}.currency`, "a money allowance needs a currency");
    if (r.unit !== "money" && r.currency !== undefined) reject(`${p}.currency`, "only a money allowance has a currency");
    if (r.unit !== "model-usd" && r.taskEstimate !== undefined) reject(`${p}.taskEstimate`, "only a model-usd allowance has a task estimate");
    const { period, owner, ...rest } = r;
    out[r.name] = { ...rest, period: period ?? "total", owner: owner ?? "owner" };
  });
  return out;
};

/** The allowances of `raw` (an already-parsed list from `file`), by name; a wrong field is a GovernError naming file and path. */
export const parseAllowances = (file: string, raw: unknown): Record<string, Allowance> => check(file, raw, ALLOWANCES);
/** The workspace's allowances, by name (none declared is empty). */
export const allowances = (): Record<string, Allowance> => readDeclared("allowances", "GOVERN_ALLOWANCES", ALLOWANCES, () => emptyRecord(), "allowances");
/** One allowance by name, or a GovernError listing the ones there are. */
export function allowanceNamed(n: string): Allowance {
  const all = allowances();
  return all[n] ?? fail(`no allowance "${n}" (have: ${Object.keys(all).join(", ") || "none"})`);
}

// ---------------------------------------------------------------- state

/** Who holds a reservation and the job it is for (so a dead holder's job can be settled by its own record). */
export interface Holder { pid: number; start?: string }
export interface JobRef { slug: string; id: string }
interface Reservation { id: string; label: string; allowance: string; unit: Unit; currency?: string; amount: number; period: string; holder: Holder; job?: JobRef; at: string }
interface Spent { id: string; label: string; at: string; period: string; reserved: number; actual: number; note?: string }
interface Extra { at: string; period: string; amount: number; quote: string; by: string; source: Source }

const now = (): Date => (process.env.GOVERN_NOW ? new Date(process.env.GOVERN_NOW) : new Date());
const periodKey = (a: Allowance): string => (a.period === "day" ? now().toISOString().slice(0, 10) : "total");
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const root = () => join(stateDir(), "allowances");
const dirOf = (name: string) => join(root(), name);
const fileOf = (id: string) => `${Buffer.from(id).toString("base64url")}.json`;
const guarded = <T>(f: () => T): T => locks.withMutex(join(root(), ".guard"), f);

function readRows<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as T] : []; } catch { return []; } });
}
function reservations(name: string): { path: string; r: Reservation }[] {
  const d = join(dirOf(name), "reserved");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    try { return [{ path: join(d, f), r: JSON.parse(readFileSync(join(d, f), "utf8")) as Reservation }]; } catch { return []; }
  });
}
const drop = (path: string) => { try { unlinkSync(path); } catch { /* already gone */ } };
const append = (path: string, row: object) => { mkdirSync(join(path, ".."), { recursive: true }); appendFileSync(path, JSON.stringify(row) + "\n"); };
// A reservation counts while its holder runs; one whose holder died counts only if it names a job (the sweep decides it).
const counts = (r: Reservation) => locks.live(r.holder) || r.job !== undefined;

/** What has been used, is reserved and is left of `a` in its current period. */
export function status(a: Allowance): { used: number; reserved: number; left: number; extra: number } {
  const key = periodKey(a);
  const used = round(readRows<Spent>(join(dirOf(a.name), "spent.jsonl")).filter((s) => s.period === key).reduce((t, s) => t + s.actual, 0));
  const extra = round(readRows<Extra>(join(dirOf(a.name), "extras.jsonl")).filter((x) => x.period === key).reduce((t, x) => t + x.amount, 0));
  const reserved = round(reservations(a.name).filter((x) => counts(x.r)).reduce((t, x) => t + x.r.amount, 0));
  return { used, reserved, left: round(a.limit + extra - used - reserved), extra };
}

// ---------------------------------------------------------------- reserve

export interface Request {
  id: string; label: string;
  /** A queued task's estimate (model dollars). Without hours, the request is a task. */
  usd?: number;
  /** A machine job's estimate in hours, and its price for the same time when the resource is time-priced. */
  hours?: number; money?: { amount: number; currency: string };
  /** The process that holds the reservation (default: this one). */
  holder?: Holder; job?: JobRef;
}
export interface Refusal { kind: "over" | "no-estimate" | "invalid"; text: string; owner: string }

const matches = (a: Allowance, k: { lane?: string; profile?: string }): boolean =>
  a.consumer.kind === "profile" ? k.profile === a.consumer.name : k.lane !== undefined && (k.lane === a.consumer.name || k.lane.startsWith(`${a.consumer.name}/`));
/** Whether a machine job of lane `lane` is metered by some allowance (a money one only in `currency`). */
export const meters = (list: Record<string, Allowance>, lane: string, currency: string | undefined): boolean =>
  Object.values(list).some((a) => matches(a, { lane }) && (a.unit === "machine-hours" || (a.unit === "money" && a.currency === currency)));
const UNITS: Record<Unit, string> = { "model-usd": "model dollars", "machine-hours": "machine-hours", money: "money" };
const unitOf = (a: Allowance): string => (a.unit === "model-usd" ? "USD" : a.unit === "money" ? a.currency! : "machine-hours");
const periodWords = (a: Allowance) => (a.period === "day" ? "per day" : "in total");
/** What `req` would reserve against `a`: undefined when the request is not metered by it, null when it has no estimate. */
function amountFor(a: Allowance, req: Request): number | null | undefined {
  if (req.hours !== undefined) {
    if (a.unit === "machine-hours") return req.hours;
    return a.unit === "money" && req.money && req.money.currency === a.currency ? req.money.amount : undefined;
  }
  // A task's estimate cannot go below the allowance's taskEstimate: a lowball estimate would bypass the limit.
  return a.unit === "model-usd" ? (req.usd === undefined ? a.taskEstimate ?? null : Math.max(req.usd, a.taskEstimate ?? 0)) : undefined;
}
const validAmount = (n: number): boolean => Number.isFinite(n) && n >= 0;
/** Whether a request's amount (hours, USD, money) is an amount at all: never negative, never NaN or Infinity. */
const invalid = (a: Allowance, req: Request): Refusal | undefined => {
  const raw = req.hours !== undefined ? (a.unit === "machine-hours" ? req.hours : req.money?.amount) : req.usd;
  return raw !== undefined && !validAmount(raw) ? { kind: "invalid", owner: a.owner, text: `${req.label} asked ${String(raw)} of allowance "${a.name}": not a valid amount (it must be a finite number, 0 or more)` } : undefined;
};

/** Reserve `req` against every allowance that applies to the lane/profile in `keys`, all or nothing. Undefined: reserved
 *  (or nothing applies). A refusal says what was asked, what is left and who decides. Reservations of dead holders are
 *  swept first; `onDead` is asked about each that names a job (true: the job still runs, keep it). */
export function reserve(list: Record<string, Allowance>, keys: { lane?: string; profile?: string }, req: Request, onDead?: (job: JobRef) => boolean): Refusal | undefined {
  const mine = Object.values(list).filter((a) => matches(a, keys) && amountFor(a, req) !== undefined).sort((x, y) => x.name.localeCompare(y.name));
  if (!mine.length) return undefined;
  sweepDead(mine, onDead);
  return guarded(() => {
    for (const a of mine) {
      const bad = invalid(a, req);
      if (bad) return bad;
      const want = amountFor(a, req);
      if (want === null) return { kind: "no-estimate" as const, owner: a.owner, text: `${req.label} has no estimate for allowance "${a.name}": give one with --estimate-usd, or set taskEstimate on the allowance` };
      const s = status(a);
      if (want! > s.left + 1e-9) return refusal(a, req.label, want!, s);
    }
    const holder = req.holder ?? { pid: process.pid, ...locks.identity(process.pid) };
    for (const a of mine) {
      const r: Reservation = { id: req.id, label: req.label, allowance: a.name, unit: a.unit, ...(a.currency ? { currency: a.currency } : {}), amount: amountFor(a, req)!, period: periodKey(a), holder, ...(req.job ? { job: req.job } : {}), at: nowIso() };
      const d = join(dirOf(a.name), "reserved");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${fileOf(req.id)}.tmp-${process.pid}`), JSON.stringify(r) + "\n");
      renameSync(join(d, `${fileOf(req.id)}.tmp-${process.pid}`), join(d, fileOf(req.id)));
    }
    return undefined;
  });
}

function refusal(a: Allowance, label: string, want: number, s: ReturnType<typeof status>): Refusal {
  const limit = round(a.limit + s.extra);
  const more = round(want - s.left);
  const by = a.owner === "owner" ? "" : ` --by ${a.owner}`;
  return { kind: "over", owner: a.owner,
    text: `${label} asked ${round(want)} ${unitOf(a)} of allowance "${a.name}" (${UNITS[a.unit]}, ${periodWords(a)}); left ${s.left} (limit ${limit}, used ${s.used}, reserved ${s.reserved}). Decision owner: ${a.owner}.\n` +
      `to allow it: govern allow ${a.name} --extra ${more} --quote "<${a.owner === "owner" ? "owner's" : `${a.owner}'s`} own words>"${by}` };
}

/** Close the reservations of dead holders: one with no job is charged as reserved (what it used is unknown); one with a
 *  job is first offered to `onDead`, which may settle it (it calls settle) or say the job still runs; one it did not
 *  settle is charged as reserved too. The callback runs outside the guard. */
function sweepDead(list: Allowance[], onDead?: (job: JobRef) => boolean): void {
  const jobs: { name: string; r: Reservation }[] = [];
  guarded(() => {
    for (const a of list) for (const x of reservations(a.name)) {
      if (locks.live(x.r.holder)) continue;
      if (x.r.job && onDead) jobs.push({ name: a.name, r: x.r });
      else if (!x.r.job) closeOne(a, x, x.r.amount, DIED);
    }
  });
  const keep = new Map<string, boolean>();
  for (const j of jobs) {
    const k = `${j.r.job!.slug}/${j.r.job!.id}`;
    if (!keep.has(k)) keep.set(k, onDead!(j.r.job!));
  }
  guarded(() => {
    for (const j of jobs) {
      if (keep.get(`${j.r.job!.slug}/${j.r.job!.id}`)) continue;
      const a = list.find((x) => x.name === j.name);
      const x = reservations(j.name).find((y) => y.r.id === j.r.id);
      if (a && x && !locks.live(x.r.holder)) closeOne(a, x, x.r.amount, DIED);
    }
  });
}

const DIED = "holder died, charged as reserved";
// A crash between the append and the drop leaves the reservation, which the next sweep charges again: that errs high.
function closeOne(a: { name: string }, x: { path: string; r: Reservation }, actual: number, note?: string): void {
  append(join(dirOf(a.name), "spent.jsonl"), { id: x.r.id, label: x.r.label, at: nowIso(), period: x.r.period, reserved: x.r.amount, actual, ...(note ? { note } : {}) } satisfies Spent);
  drop(x.path);
}

// ---------------------------------------------------------------- settle, release, adopt, grant

const names = (): string[] => (existsSync(root()) ? readdirSync(root(), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort() : []);
const held = (id: string) => names().flatMap((name) => reservations(name).filter((x) => x.r.id === id).map((x) => ({ name, x })));

/** What a request really used, by unit; a unit it does not say is charged as reserved. */
export interface Actual { usd?: number; hours?: number; money?: { amount: number; currency: string } }
const pick = (r: Reservation, a: Actual): number | undefined =>
  r.unit === "model-usd" ? a.usd : r.unit === "machine-hours" ? a.hours : a.money && a.money.currency === r.currency ? a.money.amount : undefined;
function finish(id: string, actual: (r: Reservation) => number | undefined, note?: string): void {
  if (!held(id).length) return;
  guarded(() => {
    for (const { name, x } of held(id)) {
      const raw = actual(x.r);
      const got = raw !== undefined && validAmount(raw) ? raw : undefined;
      closeOne({ name }, x, got ?? x.r.amount, got === undefined ? "unpriced" : note);
    }
  });
}
/** The end of `id`: release the unused part of each reservation and record what was used. A unit with no actual is
 *  charged as reserved and noted "unpriced". */
export const settle = (id: string, actual: Actual, note?: string): void => finish(id, (r) => pick(r, actual), note);
/** The end of `id` when nobody can say what it really used (its machines may still run): each unit is charged at least what
 *  was reserved, and more where the actual, as far as it is known, is larger. */
export const settleAtLeast = (id: string, actual: Actual, note?: string): void =>
  finish(id, (r) => { const v = pick(r, actual); return v === undefined ? undefined : Math.max(v, r.amount); }, note);
/** Give `id` back without using it (it never ran). */
export const release = (id: string): void => finish(id, () => 0, "released");

/** The most a request `id` may use of model dollars: its smallest model-usd reservation (undefined: none is reserved). */
export const reservedUsd = (id: string): number | undefined => {
  const mine = held(id).filter((h) => h.x.r.unit === "model-usd").map((h) => h.x.r.amount);
  return mine.length ? Math.min(...mine) : undefined;
};

/** Hand the reservations of `id` to another process: the one that runs the job. */
export function adopt(id: string, to: Holder): void {
  if (!held(id).length) return;
  guarded(() => {
    for (const { x } of held(id)) {
      const { start: _, ...rest } = x.r.holder;
      writeFileSync(`${x.path}.tmp-${process.pid}`, JSON.stringify({ ...x.r, holder: { ...rest, pid: to.pid, ...(to.start ? { start: to.start } : {}) } }) + "\n");
      renameSync(`${x.path}.tmp-${process.pid}`, x.path);
    }
  });
}

/** Whether `quote` holds `amount` as a number token ("10", "$10", "10.0"; not "100" or "1.0"), compared numerically. */
export const quoteNamesAmount = (quote: string, amount: number): boolean =>
  (quote.match(/\d+(?:\.\d+)?/g) ?? []).some((t) => Math.abs(Number(t) - amount) < 1e-9);
const sameQuote = (a: string, b: string): boolean => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** Record an approved extra for the current period of `a`: the person's words, who decided and where they came from.
 *  The words must name the amount, and one quote grants once per allowance and period (an old "ok go ahead" is no grant). */
export function grant(a: Allowance, amount: number, quote: string, source: Source, by: string): void {
  if (!quoteNamesAmount(quote, amount)) fail(`the quote must contain the amount ${amount} as a number (e.g. "${amount}" or "${amount} ${unitOf(a)}"): words that do not name it cannot grant it`, 1);
  guarded(() => {
    if (readRows<Extra>(join(dirOf(a.name), "extras.jsonl")).some((x) => x.period === periodKey(a) && sameQuote(x.quote, quote)))
      fail(`this quote was already used for allowance ${a.name} in this period: one quote grants once; ask ${by} for new words`, 1);
    append(join(dirOf(a.name), "extras.jsonl"), { at: nowIso(), period: periodKey(a), amount, quote, by, source } satisfies Extra);
  });
}

// ---------------------------------------------------------------- display

/** The money allowance of `lane` whose currency is not `currency` (a job on a resource priced in `currency` cannot be metered by it). */
export const currencyClash = (list: Record<string, Allowance>, lane: string, currency: string): Allowance | undefined =>
  Object.values(list).find((a) => matches(a, { lane }) && a.unit === "money" && a.currency !== currency);
/** `lines`, or one "allowances: config error" line when the declaration is wrong: desk and usage show it and go on. */
export function shown(): string[] {
  try { return lines(); } catch (e) { return [`allowances: config error — ${e instanceof Error ? e.message : String(e)}`]; }
}

/** "USD", "machine-hours" or the currency: the unit as people read it after a number. */
export const unitName = unitOf;
/** One line per allowance: used, reserved, left. Empty when none is declared. */
export function lines(list: Record<string, Allowance> = allowances()): string[] {
  const all = Object.values(list);
  if (!all.length) return [];
  const w = Math.max(...all.map((a) => a.name.length)), c = Math.max(...all.map((a) => `${a.consumer.kind}:${a.consumer.name}`.length)), u = Math.max(...all.map((a) => `${a.unit}/${a.period}`.length));
  return all.map((a) => {
    const s = status(a);
    return `${a.name.padEnd(w)}  ${`${a.consumer.kind}:${a.consumer.name}`.padEnd(c)}  ${`${a.unit}/${a.period}`.padEnd(u)}  used ${s.used} · reserved ${s.reserved} · left ${s.left} of ${round(a.limit + s.extra)} ${unitOf(a)}`;
  });
}
