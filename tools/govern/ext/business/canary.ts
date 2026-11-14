// `govern canary` (BUSINESS.md "Canary revisions"): a new revision of a process gets a share of the new cases, is judged
// against the cases the current revision got meanwhile, and is promoted (its definition becomes the process file) or
// reverted, with no person when it changes only how agents are told and how stages retry. lib/canary.ts holds the
// state and assigns new cases to an arm.
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { getProcess, parseProcess, extraDir, freezeProcess, snapshotProcess, type Process } from "../../lib/process.ts";
import { readCanary, writeCanary, canaryLog, canaryDir, type Canary } from "../../lib/canary.ts";
import { outcomesOf, summarize, type Summary } from "../../lib/outcomes.ts";
import { verifyQuote } from "../../lib/approval.ts";
import { fail, usage, nowIso } from "../../lib/util.ts";

/** What a candidate may change and still be a heuristic change (no person needed): what an agent is told, which agent
 *  and profile does it, its files and time, and how a stage retries. Anything else (fields, routes, gates, policies,
 *  people, what a stage outputs, its checks, a service's command or money) is policy. */
const HEURISTIC = [
  /^\$\.(description|revision|manual)$/,
  /^\$\.stages\[\d+\]\.agent\.(summary|body|to|profile|files|timeout|attempts)(\[\d+\])?$/,
  /^\$\.stages\[\d+\]\.service\.(attempts|backoffSeconds|recoveries|poll)$/,
];
/** Without a person's words, a canary is held to these: at most half the cases, at least 10 judged, a 10-point tolerance. */
export const UNATTENDED = { fraction: 0.5, min: 10, tolerance: 0.1 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The JSON paths where `a` and `b` differ: a key added, removed or changed, an array of another length (the array's own
 *  path), or an element changed. */
export function differences(a: unknown, b: unknown, at = "$"): string[] {
  if (isObj(a) && isObj(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => differences(a[k], b[k], `${at}.${k}`));
  if (Array.isArray(a) && Array.isArray(b)) return a.length !== b.length ? [at] : a.flatMap((x, i) => differences(x, b[i], `${at}[${i}]`));
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

/** What `candidate` changes from `base`, and whether any of it is policy. */
export function changeKind(base: Process, candidate: Process): { kind: "heuristic" | "policy"; changes: string[]; policy: string[] } {
  const strip = ({ dir: _d, ...rest }: Process) => rest;
  const changes = differences(strip(base), strip(candidate)), policy = changes.filter((c) => !HEURISTIC.some((r) => r.test(c)));
  return { kind: policy.length ? "policy" : "heuristic", changes, policy };
}

/** `govern canary start`: give revision `file` of process `name` a share of the new cases. A policy change, or limits
 *  beyond UNATTENDED, need a person's quoted words. */
export function startCanary(name: string, file: string, o: { fraction?: number; min?: number; tolerance?: number; quote?: string }): Canary {
  const base = getProcess(name), running = readCanary(name);
  if (running?.status === "running") fail(`a canary of ${name} is running since ${running.started} (revision ${running.candidate.revision}): govern canary status ${name}`);
  const dir = extraDir() ?? fail("no workspace processes folder: a promoted candidate has nowhere to go");
  if (!existsSync(file)) fail(`${file}: no such file`);
  // Parsed as if it were the process file, so its relative paths (manual, prompts) resolve as they will once promoted.
  const candidate = parseProcess(join(dir, `${name}.json`), readFileSync(file, "utf8"));
  if (candidate.name !== name) fail(`${file} is process ${candidate.name}, not ${name}`);
  const from = base.revision ?? 1, to = candidate.revision ?? 1;
  if (to <= from) fail(`${file}: revision ${to} is not above the current revision of ${name} (${from}); raise "revision"`);
  const { kind, changes, policy } = changeKind(base, candidate);
  if (!changes.some((c) => c !== "$.revision")) fail(`${file} changes nothing but the revision`);
  const fraction = o.fraction ?? 0.1, min = o.min ?? 20, tolerance = o.tolerance ?? 0.05;
  if (!(fraction > 0 && fraction <= 1)) usage("--fraction must be above 0 and at most 1");
  if (!Number.isSafeInteger(min) || min < 1) usage("--min must be a whole number of cases, at least 1");
  if (!(tolerance >= 0 && tolerance < 1)) usage("--tolerance must be at least 0 and below 1");
  const beyond = [fraction > UNATTENDED.fraction ? `--fraction above ${UNATTENDED.fraction}` : "", min < UNATTENDED.min ? `--min below ${UNATTENDED.min}` : "",
    tolerance > UNATTENDED.tolerance ? `--tolerance above ${UNATTENDED.tolerance}` : ""].filter(Boolean);
  if (!o.quote && kind === "policy") fail(`${file} changes policy (${policy.slice(0, 8).join(", ")}${policy.length > 8 ? ", …" : ""}): a person starts this canary, with --quote "<their own words>"`, 1);
  if (!o.quote && beyond.length) fail(`${beyond.join(", ")}: beyond what a canary may do with no person; a person starts it, with --quote "<their own words>"`, 1);
  const source = o.quote ? verifyQuote(o.quote) : undefined;
  const c: Canary = {
    id: `${name}-r${to}-${Date.now().toString(36)}`, process: name, base: freezeProcess(base), candidate: freezeProcess(candidate),
    fraction, min, tolerance, kind, changes, started: nowIso(), by: userInfo().username, ...(source ? { source: { ...source, quote: o.quote } } : {}), status: "running",
  };
  writeCanary(c);
  canaryLog({ kind: "started", process: name, id: c.id, from, to, fraction, min, tolerance, change: kind, by: c.by });
  return c;
}

export type Decision = "promote" | "revert" | "continue";
export interface CanaryReport { canary: Canary; candidate: Summary; base: Summary; decision: Decision; reason: string }

/** The verdict on a running canary, from its two arms. Reverted at once: a candidate case harmed its customer, a candidate
 *  exception was left with no destination, or the process file changed under it. Then, once `min` candidate cases
 *  finished (and, when the process judges correctness, `min` were judged): reverted when the candidate's correct rate is
 *  more than `tolerance` below the base arm's (below 1 − tolerance when the base arm has none judged) or its exception
 *  rate more than `tolerance` above; promoted otherwise. */
export function verdict(c: Canary, cand: Summary, base: Summary, o: { judgesCorrect: boolean; baseChanged: boolean }): { decision: Decision; reason: string } {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  if (o.baseChanged) return { decision: "revert", reason: `the ${c.process} process file changed while the canary ran: its base is no longer the current revision` };
  if (cand.impacted) return { decision: "revert", reason: `${cand.impacted} candidate case${cand.impacted === 1 ? "" : "s"} harmed the customer` };
  if (cand.unrouted) return { decision: "revert", reason: `${cand.unrouted} candidate exception${cand.unrouted === 1 ? " was" : "s were"} left with no destination` };
  if (cand.finished < c.min) return { decision: "continue", reason: `${cand.finished} of ${c.min} candidate cases finished` };
  if (o.judgesCorrect) {
    if (cand.judged < c.min) return { decision: "continue", reason: `${cand.judged} of ${c.min} candidate cases judged` };
    const floor = (base.judged ? base.correctRate! : 1) - c.tolerance;
    if (cand.correctRate! < floor - 1e-9) return { decision: "revert", reason: `candidate correct ${pct(cand.correctRate!)}, below ${pct(floor)} (base ${base.judged ? pct(base.correctRate!) : "none judged"}, tolerance ${pct(c.tolerance)})` };
  }
  if (cand.exceptionRate > base.exceptionRate + c.tolerance + 1e-9)
    return { decision: "revert", reason: `candidate exceptions in ${pct(cand.exceptionRate)} of cases, above the base's ${pct(base.exceptionRate)} by more than ${pct(c.tolerance)}` };
  return { decision: "promote", reason: `${cand.finished} candidate cases finished${o.judgesCorrect ? `, correct ${pct(cand.correctRate!)} (base ${base.judged ? pct(base.correctRate!) : "none judged"})` : ""}, exceptions ${pct(cand.exceptionRate)} (base ${pct(base.exceptionRate)}), no customer harmed` };
}

/** The running canary of `name` judged: both arms' summaries and the verdict. */
export function canaryReport(name: string): CanaryReport {
  const c = readCanary(name) ?? fail(`${name} has no canary: govern canary start ${name} --file F`);
  const rows = outcomesOf(name).filter((r) => r.canary === c.id);
  const cand = summarize("candidate", rows.filter((r) => r.arm === "candidate")), base = summarize("base", rows.filter((r) => r.arm === "base"));
  if (c.status !== "running") return { canary: c, candidate: cand, base, decision: c.status === "promoted" ? "promote" : "revert", reason: c.reason ?? c.status };
  let baseChanged = false;
  try { baseChanged = freezeProcess(getProcess(name)).hash !== c.base.hash; } catch { baseChanged = true; }
  const judgesCorrect = !!snapshotProcess(c.candidate).outcomes?.correct;
  return { canary: c, candidate: cand, base, ...verdict(c, cand, base, { judgesCorrect, baseChanged }) };
}

/** The workspace file that holds process `name`, or where a new one goes. */
function processFile(name: string): string {
  const dir = extraDir() ?? fail("no workspace processes folder");
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json") && !x.endsWith(".candidate.json")).sort().reverse() : []) {
    try { if ((JSON.parse(readFileSync(join(dir, f), "utf8")) as { name?: unknown }).name === name) return join(dir, f); } catch { /* not this one */ }
  }
  return join(dir, `${name}.json`);
}

/** End canary `c`: promoted (the candidate's definition becomes the process file, the old one kept in the canary folder)
 *  or reverted. */
function end(c: Canary, status: "promoted" | "reverted", reason: string, by: string, extra: Record<string, unknown> = {}): Canary {
  if (status === "promoted") {
    const file = processFile(c.process), keep = join(canaryDir(), `${c.process}.r${c.base.revision}.json`);
    if (existsSync(file)) writeFileSync(keep, readFileSync(file), { mode: 0o600 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(JSON.parse(c.candidate.definition), null, 2) + "\n");
    renameSync(tmp, file);
    const pending = join(extraDir()!, `${c.process}.candidate.json`);
    if (existsSync(pending)) renameSync(pending, join(canaryDir(), `${c.process}.r${c.candidate.revision}.candidate.json`));
  }
  const done: Canary = { ...c, status, ended: nowIso(), reason, ...extra };
  writeCanary(done);
  canaryLog({ kind: status, process: c.process, id: c.id, revision: c.candidate.revision, reason, by });
  return done;
}

/** `govern canary check`: apply the verdict. Exit 0 promoted, 65 reverted, 75 not yet (a polling service asks again). */
export function checkCanary(name: string): { code: 0 | 65 | 75; text: string } {
  const r = canaryReport(name), c = r.canary, rev = c.candidate.revision;
  if (c.status === "promoted") return { code: 0, text: `${name}: revision ${rev} was promoted (${c.reason})` };
  if (c.status === "reverted") return { code: 65, text: `${name}: revision ${rev} was reverted: ${c.reason}` };
  if (r.decision === "continue") return { code: 75, text: `${name}: revision ${rev} canary continues: ${r.reason}` };
  end(c, r.decision === "promote" ? "promoted" : "reverted", r.reason, userInfo().username);
  return r.decision === "promote"
    ? { code: 0, text: `${name}: revision ${rev} promoted: ${r.reason}` }
    : { code: 65, text: `${name}: revision ${rev} reverted: ${r.reason}` };
}

/** `govern canary stop`: a person reverts the running canary of `name`. */
export function stopCanary(name: string, quote: string): Canary {
  const c = readCanary(name);
  if (!c || c.status !== "running") fail(`${name} has no running canary`);
  const source = verifyQuote(quote);
  return end(c, "reverted", `stopped by ${userInfo().username}: ${quote}`, userInfo().username, { stoppedBy: { ...source, quote } });
}

/** A report as text. */
export function reportText(r: CanaryReport): string {
  const c = r.canary, s = (x: Summary) => `${x.lanes} cases, ${x.finished} finished, correct ${x.correctRate === undefined ? "-" : `${Math.round(x.correctRate * 100)}% of ${x.judged}`}, harmed ${x.impacted}, exceptions ${x.exceptions} (${x.unrouted} with no destination)`;
  return [`${c.process}: canary ${c.id} (${c.status}), revision ${c.base.revision} → ${c.candidate.revision}, ${c.kind} change, ${Math.round(c.fraction * 100)}% of new cases, judged after ${c.min}, tolerance ${Math.round(c.tolerance * 100)}%`,
    `  candidate: ${s(r.candidate)}`, `  base:      ${s(r.base)}`, `  ${c.status === "running" ? `verdict: ${r.decision}` : c.status}: ${r.reason}`].join("\n");
}
