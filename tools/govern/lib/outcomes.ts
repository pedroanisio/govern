// Business outcomes: what became of each case, read from the lane and its ledger, and summed per process revision (or
// canary arm) by `govern metrics`. The ledger already says what was spent and who acted; this says whether the work was
// right: the case was concluded correctly, its customer was not harmed, no exception was left without a destination, and
// how long it took. Correctness and customer impact come from the process's declared boolean fields (`outcomes`) or
// from a later `govern outcome` entry, which wins: a complaint can arrive after the case closed.
import { userInfo } from "node:os";
import { load, laneSlugs, appendLedger, ledgerFile, type Project } from "./project.ts";
import { processName, processOf } from "./process.ts";
import { readJsonl } from "./util.ts";

/** One case's outcome. `exceptions`: stages that gave up (drive-failed); `unrouted`: those left with no destination.
 *  `humanTouches`: approvals, rejections, completed human tasks and recoveries. `moved`: money charged, by currency. */
export interface LaneOutcome {
  slug: string; process: string; revision: number; arm?: "candidate" | "base"; canary?: string;
  created: string; finished?: string; seconds?: number;
  correct?: boolean; customerImpact?: boolean;
  exceptions: number; unrouted: number; humanTouches: number; agentTasks: number;
  moved: Record<string, number>;
}

const HUMAN_KINDS = new Set(["approve", "reject", "human-complete", "recover"]);

/** The outcome of lane `p`, from its state and ledger. */
export function laneOutcome(p: Project): LaneOutcome {
  const ledger = readJsonl(ledgerFile(p.slug));
  let revision = p.processSnapshot?.revision ?? 1, declared: { correct?: string; customerImpact?: string } = {};
  try { const pr = processOf(p); revision = p.processSnapshot?.revision ?? pr.revision ?? 1; declared = pr.outcomes ?? {}; } catch { /* a process since removed: counted with what the lane holds */ }
  const field = (f: string | undefined) => { const v = f ? p.data?.[f] : undefined; return typeof v === "boolean" ? v : undefined; };
  let correct = field(declared.correct), customerImpact = field(declared.customerImpact);
  for (const e of ledger) if (e.kind === "outcome") {
    if (typeof e.correct === "boolean") correct = e.correct;
    if (typeof e.customerImpact === "boolean") customerImpact = e.customerImpact;
  }
  const failed = ledger.filter((e) => e.kind === "drive-failed"), moved: Record<string, number> = {};
  for (const e of ledger) if (e.kind === "drive-money" && e.charged === true && typeof e.amount === "number" && typeof e.currency === "string")
    moved[e.currency] = Math.round(((moved[e.currency] ?? 0) + e.amount) * 100) / 100;
  return {
    slug: p.slug, process: processName(p), revision,
    ...(p.canary ? { arm: p.canary.arm, canary: p.canary.id } : {}),
    created: p.created, ...(p.finished ? { finished: p.finished, seconds: Math.max(0, Math.round((Date.parse(p.finished) - Date.parse(p.created)) / 1000)) } : {}),
    ...(correct !== undefined ? { correct } : {}), ...(customerImpact !== undefined ? { customerImpact } : {}),
    exceptions: failed.length, unrouted: failed.filter((e) => typeof e.routed !== "string").length,
    humanTouches: ledger.filter((e) => HUMAN_KINDS.has(e.kind)).length,
    agentTasks: ledger.filter((e) => e.kind === "drive-sent").length, moved,
  };
}

/** `govern outcome`: record what became of a case after the fact (an agent that reconciled it, a complaint that came in).
 *  The latest entry wins over the declared fields. Returns the lane's outcome after it. */
export function recordOutcome(slug: string, o: { correct?: boolean; customerImpact?: boolean; note?: string; by?: string }): LaneOutcome {
  const p = load(slug);
  appendLedger(p.slug, { kind: "outcome", ...(o.correct !== undefined ? { correct: o.correct } : {}),
    ...(o.customerImpact !== undefined ? { customerImpact: o.customerImpact } : {}), ...(o.note ? { note: o.note } : {}), by: o.by ?? userInfo().username });
  return laneOutcome(p);
}

