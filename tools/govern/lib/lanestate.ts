// The live state of a lane (a project) as one small, typed summary: where it stands in its process, what each gate
// decided, what each check last said, which jobs run and which BLOCKED messages wait, and one derived status. Read
// only: it loads govern.json, the lane's ledger, its job records and the queue, and writes nothing. The summary is also
// what a host sends to the command center (ext/peer/peer.ts, "govern-lanes/1"), so its shape is closed and parsed.
import { GovernError, readJsonl, clip } from "./util.ts";
import { obj, arr, bool, literal, reject, type Shape } from "./shape.ts";
import { load, laneSlugs, ledgerFile, stagesOf, type Project } from "./project.ts";
import { processOf, freezeProcess } from "./process.ts";
import { gateApproved, activeStages } from "./business.ts";
import * as jobs from "./jobs.ts";
import * as queue from "./queue.ts";

/** Stage drift (jobs, notes and asks since the last advance, and the warning thresholds) is computed in project.ts, which the brief also uses. */
export { stageDrift as drift, driftWarning, DRIFT_MIN_ENTRIES, DRIFT_MIN_HOURS, type Drift } from "./project.ts";

export const STATUSES =["running", "waiting-on-owner", "waiting-on-coordinator", "blocked-by-check", "idle", "done"] as const;
export type Status = (typeof STATUSES)[number];
export const MARKS = ["done", "current", "blocked", "todo"] as const;
export type Mark = (typeof MARKS)[number];
export const DECISIONS = ["approved", "rejected", "pending", "waiting"] as const;
export type Decision = (typeof DECISIONS)[number];

/** A gate's standing for this lane. `pending`: its stage is active and the gates it needs are approved, so it can be
 *  decided now; `waiting`: not yet reachable. `by`, `at` and `quote` are the recorded decision (approval or rejection). */
export interface GateState { name: string; stage?: string; owner: string; decision: Decision; needs: string[]; by?: string; at?: string; quote?: string }
/** A checked stage's last recorded run: `ok` and `at` absent when it never ran; `failure` is the first failing line of its log. */
export interface CheckState { stage: string; command: string; ok?: boolean; at?: string; exit?: number; failure?: string }
export interface JobRef { id: string; name: string; start: string }
export interface BlockedMessage { id: string; from: string; to: string; summary: string; created: string }
export interface ProcessRef { name: string; revision: number; hash: string }
export interface LaneState {
  slug: string; title: string; kind: string; process: ProcessRef;
  stage: string; stageIndex: number; stageTotal: number; finished?: string;
  stages: { name: string; mark: Mark }[];
  gates: GateState[]; checks: CheckState[];
  jobs: JobRef[]; blocked: BlockedMessage[]; waitingOn: string[];
  lastActivity: string; status: Status;
}

const count: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a whole number, 0 or more"));
const stamp: Shape<string> = (v, p) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : reject(p, "must be a timestamp"));
const text = (n: number): Shape<string> => (v, p) => (typeof v === "string" && v.length <= n ? v : reject(p, `must be a string of at most ${n} characters`));
const label = text(200);
const GATE: Shape<GateState> = obj({ name: label, owner: label, decision: literal(...DECISIONS), needs: arr(label) }, { stage: label, by: label, at: stamp, quote: text(400) }) as Shape<GateState>;
const CHECK: Shape<CheckState> = obj({ stage: label, command: label }, { ok: bool, at: stamp, exit: count, failure: text(400) }) as Shape<CheckState>;
/** The closed shape of one lane summary: a command center parses a remote host's answer with it. */
export const LANE_STATE: Shape<LaneState> = obj({
  slug: label, title: label, kind: label, process: obj({ name: label, revision: count, hash: label }),
  stage: label, stageIndex: count, stageTotal: count,
  stages: arr(obj({ name: label, mark: literal(...MARKS) })), gates: arr(GATE), checks: arr(CHECK),
  jobs: arr(obj({ id: label, name: label, start: stamp })),
  blocked: arr(obj({ id: label, from: label, to: label, summary: text(240), created: stamp })), waitingOn: arr(label),
  lastActivity: stamp, status: literal(...STATUSES),
}, { finished: stamp }) as Shape<LaneState>;

const FAILURE = /fail|error|gap|missing|not verified|unreachable|refus|must|✗|✖/i;
/** The first line of a failed check's log that says what failed; its last line when none does; undefined without a log. */
function firstFailure(slug: string, job: string | undefined): string | undefined {
  if (!job) return undefined;
  try {
    const lines = jobs.tail(slug, job, 400);
    return clip(lines.find((l) => FAILURE.test(l)) ?? lines.at(-1) ?? "", 300) || undefined;
  } catch { return undefined; }
}

/** The processes' reference for a lane: its name, revision and the hash of the definition it runs (its frozen snapshot, else the current file). */
const hashes = new Map<string, string>();
function refOf(p: Project): ProcessRef {
  const pr = processOf(p);
  if (p.processSnapshot) return { name: pr.name, revision: p.processSnapshot.revision, hash: p.processSnapshot.hash };
  const key = `${pr.name}@${pr.dir}@${pr.revision ?? 1}@${JSON.stringify(pr.stages).length}`;
  let h = hashes.get(key);
  if (!h) { h = freezeProcess(pr).hash; hashes.set(key, h); }
  return { name: pr.name, revision: pr.revision ?? 1, hash: h };
}

/** How long an open `work` segment with no job counts as someone working on the lane (ms). */
export const WORK_FRESH_MS = 2 * 3600_000;

