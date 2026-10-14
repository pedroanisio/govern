import { enterRuntime } from './lifecycle-runtime.ts';
import { userInfo } from "node:os";
import { processOf, type GateDef, type Process } from "./process.ts";
import type { Project } from "./project.ts";
import { fail, nowIso } from "./util.ts";
import { check, emptyRecord, reject } from "./shape.ts";
import { fieldValue, type Scalar, type Condition, type Vote } from "./business-schema.ts";

export const isGraph = (pr: Process) => pr.stages.some((s) => s.next !== undefined);
export const activeStages = (p: Project): string[] => (p.finished ? [] : (p.workflow?.active ?? [p.stage]));
export function matches(c: Condition, data: Record<string, Scalar>): boolean {
  if ("all" in c) return c.all.every((x) => matches(x, data));
  if ("any" in c) return c.any.some((x) => matches(x, data));
  if ("not" in c) return !matches(c.not, data);
  const present = Object.hasOwn(data, c.field),
    v = data[c.field];
  if (c.op === "exists") return present;
  if (!present) return false; // missing data never selects an inequality route
  switch (c.op) {
    case "eq":
      return v === c.value;
    case "ne":
      return v !== c.value;
    case "in":
      return (c.value as Scalar[]).includes(v!);
    case "gt":
      return (v as number) > (c.value as number);
    case "gte":
      return (v as number) >= (c.value as number);
    case "lt":
      return (v as number) < (c.value as number);
    case "lte":
      return (v as number) <= (c.value as number);
  }
}
export function validateCase(p: Project, pr: Process, path: string): void {
  for (const [k, v] of Object.entries(p.data ?? {})) {
    const f = pr.fields?.[k];
    if (!f) reject(path + ".data", `unknown field ${k}`);
    fieldValue(f!, v, path + ".data." + k);
  }
  for (const field of new Set(pr.gates.flatMap((g) => g.policy?.excludeFields ?? []))) {
    if (p.data && Object.hasOwn(p.data, field) && !Object.hasOwn(pr.people ?? {}, String(p.data[field])))
      reject(path + ".data." + field, "must name a process person");
  }
  if (p.workflow) {
    if (!isGraph(pr)) reject(path + ".workflow", "linear process cannot have graph state");
    const w = p.workflow,
      known = new Set(pr.stages.map((s) => s.name)),
      seen = new Set<string>();
    for (const [kind, ids] of Object.entries(w))
      for (const id of ids) {
        if (!known.has(id) || seen.has(id)) reject(path + ".workflow." + kind, `unknown or repeated stage ${id}`);
        seen.add(id);
        if (kind === "waiting" && !pr.stages.find((s) => s.name === id)!.join)
          reject(path + ".workflow.waiting", "only joins may wait");
      }
    if (p.finished ? w.active.length || w.waiting.length : !w.active.includes(p.stage))
      reject(path + ".workflow", "selected stage must be active; finished lanes cannot have active or waiting stages");
  } else if (isGraph(pr)) reject(path + ".workflow", "graph state missing (create a new lane for a graph process)");
  for (const [stage, t] of Object.entries(p.humanTasks ?? {})) {
    const def = pr.stages.find((s) => s.name === stage)?.human;
    if (!def) reject(path + ".humanTasks", `unknown human stage ${stage}`);
    if (t.assignee && !eligibleHuman(pr, stage, t.assignee))
      reject(path + ".humanTasks", `ineligible assignee ${t.assignee}`);
    if (!!t.completedAt !== !!t.completedBy || !!t.completedAt !== !!t.quote)
      reject(path + ".humanTasks", "completion requires person, timestamp and quote");
    if (t.completedBy && t.completedBy !== t.assignee)
      reject(path + ".humanTasks", "only the assignee may complete a task");
    if (t.completedAt && Number.isNaN(Date.parse(t.completedAt)))
      reject(path + ".humanTasks", "invalid completion timestamp");
  }
  for (const [gate, votes] of Object.entries(p.votes ?? {})) {
    const g = pr.gates.find((g) => g.name === gate);
    if (!g?.policy) reject(path + ".votes", `unknown policy gate ${gate}`);
    const people = new Set<string>();
    for (const v of votes) {
      if (people.has(v.by) || !eligibleApprover(pr, g!, v.by) || Number.isNaN(Date.parse(v.at)))
        reject(path + ".votes", "duplicate, ineligible or invalid vote");
      people.add(v.by);
    }
  }
}
export function initializeBusiness(p: Project): void {
  const pr = processOf(p);
  if (pr.fields)
    p.data = Object.fromEntries(
      Object.entries(pr.fields)
        .filter(([, f]) => f.default !== undefined)
        .map(([k, f]) => [k, f.default!])
    ) as Record<string, Scalar>;
  if (isGraph(pr)) p.workflow = { active: [p.stage], completed: [], waiting: [], cancelled: [] };
  enterTasks(p);
}
export function requireActive(p: Project, stage = p.stage): void {
  if (!activeStages(p).includes(stage)) fail(`${p.slug}: stage ${stage} is not active`);
}
export function validateRequired(p: Project, stage = p.stage): void {
  const pr = processOf(p),
    required = [
      ...Object.keys(pr.fields ?? {}).filter((k) => pr.fields![k]!.required),
      ...(pr.stages.find((s) => s.name === stage)?.requiredFields ?? [])
    ];
  const missing = required.filter((k) => !Object.hasOwn(p.data ?? {}, k));
  if (missing.length) fail(`${p.slug}: missing required fields: ${[...new Set(missing)].join(", ")}`);
}
export function setData(p: Project, patch: Record<string, Scalar>): void {
  if (p.finished) fail(`${p.slug} is finished; case data is read-only`);
  const identityFields = new Set(processOf(p).gates.flatMap((g) => g.policy?.excludeFields ?? []));
  for (const field of identityFields)
    if (Object.hasOwn(p.data ?? {}, field) && Object.hasOwn(patch, field) && p.data![field] !== patch[field])
      fail(`identity field ${field} cannot be changed after it is recorded`);
  for(const stage of activeStages(p)){const s=processOf(p).stages.find(s=>s.name===stage)!;const r=p.runtime?.[stage];if(r?.child && Object.values(s.call?.inputs??{}).some(f=>Object.hasOwn(patch,f)&&p.data?.[f]!==patch[f]))fail(`subprocess inputs are frozen while ${stage} is active`);}
  const data = Object.assign(emptyRecord<Scalar>(), p.data ?? {}, patch);
  check<Record<string, Scalar>>("case data", data, (v, path) => {
    validateCase({ ...p, data: v as Record<string, Scalar> }, processOf(p), path);
    return v as Record<string, Scalar>;
  });
  if (JSON.stringify(data) === JSON.stringify(p.data ?? {})) return;
  for(const stage of activeStages(p)){const s=processOf(p).stages.find(s=>s.name===stage)!;if(s.event&&p.runtime?.[stage]&&p.data?.[s.event.correlationField]!==data[s.event.correlationField])delete p.runtime[stage]!.eventId;}
  p.data = data;
  // Votes and active human decisions apply to the case as reviewed, not to a later revision.
  for (const g of processOf(p).gates)
    if (g.policy) {
      delete p.approvals[g.name];
      if (p.votes) delete p.votes[g.name];
    }
  for (const s of activeStages(p)) {
    const t = p.humanTasks?.[s];
    if (t) {
      delete t.completedBy;
      delete t.completedAt;
      delete t.quote;
    }
  }
}
export function nextStages(p: Project): string[] {
  const pr = processOf(p),
    def = pr.stages.find((s) => s.name === p.stage)!;
  if (!isGraph(pr)) return [pr.stages[pr.stages.indexOf(def) + 1]?.name].filter((x): x is string => x !== undefined);
  const routes = def.next!,
    matching = routes.filter((r) => r.when && matches(r.when, p.data ?? {}));
  if (matching.length > 1) fail(`${p.slug}: ambiguous routes from ${p.stage}`);
  const selected = matching[0] ?? routes.find((r) => !r.when);
  if (routes.length && !selected) fail(`${p.slug}: no route matches from ${p.stage}`);
  return selected?.to ?? [];
}
export function enterTasks(p: Project): void {
  enterRuntime(p, activeStages(p));
  const pr = processOf(p);
  for (const stage of activeStages(p)) {
    const def = pr.stages.find((s) => s.name === stage)?.human;
    if (!def) continue;
    p.humanTasks ??= emptyRecord();
    p.humanTasks[stage] ??= def.assignee ? { assignee: def.assignee } : {};
  }
}
export function completeStage(p: Project, destinations: string[]): void {
  const pr = processOf(p),
    from = p.stage;
  if (!p.workflow) {
    if (destinations.length) p.stage = destinations[0]!;
    else p.finished = nowIso();
    if(!p.finished)enterRuntime(p,[p.stage],true);
    enterTasks(p);
    return;
  }
  const previous=new Set(p.workflow.active);
  const w = p.workflow;
  w.active = w.active.filter((s) => s !== from);
  w.completed.push(from);
  for (const id of destinations) {
    if (w.completed.includes(id) || w.cancelled.includes(id) || w.active.includes(id) || w.waiting.includes(id))
      continue;
    if (pr.stages.find((s) => s.name === id)!.join) w.waiting.push(id);
    else w.active.push(id);
  }
  for (const id of [...w.waiting]) {
    if (!w.waiting.includes(id)) continue;
    const join = pr.stages.find((s) => s.name === id)!.join!;
    const met = join.stages.map((s) => w.completed.includes(s));
    if (!(join.mode === "all" ? met.every(Boolean) : met.some(Boolean))) continue;
    if (join.mode === "any") {
      // Cancel unfinished paths leading to this join, not unrelated active work.
      const reaches = (s: string): boolean =>
        s === id || (pr.stages.find((x) => x.name === s)!.next ?? []).some((r) => r.to.some(reaches));
      const cancelled = [...w.active, ...w.waiting].filter((s) => s !== id && reaches(s));
      w.cancelled.push(...cancelled);
      w.active = w.active.filter((s) => !cancelled.includes(s));
      w.waiting = w.waiting.filter((s) => !cancelled.includes(s));
    }
    w.waiting = w.waiting.filter((s) => s !== id);
    w.active.push(id);
  }
  if (!w.active.length) {
    if (w.waiting.length) fail(`${p.slug}: join cannot complete: ${w.waiting.join(", ")} (no active branches remain)`);
    p.finished = nowIso();
  } else p.stage = w.active[0]!;
  enterRuntime(p,activeStages(p).filter(s=>!previous.has(s)),true);
  enterTasks(p);
}
export function authenticatedPerson(pr: Process, requested?: string): string {
  const user = userInfo().username,
    ids = Object.keys(pr.people ?? {}).filter((id) => pr.people![id]!.user === user);
  const id = ids[0];
  if (!id || (requested && requested !== id))
    fail(`OS account ${user} is not authenticated as ${requested ?? "a process person"}`);
  return id!;
}
export function eligibleHuman(pr: Process, stage: string, id: string): boolean {
  const h = pr.stages.find((s) => s.name === stage)?.human,
    person = pr.people?.[id];
  return !!h && !!person && (h.assignee ? h.assignee === id : !!person.roles?.includes(h.role!));
}
export function humanAction(
  p: Project,
  stage: string,
  action: "claim" | "delegate" | "complete",
  actor: string,
  quote: string,
  to?: string
): void {
  requireActive(p, stage);
  const pr = processOf(p);
  if (!eligibleHuman(pr, stage, actor)) fail(`${actor} is not eligible for task ${stage}`);
  enterTasks(p);
  const task = p.humanTasks?.[stage] ?? fail(`${stage} is not a human task`);
  if (task.completedAt) fail(`${stage} is already completed`);
  if (action === "claim") {
    if (task.assignee && task.assignee !== actor) fail(`${stage} is already assigned to ${task.assignee}`);
    task.assignee = actor;
  } else {
    if (task.assignee !== actor) fail(`only the assignee may ${action} ${stage}`);
    if (action === "delegate") {
      if (!to || !eligibleHuman(pr, stage, to))
        fail("delegation requires an eligible --to person (use a role task for delegation)");
      task.assignee = to;
    } else {
      validateRequired(p, stage);
      task.completedBy = actor;
      task.completedAt = nowIso();
      task.quote = quote;
    }
  }
}
export function requireHumanComplete(p: Project, stage = p.stage): void {
  if (processOf(p).stages.find((s) => s.name === stage)?.human && !p.humanTasks?.[stage]?.completedAt)
    fail(`${p.slug}: human task ${stage} must be completed by its assignee`);
}
export function eligibleApprover(pr: Process, g: GateDef, id: string): boolean {
  const q = g.policy;
  return (
    !!q &&
    Object.hasOwn(pr.people ?? {}, id) &&
    (q.people ? q.people.includes(id) : !!pr.people?.[id]?.roles?.includes(q.role!))
  );
}
export function gateApproved(p: Project, g: GateDef | undefined, at = Date.now()): boolean {
  if (!g) return false;
  if (!g.policy) return !!p.approvals[g.name];
  const q = g.policy,
    pr = processOf(p);
  if ((q.excludeFields ?? []).some((f) => !Object.hasOwn(p.data ?? {}, f))) return false;
  const votes = (p.votes?.[g.name] ?? []).filter(
    (v) =>
      eligibleApprover(pr, g, v.by) &&
      !(q.excludeFields ?? []).some((f) => p.data?.[f] === v.by) &&
      (q.expiresSeconds === undefined || Date.parse(v.at) + q.expiresSeconds * 1000 > at)
  );
  return (
    !votes.some((v) => v.decision === "reject") &&
    new Set(votes.filter((v) => v.decision === "approve").map((v) => v.by)).size >= q.quorum
  );
}
export function policyVote(p: Project, g: GateDef, actor: string, decision: "approve" | "reject", quote: string): Vote {
  const pr = processOf(p),
    q = g.policy ?? fail("gate has no approval policy");
  if (p.finished) fail("finished lane cannot receive decisions");
  if (g.stage) requireActive(p, g.stage);
  if (!eligibleApprover(pr, g, actor)) fail(`${actor} is not an eligible approver for ${g.name}`);
  for (const f of q.excludeFields ?? []) {
    if (!Object.hasOwn(p.data ?? {}, f)) fail(`approval requires identity field ${f}`);
    if (p.data![f] === actor) fail(`${actor} cannot approve their own request (${f})`);
  }
  for (const need of g.needs ?? [])
    if (!gateApproved(p, pr.gates.find((x) => x.name === need)!)) fail(`needs the ${need} approval first`);
  const vote: Vote = { by: actor, decision, quote, at: nowIso() };
  p.votes ??= emptyRecord();
  p.votes[g.name] = [...(p.votes[g.name] ?? []).filter((v) => v.by !== actor), vote];
  // Policy consumers always use gateApproved; the cached approval remains compatible with stored shape.
  if (gateApproved(p, g)) p.approvals[g.name] = { at: vote.at, by: actor, quote };
  else delete p.approvals[g.name];
  return vote;
}
export function rejectRoute(p: Project, g: GateDef): void {
  const to = g.policy?.rejectTo;
  if (!to) return; // a veto blocks until superseded by the same approver
  if (p.workflow) p.workflow = { active: [to], completed: [], waiting: [], cancelled: [] };
  p.stage = to;
  delete p.finished;
  p.humanTasks = emptyRecord();
  for (const other of processOf(p).gates)
    if (other.policy && other.name !== g.name) {
      delete p.approvals[other.name];
      if (p.votes) delete p.votes[other.name];
    }
  enterRuntime(p,[to],true);
  enterTasks(p);
}
