// Reaping what govern started: `up` runs a resource's start command under a unique tag and records it, `down` runs stop,
// `reap` lists what the provider still runs and shows the tagged instances nothing is using. Everything the provider CLI
// prints is untrusted: a failed, silent, unparseable or timed-out command is reported as that, never as "nothing there",
// and an instance is govern's only if its tag is one govern recorded (never a name pattern). Listing never stops anything.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fail, readJson, writeJson, nowIso, clip, sleepSync, GovernError } from "./util.ts";
import { appendLedger, load } from "./project.ts";
import { repo } from "./workspace.ts";
import { obj, arr, str, literal, posInt, parseFile, reject, type Shape } from "./shape.ts";
import { resources, resourceNamed, stateDir, lockDir, costOf, mayUse, PRICE, type Resource, type Price } from "./resources.ts";
import * as jobs from "./jobs.ts";
import * as locks from "./locks.ts";

/** A start that is still running is not an orphan for this long (then it is a crashed `up`). */
const STARTING_GRACE_MS = 15 * 60e3;
/** How many of a lane's latest jobs are checked for a lease on a resource. */
const LEASE_JOBS = 30;
/** How long a down or reap waits for another one on the same tag. */
const TAG_WAIT_MS = 10 * 60e3;

export interface Instances {
  tag: string; resource: string; startedAt: string; status: "starting" | "running" | "start-failed" | "ended";
  /** Ids the start printed, plus any a listing found under the tag. */
  ids: string[]; stopped?: string[]; endedAt?: string; lane?: string; job?: string; count?: number; price?: Price;
  /** The --timeout `up` ran its start with (s): the start may run that long. */
  timeout?: number;
}
const INSTANCES: Shape<Instances> = obj(
  { tag: str, resource: str, startedAt: str, status: literal("starting", "running", "start-failed", "ended"), ids: arr(str) },
  { stopped: arr(str), endedAt: str, lane: str, job: str, count: posInt, price: PRICE, timeout: posInt },
) as Shape<Instances>;

export interface Orphan { id: string; tag: string; lane?: string; since: string; again?: boolean }
export interface Scan { resource: string; at: string; status: "ok" | "failed" | "unconfirmed"; why?: string; orphans: Orphan[]; inUse: number; untagged: number }
const count0: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a whole number, 0 or more"));
const ORPHAN: Shape<Orphan> = obj({ id: str, tag: str, since: str }, { lane: str, again: (v, p) => (v === true ? true : reject(p, "must be true")) }) as Shape<Orphan>;
const SCANS: Shape<{ results: Scan[] }> = obj({ results: arr(obj(
  { resource: str, at: str, status: literal("ok", "failed", "unconfirmed"), orphans: arr(ORPHAN), inUse: count0, untagged: count0 }, { why: str })) }) as Shape<{ results: Scan[] }>;

const dirOf = () => join(stateDir(), "instances");
const fileOf = (tag: string) => join(dirOf(), `${tag}.json`);
const scanFile = () => join(stateDir(), "reap-scan.json");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const unstopped = (r: Instances) => r.ids.filter((i) => !r.stopped?.includes(i));

/** Every recorded start; a state file that does not read is an error, never skipped. */
export function instances(): Instances[] {
  const d = dirOf();
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => parseFile(join(d, f), readFileSync(join(d, f), "utf8"), INSTANCES));
}
const save = (r: Instances) => writeJson(fileOf(r.tag), r);

// ---- running the provider's commands

type Ran = { ok: true; out: string } | { ok: false; why: string; out: string };
const expandArgv = (argv: string[], v: Record<string, string>) => argv.map((a) => a.replace(/\{(tag|count|id|lane|resource)\}/g, (_, k: string) => v[k] ?? ""));
const lastLine = (s: string) => clip((s.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "").replace(/\s+/g, " "), 200);

