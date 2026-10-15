// Place a process graph (lib/processgraph.ts) on lanes and route its flows: columns by depth, rows for parallel
// stages, gates in their owner's lane after the stage they hold, and an orthogonal router that goes around every box.
// Pure and deterministic.
import type { Process } from "./process.ts";
import { buildGraph, SIZE, type Box, type Flow, type GEdge, type LaneBand, type Layout, type Pt, type Side } from "./processgraph.ts";

const MARGIN = 10, STUB = 26, BEND = 70;

const LANE_TITLES: Record<string, [string, string]> = {
  owner: ["Owner", "decides the owner gates"], coordinator: ["Coordinator", "orchestrates; decides its gates"],
  agents: ["Worker agents", "the stages, in order"], checks: ["Stage checks", "commands, no model"],
};
const laneTitle = (k: string): [string, string] => LANE_TITLES[k] ?? [k.charAt(0).toUpperCase() + k.slice(1), "decides its gates"];
const FIXED = ["owner", "coordinator", "agents", "checks"];
/** The colour slot of a lane: owner, coordinator, agents and checks have their own; any other owner cycles through four more. */
export const laneSlot = (k: string, keys: string[]): number =>
  ({ owner: 0, coordinator: 1, agents: 2, checks: 3 } as Record<string, number>)[k] ?? 4 + (keys.filter((x) => !FIXED.includes(x)).indexOf(k) % 4);

const r1 = (v: number) => Math.round(v * 10) / 10;
type R = { x0: number; y0: number; x1: number; y1: number };
const rect = (b: { x: number; y: number; w: number; h: number }, m: number): R => ({ x0: b.x - m, y0: b.y - m, x1: b.x + b.w + m, y1: b.y + b.h + m });
const inside = (r: R, x: number, y: number) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const SIDE_DIR: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };
const out = (s: Side): Pt => DIRS[SIDE_DIR[s]]!;

interface Heap { push(f: number, id: number): void; pop(): number | undefined }
function heap(): Heap {
  const a: [number, number, number][] = []; let seq = 0;
  const less = (i: number, j: number) => a[i]![0] < a[j]![0] || (a[i]![0] === a[j]![0] && a[i]![1] < a[j]![1]);
  return {
    push(f, id) { a.push([f, seq++, id]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(i, p)) break; [a[i], a[p]] = [a[p]!, a[i]!]; i = p; } },
    pop() {
      if (!a.length) return undefined;
      const top = a[0]![2], last = a.pop()!;
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && less(l, m)) m = l; if (r < a.length && less(r, m)) m = r; if (m === i) break; [a[i], a[m]] = [a[m]!, a[i]!]; i = m; } }
      return top;
    },
  };
}

/** An orthogonal router on the grid of box edges and port lines: the shortest path with a bend penalty, around every
 *  box, with a penalty for running along a line another flow already uses. */
