// The structured views govern remote serves (docs: REMOTE.md): the desk as data, one lane in full, and the telemetry of
// today. They read the same files as `govern desk` and `govern brief`, and run no model and no check.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import * as conversations from "../../lib/conversation.ts";
import * as jobs from "../../lib/jobs.ts";
import * as artifacts from "../../lib/artifacts.ts";
import { config } from "../../lib/workspace.ts";
import { registry } from "../../lib/caps.ts";
import { governDir } from "../../lib/project.ts";
import type { ArtifactRef, ArtifactView } from "../../lib/artifacts.ts";
import { join } from "node:path";
import { readJsonl, clip } from "../../lib/util.ts";
import { load, ledgerFile, stagesOf, laneSlugs, blockedBy, exitCondition, checkOf, openSegments, type Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { gateApproved, activeStages } from "../../lib/business.ts";
import { GovernError } from "../../lib/util.ts";
import * as queue from "../../lib/queue.ts";
import * as allowances from "../../lib/allowances.ts";
import { machineSummary, machineEntries, stateDir } from "../../lib/resources.ts";
import { tokensOn, dispatcherInfo } from "../../lib/desk.ts";

/** The wire protocol's name and version: a client refuses a server whose major version it does not know. */
export const PROTOCOL = "govern-remote/2";

export interface GateView { name: string; stage: string | null; owner: string; policy: boolean; approved: boolean; approvedAt: string | null; needs: string[]; approvedBy: string | null; quote: string | null; artifact: ArtifactRef | null }
export interface CheckSummary { passed: number; failed: number; total: number }
export interface CheckView { stage: string; name: string; ok: boolean; exit: number | null; at: string; job: string | null }
export interface Progress { done: number; total: number; failed: number }
export interface JobView { id: string; name: string; status: string; start: string; end: string | null; seconds: number | null; exit: number | null; progress: Progress | null }
export interface DecisionView { t: string; kind: "approve" | "changes"; gate: string; by: string; quote: string; device: string | null; artifact: ArtifactRef | null }
export interface Viewer { person: string; device: string; lanes: string[] | null }
export interface MessageView { id: string; role: "user" | "assistant"; at: string; text: string; runId: string | null; verification: "transport-only" | "checked" | "unverified" | null }
export interface SessionSummary { id: string; title: string; lane: string | null; engine: string; state: "idle" | "queued" | "running" | "failed" | "closed"; updatedAt: string; needsDecision: boolean; lastMessage: MessageView | null }
export interface RunView { id: string; state: conversations.RunState; createdAt: string; startedAt: string | null; endedAt: string | null; verification: MessageView["verification"]; error: string | null }
export interface SessionDetail { protocol: string; session: SessionSummary; messages: MessageView[]; runs: RunView[] }
export interface JobDetail { protocol: string; lane: string; job: JobView; argv: string[]; log: string[] }
/** A lane's freeze, as the phone needs it: the owner's words and the pointer, without `by` (always "owner") or `source`
 *  (a terminal/session detail the phone has no use for). */
export interface FrozenView { at: string; quote: string; continuedAs: string | null }
/** Where an imported lane came from, as the phone needs it: not the bundle's hash or the source workspace's, which the
 *  phone cannot act on and should not learn. */
export interface ImportedFromView { slug: string; exportedAt: string; mode: "full" | "template" }
/** One of the source lane's approvals, carried as history only (PLAN, Import): never a live gate. */
export interface ImportedApprovalView { gate: string; at: string; by: string | null; quote: string }
export interface LaneSummary {
  checkSummary: CheckSummary;
  slug: string; title: string; process: string; kind: string;
  stage: string; stageIndex: number; stageCount: number; active: string[];
  state: "finished" | "blocked" | "ready" | "open";
  blockedBy: string[]; gates: GateView[]; openAlerts: number;
  working: { engine: string; since: string } | null;
  lastNote: { at: string; text: string } | null;
  lastJob: { name: string; status: string; at: string } | null;
  frozen: FrozenView | null;
  importedFrom: ImportedFromView | null;
}
export interface LaneError { slug: string; error: string }
export interface AlertView { id: string; stage: string; kind: string; at: string; message: string; acknowledgedAt: string | null }
export interface LedgerView { t: string; kind: string; text: string; summary: string; tone: "ok" | "failed" | "running" | "info" }
export interface LaneDetail extends LaneSummary {
  checks: CheckView[]; jobs: JobView[]; artifacts: ArtifactView[]; sessions: SessionSummary[]; decisions: DecisionView[];
  stages: string[]; exit: string | null; check: string | null; finished: string | null;
  data: Record<string, unknown>; humanTasks: { stage: string; assignee: string | null; completedBy: string | null }[];
  alerts: AlertView[]; notes: { at: string; stage: string; text: string }[]; ledger: LedgerView[];
  importedApprovals: ImportedApprovalView[];
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
export interface SessionError { id: string; error: string }
export interface Desk { viewer: Viewer; sessions: SessionSummary[]; unreadableSessions: SessionError[]; engines: string[]; host: string; protocol: string; at: string; lanes: LaneSummary[]; unreadable: LaneError[]; telemetry: Telemetry }

const gateViews = (p: Project): GateView[] => processOf(p).gates.map((g) => {
  const approved = gateApproved(p, g);
  return { name: g.name, stage: g.stage ?? null, owner: g.owner ?? "owner", policy: !!g.policy, approved,
    approvedAt: approved ? p.approvals[g.name]?.at ?? null : null, needs: g.needs ?? [],
    approvedBy: approved ? p.approvals[g.name]?.by ?? null : null, quote: approved ? p.approvals[g.name]?.quote ?? null : null,
    artifact: approved ? decisions(p.slug).find(e => e.kind === "approve" && e.gate === g.name && e.quote === p.approvals[g.name]?.quote && e.by === p.approvals[g.name]?.by)?.artifact ?? null : null };
});

/** A lane's desk row as data: title, process, current and active stages, state (finished, blocked, ready or open), what
 *  blocks it, its gates, open alerts, and the last work, note and job from its ledger. */
export function laneSummary(p: Project, open = openSegments()): LaneSummary {
  const list = stagesOf(p), led = readJsonl(ledgerFile(p.slug));
  const seg = open.get(p.slug);
  const lastJob = [...led].reverse().find((e) => e.kind === "job");
  const blocked = p.finished ? [] : blockedBy(p);
  const note = p.notes.at(-1);
  return {
    checkSummary: checkSummary(p, led),
    slug: p.slug, title: p.title, process: processOf(p).name, kind: p.kind,
    stage: p.stage, stageIndex: list.indexOf(p.stage), stageCount: list.length, active: activeStages(p),
    state: p.finished ? "finished" : blocked.length ? "blocked" : p.after?.length ? "ready" : "open",
    blockedBy: blocked, gates: gateViews(p), openAlerts: (p.alerts ?? []).filter((a) => !a.acknowledgedAt).length,
    working: seg ? { engine: seg.engine, since: seg.t } : null,
    lastNote: note ? { at: note.at, text: clip(note.text, 240) } : null,
    lastJob: lastJob ? { name: String(lastJob.name), status: String(lastJob.status), at: String(lastJob.t) } : null,
    frozen: p.frozen ? { at: p.frozen.at, quote: p.frozen.quote, continuedAs: p.frozen.continuedAs ?? null } : null,
    importedFrom: p.importedFrom ? { slug: p.importedFrom.slug, exportedAt: p.importedFrom.exportedAt, mode: p.importedFrom.mode } : null,
  };
}

/** Human ledger lines use the complete entry; failed outcomes take precedence over success and running. */
export function ledgerSummary(e: Record<string, unknown>): Pick<LedgerView, "summary" | "tone"> {
  const text = (v: unknown): string => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  const s = (key: string) => text(e[key]);
  const number = (key: string) => typeof e[key] === "number" && Number.isFinite(e[key]) ? String(e[key]) : "";
  const list = (v: unknown) => Array.isArray(v) ? v.map(text).filter(Boolean).join(", ") : text(v);
  const part = (value: string) => value ? ` · ${value}` : "";
  const stage = part(s("stage")), by = s("by") || s("person"), author = part(by ? `by ${by}` : "");
  const status = s("status") || s("state");
  const outcome = (): LedgerView["tone"] => ["failed", "killed", "timeout", "interrupted"].includes(status) || (number("exit") !== "" && e.exit !== 0) || e.ok === false ? "failed"
    : ["ok", "done", "completed"].includes(status) || e.exit === 0 || e.ok === true ? "ok"
    : ["started", "running", "queued"].includes(status) ? "running" : "info";
  const result = e.ok === true ? "passed" : e.ok === false ? "failed" : "recorded";
  const details = (number("exit") !== "" ? part(`exit ${number("exit")}`) : "") + (number("seconds") !== "" ? part(`${number("seconds")} s`) : "")
    + (s("resource") !== "local" ? part(s("resource")) : "");
  const quote = s("quote") ? `: "${clip(s("quote"), 60)}"` : "";
  const artifact = e.artifact && typeof e.artifact === "object" ? text((e.artifact as Record<string, unknown>).name) : "";
  type Line = [string, LedgerView["tone"]];
  const cases: Record<string, () => Line> = {
    job: () => [`${s("name")} ${status}${details}`, outcome()],
    check: () => [`check ${s("name")} ${result}${e.ok === false && number("exit") !== "" ? ` (exit ${number("exit")})` : ""}${stage}`, outcome()],
    advance: () => [`advanced ${s("from")} → ${list(e.to)}${part(s("authority") ? `by ${s("authority")}` : "")}`, "ok"],
    "cmd-set": () => [`command ${s("name")} set`, "info"],
    "cmd-rm": () => [`command ${s("name")} removed`, "info"],
    command: () => [`command ${s("name")} ${status}${details}`, outcome()],
    approve: () => [`${by} approved ${s("gate")}`, "ok"],
    reject: () => [`${by} rejected ${s("gate")}${quote}`, "failed"],
    "changes-requested": () => [`${by} requested changes on ${s("gate")}${quote}`, "failed"],
    note: () => [s("text"), "info"],
    work: () => [`${s("engine")} working on ${s("stage")}`, "running"],
    done: () => [`${s("engine")} finished working`, "ok"],
    artifact: () => [`artifact ${s("name")}${number("version") ? ` v${number("version")}` : ""} published`, "ok"],
    "artifact-reviewed": () => [`${s("person") || by} reviewed ${s("name") || artifact}`, "ok"],
    alert: () => [`alert ${s("message") || s("id")}${stage}`, "info"],
    "alert-ack": () => [`alert ${s("id")} acknowledged${author}`, "ok"],
    kill: () => [`job ${s("job")} stop: ${s("outcome")}`, s("outcome") === "already-exited" ? "info" : "failed"],
    timer: () => [`timer ${s("timer")}${stage}${part(s("scheduledAt"))}`, "info"],
    ask: () => [`ask ${s("prompt")} ${result}`, outcome()],
    instruct: () => [`${by} instructed ${s("session")}${part(s("mode"))}`, "info"],
    session: () => [`session ${s("session")}${part(s("engine"))}`, outcome()],
    "session-opened": () => [`session ${s("session")} opened${part(s("engine"))}${author}`, "ok"],
    conversation: () => [`conversation ${s("conversation")} ${status}${part(s("engine"))}`, outcome()],
    recover: () => [`recovery ${s("action")}${stage}`, "info"],
    "retry-scheduled": () => [`retry ${number("attempt")} scheduled${stage}${part(s("at"))}`, "running"],
    "foreach-start": () => [`foreach started ${s("child")}${stage}`, "running"],
    "foreach-sync": () => [`foreach synced ${number("count")} items${stage}`, "ok"],
    "subprocess-start": () => [`subprocess started ${s("child")}${stage}`, "running"],
    "subprocess-sync": () => [`subprocess synced ${s("child")}${stage}`, "ok"],
    "exception-route": () => [`exception ${s("from")} → ${list(e.to)}${part(s("reason"))}`, "failed"],
    compensate: () => [`compensation ${s("command")} ${result}${stage}`, outcome()],
    "process-pin": () => [`process pinned to revision ${number("revision")}`, "info"],
    "process-migrate": () => [`process migrated ${number("from")} → ${number("to")}`, "ok"],
    data: () => [`data updated: ${list(e.fields)}`, "info"],
    "human-claim": () => [`${by} claimed ${s("stage")}`, "info"],
    "human-delegate": () => [`${by} delegated ${s("stage")} to ${s("to")}`, "info"],
    "human-complete": () => [`${by} completed ${s("stage")}`, "ok"],
    "check-accept": () => [`check change accepted${stage}${author}`, "ok"],
    "check-set": () => [`check set to ${s("to") || "none"}${stage}`, "info"],
    dep: () => [`dependencies set: ${list(e.after) || "none"}`, "info"],
    "recover-source": () => ["recovery source recorded", "info"],
    "migration-source": () => ["migration source recorded", "info"],
    "stop-block": () => [`stop blocked by check ${s("check")}${stage}`, "failed"],
    event: () => [`event ${s("name")} received${stage}`, "info"],
    up: () => [`resource ${s("resource")} started${part(s("tag"))}`, outcome()],
    down: () => [`resource ${s("resource")} stopped${part(s("tag"))}`, "ok"],
    reap: () => [`resource ${s("resource")} reaped${part(s("tag"))}`, "ok"],
  };
  const kind = s("kind") || "entry";
  const scalar = (v: unknown) => typeof v === "string" ? text(v).replace(/[{}"']/g, "")
    : typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ? String(v) : "";
  const fallback = (): Line => [scalar(kind) + (Object.entries(e).filter(([k, v]) => !["kind", "t", "slug"].includes(k) && scalar(v) !== "")
    .slice(0, 3).map(([k, v], i) => `${i ? " · " : " "}${scalar(k)} ${scalar(v)}`).join("")), "info"];
  const [summary, tone] = Object.hasOwn(cases, kind) ? cases[kind]!() : fallback();
  return { summary: clip(text(summary) || scalar(kind) || "entry", 160), tone };
}

/** A ledger entry as one line: its kind and time, the rest as compact JSON (quotes and sources kept short). */
function ledgerView(e: Record<string, unknown>): LedgerView {
  const { t, kind, slug: _, ...rest } = e;
  return { t: String(t), kind: String(kind), text: clip(JSON.stringify(rest), 240), ...ledgerSummary(e) };
}

/** A lane in full: its summary plus every stage, exit condition, check, data, human tasks and alerts, and the last
 *  `notes` (default 20) notes and `ledger` (default 30) ledger entries. */
export function laneDetail(p: Project, o: { notes?: number; ledger?: number } = {}): LaneDetail {
  return {
    ...laneSummary(p),
    checks: checks(p.slug), jobs: jobs.list(p.slug).map(id => jobs.state(p.slug, id)).sort((a, b) => b.start.localeCompare(a.start)).slice(0, 10).map(jobView),
    artifacts: artifacts.list(p.slug), sessions: sessions().filter(s => s.lane === p.slug), decisions: decisions(p.slug),
    stages: stagesOf(p), exit: exitCondition(p) ?? null, check: checkOf(p) ?? null, finished: p.finished ?? null,
    data: { ...(p.data ?? {}) },
    humanTasks: Object.entries(p.humanTasks ?? {}).map(([stage, t]) => ({ stage, assignee: t.assignee ?? null, completedBy: t.completedBy ?? null })),
    alerts: (p.alerts ?? []).map((a) => ({ id: a.id, stage: a.stage, kind: a.kind, at: a.at, message: a.message, acknowledgedAt: a.acknowledgedAt ?? null })),
    notes: p.notes.slice(-(o.notes ?? 20)),
    ledger: readJsonl(ledgerFile(p.slug)).slice(-(o.ledger ?? 30)).map(ledgerView),
    importedApprovals: (p.importedApprovals ?? []).map((a) => ({ gate: a.gate, at: a.at, by: a.by ?? null, quote: a.quote })),
  };
}

/** Usage on `day` (default today, UTC): tokens and machine time per lane, queue counts per runner, failed and unverified
 *  messages, the dispatcher's record, the owner's last 20 open messages, and the allowances shown on the desk. */
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

/** The engines a phone can open a session with: claude, codex and grok profiles plus configured conversation adapters, sorted. */
export const engines = (): string[] => [...new Set([...registry().profiles.values()].filter(p => ["claude", "codex", "grok"].includes(p.engine)).map(p => p.name).concat(Object.keys(config().conversationAdapters ?? {})))].sort();

/** Every lane as a summary (a lane that cannot be read is listed under `unreadable` with its error) and today's telemetry. */
export function deskView(): Omit<Desk, "viewer"> {
  const slugs = laneSlugs(), lanes: LaneSummary[] = [], unreadable: LaneError[] = [], open = openSegments();
  for (const s of slugs) {
    try { lanes.push(laneSummary(load(s), open)); } catch (e) {
      if (!(e instanceof GovernError)) throw e;
      unreadable.push({ slug: s, error: e.message });
    }
  }
  const unreadableSessions: SessionError[] = [];
  const listed = sessions(unreadableSessions);
  return { sessions: listed, unreadableSessions, engines: engines(), host: hostname(), protocol: PROTOCOL, at: new Date().toISOString(), lanes, unreadable, telemetry: telemetry(slugs) };
}

function checkSummary(p: Project, led: Record<string, unknown>[]): CheckSummary {
  const stages = stagesOf(p).filter(s => checkOf(p, s)), latest = stages.map(s => led.findLast(e => e.kind === "check" && e.stage === s));
  return { passed: latest.filter(e => e?.ok === true).length, failed: latest.filter(e => e?.ok === false).length, total: stages.length };
}
function checks(slug: string): CheckView[] {
  const latest = new Map<string, CheckView>();
  for (const e of readJsonl(ledgerFile(slug)).filter(e => e.kind === "check")) {
    const stage = String(e.stage), name = String(e.name);
    latest.set(JSON.stringify([stage, name]), { stage, name, ok: e.ok === true, exit: typeof e.exit === "number" ? e.exit : null, at: String(e.t), job: typeof e.job === "string" ? e.job : null });
  }
  return [...latest.values()];
}
function decisions(slug: string): DecisionView[] {
  return readJsonl(ledgerFile(slug)).filter(e => e.kind === "approve" || e.kind === "changes-requested").reverse().map(e => ({
    t: String(e.t), kind: e.kind === "approve" ? "approve" : "changes", gate: String(e.gate), by: String(e.by), quote: String(e.quote),
    device: typeof e.device === "string" ? e.device : (e.source as { device?: string } | undefined)?.device ?? null, artifact: (e.artifact as ArtifactRef | undefined) ?? null,
  }));
}
/** Job `j` as the phone sees it: name, status, times, exit code, and slice progress when the job is sliced. */
export function jobView(j: jobs.JobState): JobView {
  const file = join(governDir(j.slug), "jobs", j.id, "slice.json");
  const p = j.slice && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Progress : null;
  return { id: j.id, name: j.name, status: j.status, start: j.start, end: j.end ?? null, seconds: j.seconds ?? null, exit: j.exit ?? null,
    progress: p ? { done: p.done, total: p.total, failed: p.failed } : null };
}
/** Job `id` of lane `slug` with its argv and the last `lines` lines of its log. */
export function jobDetail(slug: string, id: string, lines = 100): JobDetail {
  const j = jobs.state(slug, id);
  return { protocol: PROTOCOL, lane: slug, job: jobView(j), argv: j.argv, log: jobs.tail(slug, id, lines) };
}
function messageView(s: conversations.Conversation, m: conversations.Message, limit: number): MessageView {
  return { id: m.id, role: m.role, at: m.at, text: clip(m.content, limit), runId: m.runId ?? null,
    verification: m.role === "assistant" ? s.runs.find(r => r.id === m.runId)?.verification ?? null : null };
}
/** Conversation `s` as a desk row: its state, engine, lane, latest activity, last message, and whether its lane is waiting
 *  on a decision at its current stage (false when the lane cannot be read). */
export function sessionSummary(s: conversations.Conversation): SessionSummary {
  let p: Project | null = null;
  try { p = s.lane ? load(s.lane) : null; } catch (e) { if (!(e instanceof GovernError)) throw e; }
  const last = s.runs.at(-1), message = s.messages.at(-1);
  const state = s.closedAt ? "closed" : s.runs.some(r => r.state === "running") ? "running" : s.runs.some(r => r.state === "queued") ? "queued" : last && ["failed", "interrupted"].includes(last.state) ? "failed" : "idle";
  return { id: s.id, title: s.title, lane: s.lane ?? null, engine: s.adapter.name, state,
    updatedAt: [s.updatedAt, ...s.messages.map(m => m.at), ...s.events.map(e => e.at), ...s.runs.flatMap(r => [r.createdAt, r.startedAt, r.endedAt].filter((t): t is string => !!t))].sort().at(-1)!,
    needsDecision: !!p && !p.finished && gateViews(p).some(g => !g.policy && !g.approved && (g.stage === null || g.stage === p.stage)),
    lastMessage: message ? messageView(s, message, 400) : null };
}
/** Every readable conversation as a summary, latest activity first; one that cannot be read is pushed to `unreadable`
 *  with its error. [] when there are no conversations. */
export function sessions(unreadable: SessionError[] = []): SessionSummary[] {
  if (!existsSync(conversations.root())) return [];
  return readdirSync(conversations.root(), { withFileTypes: true })
    .filter(d => d.isDirectory() && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(d.name))
    .flatMap(d => {
      try { return [sessionSummary(conversations.inspect(d.name))]; }
      catch (e) {
        if (!(e instanceof GovernError) && !(e instanceof Error && "code" in e)) throw e;
        unreadable.push({ id: d.name, error: e.message });
        return [];
      }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
/** Conversation `id` with its summary, its last `messages` messages and its last 5 runs. */
export function sessionDetail(id: string, messages = 20): SessionDetail {
  const s = conversations.inspect(id);
  return { protocol: PROTOCOL, session: sessionSummary(s), messages: s.messages.slice(-messages).map(m => messageView(s, m, 4000)),
    runs: s.runs.slice(-5).map(r => ({ id: r.id, state: r.state, createdAt: r.createdAt, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null, verification: r.verification ?? null, error: r.error ?? null })) };
}
