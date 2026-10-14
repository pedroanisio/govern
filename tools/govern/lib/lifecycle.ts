import { syncItems } from "./fanout.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { create, load, save, stateFile, checkSlug, laneSlugs, appendLedger, type Project } from "./project.ts";
import { processOf, getProcess, freezeProcess, type Process } from "./process.ts";
import { activeStages, requireActive, setData, isGraph, enterTasks, gateApproved } from "./business.ts";
import { enterRuntime } from "./lifecycle-runtime.ts";
import { emptyRecord } from "./shape.ts";
import { type Scalar, type Value } from "./business-schema.ts";
import { fail, sha256, nowIso } from "./util.ts";
import * as jobs from "./jobs.ts";
import { withLaneLock } from "./lane-lock.ts";
import { stateDir } from "./workspace.ts";
import type { StageRuntime, EventReceipt } from "./lifecycle-schema.ts";

/** Run `f` while holding the lane lock for `slug` (a lock file under `<state dir>/lane-locks`, keyed by the lane's state
 *  file path), and return its result. Fails on an invalid slug. */
export const transaction = <T>(slug: string, f: () => T): T =>
  withLaneLock(join(stateDir(), "lane-locks", sha256(stateFile(checkSlug(slug)))), f);
/** The runtime record of `stage` (default: the current stage), created on first use; fails when the stage has no
 *  lifecycle definition. */
export function runtimeOf(p: Project, stage = p.stage): StageRuntime {
  enterRuntime(p, [stage]);
  return p.runtime?.[stage] ?? fail(`${stage} has no lifecycle definition`);
}
/** Reroute the lane to stage `to` as an exception: reset workflow state, human tasks, approvals and votes, enter the new
 *  stage and append an exception-route ledger entry. Fails on an unknown stage, an uncertain check or compensation, or
 *  unfinished subprocesses. */
export function resetExecution(p: Project, to: string, reason: string): void {
  const from = p.stage,
    pr = processOf(p);
  if (!pr.stages.some((s) => s.name === to)) fail(`unknown exception destination ${to}`);
  if (Object.values(p.runtime ?? {}).some((r) => r.checkInFlight || r.compensation === "running"))
    fail("resolve interrupted checks or uncertain compensation before rerouting");
  if (
    p.runtime &&
    Object.values(p.runtime).some((r) => (r.child && !load(r.child).finished) || (r.batch && !r.batch.synced))
  )
    fail("cannot reroute a case with unfinished subprocesses; finish or resolve them first");
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
  p.approvals = emptyRecord();
  p.votes = emptyRecord();
  enterRuntime(p, [to], true);
  enterTasks(p);
  appendLedger(p.slug, { kind: "exception-route", from, to, reason });
}
/** Fire each due, not-yet-fired timer deadline on the active stages at time `at`: raise an alert, apply an escalation
 *  (reroute and/or reassign the human task), save the lane and append a timer ledger entry. Returns how many fired. */
export function tickTimers(p: Project, at = Date.now()): number {
  let emitted = 0;
  for (const stage of [...activeStages(p)]) {
    const s = processOf(p).stages.find((s) => s.name === stage)!,
      t = s.timer;
    if (!t) continue;
    const r = runtimeOf(p, stage);
    for (const [key, date] of Object.entries(r.deadlines).sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]))) {
      if (Date.parse(date) > at || r.fired.includes(key)) continue;
      if (key === "escalation" && t.escalate?.to) {
        const old = p.stage;
        p.stage = stage;
        try {
          resetExecution(p, t.escalate.to, "deadline escalation");
        } catch (e) {
          p.stage = old;
          throw e;
        }
      }
      if (key === "escalation" && (t.escalate?.assignee || t.escalate?.role)) {
        const task = p.humanTasks?.[stage];
        if (task && !task.completedAt) {
          const pr = processOf(p);
          task.assignee =
            t.escalate.assignee ??
            Object.keys(pr.people ?? {})
              .filter((id) => pr.people![id]!.roles?.includes(t.escalate!.role!))
              .sort()[0];
        }
      }
      const id = `${stage}:${r.generation}:${key}`;
      p.alerts ??= [];
      if (!p.alerts.some((a) => a.id === id))
        p.alerts.push({
          id,
          stage,
          kind: key === "escalation" ? "escalation" : key === "due" ? "due" : "reminder",
          at: new Date(at).toISOString(),
          message:
            key === "escalation" ? (t.escalate?.message ?? `${stage} overdue: escalation required`) : `${stage}: ${key}`
        });
      r.fired.push(key);
      save(p);
      appendLedger(p.slug, { kind: "timer", stage, generation: r.generation, timer: key, scheduledAt: date });
      emitted++;
      if (key === "escalation" && t.escalate?.to) break;
    }
    if (!activeStages(p).includes(stage)) break;
  }
  return emitted;
}
/** Deliver external event `name`/`id` to the one active stage waiting for it with matching correlation (and generation,
 *  when given): copy its mapped outputs into case data and record a receipt. Returns false for a repeat of the same event;
 *  fails when the ID was used with other content, no or several stages match, or the stage already has its event. */
