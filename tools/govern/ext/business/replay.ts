// `govern replay` (BUSINESS.md "Replaying past cases"): run past finished cases of a process again on a candidate
// definition, without effects (lib/replay.ts), and compare what the candidate concluded with what the original did,
// before the candidate gets real cases in a canary.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { create, load, laneSlugs, ledgerFile, checkSlug, REPLAY_PREFIX, type Project } from "../../lib/project.ts";
import { getProcess, parseProcess, extraDir, freezeProcess, snapshotProcess, processName, processOf, type Process } from "../../lib/process.ts";
import { readReplay, writeReplay, replayByKey, type Replay, type ReplayCase } from "../../lib/replay.ts";
import { fail, usage, nowIso, readJsonl } from "../../lib/util.ts";
import type { Value } from "../../lib/business-schema.ts";

const ESCALATIONS = new Set(["approve", "reject", "human-complete"]);

/** The fields an agent or a command of `pr` writes. */
const outputFields = (pr: Process): Set<string> =>
  new Set(pr.stages.flatMap((s) => [...(s.agent?.outputs ?? []), ...(s.service?.outputs ?? [])]));

/** What a case was made with: its recorded intake, or (a case older than that record) its final data less every field
 *  a stage of its process writes. */
function intakeOf(p: Project): Record<string, Value> {
  if (p.intake) return { ...p.intake };
  const outs = outputFields(processOf(p));
  return Object.fromEntries(Object.entries(p.data ?? {}).filter(([k]) => !outs.has(k)));
}

/** `govern replay start`: replay process `name`'s most recently finished cases (or `lanes`) on revision `file` (default
 *  the current definition). Each gets a lane `replay/<run>/<case>`; `govern drive` moves them on. */
export function startReplay(name: string, o: { file?: string; cases?: number; since?: string; lanes?: string[]; key?: string } = {}): Replay {
  const again = o.key ? replayByKey(o.key) : undefined;
  if (again) return again;
  let candidate = getProcess(name);
  if (o.file) {
    if (!existsSync(o.file)) fail(`${o.file}: no such file`);
    // Parsed as if it were the process file, so its relative paths resolve as they would once promoted.
    candidate = parseProcess(join(extraDir() ?? dirname(o.file), `${name}.json`), readFileSync(o.file, "utf8"));
    if (candidate.name !== name) fail(`${o.file} is process ${candidate.name}, not ${name}`);
  }
  const n = o.cases ?? 20;
  if (!Number.isSafeInteger(n) || n < 1) usage("--cases must be a whole number, at least 1");
  if (o.since !== undefined && Number.isNaN(Date.parse(o.since))) usage("--since must be an ISO date");
  let originals: Project[];
  if (o.lanes?.length) {
    originals = o.lanes.map((l) => {
      const p = load(checkSlug(l));
      if (p.replay) fail(`${p.slug} is itself a replay`);
      if (processName(p) !== name) fail(`${p.slug} is a case of ${processName(p)}, not ${name}`);
      if (!p.finished) fail(`${p.slug} has not finished: only a finished case can be replayed`);
      return p;
    });
  } else {
    originals = laneSlugs().flatMap((s) => { try { return [load(s)]; } catch { return []; } })
      .filter((p) => processName(p) === name && p.finished && (!o.since || Date.parse(p.created) >= Date.parse(o.since)))
      .sort((a, b) => Date.parse(b.finished!) - Date.parse(a.finished!)).slice(0, n);
  }
  if (!originals.length) fail(`no finished case of ${name} to replay${o.since ? ` since ${o.since}` : ""}`);
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-").replace(/Z$/, "");
  const id = `${name}-${stamp}-${randomBytes(2).toString("hex")}`, snapshot = freezeProcess(candidate);
  const cases: ReplayCase[] = originals.map((orig) => {
    const ledger = readJsonl(ledgerFile(orig.slug));
    const rec: ReplayCase = {
      slug: `${REPLAY_PREFIX}${id}/${orig.slug.replace(/\//g, "__")}`, of: orig.slug, data: { ...(orig.data ?? {}) },
      completed: [...new Set(ledger.filter((e) => e.kind === "advance" && typeof e.from === "string").map((e) => e.from as string))],
      escalated: ledger.some((e) => ESCALATIONS.has(e.kind as string)),
    };
    try {
      create(rec.slug, { process: name, ...(candidate.kinds ? { kind: orig.kind } : {}), title: `replay of ${orig.slug}`, lang: orig.lang,
        data: intakeOf(orig), snapshot, replay: { run: id, of: orig.slug } });
    } catch (e) { rec.refused = (e as Error).message; }
    return rec;
  });
  const r: Replay = { id, process: name, revision: candidate.revision ?? 1, candidate: snapshot, ...(o.file ? { file: o.file } : {}),
    ...(o.key ? { key: o.key } : {}), started: nowIso(), by: userInfo().username, cases };
  writeReplay(r);
  return r;
}

/** Where a replayed case stands: still running; finished; stopped where a person or the world outside would be needed
 *  (escalated); diverged from the original (it needed an effect the original never had); failed with no destination;
 *  or refused (its lane could not be made). */
export type ReplayStatus = "running" | "finished" | "escalated" | "diverged" | "failed" | "refused";

/** One replayed case against its original. `differs`: the compared fields whose values are not the original's. */
export interface CaseResult {
  slug: string; of: string; status: ReplayStatus; why?: string; stage?: string;
  compared: string[]; differs: { field: string; original?: Value; replay?: Value }[];
  originalEscalated: boolean;
}

