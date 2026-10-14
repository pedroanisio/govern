import { load } from "./project.ts";
import { enterRuntime } from "./lifecycle-runtime.ts";
import { userInfo } from "node:os";
import { processOf, type GateDef, type Process } from "./process.ts";
import type { Project } from "./project.ts";
import type { Source } from "./approval.ts";
import { fail, nowIso } from "./util.ts";
import { check, emptyRecord, reject } from "./shape.ts";
import { fieldValue, type Scalar, type Value, type Condition, type Vote } from "./business-schema.ts";

export const isGraph = (pr: Process) => pr.stages.some((s) => s.next !== undefined);
export const activeStages = (p: Project): string[] => (p.finished ? [] : (p.workflow?.active ?? [p.stage]));
export function matches(c: Condition, data: Record<string, Value>): boolean {
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
    case "contains":
      return Array.isArray(v) && v.includes(c.value as Scalar);
    case "in":
      return (c.value as Scalar[]).includes(v as Scalar);
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
    for (const kind of ["active", "completed", "waiting", "cancelled"] as const) {
      const ids = w[kind];
      for (const id of ids) {
        if (!known.has(id) || seen.has(id)) reject(path + ".workflow." + kind, `unknown or repeated stage ${id}`);
        seen.add(id);
        if (kind === "waiting" && !pr.stages.find((s) => s.name === id)!.join)
          reject(path + ".workflow.waiting", "only joins may wait");
      }
    }
    for (const [latch, n] of Object.entries(w.loops ?? {})) {
      const loop = pr.stages.find((s) => s.name === latch)?.next?.find((r) => r.loop)?.loop;
      if (!loop || n >= loop.maxIterations) reject(path + ".workflow.loops", "invalid loop counter");
    }
    for (const [join, expected] of Object.entries(w.joinExpected ?? {})) {
      const def = pr.stages.find((s) => s.name === join)?.join;
      if (!def || new Set(expected).size !== expected.length || expected.some((id) => !def.stages.includes(id)))
        reject(path + ".workflow.joinExpected", "invalid dynamic join predecessors");
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
    ) as Record<string, Value>;
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
export function setData(p: Project, patch: Record<string, Value>): void {
  if (p.finished) fail(`${p.slug} is finished; case data is read-only`);
  const identityFields = new Set(processOf(p).gates.flatMap((g) => g.policy?.excludeFields ?? []));
  for (const field of identityFields)
    if (Object.hasOwn(p.data ?? {}, field) && Object.hasOwn(patch, field) && p.data![field] !== patch[field])
      fail(`identity field ${field} cannot be changed after it is recorded`);
  for (const stage of activeStages(p)) {
    const s = processOf(p).stages.find((s) => s.name === stage)!;
    const r = p.runtime?.[stage];
    if (
      r?.child &&
      Object.values(s.call?.inputs ?? {}).some(
        (f) => Object.hasOwn(patch, f) && JSON.stringify(p.data?.[f]) !== JSON.stringify(patch[f])
      )
    )
      fail(`subprocess inputs are frozen while ${stage} is active`);
  }
  const data = Object.assign(emptyRecord<Value>(), p.data ?? {}, patch);
  check<Record<string, Value>>("case data", data, (v, path) => {
    validateCase({ ...p, data: v as Record<string, Value> }, processOf(p), path);
    return v as Record<string, Value>;
  });
  for (const stage of activeStages(p)) {
    const def = processOf(p).stages.find((s) => s.name === stage)!.foreach;
    if (
      def &&
      p.runtime?.[stage]?.batch &&
      [def.collection, ...Object.values(def.inputs ?? {})].some(
        (f) => Object.hasOwn(patch, f) && JSON.stringify(p.data?.[f]) !== JSON.stringify(data[f])
      )
    )
      fail(`foreach inputs are frozen while ${stage} is active`);
  }
  if (JSON.stringify(data) === JSON.stringify(p.data ?? {})) return;
  for (const stage of activeStages(p)) {
    const s = processOf(p).stages.find((s) => s.name === stage)!;
    if (s.event && p.runtime?.[stage] && p.data?.[s.event.correlationField] !== data[s.event.correlationField])
      delete p.runtime[stage]!.eventId;
  }
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
export function selectedRoute(p: Project) {
  const def = processOf(p).stages.find((s) => s.name === p.stage)!;
  const routes = def.next ?? [],
    matching = routes.filter((r) => r.when && matches(r.when, p.data ?? {}));
  if (matching.length > 1) fail(`${p.slug}: ambiguous routes from ${p.stage}`);
  const r = matching[0] ?? routes.find((r) => !r.when);
  if (routes.length && !r) fail(`${p.slug}: no route matches from ${p.stage}`);
  return r;
}
export function nextStages(p: Project): string[] {
  const pr = processOf(p),
    def = pr.stages.find((s) => s.name === p.stage)!;
  if (!isGraph(pr)) return [pr.stages[pr.stages.indexOf(def) + 1]?.name].filter((x): x is string => x !== undefined);
  const selected = selectedRoute(p);
  if (selected?.loop) {
    if ((p.workflow?.loops?.[p.stage] ?? 0) + 1 >= selected.loop.maxIterations)
      fail(`${p.slug}: loop ${p.stage} reached its ${selected.loop.maxIterations}-iteration limit`);
    const body = new Set(selected.loop.stages);
    if ([...p.workflow!.active, ...p.workflow!.waiting].some((id) => id !== p.stage && body.has(id)))
      fail("loop body still has active or waiting work");
    for (const id of body) {
      const rt = p.runtime?.[id];
      if ((rt?.child && !load(rt.child).finished) || (rt?.batch && !rt.batch.synced))
        fail("finish loop subprocesses before repeating");
      if (rt?.checkInFlight || rt?.compensation === "running" || rt?.compensation === "failed")
        fail("resolve uncertain loop work before repeating");
    }
  }
  if (selected?.branches) {
    if (p.workflow!.active.includes(selected.join!) || p.workflow!.waiting.includes(selected.join!))
      fail("dynamic join is already in use");
    const targets = [
      ...selected.to,
      ...selected.branches.filter((b) => matches(b.when, p.data ?? {})).map((b) => b.to)
    ];
    return targets.length ? targets : [selected.join!];
  }
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
    if (!p.finished) enterRuntime(p, [p.stage], true);
    enterTasks(p);
    return;
  }
  const route = selectedRoute(p);
  if (route?.loop) nextStages(p);
  if (route?.loop) {
    const body = new Set(route.loop.stages),
      w = p.workflow;
    w.loops ??= emptyRecord();
    w.loops[from] = (w.loops[from] ?? 0) + 1;
    for (const stage of pr.stages)
      if (body.has(stage.name) && stage.name !== from && stage.next?.some((r) => r.loop)) delete w.loops[stage.name];
    for (const key of ["completed", "cancelled", "waiting"] as const) w[key] = w[key].filter((id) => !body.has(id));
    w.active = w.active.filter((id) => id !== from);
    w.active.push(destinations[0]!);
    for (const id of body) {
      if (p.humanTasks) delete p.humanTasks[id];
      if (w.joinExpected) delete w.joinExpected[id];
    }
    const invalid = new Set(pr.gates.filter((g) => g.stage && body.has(g.stage)).map((g) => g.name));
    for (let changed = true; changed; ) {
      changed = false;
      for (const g of pr.gates)
        if (!invalid.has(g.name) && (g.needs ?? []).some((n) => invalid.has(n))) {
          invalid.add(g.name);
          changed = true;
        }
    }
    for (const gate of invalid) {
      delete p.approvals[gate];
      if (p.votes) delete p.votes[gate];
    }
    p.stage = w.active[0]!;
    enterRuntime(p, [destinations[0]!], true);
    enterTasks(p);
    return;
  }
  if (route?.branches) {
    p.workflow.joinExpected ??= emptyRecord();
    p.workflow.joinExpected[route.join!] = destinations.filter((id) => id !== route.join);
  }
  const previous = new Set(p.workflow.active);
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
    const expected = w.joinExpected?.[id] ?? join.stages;
    const met = expected.map((s) => w.completed.includes(s));
    if (!(met.length === 0 || (join.mode === "all" ? met.every(Boolean) : met.some(Boolean)))) continue;
    if (join.mode === "any") {
      // Cancel unfinished paths leading to this join, not unrelated active work.
      const reaches = (s: string): boolean =>
        s === id ||
        (pr.stages.find((x) => x.name === s)!.next ?? []).filter((r) => !r.loop).some((r) => r.to.some(reaches));
      const cancelled = [...w.active, ...w.waiting].filter((s) => s !== id && reaches(s));
      for (const stage of cancelled) {
        const rt = p.runtime?.[stage];
        if ((rt?.child && !load(rt.child).finished) || (rt?.batch && !rt.batch.synced))
          fail("finish subprocesses before cancelling their branch");
      }
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
  enterRuntime(
    p,
    activeStages(p).filter((s) => !previous.has(s)),
    true
  );
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
/** Records the owner's approval of gate `g` (one without a policy) on `p`: `by` must be the gate's decision owner (omitted
 *  only when that owner is "owner"), `quote` the owner's own words, and every gate it needs already approved. `source` says
 *  where the words came from; it runs after those checks, so a refusal names the missing approval before the quote is checked. */
export function ownerApproval(p: Project, g: GateDef, by: string | undefined, quote: string | undefined, source: () => Source): void {
  const owner = g.owner ?? "owner", gates = processOf(p).gates;
  if (by === undefined && owner !== "owner") fail(`gate ${g.name} is decided by ${owner}: pass --by ${owner}`);
  if (by !== undefined && by !== owner) fail(`gate ${g.name} is decided by ${owner}, not ${by}`);
  if (!quote || quote.trim().length < 2) fail(`--quote is required: ${owner}'s own words approving the ${g.name} (only ${owner} approves)`);
  for (const need of g.needs ?? []) if (!gateApproved(p, gates.find((x) => x.name === need)!)) fail(g.message ?? `needs the ${need} approval first`);
  const src = source();
  p.approvals[g.name] = { at: nowIso(), quote, by: owner, source: src };
  p.notes.push({ at: nowIso(), stage: p.stage, text: `${owner} approved ${g.name}: "${quote}"` });
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
  if (Object.values(p.runtime ?? {}).some((r) => (r.child && !load(r.child).finished) || (r.batch && !r.batch.synced)))
    fail("cannot reject-reroute a case with unfinished subprocesses");
  if (p.workflow)
    p.workflow = {
      active: [to],
      completed: [],
      waiting: [],
      cancelled: [],
      ...(p.workflow.loops ? { loops: p.workflow.loops } : {})
    };
  p.stage = to;
  delete p.finished;
  p.humanTasks = emptyRecord();
  for (const other of processOf(p).gates)
    if (other.policy && other.name !== g.name) {
      delete p.approvals[other.name];
      if (p.votes) delete p.votes[other.name];
    }
  enterRuntime(p, [to], true);
  enterTasks(p);
}