export function deliverEvent(
  p: Project,
  name: string,
  id: string,
  correlation: Scalar,
  data: Record<string, Scalar>,
  generation?: number
): boolean {
  const prior = p.events?.find((e) => e.id === id);
  if (prior) {
    if (
      prior.name !== name ||
      prior.correlation !== correlation ||
      JSON.stringify(Object.entries(prior.data).sort()) !== JSON.stringify(Object.entries(data).sort())
    )
      fail(`event id ${id} was already used with different content`);
    return false;
  }
  if (tickTimers(p)) save(p);
  const pr = processOf(p),
    candidates = activeStages(p).filter((stage) => {
      const e = pr.stages.find((s) => s.name === stage)!.event;
      return (
        e?.name === name &&
        (!e.requireGeneration || generation !== undefined) &&
        Object.hasOwn(p.data ?? {}, e.correlationField) &&
        p.data![e.correlationField] === correlation &&
        (!generation || runtimeOf(p, stage).generation === generation)
      );
    });
  if (candidates.length !== 1)
    fail(
      candidates.length
        ? "event matches multiple active stages"
        : "no active event wait matches name, correlation and generation"
    );
  const stage = candidates[0]!,
    e = pr.stages.find((s) => s.name === stage)!.event!,
    r = runtimeOf(p, stage);
  if (r.eventId) fail(`${stage} already received its event`);
  const patch = emptyRecord<Scalar>();
  for (const [destination, source] of Object.entries(e.outputs ?? {})) {
    if (!Object.hasOwn(data, source)) fail(`event payload is missing ${source}`);
    patch[destination] = data[source]!;
  }
  setData(p, patch);
  const receipt: EventReceipt = { id, name, stage, generation: r.generation, correlation, data, at: nowIso() };
  p.events ??= [];
  p.events.push(receipt);
  r.eventId = id;
  appendLedger(p.slug, { kind: "event", id, name, stage, generation: r.generation });
  return true;
}
/** Fail (GovernError, exit 2) unless the current stage's lifecycle lets it advance at `at`: its event received, its
 *  subprocess or foreach items synced, no uncertain check or compensation, no pending retry and retries not exhausted. */
export function requireLifecycleReady(p: Project, at = Date.now()): void {
  const s = processOf(p).stages.find((s) => s.name === p.stage)!;
  if (!s.event && !s.onError && !s.call && !s.foreach) return;
  const r = runtimeOf(p);
  if (s.event && !r.eventId) fail(`${p.stage} is waiting for event ${s.event.name}`);
  if (s.foreach && !r.batch?.synced)
    fail(`${p.stage} is waiting for foreach item completion (govern subprocess ${p.slug} ${p.stage})`);
  if (s.call && !r.childSynced)
    fail(`${p.stage} is waiting for subprocess completion (govern subprocess ${p.slug} ${p.stage})`);
  if (r.checkInFlight) fail(`${p.stage}: check outcome is uncertain; inspect its job and use govern recover`);
  if (r.compensation === "running" || r.compensation === "failed")
    fail(`${p.stage}: compensation ${r.compensation}; use govern recover with a human quote`);
  if (r.retryAt && Date.parse(r.retryAt) > at) fail(`${p.stage}: retry is scheduled for ${r.retryAt}`);
  if (r.failure && !r.retryAt) fail(`${p.stage}: retries exhausted; use govern recover`);
}
/** For a stage with an onError policy, count a new check attempt, mark the check in flight and save the lane; a no-op
 *  otherwise. */
