// Resources: the machines, services and accounts a job may run on, declared in the workspace (govern.config.json
// "resources": a path or the list itself; GOVERN_RESOURCES names a file instead). govern knows only what the entry says:
// a name, a kind (free text), who may use it, what it costs by time, what it allows, and how it is started, stopped and
// listed. A shared resource is a lock with slots (lib/locks.ts); money is computed only where the price is per time.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fail, readJsonl, GovernError } from "./util.ts";
import { REPO, PROJECTS } from "./project.ts";
import { obj, arr, record, emptyRecord, str, name, posInt, literal, parseFile, check, reject, type Shape } from "./shape.ts";
import * as locks from "./locks.ts";

export type Price =
  | { basis: "free" }
  | { basis: "per-second" | "per-hour" | "per-month"; currency: string; amount: number };
export interface Resource {
  name: string;
  /** Free text: vm, farm, account, gpu … */
  kind: string;
  sharing: "shared" | "dedicated";
  /** A dedicated resource's lane (or a folder of lanes: `ops` takes `ops/engine`). */
  to?: string;
  price: Price;
  allowance?: { text: string; maxJobs?: number; maxMachines?: number };
  /** Argv lists: govern stores and shows them, and runs none of them. */
  commands?: { start?: string[]; stop?: string[]; list?: string[] };
}

const nonNegative: Shape<number> = (v, p) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : reject(p, `must be a number, 0 or more (got ${JSON.stringify(v)})`));
const ARGV = arr(str, { nonEmpty: true });
const NAME_CHARS: Shape<string> = (v, p) => {
  const s = name(v, p);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ? s : reject(p, `may use only letters, digits, "." "_" "-", starting with a letter or digit (got ${JSON.stringify(s)})`);
};
const PRICE_RAW = obj({ basis: literal("free", "per-second", "per-hour", "per-month") }, { currency: str, amount: nonNegative });
const PRICE: Shape<Price> = (v, at) => {
  const x = PRICE_RAW(v, at);
  if (x.basis === "free") {
    if (x.currency !== undefined) reject(`${at}.currency`, "a free resource has no currency");
    if (x.amount !== undefined) reject(`${at}.amount`, "a free resource has no amount");
    return { basis: "free" };
  }
  if (x.currency === undefined) reject(`${at}.currency`, "missing");
  if (x.amount === undefined) reject(`${at}.amount`, "missing");
  return { basis: x.basis, currency: x.currency!, amount: x.amount! };
};
const RESOURCE_RAW = obj(
  { name: NAME_CHARS, kind: name, sharing: literal("shared", "dedicated") },
  { to: name, price: PRICE, allowance: obj({ text: str }, { maxJobs: posInt, maxMachines: posInt }),
    commands: obj({}, { start: ARGV, stop: ARGV, list: ARGV }) },
);
const RESOURCES: Shape<Record<string, Resource>> = (v, at) => {
  const out = emptyRecord<Resource>();
  arr(RESOURCE_RAW)(v, at).forEach((r, i) => {
    const p = `${at}[${i}]`;
    if (out[r.name]) reject(`${p}.name`, `resource "${r.name}" is already defined`);
    if (r.sharing === "dedicated" && r.to === undefined) reject(`${p}.to`, "a dedicated resource must say who it is dedicated to");
    if (r.sharing === "shared" && r.to !== undefined) reject(`${p}.to`, "only a dedicated resource names who it is dedicated to");
    out[r.name] = { ...r, price: r.price ?? { basis: "free" } };
  });
  return out;
};

/** The resources of `raw` (an already-parsed list from `file`), by name; a wrong field is a GovernError naming file and path. */
export const parseResources = (file: string, raw: unknown): Record<string, Resource> => check(file, raw, RESOURCES);

/** The workspace's resources, by name: GOVERN_RESOURCES (a file), else govern.config.json "resources" (a path, relative
 *  to the config, or the list itself). None declared is an empty registry. */
