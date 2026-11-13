// What the lanes wait on from people, and where each of those decisions stands. Both the notifier (notify.ts) and the
// decision server (slack.ts) use this: the notifier to post and close messages, the server to say on the clicked message
// who decided and whether it still waits on others.
import type { Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { activeStages, eligibleHuman, eligibleApprover, gateApproved } from "../../lib/business.ts";
import type { GateOption, Scalar } from "../../lib/business-schema.ts";
import type { Decision, Target } from "./slack.ts";

/** One thing a lane waits on from people: a human task or a gate, who may decide it, and how. */
export interface Pending { key: string; lane: string; target: Target; decisions: Decision[]; people: string[];
  /** A gate's approve options as they stand on the case: each its label and the fields it sets. */
  options?: { label: string; set: Record<string, Scalar>; edit?: string[] }[] }

/** A gate option's case data as it stands on `p`: {data.FIELD} in a string value filled from the case ("" when absent). */
export function optionSet(o: GateOption, p: Pick<Project, "data">): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(o.set).map(([k, v]) => [k, typeof v === "string"
    ? v.replace(/\{data\.([^{}]+)\}/g, (_m, f: string) => { const x = p.data?.[f]; return x === undefined ? "" : String(x); }) : v]));
}

/** What `p` waits on from people now: its active human tasks not completed (for the assignee, else everyone eligible),
 *  and its gates at an active stage (or with no stage) whose needed gates are approved and which are not approved yet. */
export function pending(p: Project): Pending[] {
  if (p.finished) return [];
  const pr = processOf(p), people = Object.keys(pr.people ?? {}), active = activeStages(p), out: Pending[] = [];
  for (const stage of active) {
    if (!pr.stages.find((s) => s.name === stage)?.human) continue;
    const task = p.humanTasks?.[stage];
    if (task?.completedAt) continue;
    out.push({ key: `${p.slug}:task:${stage}`, lane: p.slug, target: { task: stage }, decisions: ["complete"],
      people: task?.assignee ? [task.assignee] : people.filter((id) => eligibleHuman(pr, stage, id)) });
  }
  for (const g of pr.gates) {
    if ((g.stage && !active.includes(g.stage)) || gateApproved(p, g)) continue;
    if ((g.needs ?? []).some((n) => !gateApproved(p, pr.gates.find((x) => x.name === n)))) continue;
    const excluded = new Set((g.policy?.excludeFields ?? []).map((f) => String(p.data?.[f])));
    const owner = g.owner ?? "owner";
    out.push({ key: `${p.slug}:gate:${g.name}`, lane: p.slug, target: { gate: g.name },
      decisions: g.policy ? ["approve", "reject"] : ["approve"],
      ...(g.options ? { options: g.options.map((o) => ({ label: o.label, set: optionSet(o, p), ...(o.edit ? { edit: o.edit } : {}) })) } : {}),
      people: g.policy ? people.filter((id) => eligibleApprover(pr, g, id) && !excluded.has(id)) : people.includes(owner) ? [owner] : [] });
  }
  return out;
}

/** The target a notifier key (`lane:task:stage`, `lane:gate:name`) names, or undefined for any other key. */
export function targetOf(key: string, lane: string): Target | undefined {
  if (!key.startsWith(`${lane}:`)) return undefined;
  const rest = key.slice(lane.length + 1), i = rest.indexOf(":"), kind = rest.slice(0, i), name = rest.slice(i + 1);
  return i < 1 || !name ? undefined : kind === "task" ? { task: name } : kind === "gate" ? { gate: name } : undefined;
}

/** Where the decision on `target` stands on `p`, in Slack mrkdwn (people mentioned by their Slack id when mapped):
 *  who completed the task, who approved or sent back the gate, or how many of a policy's quorum approved so far.
 *  Undefined when nobody has decided anything yet. Progress counts distinct approvers the policy makes eligible. */
export function standing(p: Project, target: Target): string | undefined {
  const pr = processOf(p), who = (id: string) => (pr.people?.[id]?.slack ? `<@${pr.people[id]!.slack}>` : id);
  if ("task" in target) {
    const by = p.humanTasks?.[target.task]?.completedBy;
    return by ? `Done by ${who(by)}` : undefined;
  }
  const g = pr.gates.find((x) => x.name === target.gate);
  if (!g) return undefined;
  if (!g.policy) { const a = p.approvals[g.name]; return a ? `Approved by ${who(a.by ?? g.owner ?? "owner")}` : undefined; }
  const votes = (p.votes?.[g.name] ?? []).filter((v) => eligibleApprover(pr, g, v.by));
  const by = (d: "approve" | "reject") => [...new Set(votes.filter((v) => v.decision === d).map((v) => v.by))];
  const approvers = by("approve"), rejecters = by("reject");
  if (gateApproved(p, g)) return `Approved by ${approvers.map(who).join(", ")}`;
  if (rejecters.length) return `Sent back by ${rejecters.map(who).join(", ")}`;
  return approvers.length ? `${approvers.length}/${g.policy.quorum} approvals: ${approvers.map(who).join(", ")}` : undefined;
}

/** The block_id of the buttons govern posts, and of the line saying where the decision stands. */
export const ACTIONS_BLOCK = "govern", OUTCOME_BLOCK = "govern.outcome";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `blocks` (a message as posted) with `line` as its one outcome line: above the buttons when `keepButtons`, else at the
 *  end with the buttons removed. An earlier outcome line is replaced. Undefined when `blocks` is not a list of blocks,
 *  so a caller never invents a message it was not given. */
export function settled(blocks: unknown, line: string, keepButtons: boolean): Record<string, unknown>[] | undefined {
  if (!Array.isArray(blocks) || !blocks.length || !blocks.every(object)) return undefined;
  const kept = blocks.filter((b) => b.block_id !== OUTCOME_BLOCK && (keepButtons || b.block_id !== ACTIONS_BLOCK));
  const outcome = { type: "context", block_id: OUTCOME_BLOCK, elements: [{ type: "mrkdwn", text: line.slice(0, 3000) }] };
  const at = keepButtons ? kept.findIndex((b) => b.block_id === ACTIONS_BLOCK) : -1;
  return at < 0 ? [...kept, outcome] : [...kept.slice(0, at), outcome, ...kept.slice(at)];
}