export function beginAttempt(p: Project): void {
  const s = processOf(p).stages.find((s) => s.name === p.stage)!;
  if (!s.onError) return;
  const r = runtimeOf(p);
  r.attempts = (r.attempts ?? 0) + 1;
  r.checkInFlight = true;
  delete r.retryAt;
  save(p);
}
/** Clear the current stage's failure, scheduled retry and in-flight check flag. Does not save. */
export function checkSucceeded(p: Project): void {
  const r = p.runtime?.[p.stage];
  if (r) {
    delete r.failure;
    delete r.retryAt;
    delete r.checkInFlight;
  }
}
/** Run the current stage's onError compensation command as a job, once, recording running/done/failed in the runtime and
 *  the ledger. A no-op when none is declared or it already succeeded; fails when a prior run is uncertain, and fails
 *  (exit 1) when the command exits non-zero. */
export function compensate(p: Project): void {
  const s = processOf(p).stages.find((s) => s.name === p.stage)!,
    r = runtimeOf(p),
    command = s.onError?.compensate;
  if (!command) return;
  if (r.compensation === "done") return;
  if (r.compensation === "running")
    fail("compensation outcome is uncertain; a human must resolve it with govern recover");
  r.compensation = "running";
  save(p);
  let result: jobs.JobState;
  try {
    result = jobs.start(p, command, [], false);
  } catch (e) {
    r.compensation = "failed";
    save(p);
    throw e;
  }
  r.compensation = result.exit === 0 ? "done" : "failed";
  save(p);
  appendLedger(p.slug, { kind: "compensate", stage: p.stage, command, job: result.id, ok: result.exit === 0 });
  if (result.exit !== 0) fail(`compensation ${command} failed (${jobs.ending(result)})`, 1);
}
/** Record a failed exit check under the stage's onError policy: schedule a retry with exponential backoff while attempts
 *  remain, else run the compensation and reroute to the policy's `to` stage. Saves the lane; a no-op without a policy. */
export function checkFailed(p: Project, message: string, at = Date.now()): void {
  const s = processOf(p).stages.find((s) => s.name === p.stage)!,
    policy = s.onError;
  if (!policy) return;
  const r = runtimeOf(p);
  delete r.checkInFlight;
  r.failure = message;
  if (policy.retry && (r.attempts ?? 0) < policy.retry.attempts) {
    const delay =
      policy.retry.delaySeconds * Math.pow(policy.retry.multiplier ?? 1, Math.max(0, (r.attempts ?? 1) - 1));
    if (!Number.isFinite(delay) || delay > 315360000) fail("retry delay exceeds supported ten-year horizon");
    r.retryAt = new Date(at + delay * 1000).toISOString();
    save(p);
    appendLedger(p.slug, { kind: "retry-scheduled", stage: p.stage, attempt: r.attempts, at: r.retryAt });
    return;
  }
  delete r.retryAt;
  save(p);
  compensate(p);
  if (policy.to) resetExecution(p, policy.to, "exit check failed");
  save(p);
}
/** Human recovery of the current stage's failed or interrupted check: `retry` resets the attempt state; `compensated`
 *  records the declared compensation as done and reroutes to the onError destination. Appends a recover ledger entry. */
export function recover(p: Project, action: "retry" | "compensated", quote: string): void {
  requireActive(p);
  const r = runtimeOf(p);
  if (!r.failure && !r.checkInFlight) fail("stage has no failed or interrupted check to recover");
  if (action === "compensated") {
    if (!processOf(p).stages.find((s) => s.name === p.stage)!.onError?.compensate) fail("no compensation was declared");
    r.compensation = "done";
    const to = processOf(p).stages.find((s) => s.name === p.stage)!.onError?.to;
    if (to) resetExecution(p, to, "human confirmed compensation");
  } else {
    if (r.compensation === "running") fail("uncertain compensation must be resolved before retrying");
    r.attempts = 0;
    delete r.checkInFlight;
    delete r.failure;
    delete r.retryAt;
    delete r.compensation;
  }
  appendLedger(p.slug, { kind: "recover", stage: p.stage, action, quote });
}
/** Start (or return the existing) subprocess lane for call stage `stage`: check nesting depth and cycles, map inputs and
 *  output types, create the child lane under the parent's `__calls/` and save the parent. Returns the child's slug. */