class Router {
  xs: number[]; ys: number[]; nx: number; ny: number; ok: Uint8Array; hOpen: Uint8Array; vOpen: Uint8Array; used = new Map<number, number>();
  constructor(boxes: Box[], px: number[], py: number[]) {
    const X = new Set<number>(px), Y = new Set<number>(py);
    for (const b of boxes) { X.add(r1(b.x - MARGIN)); X.add(r1(b.x + b.w + MARGIN)); Y.add(r1(b.y - MARGIN)); Y.add(r1(b.y + b.h + MARGIN)); }
    this.xs = [...X].sort((a, b) => a - b); this.ys = [...Y].sort((a, b) => a - b);
    this.nx = this.xs.length; this.ny = this.ys.length;
    const infl = boxes.map((b) => rect(b, MARGIN)), blocked = (x: number, y: number) => infl.some((r) => inside(r, x, y));
    this.ok = new Uint8Array(this.nx * this.ny); this.hOpen = new Uint8Array(this.nx * this.ny); this.vOpen = new Uint8Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) this.ok[j * this.nx + i] = blocked(this.xs[i]!, this.ys[j]!) ? 0 : 1;
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      const n = j * this.nx + i;
      if (i + 1 < this.nx && this.ok[n] && this.ok[n + 1] && !blocked((this.xs[i]! + this.xs[i + 1]!) / 2, this.ys[j]!)) this.hOpen[n] = 1;
      if (j + 1 < this.ny && this.ok[n] && this.ok[n + this.nx] && !blocked(this.xs[i]!, (this.ys[j]! + this.ys[j + 1]!) / 2)) this.vOpen[n] = 1;
    }
  }
  private index(v: number, list: number[]) { let lo = 0, hi = list.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m]! < v - 1e-6) lo = m + 1; else hi = m - 1; } return lo; }
  node(p: Pt): number { return this.index(p.y, this.ys) * this.nx + this.index(p.x, this.xs); }
  coord(n: number): Pt { return { x: this.xs[n % this.nx]!, y: this.ys[Math.floor(n / this.nx)]! }; }
  /** From `start` leaving in direction `d0` to `goal`, entered travelling in `dg`: the points of the path, or undefined. */
  find(start: Pt, d0: number, goal: Pt, dg: number): Pt[] | undefined {
    const s = this.node(start), g = this.node(goal), N = this.nx * this.ny;
    if (!this.ok[s] || !this.ok[g]) return undefined;
    const dist = new Float64Array(N * 4).fill(Infinity), prev = new Int32Array(N * 4).fill(-1), q = heap();
    const gc = this.coord(g), h = (n: number) => { const c = this.coord(n); return Math.abs(c.x - gc.x) + Math.abs(c.y - gc.y); };
    dist[s * 4 + d0] = 0; q.push(h(s), s * 4 + d0);
    for (let id = q.pop(); id !== undefined; id = q.pop()) {
      const n = id >> 2, d = id & 3, here = dist[id]!;
      if (n === g && d === dg) { const pts: Pt[] = []; for (let c = id; c >= 0; c = prev[c]!) pts.push(this.coord(c >> 2)); return pts.reverse(); }
      const c = this.coord(n);
      if (n === g && (d + dg) % 2 === 1 && here + BEND < dist[g * 4 + dg]!) { dist[g * 4 + dg] = here + BEND; prev[g * 4 + dg] = id; q.push(here + BEND, g * 4 + dg); }
      for (const nd of [d, (d + 1) & 3, (d + 3) & 3]) {
        const dx = DIRS[nd]!.x, dy = DIRS[nd]!.y, i = n % this.nx, j = Math.floor(n / this.nx);
        let m: number, open: number;
        if (dx === 1) { m = n + 1; open = this.hOpen[n]!; } else if (dx === -1) { m = n - 1; open = i > 0 ? this.hOpen[n - 1]! : 0; }
        else if (dy === 1) { m = n + this.nx; open = this.vOpen[n]!; } else { m = n - this.nx; open = j > 0 ? this.vOpen[n - this.nx]! : 0; }
        if (!open) continue;
        const e = this.coord(m), len = Math.abs(e.x - c.x) + Math.abs(e.y - c.y);
        const key = Math.min(n, m) * 2 + (dx !== 0 ? 0 : 1), reuse = (this.used.get(key) ?? 0) * (len * 0.6 + 12);
        const cost = here + len + (nd !== d ? BEND : 0) + reuse;
        if (cost < dist[m * 4 + nd]!) { dist[m * 4 + nd] = cost; prev[m * 4 + nd] = id; q.push(cost + h(m), m * 4 + nd); }
      }
    }
    return undefined;
  }
  /** Mark the grid lines a finished path runs along, so later flows keep off them where they can. */
  mark(path: Pt[]): void {
    for (let k = 0; k + 1 < path.length; k++) {
      const a = this.node(path[k]!), b = this.node(path[k + 1]!), horizontal = path[k]!.y === path[k + 1]!.y, step = horizontal ? 1 : this.nx;
      for (let n = Math.min(a, b); n < Math.max(a, b); n += step) { const key = n * 2 + (horizontal ? 0 : 1); this.used.set(key, (this.used.get(key) ?? 0) + 1); }
    }
  }
}

/** The corners of a path with the collinear points dropped. */
export function simplify(pts: Pt[]): Pt[] {
  const res: Pt[] = [];
  for (const p of pts) {
    const a = res[res.length - 1], b = res[res.length - 2];
    if (a && a.x === p.x && a.y === p.y) continue;
    if (a && b && ((a.x === b.x && a.x === p.x) || (a.y === b.y && a.y === p.y))) res[res.length - 1] = p; else res.push(p);
  }
  return res;
}

interface End { e: GEdge; which: "from" | "to"; b: Box; side: Side; frac?: number; other: Pt; index: number }