function run(argv: string[], vars: Record<string, string>, timeout: number): Ran {
  const env = { ...process.env, GOVERN_TAG: vars["tag"] ?? "", GOVERN_LANE: vars["lane"] ?? "", GOVERN_RESOURCE: vars["resource"] ?? "",
    ...(vars["count"] ? { GOVERN_COUNT: vars["count"] } : {}), ...(vars["id"] ? { GOVERN_ID: vars["id"] } : {}) };
  const [cmd, ...rest] = expandArgv(argv, vars);
  const r = spawnSync(cmd!, rest, { cwd: repo(), env, encoding: "utf8", timeout: timeout * 1000, killSignal: "SIGKILL", maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "pipe"] });
  const out = r.stdout ?? "";
  if (r.error) return { ok: false, out, why: (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `timed out after ${timeout}s` : `could not run: ${r.error.message}` };
  if (r.signal) return { ok: false, out, why: `killed by ${r.signal}` };
  if (r.status !== 0) { const t = lastLine(r.stderr ?? "") || lastLine(out); return { ok: false, out, why: `exit ${r.status}${t ? `: ${t}` : ""}` }; }
  return { ok: true, out };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@=+-]{0,255}$/;
/** An id a provider would issue has a digit or a separator in it; a bare word ("Creating", "Done") is output, not an id. */
const looksLikeId = (s: string) => ID.test(s) && s.length >= 2 && /[0-9._:/@=+-]/.test(s);
const linesOf = (out: string) => out.split("\n").map((l, i) => ({ n: i + 1, s: l.trim() })).filter((l) => l.s);
/** The ids a start printed, one per line; `bad` names the first line that is not an id. */
function parseIds(out: string): { ids: string[]; bad?: string } {
  const ids: string[] = []; let bad: string | undefined;
  for (const { n, s } of linesOf(out)) { if (looksLikeId(s)) { if (!ids.includes(s)) ids.push(s); } else bad ??= `line ${n} ${JSON.stringify(clip(s, 60))} is not an instance id`; }
  return { ids, ...(bad ? { bad } : {}) };
}

// ---- up

const label = (s: string, n: number) => clip(s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), n) || "x";
/** govern, the lane, the job and six random hex digits: lowercase letters, digits and "-", under 63 characters. */
export const newTag = (lane?: string, job?: string) => `govern-${lane ? label(lane, 16) : "nolane"}-${job ? label(job, 28) : "nojob"}-${randomBytes(3).toString("hex")}`;

function ledger(lane: string | undefined, entry: Record<string, unknown>): void {
  if (lane) return appendLedger(lane, entry);
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(join(stateDir(), "ledger.jsonl"), JSON.stringify({ t: nowIso(), ...entry }) + "\n");
}

/** The lane and job `up` runs for: --lane, else the job it runs inside (GOVERN_JOB_DIR). */
function whose(laneOpt: string | undefined): { lane?: string; job?: string } {
  const dir = process.env["GOVERN_JOB_DIR"], f = dir ? join(dir, "job.json") : undefined;
  const j = f && existsSync(f) ? readJson<{ slug?: string; id?: string }>(f) : undefined;
  const lane = laneOpt ?? j?.slug;
  return { ...(lane ? { lane: load(lane).slug } : {}), ...(j?.id && lane === j.slug ? { job: j.id } : {}) };
}

/** Run the resource's start command under a fresh tag (refused above the resource's maxMachines); the record is written before it runs, so a crash or a timeout
 *  leaves a tag that reap can find the instances by. `problem` is set when the start cannot be trusted. */