export function startChild(p: Project, stage: string): string {
  requireActive(p, stage);
  const s = processOf(p).stages.find((s) => s.name === stage)!,
    call = s.call ?? fail(`${stage} has no subprocess call`),
    r = runtimeOf(p, stage);
  if (r.child) return r.child;
  const target = getProcess(call.process);
  let ancestor: Project | undefined = p;
  for (let depth = 0; ancestor; depth++) {
    if (depth >= 16) fail("subprocess nesting exceeds 16 levels");
    if (processOf(ancestor).name === target.name) fail("recursive subprocess cycle");
    ancestor = ancestor.invocation ? load(ancestor.invocation.parent) : undefined;
  }
  const data = emptyRecord<Value>();
  for (const [destination, source] of Object.entries(call.inputs ?? {})) {
    if (!Object.hasOwn(p.data ?? {}, source)) fail(`subprocess input ${source} is missing`);
    data[destination] = p.data![source]!;
  }
  for (const [destination, source] of Object.entries(call.outputs ?? {})) {
    if (!target.fields?.[source]) fail(`subprocess output field ${source} is not declared`);
    if (processOf(p).fields?.[destination]?.type !== target.fields[source]!.type)
      fail(`subprocess output ${source} has incompatible type`);
  }
  const child = `${p.slug}/__calls/${sha256(stage).slice(0, 16)}-${r.generation}`,
    invocation = { parent: p.slug, stage, generation: r.generation };
  transaction(child, () => {
    if (existsSync(stateFile(child))) {
      const existing = load(child);
      if (
        existing.invocation?.parent !== p.slug ||
        existing.invocation?.stage !== stage ||
        existing.invocation?.generation !== r.generation
      )
        fail("subprocess path already belongs to another invocation");
    } else
      create(child, {
        process: target.name,
        kind: call.kind,
        parent: p.slug,
        snapshot: freezeProcess(target),
        data,
        invocation
      });
  });
  r.child = child;
  save(p);
  appendLedger(p.slug, { kind: "subprocess-start", stage, child, generation: r.generation });
  return child;
}
/** Copy a finished subprocess's mapped outputs into the parent's case data, once; foreach stages delegate to syncItems.
 *  Starts the child if needed. Returns whether the stage's subprocess work is synced. */
export function syncChild(p: Project, stage: string): boolean {
  if (processOf(p).stages.find((s) => s.name === stage)?.foreach) return syncItems(p, stage);
  requireActive(p, stage);
  const child = startChild(p, stage),
    r = runtimeOf(p, stage);
  if (r.childSynced) return true;
  return transaction(child, () => {
    const c = load(child);
    if (c.invocation?.parent !== p.slug || c.invocation.stage !== stage || c.invocation.generation !== r.generation)
      fail("subprocess invocation mismatch");
    if (!c.finished) return false;
    const patch = emptyRecord<Value>(),
      call = processOf(p).stages.find((s) => s.name === stage)!.call!;
    for (const [destination, source] of Object.entries(call.outputs ?? {})) {
      if (!Object.hasOwn(c.data ?? {}, source)) fail(`finished subprocess is missing output ${source}`);
      patch[destination] = c.data![source]!;
    }
    setData(p, patch);
    r.childSynced = true;
    save(p);
    appendLedger(p.slug, { kind: "subprocess-sync", stage, child, fields: Object.keys(patch) });
    return true;
  });
}
/** Freeze the lane's current process definition into its snapshot, save and log it; a no-op when already pinned. */
export function pin(p: Project): void {
  if (p.processSnapshot) return;
  p.processSnapshot = freezeProcess(processOf(p));
  save(p);
  appendLedger(p.slug, { kind: "process-pin", revision: p.processSnapshot.revision, hash: p.processSnapshot.hash });
}
/** Move a pinned, unfinished lane to a higher revision of its process: rename stages through `map`, apply `patch` to case
 *  data (null deletes), reset approvals, votes, tasks and runtime, save and log the migration. Fails on any unsafe state
 *  (graph/linear change, active subprocesses, uncertain compensation, a dependent lane naming a renamed stage). */
