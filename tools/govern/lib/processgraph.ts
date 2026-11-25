// A govern process as a BPMN graph, laid out and routed: pure and deterministic (the same process always gives the same
// boxes and flows). Stages sit in an "agents" lane in order (graph processes by depth, parallel stages in rows); a
// stage's check is a service task and an XOR gateway in a "checks" lane; every gate is a user task in the lane of its
// owner, placed after the stage it holds and after the gates it needs; `next` routes are flows (conditions are
// labels), a split or a join is a parallel gateway. Flows are orthogonal and routed around every box.
import type { Process, StageDef, GateDef } from "./process.ts";
import { routeTargets, type Condition } from "./business-schema.ts";
import { clip } from "./util.ts";

export type NodeKind = "start" | "end" | "stage" | "human" | "subprocess" | "check" | "gateway" | "parallel" | "gate";
export type EdgeKind = "flow" | "pass" | "fail" | "needs" | "route";
export type Side = "top" | "right" | "bottom" | "left";
export interface Pt { x: number; y: number }
export interface Box { id: string; kind: NodeKind; lane: string; x: number; y: number; w: number; h: number; label: string; sub?: string; stage?: string; gate?: string }
export interface Flow { id: string; kind: EdgeKind; from: string; to: string; label?: string; points: Pt[]; labelAt?: Pt }
export interface LaneBand { id: string; title: string; subtitle: string; slot: number; y: number; h: number }
export interface Layout { name: string; revision?: number; description: string; width: number; height: number; labelW: number; lanes: LaneBand[]; boxes: Box[]; flows: Flow[] }

// ── sizes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const SIZE = {
  task: { w: 210, h: 132 }, check: { w: 210, h: 120 }, gate: { w: 200, h: 112 }, gw: 56, event: 56,
  pad: 24, gwSpace: 100, gap: 18, join: 90, split: 70, laneLabel: 170, header: 96, footer: 56, laneGap: 44, rowGap: 36,
};

/** A routing condition as short text: `field = value`, joined by and / or. */
export function conditionLabel(c: Condition): string {
  if ("all" in c) return c.all.map(conditionLabel).join(" and ");
  if ("any" in c) return c.any.map(conditionLabel).join(" or ");
  if ("not" in c) return `not (${conditionLabel(c.not)})`;
  const ops = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "in", contains: "contains", exists: "exists" } as const;
  if (c.op === "exists") return `${c.field} exists`;
  return `${c.field} ${ops[c.op]} ${Array.isArray(c.value) ? `[${c.value.join(", ")}]` : String(c.value)}`;
}

// ── the graph ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface GNode { id: string; kind: NodeKind; lane: string; label: string; sub?: string; stage?: string; gate?: string; depth: number; row: number; slot?: number; w: number; h: number }
export interface GEdge { id: string; kind: EdgeKind; from: string; to: string; label?: string; fromSide?: Side; toSide?: Side; toFrac?: number }

const stageSub = (s: StageDef): string | undefined => {
  const bits = [s.human ? `human: ${s.human.assignee ?? `role ${s.human.role}`}` : "", s.call ? `runs process ${s.call.process}` : "",
    s.timer ? `timer ${s.timer.afterSeconds}s` : "", s.event ? `waits for ${s.event.name}` : "", s.exit ?? ""].filter(Boolean);
  return bits.length ? clip(bits.join(" · "), 110) : undefined;
};

/** The lane key of a gate's owner. */
const gateLane = (g: GateDef) => g.owner ?? "owner";

/** `slots`, `split`, `join`, `space`: per column, how many gate slots, whether a stage splits, joins, or needs room for a gateway. */
export interface Graph { nodes: GNode[]; edges: GEdge[]; laneKeys: string[]; columns: number; slots: number[]; split: boolean[]; join: boolean[]; space: boolean[]; rows: number }