/** Lay out `p`: lanes, boxes and routed flows. */
export function layout(p: Process): Layout {
  const g = buildGraph(p), Z = SIZE, D = g.columns;
  // x: stages left to right by depth; gates go into their owner's lane after the gateway of the stage they hold, after
  // the gates they need and after the lane's previous gate, and may stand over the columns that follow.
  const startW = Z.event + 2 * Z.pad + 30;
  const x0: number[] = [], cxOf = new Map<string, number>(), laneRight = new Map<string, number>();
  let cursor = Z.laneLabel + 10 + startW, need = -Infinity, maxRight = 0;
  for (let d = 0; d < D; d++) {
    const joinW = g.join[d] ? Z.join : 0, space = g.space[d] ? Z.gwSpace : 60;
    x0[d] = Math.max(cursor + Z.pad + joinW, need + (g.join[d] ? Z.join / 2 + 8 + 30 : 20 - Z.task.w / 2));
    const base = x0[d]! + Z.task.w + Z.gwSpace / 2 + 56 + Z.gate.w / 2;
    const here = g.nodes.filter((n) => n.kind === "gate" && n.depth === d).sort((a, b) => a.slot! - b.slot!);
    let termRight = -Infinity;
    for (const n of here) {
      const needed = g.edges.filter((e) => e.kind === "needs" && e.to === n.id).map((e) => cxOf.get(e.from)! + Z.gate.w / 2 + Z.gap + Z.gate.w / 2);
      const c = Math.max(base, (laneRight.get(n.lane) ?? -Infinity) + Z.gap + Z.gate.w / 2, ...needed);
      cxOf.set(n.id, c); laneRight.set(n.lane, c + Z.gate.w / 2); maxRight = Math.max(maxRight, c + Z.gate.w / 2);
      if (!g.edges.some((e) => e.kind === "needs" && e.from === n.id)) termRight = Math.max(termRight, c + Z.gate.w / 2);
    }
    let right = x0[d]! + Z.task.w + space;
    for (const n of g.nodes.filter((x) => x.kind === "parallel" && x.slot === -1 && x.depth === d)) {
      const c = Math.max(x0[d]! + Z.task.w + Z.gwSpace, termRight + 30) + Z.split / 2; cxOf.set(n.id, c); right = Math.max(right, c + Z.split / 2);
    }
    need = Math.max(need, termRight);
    cursor = right + Z.pad - joinW * 0;
    maxRight = Math.max(maxRight, right);
  }
  const endCx = Math.max(cursor, maxRight + 40) + Z.event / 2 + 10, width = endCx + Z.event / 2 + Z.pad + 20, startCx = Z.laneLabel + 10 + startW / 2;
  // y: the lanes
  const lanes: LaneBand[] = []; let y = Z.header;
  const laneH = (k: string) => k === "agents" ? 2 * Z.laneGap + g.rows * Z.task.h + (g.rows - 1) * Z.rowGap
    : k === "checks" ? 2 * Z.laneGap + g.rows * Z.check.h + (g.rows - 1) * Z.rowGap + 60 : Z.gate.h + 2 * Z.laneGap;
  for (const k of g.laneKeys) { const [title, subtitle] = laneTitle(k), h = laneH(k); lanes.push({ id: k, title, subtitle, slot: laneSlot(k, g.laneKeys), y, h }); y += h; }
  const height = y + Z.footer;
  const band = new Map(lanes.map((l) => [l.id, l]));
  const rowY = (k: string, row: number, h: number) => band.get(k)!.y + Z.laneGap + row * (h + Z.rowGap) + h / 2;
  const boxes: Box[] = g.nodes.map((n) => {
    let cx: number, cy: number;
    const d = n.depth;
    if (n.kind === "start") { cx = startCx; cy = rowY("agents", 0, Z.task.h); }
    else if (n.kind === "end") { cx = endCx; cy = rowY("agents", 0, Z.task.h); }
    else if (n.kind === "gate") { const l = band.get(n.lane)!; cx = cxOf.get(n.id)!; cy = l.y + l.h / 2; }
    else if (n.kind === "check") { cx = x0[d]! + Z.task.w / 2; cy = rowY("checks", n.row, Z.check.h); }
    else if (n.kind === "gateway") { cx = x0[d]! + Z.task.w + Z.gwSpace / 2; cy = rowY("checks", n.row, Z.check.h); }
    else if (n.kind === "parallel") { cy = rowY("agents", n.row, Z.task.h); cx = n.slot === -1 ? cxOf.get(n.id)! : x0[d]! - Z.join / 2 - 8; }
    else { cx = x0[d]! + Z.task.w / 2; cy = rowY("agents", n.row, Z.task.h); }
    return { id: n.id, kind: n.kind, lane: n.lane, x: r1(cx - n.w / 2), y: r1(cy - n.h / 2), w: n.w, h: n.h, label: n.label, ...(n.sub ? { sub: n.sub } : {}), ...(n.stage ? { stage: n.stage } : {}), ...(n.gate ? { gate: n.gate } : {}) };
  });
  const box = new Map(boxes.map((b) => [b.id, b]));
  const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const ends: End[] = [];
  g.edges.forEach((e, index) => {
    const A = box.get(e.from)!, B = box.get(e.to)!, east = B.x >= A.x + A.w - 1;
    const from: Side = e.fromSide ?? (east ? "right" : B.y >= A.y + A.h ? "bottom" : "top");
    const to: Side = e.toSide ?? (east ? "left" : B.y >= A.y + A.h ? "top" : "bottom");
    ends.push({ e, which: "from", b: A, side: from, other: centre(B), index }, { e, which: "to", b: B, side: to, other: centre(A), index, ...(e.toFrac !== undefined ? { frac: e.toFrac } : {}) });
  });
  const portOf = new Map<End, Pt>(), groups = new Map<string, End[]>();
  for (const en of ends) { const k = `${en.b.id}|${en.side}`; const list = groups.get(k) ?? []; list.push(en); groups.set(k, list); }
  for (const list of groups.values()) {
    const fixed = list.filter((x) => x.frac !== undefined), free = list.filter((x) => x.frac === undefined), first = list[0]!;
    const vertical = first.side === "left" || first.side === "right";
    free.sort((a, b) => (vertical ? a.other.y - b.other.y || a.other.x - b.other.x : a.other.x - b.other.x || a.other.y - b.other.y) || a.index - b.index);
    const small = ["gateway", "parallel", "start", "end"].includes(first.b.kind);
    const put = (en: End, f: number) => {
      const b = en.b;
      portOf.set(en, en.side === "left" ? { x: b.x, y: r1(b.y + b.h * f) } : en.side === "right" ? { x: b.x + b.w, y: r1(b.y + b.h * f) }
        : en.side === "top" ? { x: r1(b.x + b.w * f), y: b.y } : { x: r1(b.x + b.w * f), y: b.y + b.h });
    };
    free.forEach((en, i) => put(en, small ? 0.5 : 0.22 + 0.5 * ((i + 1) / (free.length + 1))));
    for (const en of fixed) put(en, en.frac!);
  }
  const stub = (en: End): Pt => { const p0 = portOf.get(en)!, o = out(en.side); return { x: r1(p0.x + o.x * STUB), y: r1(p0.y + o.y * STUB) }; };
  const px: number[] = [], py: number[] = [];
  for (const en of ends) { const a = portOf.get(en)!, s = stub(en); px.push(a.x, s.x); py.push(a.y, s.y); }
  const router = new Router(boxes, px, py), flows: Flow[] = [];
  const crossing = (a: Pt, b: Pt, skip: Set<string>) => boxes.some((bx) => {
    if (skip.has(bx.id)) return false;
    const r = rect(bx, MARGIN / 2);
    return Math.max(a.x, b.x) > r.x0 && Math.min(a.x, b.x) < r.x1 && Math.max(a.y, b.y) > r.y0 && Math.min(a.y, b.y) < r.y1;
  });
  g.edges.forEach((e, index) => {
    const f = ends.find((x) => x.index === index && x.which === "from")!, t = ends.find((x) => x.index === index && x.which === "to")!;
    const p0 = portOf.get(f)!, q0 = portOf.get(t)!, p1 = stub(f), q1 = stub(t);
    const facing = (f.side === "right" && t.side === "left" && p0.x < q0.x && p0.y === q0.y) || (f.side === "bottom" && t.side === "top" && p0.y < q0.y && p0.x === q0.x)
      || (f.side === "top" && t.side === "bottom" && p0.y > q0.y && p0.x === q0.x) || (f.side === "left" && t.side === "right" && p0.x > q0.x && p0.y === q0.y);
    let pts: Pt[];
    if (facing && !crossing(p0, q0, new Set([f.b.id, t.b.id]))) pts = [p0, q0];
    else {
      const mid = router.find(p1, SIDE_DIR[f.side], q1, (SIDE_DIR[t.side] + 2) & 3);
      pts = mid ? simplify([p0, ...mid, q0]) : simplify([p0, p1, { x: p1.x, y: q1.y }, q1, q0]);
      if (mid) router.mark(mid);
    }
    const segs = pts.slice(1).map((b, k) => ({ a: pts[k]!, b })).sort((u, v) => Math.hypot(v.b.x - v.a.x, v.b.y - v.a.y) - Math.hypot(u.b.x - u.a.x, u.b.y - u.a.y));
    const longest = segs[0]!;
    flows.push({ id: e.id, kind: e.kind, from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), points: pts.map((q) => ({ x: r1(q.x), y: r1(q.y) })),
      ...(e.label ? { labelAt: { x: r1((longest.a.x + longest.b.x) / 2), y: r1((longest.a.y + longest.b.y) / 2) } } : {}) });
  });
  return { name: p.name, ...(p.revision !== undefined ? { revision: p.revision } : {}), description: p.description, width: r1(width), height: r1(height), labelW: Z.laneLabel, lanes, boxes, flows };
}