export function migrate(
  p: Project,
  map: Record<string, string>,
  patch: Record<string, Value | null>,
  quote: string
): void {
  if (p.finished) fail("finished cases cannot migrate");
  if (!p.processSnapshot) fail("pin the existing process before migrating");
  const old = processOf(p),
    target = getProcess(old.name);
  if (!target.revision || target.revision <= p.processSnapshot.revision)
    fail("migration requires a higher declared process revision");
  if (isGraph(old) !== isGraph(target)) fail("migration must preserve linear versus graph execution");
  if (activeStages(p).some((s) => p.runtime?.[s]?.child || p.runtime?.[s]?.batch))
    fail("finish and advance active subprocess calls before migration");
  if (
    Object.values(p.runtime ?? {}).some(
      (r) => r.checkInFlight || r.compensation === "running" || r.compensation === "failed"
    )
  )
    fail("resolve compensation before migration");
  const oldNames = new Set(old.stages.map((s) => s.name)),
    targetNames = new Set(target.stages.map((s) => s.name));
  for (const [from, to] of Object.entries(map))
    if (!oldNames.has(from) || !targetNames.has(to)) fail(`invalid stage mapping ${from} → ${to}`);
  const rename = (id: string) => {
    const result = map[id] ?? id;
    if (!targetNames.has(result)) fail(`map removed stage ${id} explicitly`);
    return result;
  };
  for (const slug of laneSlugs())
    if (slug !== p.slug)
      for (const dep of load(slug).after ?? [])
        if (dep.lane === p.slug && dep.stage && rename(dep.stage) !== dep.stage)
          fail(`lane ${slug} depends on the old stage name ${dep.stage}; update that dependency before migration`);
  const candidate: Project = structuredClone(p);
  candidate.processSnapshot = freezeProcess(target);
  candidate.stage = rename(p.stage);
  if (candidate.workflow)
    for (const key of ["active", "completed", "waiting", "cancelled"] as const)
      candidate.workflow[key] = candidate.workflow[key].map(rename);
  if (candidate.workflow?.loops)
    candidate.workflow.loops = Object.fromEntries(
      Object.entries(candidate.workflow.loops).map(([id, n]) => [rename(id), n])
    );
  if (candidate.workflow?.joinExpected)
    candidate.workflow.joinExpected = Object.fromEntries(
      Object.entries(candidate.workflow.joinExpected).map(([id, preds]) => [rename(id), preds.map(rename)])
    );
  if (candidate.checks)
    candidate.checks = Object.fromEntries(Object.entries(candidate.checks).map(([s, c]) => [rename(s), c]));
  candidate.approvals = emptyRecord();
  candidate.votes = emptyRecord();
  candidate.humanTasks = emptyRecord();
  candidate.runtime = emptyRecord();
  candidate.events = (p.events ?? []).map((e) => ({ ...e, stage: rename(e.stage) }));
  candidate.alerts = (p.alerts ?? []).map((a) => ({ ...a, stage: rename(a.stage) }));
  // Stage generations increase to invalidate deliveries prepared against the old definition.
  for (const stage of activeStages(candidate)) {
    const prior = p.runtime?.[Object.keys(map).find((k) => map[k] === stage) ?? stage];
    if (
      prior &&
      target.stages.some((s) => s.name === stage && (s.timer || s.event || s.call || s.foreach || s.onError))
    )
      candidate.runtime[stage] = { ...prior, generation: prior.generation, deadlines: emptyRecord(), fired: [] };
  }
  candidate.data = Object.assign(emptyRecord<Value>(), p.data ?? {});
  const identities = new Set(target.gates.flatMap((g) => g.policy?.excludeFields ?? []));
  for (const [field, value] of Object.entries(patch)) {
    if (identities.has(field) && Object.hasOwn(p.data ?? {}, field) && value !== p.data![field])
      fail(`identity field ${field} cannot be changed during migration`);
    if (value === null) delete candidate.data[field];
    else candidate.data[field] = value;
  }
  enterRuntime(candidate, activeStages(candidate), true);
  enterTasks(candidate);
  save(candidate);
  Object.assign(p, candidate);
  appendLedger(p.slug, {
    kind: "process-migrate",
    from: old.revision ?? 1,
    to: target.revision,
    hash: candidate.processSnapshot.hash,
    map,
    quote
  });
}