/** A group of cases summed: how many, how many finished, the share judged correct (of those judged), customer harm,
 *  exceptions, cases a person touched, and the duration of the finished ones (median and 90th percentile, seconds). */
export interface Summary {
  key: string; lanes: number; finished: number;
  judged: number; correct: number; correctRate?: number;
  impacted: number; impactRate: number;
  exceptions: number; exceptionRate: number; unrouted: number;
  touched: number; touchedRate: number;
  p50Seconds?: number; p90Seconds?: number; agentTasks: number; moved: Record<string, number>;
}

const pct = (xs: number[], q: number): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const rate = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : 0);

/** `rows` summed under `key`. Rates are over every case, except the correct rate (over the cases judged). */
export function summarize(key: string, rows: LaneOutcome[]): Summary {
  const judged = rows.filter((r) => r.correct !== undefined), correct = judged.filter((r) => r.correct).length;
  const impacted = rows.filter((r) => r.customerImpact === true).length, excepted = rows.filter((r) => r.exceptions > 0).length;
  const touched = rows.filter((r) => r.humanTouches > 0).length, secs = rows.flatMap((r) => (r.seconds !== undefined ? [r.seconds] : []));
  const moved: Record<string, number> = {};
  for (const r of rows) for (const [c, v] of Object.entries(r.moved)) moved[c] = Math.round(((moved[c] ?? 0) + v) * 100) / 100;
  const p50 = pct(secs, 0.5), p90 = pct(secs, 0.9);
  return {
    key, lanes: rows.length, finished: rows.filter((r) => r.finished).length,
    judged: judged.length, correct, ...(judged.length ? { correctRate: rate(correct, judged.length) } : {}),
    impacted, impactRate: rate(impacted, rows.length),
    exceptions: rows.reduce((t, r) => t + r.exceptions, 0), exceptionRate: rate(excepted, rows.length), unrouted: rows.reduce((t, r) => t + r.unrouted, 0),
    touched, touchedRate: rate(touched, rows.length),
    ...(p50 !== undefined ? { p50Seconds: p50 } : {}), ...(p90 !== undefined ? { p90Seconds: p90 } : {}),
    agentTasks: rows.reduce((t, r) => t + r.agentTasks, 0), moved,
  };
}

/** The outcomes of process `name`'s cases: every lane of it but replays, created at or after `since`. A lane that cannot
 *  be read is skipped. */
export function outcomesOf(name: string, o: { since?: string } = {}): LaneOutcome[] {
  const out: LaneOutcome[] = [];
  for (const slug of laneSlugs()) {
    let p: Project;
    try { p = load(slug); } catch { continue; }
    if (processName(p) !== name || p.replay) continue;
    if (o.since && Date.parse(p.created) < Date.parse(o.since)) continue;
    out.push(laneOutcome(p));
  }
  return out;
}

/** `govern metrics`: process `name`'s outcomes summed per revision (or per canary arm), newest revision first. */
export function metrics(name: string, o: { since?: string; by?: "revision" | "arm" } = {}): Summary[] {
  const rows = outcomesOf(name, o), groups = new Map<string, LaneOutcome[]>();
  for (const r of rows) {
    const k = o.by === "arm" ? (r.arm ? `${r.canary}:${r.arm}` : "none") : `revision ${r.revision}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })).map(([k, rs]) => summarize(k, rs));
}

/** One summary as a line of text. */
export function summaryLine(s: Summary): string {
  const t = (x?: number) => (x === undefined ? "-" : x < 3600 ? `${Math.round(x / 60)}m` : `${(x / 3600).toFixed(1)}h`);
  const money = Object.entries(s.moved).map(([c, v]) => `${v} ${c}`).join(", ");
  return `${s.key}: ${s.lanes} cases, ${s.finished} finished; correct ${s.correctRate === undefined ? "-" : `${Math.round(s.correctRate * 100)}% of ${s.judged} judged`}; ` +
    `customer harmed ${s.impacted}; exceptions ${s.exceptions} (${s.unrouted} with no destination); touched by a person ${Math.round(s.touchedRate * 100)}%; ` +
    `time p50 ${t(s.p50Seconds)}, p90 ${t(s.p90Seconds)}; agent tasks ${s.agentTasks}${money ? `; moved ${money}` : ""}`;
}