export function resources(): Record<string, Resource> {
  const cfg = join(REPO, "govern.config.json");
  const fromFile = (f: string) => {
    if (!existsSync(f)) fail(`resources file ${f} not found`);
    return parseFile(f, readFileSync(f, "utf8"), RESOURCES);
  };
  if (process.env.GOVERN_RESOURCES) return fromFile(resolve(process.env.GOVERN_RESOURCES));
  if (!existsSync(cfg)) return emptyRecord();
  let c: unknown;
  try { c = JSON.parse(readFileSync(cfg, "utf8")); } catch (e) { throw new GovernError(`${cfg}: not JSON (${(e as Error).message})`); }
  const r = typeof c === "object" && c !== null ? (c as Record<string, unknown>)["resources"] : undefined;
  if (r === undefined) return emptyRecord();
  return typeof r === "string" ? fromFile(resolve(dirname(cfg), r)) : check(`${cfg}`, { resources: r }, obj({ resources: RESOURCES }, {})).resources;
}

/** One resource by name, or a GovernError listing the ones there are. */
export function resourceNamed(n: string): Resource {
  const all = resources();
  return all[n] ?? fail(`no resource "${n}" (have: ${Object.keys(all).join(", ") || "none"})`);
}

/** Where the locks live: GOVERN_STATE, else govern-state beside the lanes' folder. */
export const stateDir = () => process.env.GOVERN_STATE ?? join(dirname(PROJECTS), "govern-state");
export const lockDir = (resource: string) => join(stateDir(), "locks", resource);

/** The slots of a resource: a shared one has maxJobs (default 1); a dedicated one is not locked unless it sets maxJobs. */
export const slots = (r: Resource): number | undefined => r.allowance?.maxJobs ?? (r.sharing === "shared" ? 1 : undefined);

/** Whether lane `slug` may use `r`: any shared resource, or the dedicated one's lane (or a lane in its folder). */
export const mayUse = (r: Resource, slug: string): boolean => r.to === undefined || slug === r.to || slug.startsWith(`${r.to}/`);

/** The resource a job runs on (`on`, else the command's own), checked, or undefined for a local job. */
export function place(slug: string, own: string | undefined, on: string | undefined): Resource | undefined {
  const n = on ?? own;
  if (n === undefined) return undefined;
  const r = resourceNamed(n);
  if (!mayUse(r, slug)) fail(`${r.name} is dedicated to ${r.to}; ${slug} is not it (govern resources ${r.name})`);
  return r;
}

/** The money for `seconds` on `r`: only a price per second or per hour is time-priced. */
export function costOf(r: Pick<Resource, "price">, seconds: number): { amount: number; currency: string } | undefined {
  const p = r.price;
  if (p.basis === "per-second") return { amount: Math.round(p.amount * seconds * 1e6) / 1e6, currency: p.currency };
  if (p.basis === "per-hour") return { amount: Math.round((p.amount * seconds / 3600) * 1e6) / 1e6, currency: p.currency };
  return undefined;
}