export function up(resource: string, o: { lane?: string; count: number; timeout: number; onTag?: (tag: string) => void }): { rec: Instances; problem?: string } {
  const res = resourceNamed(resource);
  const most = res.allowance?.maxMachines;
  if (most !== undefined && o.count > most) fail(`refused: ${res.name} allows at most ${most} machines (allowance maxMachines), ${o.count} asked for`, 1);
  const start = res.commands?.start ?? fail(`${res.name} has no start command (govern.config.json: resources[].commands.start)`);
  const { lane, job } = whose(o.lane);
  if (lane && !mayUse(res, lane)) fail(`${res.name} is dedicated to ${res.to}; ${lane} is not it`);
  const tag = newTag(lane, job);
  let rec: Instances = { tag, resource: res.name, startedAt: nowIso(), status: "starting", ids: [], count: o.count, price: res.price, timeout: Math.ceil(o.timeout), ...(lane ? { lane } : {}), ...(job ? { job } : {}) };
  save(rec);
  // Handed out before start runs: a caller whose own code fails after this still knows the tag, so it can run down.
  o.onTag?.(tag);
  const ran = run(start, { tag, count: String(o.count), resource: res.name, ...(lane ? { lane } : {}) }, o.timeout);
  const { ids, bad } = parseIds(ran.out);
  let problem: string | undefined;
  if (!ran.ok) problem = `start failed: ${ran.why}`;
  else if (bad) problem = `start printed something that is ${bad}`;
  else if (!ids.length) problem = "start printed no instance ids";
  else if (ids.length !== o.count) problem = `asked for ${o.count}, the command printed ${ids.length} id${ids.length === 1 ? "" : "s"}`;
  rec = { ...rec, ids, status: ids.length && ran.ok && !bad ? "running" : "start-failed" };
  save(rec);
  ledger(lane, { kind: "up", tag, resource: res.name, ids, status: problem ? "failed" : "ok", ...(problem ? { problem } : {}) });
  return { rec, ...(problem ? { problem: `up ${res.name}: ${problem} (tag ${tag} is recorded; govern reap lists anything it left)` } : {}) };
}

// ---- down and the machine-time books

const LIFETIME_NOTE = "machine lifetime, not added to job time on the same resource: totals take the larger of the two";
/** Book the instances `ids` as stopped now: machine time from their start (for those not booked before) priced with the
 *  price recorded at `up`, in the lane's ledger (or the state ledger), and the record updated. */
function settle(rec: Instances, ids: string[], kind: "down" | "reap", by?: string): Instances {
  const fresh = ids.filter((i) => !rec.stopped?.includes(i));
  const age = Math.max(0, Math.round((Date.now() - Date.parse(rec.startedAt)) / 1000));
  const price: Price = rec.price ?? { basis: "free" };
  const machineSeconds = fresh.length * age, cost = costOf({ price }, machineSeconds);
  const allIds = [...new Set([...rec.ids, ...ids])], stopped = [...new Set([...(rec.stopped ?? []), ...ids])];
  const ended = rec.status !== "starting" && allIds.every((i) => stopped.includes(i));
  const next: Instances = { ...rec, ids: allIds, stopped, status: ended ? "ended" : rec.status, ...(ended ? { endedAt: nowIso() } : {}) };
  save(next);
  ledger(rec.lane, { kind, tag: rec.tag, resource: rec.resource, ids, machineSeconds, basis: price.basis, additive: false, note: LIFETIME_NOTE, ...(cost ? { cost: cost.amount, currency: cost.currency } : {}), ...(by ? { by } : {}) });
  return next;
}

const stopCommand = (res: Resource) => res.commands?.stop ?? fail(`${res.name} has no stop command (govern.config.json: resources[].commands.stop)`);
const stopVars = (rec: Instances, id: string) => ({ tag: rec.tag, id, resource: rec.resource, ...(rec.lane ? { lane: rec.lane } : {}) });

/** Run `f` holding the tag's lock, a slot file that outlives the long stop commands (the short mkdir guard would be broken
 *  as stale) and is reclaimed when its holder dies. */