/** The process as nodes and edges, each node knowing its column (depth) and row; no coordinates yet. */
export function buildGraph(p: Process): Graph {
  const S = p.stages, n = S.length, at = new Map(S.map((s, i) => [s.name, i]));
  // stage-to-stage edges
  interface SE { from: number; to: number | "end"; label?: string; split?: string }
  const se: SE[] = [];
  S.forEach((s, i) => {
    if (s.next === undefined) { se.push({ from: i, to: i + 1 < n ? i + 1 : "end" }); return; }
    if (!s.next.length) { se.push({ from: i, to: "end" }); return; }
    const conditional = s.next.some((r) => r.when || r.branches);
    s.next.forEach((r, k) => {
      const label = r.loop ? `loop ≤ ${r.loop.maxIterations}${r.loop.stallOn ? ", stops if " + r.loop.stallOn.join("/") + " unchanged" : ""}` : r.when ? clip(conditionLabel(r.when), 40) : conditional ? "else" : undefined;
      const targets = r.branches ? r.branches.map((b) => ({ to: b.to, label: clip(conditionLabel(b.when), 40) })) : routeTargets(r).map((to) => ({ to, label }));
      const split = r.to.length > 1 || (r.branches?.length ?? 0) > 1 ? `${i}.${k}` : undefined;
      for (const t of targets) se.push({ from: i, to: at.get(t.to) ?? "end", ...(t.label ? { label: t.label } : {}), ...(split ? { split } : {}) });
    });
  });
  // one column per stage, in stage order: parallel branches sit side by side, each with its check straight below
  const depth = S.map((_, i) => i), row = S.map(() => 0), rowCount = new Map<number, number>([[0, 1]]);
  const D = n;
  const hasJoin = S.map((s) => !!s.join), hasSplit = S.map((_, i) => se.some((e) => e.from === i && e.split !== undefined));
  // gates held by each stage; level by needs held at the same stage; slot unique per (column, lane)
  const byName = new Map(p.gates.map((g) => [g.name, g]));
  const gateStage = (g: GateDef) => (g.stage !== undefined ? at.get(g.stage)! : n - 1);
  const held = S.map((_, i) => p.gates.filter((g) => gateStage(g) === i));
  const slotOf = new Map<string, number>(), taken = new Set<string>(), slots = Array.from({ length: D }, () => 0);
  held.forEach((gs, i) => {
    const todo = [...gs];
    while (todo.length) {
      const ready = todo.findIndex((g) => (g.needs ?? []).every((x) => !gs.includes(byName.get(x)!) || slotOf.has(x)));
      const g = todo.splice(ready < 0 ? 0 : ready, 1)[0]!;
      let s = Math.max(-1, ...(g.needs ?? []).filter((x) => slotOf.has(x) && gs.includes(byName.get(x)!)).map((x) => slotOf.get(x)!)) + 1;
      while (taken.has(`${depth[i]}|${gateLane(g)}|${s}`)) s++;
      taken.add(`${depth[i]}|${gateLane(g)}|${s}`); slotOf.set(g.name, s);
      slots[depth[i]!] = Math.max(slots[depth[i]!]!, s + 1);
    }
  });
  const nodes: GNode[] = [], edges: GEdge[] = [];
  const add = (x: GNode) => { nodes.push(x); return x; };
  const lanes = new Set<string>(["agents"]);
  add({ id: "start", kind: "start", lane: "agents", label: "start", depth: -1, row: 0, w: SIZE.event, h: SIZE.event });
  const exits: string[][] = [], entries: string[] = [];
  const space = Array.from({ length: D }, () => false);
  S.forEach((s, i) => {
    const kind: NodeKind = s.human ? "human" : s.call ? "subprocess" : "stage";
    add({ id: `s:${s.name}`, kind, lane: "agents", label: s.name, ...(stageSub(s) ? { sub: stageSub(s)! } : {}), stage: s.name, depth: depth[i]!, row: row[i]!, w: SIZE.task.w, h: SIZE.task.h });
    entries[i] = `s:${s.name}`;
    if (hasJoin[i]) {
      add({ id: `j:${s.name}`, kind: "parallel", lane: "agents", label: `join ${s.join!.mode === "any" ? "any" : "all"}`, stage: s.name, depth: depth[i]!, row: row[i]!, w: SIZE.gw, h: SIZE.gw });
      edges.push({ id: `e:j:${s.name}`, kind: "flow", from: `j:${s.name}`, to: `s:${s.name}` });
      entries[i] = `j:${s.name}`;
    }
    let out = [`s:${s.name}`];
    if (s.check) {
      lanes.add("checks");
      space[depth[i]!] = true;
      add({ id: `c:${s.name}`, kind: "check", lane: "checks", label: `check ${s.name}`, sub: `command ${s.check}`, stage: s.name, depth: depth[i]!, row: row[i]!, w: SIZE.check.w, h: SIZE.check.h });
      add({ id: `x:${s.name}`, kind: "gateway", lane: "checks", label: `${s.name} check result`, stage: s.name, depth: depth[i]!, row: row[i]!, w: SIZE.gw, h: SIZE.gw });
      edges.push({ id: `e:c:${s.name}`, kind: "flow", from: `s:${s.name}`, to: `c:${s.name}`, fromSide: "bottom", toSide: "top" },
        { id: `e:x:${s.name}`, kind: "flow", from: `c:${s.name}`, to: `x:${s.name}`, fromSide: "right", toSide: "left" },
        { id: `e:f:${s.name}`, kind: "fail", from: `x:${s.name}`, to: `s:${s.name}`, label: "gap", fromSide: "bottom", toSide: "left", toFrac: 0.82 });
      out = [`x:${s.name}`];
    }
    // gates: first by no needs held here, then each after the gates it needs
    const gs = held[i]!;
    if (gs.length) space[depth[i]!] = true;
    for (const g of gs) {
      lanes.add(gateLane(g));
      add({ id: `g:${g.name}`, kind: "gate", lane: gateLane(g), label: `approve ${g.name}`,
        sub: [`by ${gateLane(g)}`, ...(g.needs?.length ? [`needs ${g.needs.join(", ")}`] : [])].join(" · "), stage: g.stage ?? S[n - 1]!.name, gate: g.name, depth: depth[i]!, row: 0, slot: slotOf.get(g.name)!, w: SIZE.gate.w, h: SIZE.gate.h });
    }
    const local = new Set(gs.map((g) => g.name));
    for (const g of gs) {
      const inner = (g.needs ?? []).filter((x) => local.has(x));
      if (!inner.length) edges.push({ id: `e:in:${g.name}`, kind: out[0]!.startsWith("x:") ? "pass" : "flow", from: out[0]!, to: `g:${g.name}`, ...(out[0]!.startsWith("x:") ? { label: "pass", fromSide: "top" as Side } : {}), toSide: "left" });
      for (const x of inner) edges.push({ id: `e:need:${x}:${g.name}`, kind: "needs", from: `g:${x}`, to: `g:${g.name}`, toSide: "left" });
    }
    if (gs.length) out = gs.filter((g) => !gs.some((h) => (h.needs ?? []).includes(g.name))).map((g) => `g:${g.name}`);
    exits[i] = out;
  });
  // stage-to-stage flows, through a parallel split when a route starts several stages
  const splits = new Map<string, string>();
  se.forEach((e, k) => {
    const src = S[e.from]!;
    const tgt = e.to === "end" ? "end" : entries[e.to]!;
    const back = e.to !== "end" && e.to <= e.from;
    let from = exits[e.from]!;
    if (e.split !== undefined) {
      const id = `p:${src.name}:${e.split}`;
      if (!splits.has(e.split + src.name)) {
        splits.set(e.split + src.name, id);
        add({ id, kind: "parallel", lane: "agents", label: "split", stage: src.name, depth: depth[e.from]!, row: row[e.from]!, slot: -1, w: SIZE.gw, h: SIZE.gw });
        from.forEach((f, m) => edges.push({ id: `e:sp:${id}:${m}`, kind: "flow", from: f, to: id, ...(f.startsWith("x:") ? { label: "pass", fromSide: "top" as Side, kind: "pass" as EdgeKind } : {}) }));
      }
      from = [id];
    }
    from.forEach((f, m) => {
      const gw = f.startsWith("x:") && e.split === undefined;
      const label = e.label ?? (gw ? "pass" : undefined);
      edges.push({ id: `e:r:${k}:${m}`, kind: back ? "route" : gw ? "pass" : "flow", from: f, to: tgt, ...(label ? { label } : {}),
        ...(gw ? { fromSide: "top" as Side } : {}), ...(back ? { fromSide: "top" as Side, toSide: "top" as Side } : {}) });
    });
  });
  // start flows into the first stage; the end event follows every terminal stage
  edges.unshift({ id: "e:start", kind: "flow", from: "start", to: entries[0]! });
  const endDepth = D;
  if (se.some((e) => e.to === "end")) add({ id: "end", kind: "end", lane: "agents", label: "end", depth: endDepth, row: 0, w: SIZE.event, h: SIZE.event });
  const hasOwner = lanes.has("owner"), hasCoord = lanes.has("coordinator");
  const other = [...lanes].filter((l) => !["owner", "coordinator", "agents", "checks"].includes(l)).sort();
  const laneKeys = [...(hasOwner ? ["owner"] : []), ...(hasCoord ? ["coordinator"] : []), ...other, "agents", ...(lanes.has("checks") ? ["checks"] : [])];
  const colOf = (f: (i: number) => boolean) => Array.from({ length: D }, (_, d) => S.some((_s, i) => depth[i] === d && f(i)));
  return { nodes, edges, laneKeys, columns: D, slots, split: colOf((i) => hasSplit[i]!), join: colOf((i) => hasJoin[i]!),
    space: space.map((v, d) => v || colOf((i) => hasSplit[i]!)[d]!), rows: Math.max(1, ...rowCount.values()) };
}