/** A replay run judged. `agreement`: the share of decided cases (finished with a compared field, or failed) whose every
 *  compared field equals the original's. `moreEscalated`: the replay stopped for a person the original did without;
 *  `lessEscalated`: the replay finished with no person where the original had one. It passes with no case running, at
 *  least one decided, agreement at or above `min`, no divergence and nothing escalated less. */
export interface ReplayReport {
  id: string; process: string; revision: number; fields: string[]; min: number;
  counts: Record<ReplayStatus, number>; decided: number; agreeing: number; agreement?: number;
  moreEscalated: number; lessEscalated: number; verdict: "pass" | "fail" | "running"; cases: CaseResult[];
}

/** `govern replay report`: judge replay run `id`, comparing `fields` (default: the fields the candidate's agents write that
 *  the originals hold). */
export function replayReport(id: string, o: { fields?: string[]; min?: number } = {}): ReplayReport {
  const r = readReplay(id), min = o.min ?? 0.9;
  if (!(min >= 0 && min <= 1)) usage("--min must be between 0 and 1");
  const candidate = snapshotProcess(r.candidate);
  const agentOuts = candidate.stages.flatMap((s) => s.agent?.outputs ?? []);
  const fields = o.fields?.length ? o.fields : [...new Set(agentOuts)].filter((f) => r.cases.some((c) => c.data[f] !== undefined));
  const counts: Record<ReplayStatus, number> = { running: 0, finished: 0, escalated: 0, diverged: 0, failed: 0, refused: 0 };
  let decided = 0, agreeing = 0, moreEscalated = 0, lessEscalated = 0;
  const cases = r.cases.map((c): CaseResult => {
    const res: CaseResult = { slug: c.slug, of: c.of, status: "running", compared: [], differs: [], originalEscalated: c.escalated };
    let p: Project | undefined;
    if (c.refused) { res.status = "refused"; res.why = c.refused; }
    else {
      try { p = load(c.slug); } catch (e) { res.status = "failed"; res.why = (e as Error).message; }
    }
    if (p) {
      const ledger = readJsonl(ledgerFile(c.slug)), stop = ledger.find((e) => e.kind === "replay-stopped");
      const unrouted = ledger.filter((e) => e.kind === "drive-failed" && typeof e.routed !== "string").at(-1);
      if (stop) { res.status = stop.diverged ? "diverged" : "escalated"; res.why = String(stop.why); res.stage = String(stop.stage); }
      else if (p.finished) res.status = "finished";
      else if (unrouted) { res.status = "failed"; res.why = String(unrouted.reason); res.stage = String(unrouted.stage); }
      for (const f of fields) {
        if (c.data[f] === undefined) continue;
        res.compared.push(f);
        const mine = p.data?.[f];
        if (JSON.stringify(mine) !== JSON.stringify(c.data[f])) res.differs.push({ field: f, original: c.data[f], ...(mine !== undefined ? { replay: mine } : {}) });
      }
    }
    counts[res.status]++;
    if (res.status === "escalated" && !c.escalated) moreEscalated++;
    if (res.status === "finished" && c.escalated) lessEscalated++;
    if ((res.status === "finished" && res.compared.length) || res.status === "failed") {
      decided++;
      if (res.status === "finished" && !res.differs.length) agreeing++;
    }
    return res;
  });
  const agreement = decided ? Math.round((agreeing / decided) * 1000) / 1000 : undefined;
  const verdict = counts.running ? "running"
    : decided && agreement! >= min && !counts.diverged && !lessEscalated ? "pass" : "fail";
  return { id, process: r.process, revision: r.revision, fields, min, counts, decided, agreeing, ...(agreement !== undefined ? { agreement } : {}),
    moreEscalated, lessEscalated, verdict, cases };
}

/** A report as text: the verdict, the counts, then each case that did not simply agree. */
export function replayText(rep: ReplayReport): string {
  const c = rep.counts, L = [
    `replay ${rep.id} of ${rep.process} revision ${rep.revision}: ${rep.verdict}`,
    `  ${rep.cases.length} cases: ${c.finished} finished, ${c.escalated} escalated, ${c.diverged} diverged, ${c.failed} failed, ${c.running} running, ${c.refused} refused`,
    `  agreement ${rep.agreement === undefined ? "-" : `${Math.round(rep.agreement * 100)}%`} of ${rep.decided} decided (at least ${Math.round(rep.min * 100)}%) on ${rep.fields.join(", ") || "no field"}`,
    `  escalated more than the original ${rep.moreEscalated}; less ${rep.lessEscalated}`,
  ];
  for (const k of rep.cases) {
    if (k.status === "finished" && !k.differs.length) continue;
    const d = k.differs.map((x) => `${x.field} ${JSON.stringify(x.original)} → ${x.replay === undefined ? "none" : JSON.stringify(x.replay)}`).join("; ");
    L.push(`  ${k.of}: ${k.status}${k.stage ? ` at ${k.stage}` : ""}${k.why ? `: ${k.why}` : ""}${d ? ` (${d})` : ""}`);
  }
  return L.join("\n");
}

/** The exit code of a report, for a polling service stage: 0 pass, 65 fail, 75 still running. */
export const replayExit = (rep: ReplayReport): number => (rep.verdict === "pass" ? 0 : rep.verdict === "running" ? 75 : 65);