function withTag<T>(tag: string, f: () => T): T {
  const dir = join(stateDir(), "locks", "instances", tag), me = locks.identity(process.pid), id = `pid-${process.pid}`;
  locks.enqueue(dir, { id, label: `govern ${process.pid}`, pid: process.pid, ...(me ? { start: me.start } : {}) });
  try {
    for (const end = Date.now() + TAG_WAIT_MS; !locks.tryAcquire(dir, id, 1); sleepSync(50)) if (Date.now() > end) fail(`${tag}: another govern down or reap has held it for ${TAG_WAIT_MS / 60e3} minutes`);
    return f();
  } finally { locks.release(dir, id); }
}

/** Stop a recorded tag's instances, or one instance by id (--forget: book the time without running stop, for a machine that is already gone). */
export function down(ref: string, o: { timeout: number; forget: boolean }): { lines: string[]; problems: string[] } {
  const all = instances();
  const byTag = all.find((r) => r.tag === ref);
  const found = byTag ?? all.find((r) => r.ids.includes(ref)) ?? fail(`no recorded instance "${ref}" (a tag or an id that govern up started; govern reap lists what is running)`);
  return withTag(found.tag, () => {
    const rec = instances().find((r) => r.tag === found.tag) ?? found; // re-read: another down or reap may have just stopped some
    const pick = byTag ? unstopped(rec) : unstopped(rec).filter((i) => i === ref);
    if (!pick.length) return { lines: [`nothing running under ${ref}: ${rec.tag} is ${rec.status}${rec.ids.length ? "" : " and has no recorded ids (govern reap finds them by tag)"}`], problems: [] };
    const lines: string[] = [], problems: string[] = [], done: string[] = [];
    const res = o.forget ? undefined : resourceNamed(rec.resource);
    const argv = res ? stopCommand(res) : [];
    for (const id of pick) {
      if (o.forget) { done.push(id); continue; }
      const r = run(argv, stopVars(rec, id), o.timeout);
      if (r.ok) { done.push(id); lines.push(`stopped ${id}`); } else problems.push(`could not stop ${id}: ${r.why}`);
    }
    if (done.length) {
      settle(rec, done, "down", o.forget ? "forget" : "stop");
      forgetOrphans(rec.tag, done);
      if (o.forget) lines.push(`forgot ${done.join(", ")} (no stop run; machine time booked up to now)`);
    }
    return { lines, problems };
  });
}

// ---- reap

/** Why the instance may not be stopped now, or undefined: its start may still run (the longer of the grace and the
 *  start's own timeout), anyone holds or waits for the resource's lock (any lane, any job), or its job runs. */
function inUse(rec: Instances, resource: string): string | undefined {
  const grace = Math.max(STARTING_GRACE_MS, (rec.timeout ?? 0) * 1000);
  if (rec.status === "starting" && Date.now() - Date.parse(rec.startedAt) < grace) return "its start is still running";
  const { holders, queue } = locks.inspect(lockDir(resource));
  if (holders[0]) return `${holders[0].label} holds ${resource}`;
  if (queue[0]) return `${queue[0].label} is waiting for ${resource}`;
  if (!rec.lane) return undefined;
  const ids = jobs.list(rec.lane);
  if (rec.job && ids.includes(rec.job) && jobs.state(rec.lane, rec.job).status === "running") return `job ${rec.job} is running`;
  for (const id of ids.slice(-LEASE_JOBS)) {
    const s = jobs.state(rec.lane, id);
    if (s.status === "running" && s.resource === resource) return `job ${id} holds ${resource}`;
  }
  return undefined;
}

/** The listing grammar: lines of `<id>` or `<id> <tag>`; anything else makes the whole listing untrusted. */
function parseList(out: string): { items: { id: string; tag?: string }[]; bad?: string } {
  const items: { id: string; tag?: string }[] = [];
  for (const { n, s } of linesOf(out)) {
    const [id, tag, ...extra] = s.split(/\s+/);
    if (!id || !ID.test(id) || extra.length || (tag !== undefined && !ID.test(tag))) return { items, bad: `line ${n} ${JSON.stringify(clip(s, 60))} is not "<id> <tag>"` };
    items.push({ id, ...(tag ? { tag } : {}) });
  }
  return { items };
}