const money = (n: number) => (n === 0 || n >= 0.01 ? n.toFixed(2) : n.toFixed(4));
/** "0.5 USD/hour", "free" */
export const priceShort = (p: Price) => (p.basis === "free" ? "free" : `${p.amount} ${p.currency}/${p.basis.slice(4)}`);
const priceLong = (p: Price) => (p.basis === "free" ? "free" : `${p.amount} ${p.currency} per ${p.basis.slice(4)}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The machine time and money of ledger entries, as the text after "machine time: " and "machine money: "; undefined
 *  where there is none. Money is summed per currency from the entries that carry a cost; a resource priced per month
 *  is named as not time-priced, and a free one adds no money. */
export function machineSummary(entries: Record<string, unknown>[]): { time: string; money?: string } | undefined {
  const secs = emptyRecord<number>(), cost = emptyRecord<Record<string, number>>(), monthly = new Set<string>();
  for (const e of entries) {
    if (e["kind"] !== "job" || typeof e["machineSeconds"] !== "number") continue;
    const r = typeof e["resource"] === "string" ? e["resource"] : "local";
    secs[r] = (secs[r] ?? 0) + e["machineSeconds"];
    if (typeof e["cost"] === "number" && typeof e["currency"] === "string") {
      const c = (cost[e["currency"]] ??= emptyRecord<number>());
      c[r] = (c[r] ?? 0) + e["cost"];
    }
    if (e["basis"] === "per-month") monthly.add(r);
  }
  const names = Object.keys(secs).sort();
  if (!names.length) return undefined;
  const parts = Object.keys(cost).sort().map((cur) => {
    const by = cost[cur]!;
    return `${money(Object.values(by).reduce((a, b) => a + b, 0))} ${cur} (${Object.keys(by).sort().join(", ")})`;
  });
  parts.push(...[...monthly].sort().map((r) => `${r} not time-priced`));
  return { time: names.map((n) => `${n} ${Math.round(secs[n]!)}s`).join(" · "), ...(parts.length ? { money: parts.join(" · ") } : {}) };
}
/** The "machine time: …" and "machine money: …" lines of ledger entries (none when no job ran). */
export function machineLines(entries: Record<string, unknown>[]): string[] {
  const s = machineSummary(entries);
  return s ? [`machine time: ${s.time}`, ...(s.money ? [`machine money: ${s.money}`] : [])] : [];
}

/** One line per resource for `govern resources`. */
export function listLines(): string[] {
  const all = Object.values(resources());
  if (!all.length) return ["no resources declared (govern.config.json: resources)"];
  const w = Math.max(...all.map((r) => r.name.length), 4), k = Math.max(...all.map((r) => r.kind.length), 4);
  const who = (r: Resource) => (r.sharing === "dedicated" ? `dedicated to ${r.to}` : "shared");
  const wh = Math.max(...all.map((r) => who(r).length));
  return all.map((r) => `${r.name.padEnd(w)}  ${r.kind.padEnd(k)}  ${who(r).padEnd(wh)}  ${priceShort(r.price).padEnd(14)}  ${r.allowance?.text ?? ""}`.trimEnd());
}

/** `govern resources <name>`: the entry, who holds its lock and who waits behind. */
export function showLines(n: string): string[] {
  const r = resourceNamed(n);
  const cap = slots(r);
  const L = [`${r.name} · ${r.kind} · ${r.sharing === "dedicated" ? `dedicated to ${r.to}` : "shared"}${cap !== undefined ? ` · max ${plural(cap, "job")} at a time${r.allowance?.maxJobs === undefined ? " (default)" : ""}` : ""}`,
    `price: ${priceLong(r.price)}${r.price.basis === "per-month" ? " (machine seconds only: not time-priced)" : ""}`];
  if (r.allowance) L.push(`allowance: ${r.allowance.text}${r.allowance.maxMachines ? ` (max ${plural(r.allowance.maxMachines, "machine")})` : ""}`);
  for (const c of ["start", "stop", "list"] as const) if (r.commands?.[c]) L.push(`${c}: ${r.commands[c]!.join(" ")}`);
  if (cap === undefined) return [...L, "lock: none (a dedicated resource is not shared)"];
  const { holders, queue } = locks.inspect(lockDir(r.name));
  const who = (e: locks.Entry) => `${e.label} (pid ${e.pid}, since ${e.at})`;
  if (!holders.length) L.push("holder: none");
  for (const h of holders) L.push(`holder: ${who(h)}`);
  if (!queue.length) L.push("queue: none");
  else { L.push("queue:"); queue.forEach((q, i) => L.push(`  ${i + 1}. ${who(q)}`)); }
  return L;
}

/** All of a lane's ledger entries that are jobs with machine time, for reports. */
export const machineEntries = (ledgerPath: string): Record<string, unknown>[] => readJsonl(ledgerPath).filter((e) => e.kind === "job" && typeof e.machineSeconds === "number");