/** The summary of lane `p` at `now` (ms). `msgs` is the queue's messages (read once for many lanes). */
export function summarize(p: Project, o: { now: number; msgs?: ReturnType<typeof queue.all> }): LaneState {
  const pr = processOf(p), list = stagesOf(p), led = readJsonl(ledgerFile(p.slug));
  const active = activeStages(p);
  const idx = list.indexOf(p.stage);
  // checks: the stage's last recorded run
  const checks: CheckState[] = [];
  for (const s of pr.stages) {
    const command = p.checks?.[s.name] ?? s.check;
    if (!command) continue;
    const last = [...led].reverse().find((e) => e.kind === "check" && e.stage === s.name);
    checks.push({ stage: s.name, command, ...(last ? { ok: last.ok === true, at: String(last.t), ...(typeof last.exit === "number" ? { exit: last.exit } : {}), ...(last.ok === true ? {} : { failure: firstFailure(p.slug, typeof last.job === "string" ? last.job : undefined) }) } : {}) } as CheckState);
  }
  // gates
  const approved = new Map(pr.gates.map((g) => [g.name, gateApproved(p, g)]));
  const gates: GateState[] = pr.gates.map((g) => {
    const owner = g.owner ?? "owner", needs = g.needs ?? [], a = p.approvals[g.name];
    const rej = (p.votes?.[g.name] ?? []).filter((v) => v.decision === "reject").at(-1);
    const done = approved.get(g.name) === true;
    const reachable = (g.stage === undefined || active.includes(g.stage)) && !p.finished && needs.every((n) => approved.get(n));
    const decision: Decision = done ? "approved" : rej ? "rejected" : reachable ? "pending" : "waiting";
    const who = done && a ? { by: a.by, at: a.at, quote: a.quote } : rej ? { by: rej.by, at: rej.at, quote: rej.quote } : {};
    return { name: g.name, ...(g.stage ? { stage: g.stage } : {}), owner, decision, needs,
      ...(who.by ? { by: who.by } : {}), ...(who.at ? { at: who.at } : {}), ...(who.quote ? { quote: clip(who.quote, 400) } : {}) };
  });
  // jobs still running: the ledger says which started and have no end line, the job record says whether one is alive
  const ended = new Set(led.filter((e) => e.kind === "job" && e.status !== "started").map((e) => String(e.id)));
  const running: JobRef[] = [];
  for (const e of led) if (e.kind === "job" && e.status === "started" && !ended.has(String(e.id))) {
    try { if (jobs.state(p.slug, String(e.id)).status === "running") running.push({ id: String(e.id), name: String(e.name), start: String(e.t) }); } catch { /* record gone */ }
  }
  // queue messages about this lane still waiting
  const blocked = (o.msgs ?? queue.all()).filter(({ state, m }) => (state === "open" || state === "claimed") && m.kind === "BLOCKED" && (m.project === p.slug || m.lane === p.slug))
    .map(({ m }) => ({ id: m.id, from: m.from, to: m.to, summary: clip(m.summary, 240), created: m.created }));
  // marks
  const failedHere = checks.some((c) => c.stage === p.stage && c.ok === false);
  const rejectedHere = gates.some((g) => g.decision === "rejected" && g.stage !== undefined && active.includes(g.stage));
  const wf = p.workflow;
  const stages = list.map((name, i): { name: string; mark: Mark } => {
    const cur = p.finished ? false : active.includes(name);
    const done = p.finished ? true : wf ? wf.completed.includes(name) : i < idx;
    return { name, mark: cur ? (failedHere && name === p.stage) || (rejectedHere && cur) ? "blocked" : "current" : done ? "done" : "todo" };
  });
  const pending = gates.filter((g) => g.decision === "pending");
  const waitingOn = [...new Set([...pending.map((g) => g.owner), ...blocked.map((m) => m.to)])].sort();
  const lastWork = [...led].reverse().find((e) => e.kind === "work" || e.kind === "done");
  const working = lastWork?.kind === "work" && o.now - Date.parse(lastWork.t) < WORK_FRESH_MS;
  const side = (who: string): Status => (who === "owner" ? "waiting-on-owner" : "waiting-on-coordinator");
  const status: Status = p.finished ? "done" : running.length || working ? "running" : failedHere ? "blocked-by-check"
    : waitingOn.length ? side(waitingOn.includes("owner") ? "owner" : "coordinator") : "idle";
  const times = [p.created, ...(led.map((e) => String(e.t))), ...p.notes.map((n) => n.at), ...(p.finished ? [p.finished] : [])].filter((t) => Number.isFinite(Date.parse(t)));
  const lastActivity = times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  return {
    slug: p.slug, title: clip(p.title, 200), kind: p.kind, process: refOf(p), stage: p.stage, stageIndex: Math.max(idx, 0) + 1, stageTotal: list.length,
    ...(p.finished ? { finished: p.finished } : {}), stages, gates, checks, jobs: running, blocked, waitingOn, lastActivity, status,
  };
}

/** One lane's summary by slug (a GovernError for a lane that does not load). */
export const readLane = (slug: string, o: { now?: number } = {}): LaneState => summarize(load(slug), { now: o.now ?? Date.now() });

/** Every lane's summary, with the lanes that could not be read (a bad govern.json is reported, never hidden). */
export function readLanes(o: { now?: number } = {}): { lanes: LaneState[]; unreadable: { slug: string; error: string }[] } {
  const now = o.now ?? Date.now(), lanes: LaneState[] = [], unreadable: { slug: string; error: string }[] = [];
  let msgs: ReturnType<typeof queue.all> = [];
  try { msgs = queue.all(); } catch { /* no queue folder: no messages */ }
  for (const slug of laneSlugs()) {
    try { lanes.push(summarize(load(slug), { now, msgs })); } catch (e) {
      if (!(e instanceof GovernError)) throw e;
      unreadable.push({ slug, error: clip(e.message, 300) });
    }
  }
  return { lanes, unreadable };
}