function scanOne(res: Resource, recs: Instances[], timeout: number): Scan {
  const base = { resource: res.name, at: nowIso(), orphans: [] as Orphan[], inUse: 0, untagged: 0 };
  const ran = run(res.commands!.list!, { resource: res.name }, timeout);
  if (!ran.ok) return { ...base, status: "failed", why: `listing failed: ${ran.why}` };
  const { items, bad } = parseList(ran.out);
  if (bad) return { ...base, status: "failed", why: `listing not understood: ${bad}` };
  const mine = recs.filter((r) => r.resource === res.name);
  if (!items.length) {
    const n = mine.reduce((s, r) => s + (r.status === "ended" ? 0 : unstopped(r).length), 0);
    if (n) return { ...base, status: "unconfirmed", why: `the list command printed nothing, but govern started ${plural(n, "instance")} that it has no record of stopping (govern down <tag> --forget when they are gone)` };
    return { ...base, status: "ok" };
  }
  const byTag = new Map(mine.map((r) => [r.tag, r]));
  const out = { ...base };
  for (const it of items) {
    const rec = it.tag === undefined ? undefined : byTag.get(it.tag);
    if (!rec) { out.untagged++; continue; }
    if (!looksLikeId(it.id)) return { ...base, status: "failed", why: `listing shows ${JSON.stringify(clip(it.id, 60))} under govern's tag ${rec.tag}, which does not look like an instance id: nothing stopped` };
    if (inUse(rec, res.name)) { out.inUse++; continue; }
    out.orphans.push({ id: it.id, tag: rec.tag, since: rec.startedAt, ...(rec.lane ? { lane: rec.lane } : {}), ...(rec.stopped?.includes(it.id) ? { again: true as const } : {}) });
  }
  return { ...out, status: "ok" };
}

/** The resources with a list command (`names`: just those, each of which must have one). */
function listable(names: string[]): Resource[] {
  if (names.length) return names.map((n) => { const r = resourceNamed(n); if (!r.commands?.list) fail(`${r.name} has no list command (govern.config.json: resources[].commands.list)`); return r; });
  return Object.values(resources()).filter((r) => r.commands?.list);
}

/** The last orphan-scan results per resource from the state folder's reap-scan.json; [] when there is none, and fails
 *  when the file does not match its shape. */
export function readScan(): Scan[] {
  const f = scanFile();
  return existsSync(f) ? parseFile(f, readFileSync(f, "utf8"), SCANS).results : [];
}
/** Keep the other resources' last results, replace these. */
export function writeScan(fresh: Scan[]): void {
  withScanLock(() => writeScanLocked(fresh));
}
const withScanLock = <T>(f: () => T): T => locks.withMutex(join(stateDir(), "locks", "reap-scan"), f);
function writeScanLocked(fresh: Scan[]): void {
  let old: Scan[] = [];
  try { old = readScan(); } catch (e) { if (!(e instanceof GovernError)) throw e; }
  const names = new Set(fresh.map((s) => s.resource)), live = new Set(Object.keys(resources()));
  writeJson(scanFile(), { results: [...old.filter((s) => !names.has(s.resource) && live.has(s.resource)), ...fresh] });
}
/** Keep the last scan honest after a stop: the instances `ids` of `tag` are no longer shown as running. */
function forgetOrphans(tag: string, ids: string[]): void {
  withScanLock(() => {
    let old: Scan[];
    try { old = readScan(); } catch (e) { if (e instanceof GovernError) return; throw e; }
    if (old.length) writeJson(scanFile(), { results: old.map((s) => ({ ...s, orphans: s.orphans.filter((x) => !(x.tag === tag && ids.includes(x.id))) })) });
  });
}

