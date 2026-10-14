// The structured views govern remote serves (docs: REMOTE.md): the desk as data, one lane in full, and the telemetry of
// today. They read the same files as `govern desk` and `govern brief`, and run no model and no check.
import { join } from "node:path";
import { readJsonl, clip } from "./util.ts";
import { load, ledgerFile, stagesOf, laneSlugs, blockedBy, exitCondition, checkOf, type Project } from "./project.ts";
import { processOf } from "./process.ts";
import { gateApproved, activeStages } from "./business.ts";
import { GovernError } from "./util.ts";
import * as queue from "./queue.ts";
import * as allowances from "./allowances.ts";
import { machineSummary, machineEntries, stateDir } from "./resources.ts";
import { tokensOn, dispatcherInfo } from "./desk.ts";

/** The wire protocol's name and version: a client refuses a server whose major version it does not know. */
export const PROTOCOL = "govern-remote/1";

export interface GateView { name: string; stage: string | null; owner: string; policy: boolean; approved: boolean; approvedAt: string | null; needs: string[] }
export interface LaneSummary {
  slug: string; title: string; process: string; kind: string;
  stage: string; stageIndex: number; stageCount: number; active: string[];
  state: "finished" | "blocked" | "ready" | "open";
  blockedBy: string[]; gates: GateView[]; openAlerts: number;
  working: { engine: string; since: string } | null;
  lastNote: { at: string; text: string } | null;
  lastJob: { name: string; status: string; at: string } | null;
}
export interface LaneError { slug: string; error: string }
export interface AlertView { id: string; stage: string; kind: string; at: string; message: string; acknowledgedAt: string | null }
export interface LedgerView { t: string; kind: string; text: string }
export interface LaneDetail extends LaneSummary {
  stages: string[]; exit: string | null; check: string | null; finished: string | null;
  data: Record<string, unknown>; humanTasks: { stage: string; assignee: string | null; completedBy: string | null }[];
  alerts: AlertView[]; notes: { at: string; stage: string; text: string }[]; ledger: LedgerView[];
}
export interface Telemetry {
  day: string;
  tokens: { lane: string; calls: number; input: number; output: number; usd: number }[];
  machines: { lane: string; time: string; money: string | null }[];
  queue: { runners: { runner: string; waiting: number; running: number }[]; failed: number; unverified: number };
  dispatcher: { running: boolean; pid: number; started: string; interval: number } | null;
  inbox: { id: string; kind: string; from: string; project: string; summary: string; created: string }[];
  allowances: string[];
}
export interface Desk { protocol: string; at: string; lanes: LaneSummary[]; unreadable: LaneError[]; telemetry: Telemetry }

const gateViews = (p: Project): GateView[] => processOf(p).gates.map((g) => {
  const approved = gateApproved(p, g);
  return { name: g.name, stage: g.stage ?? null, owner: g.owner ?? "owner", policy: !!g.policy, approved,
    approvedAt: approved ? p.approvals[g.name]?.at ?? null : null, needs: g.needs ?? [] };
});

export function laneSummary(p: Project): LaneSummary {
  const list = stagesOf(p), led = readJsonl(ledgerFile(p.slug));
  const lastWork = [...led].reverse().find((e) => e.kind === "work" || e.kind === "done");
  const lastJob = [...led].reverse().find((e) => e.kind === "job");
  const blocked = p.finished ? [] : blockedBy(p);
  const note = p.notes.at(-1);
  return {
    slug: p.slug, title: p.title, process: processOf(p).name, kind: p.kind,
    stage: p.stage, stageIndex: list.indexOf(p.stage), stageCount: list.length, active: activeStages(p),
    state: p.finished ? "finished" : blocked.length ? "blocked" : p.after?.length ? "ready" : "open",
    blockedBy: blocked, gates: gateViews(p), openAlerts: (p.alerts ?? []).filter((a) => !a.acknowledgedAt).length,
    working: lastWork?.kind === "work" ? { engine: String(lastWork.engine ?? "?"), since: String(lastWork.t) } : null,
    lastNote: note ? { at: note.at, text: clip(note.text, 240) } : null,
    lastJob: lastJob ? { name: String(lastJob.name), status: String(lastJob.status), at: String(lastJob.t) } : null,
  };
}

/** A ledger entry as one line: its kind and time, the rest as compact JSON (quotes and sources kept short). */
function ledgerView(e: Record<string, unknown>): LedgerView {
  const { t, kind, slug: _, ...rest } = e;
  return { t: String(t), kind: String(kind), text: clip(JSON.stringify(rest), 240) };
}

export function laneDetail(p: Project, o: { notes?: number; ledger?: number } = {}): LaneDetail {
  return {
    ...laneSummary(p),
    stages: stagesOf(p), exit: exitCondition(p) ?? null, check: checkOf(p) ?? null, finished: p.finished ?? null,
    data: { ...(p.data ?? {}) },
    humanTasks: Object.entries(p.humanTasks ?? {}).map(([stage, t]) => ({ stage, assignee: t.assignee ?? null, completedBy: t.completedBy ?? null })),
    alerts: (p.alerts ?? []).map((a) => ({ id: a.id, stage: a.stage, kind: a.kind, at: a.at, message: a.message, acknowledgedAt: a.acknowledgedAt ?? null })),
    notes: p.notes.slice(-(o.notes ?? 20)),
    ledger: readJsonl(ledgerFile(p.slug)).slice(-(o.ledger ?? 30)).map(ledgerView),
  };
}

export function telemetry(slugs: string[], day = new Date().toISOString().slice(0, 10)): Telemetry {
  const msgs = queue.all();
  const count = (state: string, to?: string) => msgs.filter((x) => x.state === state && (!to || x.m.to === to)).length;
  const onDay = (e: Record<string, unknown>) => String(e["t"]).startsWith(day);
  const machines = slugs.flatMap((s) => {
    const m = machineSummary(machineEntries(ledgerFile(s)).filter(onDay));
    return m ? [{ lane: s, time: m.time, money: m.money ?? null }] : [];
  });
  const bare = machineSummary(machineEntries(join(stateDir(), "ledger.jsonl")).filter(onDay));
  if (bare) machines.push({ lane: "(no lane)", time: bare.time, money: bare.money ?? null });
  return {
    day,
    tokens: [...tokensOn(slugs, day)].sort((a, b) => b[1].input - a[1].input).map(([lane, x]) => ({ lane, ...x })),
    machines,
    queue: {
      runners: queue.plainRunners().map((runner) => ({ runner, waiting: count("open", runner), running: count("claimed", runner) })),
      failed: count("failed"),
      unverified: msgs.filter((x) => x.m.verification?.state === "unverified" && x.state !== "done").length,
    },
    dispatcher: dispatcherInfo() ?? null,
    inbox: msgs.filter((x) => x.state === "open" && x.m.to === "owner").slice(-20)
      .map(({ m }) => ({ id: m.id, kind: m.kind, from: m.from, project: m.project, summary: clip(m.summary, 200), created: m.created })),
    allowances: allowances.shown(),
  };
}

/** Every lane as a summary (a lane that cannot be read is listed under `unreadable` with its error) and today's telemetry. */
export function deskView(): Desk {
  const slugs = laneSlugs(), lanes: LaneSummary[] = [], unreadable: LaneError[] = [];
  for (const s of slugs) {
    try { lanes.push(laneSummary(load(s))); } catch (e) {
      if (!(e instanceof GovernError)) throw e;
      unreadable.push({ slug: s, error: e.message });
    }
  }
  return { protocol: PROTOCOL, at: new Date().toISOString(), lanes, unreadable, telemetry: telemetry(slugs) };
}