/** List only: what each resource's list command shows, written to state. This is all the dispatcher ever does. */
export function scan(names: string[], timeout: number): Scan[] {
  const recs = instances();
  const results = listable(names).map((r) => scanOne(r, recs, timeout));
  writeScan(results);
  return results;
}

const age = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** `govern reap`: the listing's report, and with `yes` the stop of what it shows. Problems are failures (exit 1). */
export function reap(names: string[], o: { yes: boolean; timeout: number }): { lines: string[]; problems: string[] } {
  const results = scan(names, o.timeout);
  const lines: string[] = [], problems: string[] = [];
  let shown = 0;
  for (const s of results) {
    if (s.status !== "ok") { problems.push(`${s.resource}: ${s.why}`); continue; }
    if (!s.orphans.length) lines.push(`${s.resource}: nothing to reap${s.inUse ? ` (${s.inUse} in use)` : ""}`);
    else {
      lines.push(`${s.resource}: ${plural(s.orphans.length, "instance")} running with no job${s.inUse ? ` (${s.inUse} in use)` : ""}`);
      for (const x of s.orphans) lines.push(`  ${x.id} ${x.tag}  ${x.lane ? `lane ${x.lane}, ` : ""}up ${age(x.since)}${x.again ? " (stopped earlier, but still listed)" : ""}`);
      shown += s.orphans.length;
    }
    if (s.untagged) lines.push(`  ${plural(s.untagged, "listed instance")} carry${s.untagged === 1 ? "es" : ""} no tag govern issued: not touched`);
  }
  if (!o.yes) { if (shown) lines.push("not stopped: pass --yes to stop them"); return { lines, problems }; }
  const left: Scan[] = [];
  for (const s of results.filter((x) => x.status === "ok" && x.orphans.length)) {
    const res = resourceNamed(s.resource);
    const argv = res.commands?.stop;
    const failedIds = new Set<string>();
    const tags = [...new Set(s.orphans.map((x) => x.tag))];
    for (const tag of tags) withTag(tag, () => {
      const rec = instances().find((r) => r.tag === tag); // re-read under the lock: a concurrent down may have stopped some
      const done: string[] = [];
      for (const x of s.orphans.filter((y) => y.tag === tag)) {
        if (!rec) { problems.push(`${x.id}: record of ${tag} is gone; left running`); failedIds.add(x.id); continue; }
        if (!argv) { problems.push(`${s.resource}: has no stop command; ${x.id} left running`); failedIds.add(x.id); continue; }
        if (rec.stopped?.includes(x.id) && !x.again) { lines.push(`  ${x.id} was stopped meanwhile by another govern`); continue; }
        const use = inUse(rec, s.resource); // and again right before the stop: the scan may be minutes old
        if (use) { lines.push(`  skipped ${x.id}: in use now (${use})`); continue; }
        const r = run(argv, stopVars(rec, x.id), o.timeout);
        if (r.ok) { lines.push(`  stopped ${x.id}`); done.push(x.id); } else { problems.push(`could not stop ${x.id}: ${r.why}`); failedIds.add(x.id); }
      }
      if (rec && done.length) settle(rec, done, "reap");
    });
    left.push({ ...s, orphans: s.orphans.filter((x) => failedIds.has(x.id)) });
  }
  writeScan(left);
  return { lines, problems };
}

/** The desk's lines about the last listing: instances running with no job, and listings that could not be trusted. */
export function deskLines(): string[] {
  const L: string[] = [];
  const scans = readScan();
  const n = scans.reduce((s, x) => s + x.orphans.length, 0);
  const oldest = scans.map((s) => s.at).sort()[0];
  if (n) L.push(`  ${plural(n, "instance")} running with no job (listed ${oldest ? age(oldest) : "?"} ago; govern reap)`);
  for (const s of scans) if (s.status !== "ok") L.push(`  instance listing failed for ${s.resource}: ${s.why?.replace(/^listing failed: /, "")} (${age(s.at)} ago; govern reap)`);
  return L;
}
