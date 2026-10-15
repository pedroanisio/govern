// A process (and optionally the live state of its lanes) as a BPMN drawing: a list of primitives in groups that is
// rendered to an SVG string here (colours as CSS variables, so light and dark both work) and to a scene-render document
// in lib/processscene.ts. Pure and deterministic: the clock is passed in, never read.
import type { Process } from "./process.ts";
import { layout } from "./processlayout.ts";
import type { Box, Flow, Layout, Pt } from "./processgraph.ts";
import type { LaneState, Status, CheckState } from "./lanestate.ts";

// ── palette ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Token → [light, dark]. A paint is a token name (or "none"); the SVG uses `var(--bp-<token>)`, a scene the light value. */
export const PALETTE: Record<string, [string, string]> = {
  bg: ["#F7F8FA", "#0f1216"], panel: ["#FFFFFF", "#171b21"], ink: ["#1F2933", "#e6e9ed"], muted: ["#52606D", "#98a2ae"], line: ["#3E4C59", "#aab4c0"],
  fail: ["#C0392B", "#f47067"], ok: ["#1a7f37", "#4ac26b"], warn: ["#9a6700", "#d4a72c"], accent: ["#2457c5", "#6d9cff"], onaccent: ["#FFFFFF", "#0f1216"],
  l0t: ["#FFF4E5", "#2A2118"], l0f: ["#FFE3BF", "#4A3519"], l0s: ["#D9822B", "#E0963C"],
  l1t: ["#EEF4FF", "#1A2233"], l1f: ["#D6E4FF", "#223A66"], l1s: ["#3366CC", "#6D9CFF"],
  l2t: ["#F1F8F1", "#18261C"], l2f: ["#D9F0DC", "#1F4128"], l2s: ["#2F8F46", "#4AC26B"],
  l3t: ["#F5F0FA", "#241C31"], l3f: ["#E6DAF5", "#3A2B57"], l3s: ["#7B4FB5", "#A98BE0"],
  l4t: ["#E8F6F6", "#152727"], l4f: ["#CDEDED", "#1D4646"], l4s: ["#1F8A8A", "#4DC4C4"],
  l5t: ["#FDEEF2", "#2C1820"], l5f: ["#F9D3DE", "#512336"], l5s: ["#C2456C", "#F07FA3"],
  l6t: ["#F6F6E8", "#25251A"], l6f: ["#E8E8C4", "#46461F"], l6s: ["#8A8A1F", "#C4C45A"],
  l7t: ["#EEF0F3", "#1D2128"], l7f: ["#D8DDE4", "#2E3540"], l7s: ["#596675", "#98A2AE"],
};

export interface Paint { fill: string; stroke: string; sw: number; dash?: number[] }
export type Prim =
  | { k: "rect"; x: number; y: number; w: number; h: number; r: number; p: Paint; o?: number }
  | { k: "ellipse"; cx: number; cy: number; rx: number; ry: number; p: Paint; o?: number }
  | { k: "poly"; pts: Pt[]; closed: boolean; p: Paint; o?: number }
  | { k: "flow"; pts: Pt[]; color: string; dash?: number[]; arrow: boolean; o?: number }
  | { k: "text"; x: number; y: number; w: number; h: number; lines: string[]; size: number; color: string; bold?: boolean; align: "start" | "middle" | "end"; valign: "top" | "middle" | "bottom"; o?: number };
export interface Group { tag: "g" | "a"; attrs: Record<string, string>; title?: string; prims: Prim[]; kids?: Group[] }
export interface Drawing { name: string; width: number; height: number; groups: Group[] }

/** What the live view adds: the lanes of this process (counts and badges) and one selected lane (its marks). */
export interface Overlay { now: number; lanes?: LaneState[]; selected?: LaneState }
export interface ProcessView { layout: Layout; drawing: Drawing }

// ── text ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHAR = 0.58, CHAR_BOLD = 0.63;
/** `text` wrapped to `width` px at `size`, at most `max` lines, the last one ending in … when text was cut. Words longer than a line break. */
export function wrap(text: string, size: number, width: number, max: number, bold = false): string[] {
  const per = Math.max(4, Math.floor(width / (size * (bold ? CHAR_BOLD : CHAR))));
  const atoms: { t: string; sp: boolean }[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) (word.match(/[^-_]*[-_]|[^-_]+/g) ?? [word]).forEach((t, i) => atoms.push({ t, sp: i === 0 }));
  const lines: string[] = []; let cur = "";
  for (const a of atoms) {
    let t = a.t;
    while (t.length > per) { if (cur) { lines.push(cur); cur = ""; } lines.push(t.slice(0, per)); t = t.slice(per); }
    const glue = a.sp && cur ? " " : "";
    if (!cur) cur = t; else if (cur.length + glue.length + t.length <= per) cur += glue + t; else { lines.push(cur); cur = t; }
  }
  if (cur) lines.push(cur);
  if (lines.length > max) { const kept = lines.slice(0, max); const last = kept[max - 1]!; kept[max - 1] = (last.length >= per ? last.slice(0, per - 1) : last) + "…"; return kept; }
  return lines;
}
const textWidth = (s: string, size: number, bold = false) => s.length * size * (bold ? CHAR_BOLD : CHAR);

/** "now", "5m", "3h" or "2d" for how long before `now` the ISO time `at` was. */
export function ago(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(at)) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const STATUS_COLOR: Record<Status, string> = { running: "accent", "waiting-on-owner": "warn", "waiting-on-coordinator": "warn", "blocked-by-check": "fail", idle: "muted", done: "ok" };
export const statusColor = (s: Status) => STATUS_COLOR[s];

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────
const P = (fill: string, stroke: string, sw: number, dash?: number[]): Paint => ({ fill, stroke, sw, ...(dash ? { dash } : {}) });
const txt = (x: number, y: number, w: number, h: number, lines: string[], size: number, color: string, o: Partial<Extract<Prim, { k: "text" }>> = {}): Prim =>
  ({ k: "text", x, y, w, h, lines, size, color, align: "middle", valign: "top", ...o });
const diamond = (b: Box): Pt[] => [{ x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w, y: b.y + b.h / 2 }, { x: b.x + b.w / 2, y: b.y + b.h }, { x: b.x, y: b.y + b.h / 2 }];
const userIcon = (x: number, y: number, color: string, fill: string): Prim[] => {
  const arc: Pt[] = []; for (let i = 0; i <= 8; i++) { const a = Math.PI - (Math.PI * i) / 8; arc.push({ x: x + 14 + 14 * Math.cos(a), y: y + 34 - 15 * Math.sin(a) }); }
  return [{ k: "ellipse", cx: x + 14, cy: y + 8, rx: 8, ry: 8, p: P(fill, color, 2.5) }, { k: "poly", pts: arc, closed: true, p: P(fill, color, 2.5) }];
};

interface Mark { stroke?: string; sw?: number; dash?: number[]; o?: number; badge?: Prim[]; zone?: Prim[]; title?: string; cls?: string }

/** Draw `layout` with `overlay`. */
export function draw(L: Layout, ov?: Overlay): Drawing {
  const W = L.width, H = L.height, groups: Group[] = [];
  const slotOf = new Map(L.lanes.map((l) => [l.id, l.slot]));
  const tok = (lane: string, part: "t" | "f" | "s") => `l${slotOf.get(lane) ?? 2}${part}`;
  const now = ov?.now ?? 0, sel = ov?.selected;
  // header and lanes
  const back: Prim[] = [{ k: "rect", x: 0, y: 0, w: W, h: H, r: 0, p: P("bg", "none", 0) }];
  const name = `govern process · ${L.name}${L.revision !== undefined ? `  (revision ${L.revision})` : ""}`;
  back.push(txt(14, 12, W - 28, 34, [name], 24, "ink", { bold: true, align: "start" }));
  back.push(txt(14, 48, W - 28, 36, wrap(L.description, 14, W - 400, 2), 14, "muted", { align: "start" }));
  if (ov) {
    const lanes = ov.lanes ?? [], n = (s: Status) => lanes.filter((x) => x.status === s).length;
    const line = sel ? `lane ${sel.slug} · ${sel.status} · stage ${sel.stageIndex}/${sel.stageTotal}`
      : `${lanes.length} lanes · ${n("running")} running · ${n("waiting-on-owner")} waiting on owner · ${n("waiting-on-coordinator")} on coordinator · ${n("blocked-by-check")} blocked · ${n("done")} done`;
    back.push(txt(W - 14 - 760, 14, 760, 30, [line], 15, sel ? statusColor(sel.status) : "muted", { align: "end", bold: true }));
  }
  for (const l of L.lanes) {
    back.push({ k: "rect", x: 10, y: l.y, w: W - 20, h: l.h, r: 0, p: P(tok(l.id, "t"), "line", 2) });
    back.push({ k: "rect", x: 10, y: l.y, w: L.labelW - 10, h: l.h, r: 0, p: P("none", "line", 2) });
    back.push(txt(18, l.y + l.h / 2 - 34, L.labelW - 26, 34, wrap(l.title, 18, L.labelW - 26, 2, true), 18, "ink", { bold: true, valign: "bottom" }));
    back.push(txt(18, l.y + l.h / 2 + 4, L.labelW - 26, 48, wrap(l.subtitle, 12, L.labelW - 26, 3), 12, "muted"));
  }
  groups.push({ tag: "g", attrs: { class: "bp-back" }, prims: back });
  // flows
  const boxById = new Map(L.boxes.map((b) => [b.id, b]));
  const flowGroups: Group[] = [], labels: Prim[] = [];
  for (const f of L.flows) {
    const color = f.kind === "fail" ? "fail" : f.kind === "route" ? "muted" : "line", dash = f.kind === "fail" || f.kind === "route" ? [9, 6] : undefined;
    const toTodo = sel && boxById.get(f.to)?.stage !== undefined && sel.stages.find((s) => s.name === boxById.get(f.to)!.stage)?.mark === "todo" && f.kind !== "fail";
    flowGroups.push({ tag: "g", attrs: { class: `bp-flow bp-${f.kind}`, "data-flow": f.id }, prims: [{ k: "flow", pts: f.points, color, ...(dash ? { dash } : {}), arrow: true, ...(toTodo ? { o: 0.45 } : {}) }] });
    if (f.label && f.labelAt) {
      const w = textWidth(f.label, 12, true) + 12;
      labels.push({ k: "rect", x: f.labelAt.x - w / 2, y: f.labelAt.y - 10, w, h: 20, r: 6, p: P("bg", "none", 0) }, txt(f.labelAt.x - w / 2, f.labelAt.y - 10, w, 20, [f.label], 12, color, { bold: true, valign: "middle" }));
    }
  }
  groups.push({ tag: "g", attrs: { class: "bp-flows" }, prims: [], kids: flowGroups });
  // nodes
  const nodeGroups: Group[] = [];
  for (const b of L.boxes) nodeGroups.push(drawNode(b, tok, ov, sel, now));
  groups.push({ tag: "g", attrs: { class: "bp-nodes" }, prims: [], kids: nodeGroups });
  groups.push({ tag: "g", attrs: { class: "bp-labels" }, prims: labels });
  groups.push(legend(W, H));
  return { name: L.name, width: W, height: H, groups };
}

function legend(W: number, H: number): Group {
  const y = H - 40, x = W - 760, pr: Prim[] = [];
  pr.push({ k: "rect", x, y: y + 4, w: 44, h: 22, r: 7, p: P("l2f", "l2s", 2.5) }, txt(x + 52, y + 4, 40, 22, ["task"], 13, "muted", { align: "start", valign: "middle" }));
  pr.push({ k: "poly", pts: [{ x: x + 110, y: y + 15 }, { x: x + 126, y: y + 3 }, { x: x + 142, y: y + 15 }, { x: x + 126, y: y + 27 }], closed: true, p: P("panel", "l3s", 2.5) }, txt(x + 148, y + 4, 90, 22, ["XOR gateway"], 13, "muted", { align: "start", valign: "middle" }));
  pr.push({ k: "ellipse", cx: x + 262, cy: y + 15, rx: 11, ry: 11, p: P("panel", "l2s", 2.5) }, { k: "ellipse", cx: x + 288, cy: y + 15, rx: 11, ry: 11, p: P("panel", "ink", 5) }, txt(x + 306, y + 4, 90, 22, ["start / end"], 13, "muted", { align: "start", valign: "middle" }));
  pr.push({ k: "flow", pts: [{ x: x + 410, y: y + 9 }, { x: x + 450, y: y + 9 }], color: "line", arrow: true }, { k: "flow", pts: [{ x: x + 410, y: y + 24 }, { x: x + 450, y: y + 24 }], color: "fail", dash: [7, 5], arrow: true }, txt(x + 460, y + 4, 280, 22, ["flow / gap loop (check fails)"], 13, "muted", { align: "start", valign: "middle" }));
  return { tag: "g", attrs: { class: "bp-legend" }, prims: pr };
}

/** The lane's mark for a stage, a gate's and a check's state, for the selected-lane mode. */
const stageMark = (sel: LaneState, stage: string) => sel.stages.find((s) => s.name === stage)?.mark ?? "todo";

function markFor(b: Box, ov: Overlay | undefined, sel: LaneState | undefined, now: number): Mark {
  if (!ov) return {};
  const lanes = ov.lanes ?? [];
  const zoneY = b.y + b.h - 24, zx = b.x + 10, zw = b.w - 20;
  const zoneText = (s: string, color: string, bold = false): Prim => txt(zx, zoneY, zw, 18, [s], 12, color, { align: "start", valign: "middle", bold });
  const countBadge = (n: number, color: string): Prim[] => n ? [{ k: "ellipse", cx: b.x + b.w - 8, cy: b.y + 8, rx: 14, ry: 14, p: P(color, "bg", 2.5) }, txt(b.x + b.w - 22, b.y - 6, 28, 28, [String(n)], 14, "onaccent", { bold: true, valign: "middle" })] : [];
  if (b.kind === "stage" || b.kind === "human" || b.kind === "subprocess") {
    if (sel) {
      const m = stageMark(sel, b.stage!);
      if (m === "done") return { stroke: "ok", sw: 5, zone: [zoneText("✓ done", "ok", true)], cls: "done", title: `${b.label}: done` };
      if (m === "current") return { stroke: "accent", sw: 8, zone: [zoneText(`● here · ${sel.status}`, "accent", true)], cls: "current", title: `${b.label}: ${sel.slug} is here (${sel.status})` };
      if (m === "blocked") return { stroke: "fail", sw: 8, zone: [zoneText("✗ blocked", "fail", true)], cls: "blocked", title: `${b.label}: blocked` };
      return { o: 0.5, cls: "todo", title: `${b.label}: not yet` };
    }
    const here = lanes.filter((l) => !l.finished && l.stages.some((s) => s.name === b.stage && (s.mark === "current" || s.mark === "blocked")));
    if (!here.length) return {};
    return { badge: countBadge(here.length, "accent"), title: `${b.label}: ${here.map((l) => l.slug).join(", ")}`, cls: "occupied" };
  }
  if (b.kind === "gate") {
    const gname = b.gate!;
    if (sel) {
      const g = sel.gates.find((x) => x.name === gname);
      if (!g) return {};
      const who = g.by ? ` by ${g.by}` : "", when = g.at ? ` · ${ago(g.at, now)}` : "";
      const tip = `${b.label}: ${g.decision}${who}${g.at ? ` at ${g.at}` : ""}${g.quote ? ` — “${g.quote}”` : ""}`;
      if (g.decision === "approved") return { stroke: "ok", sw: 5, zone: [zoneText(`✓ approved${who}${when}`, "ok", true)], cls: "approved", title: tip };
      if (g.decision === "rejected") return { stroke: "fail", sw: 7, zone: [zoneText(`✗ rejected${who}${when}`, "fail", true)], cls: "rejected", title: tip };
      if (g.decision === "pending") return { stroke: "warn", sw: 7, dash: [12, 7], zone: [zoneText(`… pending · ${g.owner}`, "warn", true)], cls: "pending", title: tip };
      return { o: 0.5, zone: [zoneText("waiting", "muted")], cls: "waiting", title: tip };
    }
    const pend = lanes.filter((l) => l.gates.some((g) => g.name === gname && g.decision === "pending"));
    return pend.length ? { badge: countBadge(pend.length, "warn"), title: `${b.label}: pending on ${pend.map((l) => l.slug).join(", ")}`, cls: "occupied" } : {};
  }
  if (b.kind === "check") {
    if (sel) {
      const c = sel.checks.find((x) => x.stage === b.stage);
      if (!c) return {};
      return checkMark(b, c, now, zoneText);
    }
    const bad = lanes.filter((l) => l.checks.some((c) => c.stage === b.stage && c.ok === false));
    return bad.length ? { badge: countBadge(bad.length, "fail"), title: `${b.label}: failing on ${bad.map((l) => l.slug).join(", ")}`, cls: "occupied" } : {};
  }
  if (b.kind === "gateway" && sel) {
    const c = sel.checks.find((x) => x.stage === b.stage);
    return c?.ok === true ? { stroke: "ok", sw: 5 } : c?.ok === false ? { stroke: "fail", sw: 5 } : {};
  }
  return {};
}

function checkMark(b: Box, c: CheckState, now: number, zoneText: (s: string, color: string, bold?: boolean) => Prim): Mark {
  if (c.ok === undefined) return { stroke: "muted", sw: 4, zone: [zoneText("no run yet", "muted")], cls: "never", title: `${b.label}: never run` };
  const when = c.at ? ` · ${ago(c.at, now)}` : "";
  if (c.ok) return { stroke: "ok", sw: 5, zone: [zoneText(`✓ pass${when}`, "ok", true)], cls: "pass", title: `${b.label}: passed${c.at ? ` at ${c.at}` : ""}` };
  const line = c.failure ? wrap(c.failure, 11, b.w - 20, 1)[0]! : "";
  const second: Prim = txt(b.x + 10, b.y + b.h - 42, b.w - 20, 16, [line], 11, "fail", { align: "start", valign: "middle" });
  return { stroke: "fail", sw: 7, zone: [zoneText(`✗ fail${when}`, "fail", true), ...(line ? [second] : [])], cls: "fail", title: `${b.label}: failed${c.at ? ` at ${c.at}` : ""}${c.failure ? ` — ${c.failure}` : ""}` };
}

function drawNode(b: Box, tok: (lane: string, part: "t" | "f" | "s") => string, ov: Overlay | undefined, sel: LaneState | undefined, now: number): Group {
  const m = markFor(b, ov, sel, now), o = m.o;
  const fill = tok(b.lane, "f"), stroke = m.stroke ?? tok(b.lane, "s"), sw = m.sw ?? 4;
  const pr: Prim[] = [], cls = ["bp-node", `bp-${b.kind}`, ...(m.cls ? [`bp-${m.cls}`] : [])];
  const attrs: Record<string, string> = { class: cls.join(" "), "data-node": b.id, ...(b.stage ? { "data-stage": b.stage } : {}), ...(b.gate ? { "data-gate": b.gate } : {}) };
  const kids: Group[] = [];
  const task = b.kind === "stage" || b.kind === "human" || b.kind === "subprocess" || b.kind === "check" || b.kind === "gate";
  if (b.kind === "start" || b.kind === "end") {
    pr.push({ k: "ellipse", cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2 - 3, ry: b.h / 2 - 3, p: P("panel", b.kind === "start" ? "l2s" : "ink", b.kind === "start" ? 4 : 9) });
    pr.push(txt(b.x - 20, b.y + b.h + 4, b.w + 40, 20, [b.label], 13, "muted"));
  } else if (b.kind === "gateway" || b.kind === "parallel") {
    pr.push({ k: "poly", pts: diamond(b), closed: true, p: P("panel", stroke, sw) });
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, d = b.w * 0.17;
    if (b.kind === "gateway") pr.push({ k: "poly", pts: [{ x: cx - d, y: cy - d }, { x: cx + d, y: cy + d }], closed: false, p: P("none", stroke, 5) }, { k: "poly", pts: [{ x: cx + d, y: cy - d }, { x: cx - d, y: cy + d }], closed: false, p: P("none", stroke, 5) });
    else pr.push({ k: "poly", pts: [{ x: cx - d * 1.3, y: cy }, { x: cx + d * 1.3, y: cy }], closed: false, p: P("none", stroke, 5) }, { k: "poly", pts: [{ x: cx, y: cy - d * 1.3 }, { x: cx, y: cy + d * 1.3 }], closed: false, p: P("none", stroke, 5) });
  } else if (task) {
    pr.push({ k: "rect", x: b.x, y: b.y, w: b.w, h: b.h, r: 18, p: P(fill, stroke, sw, m.dash) });
    if (b.kind === "subprocess") pr.push({ k: "rect", x: b.x + b.w / 2 - 9, y: b.y + b.h - 40, w: 18, h: 18, r: 3, p: P("panel", stroke, 2.5) }, { k: "poly", pts: [{ x: b.x + b.w / 2 - 5, y: b.y + b.h - 31 }, { x: b.x + b.w / 2 + 5, y: b.y + b.h - 31 }], closed: false, p: P("none", stroke, 2.5) }, { k: "poly", pts: [{ x: b.x + b.w / 2, y: b.y + b.h - 36 }, { x: b.x + b.w / 2, y: b.y + b.h - 26 }], closed: false, p: P("none", stroke, 2.5) });
    if (b.kind === "human" || b.kind === "gate") pr.push(...userIcon(b.x + 12, b.y + 8, stroke, "panel"));
    if (b.kind === "check") pr.push(txt(b.x + 8, b.y + 4, 34, 30, ["⚙"], 22, stroke, { align: "start" }));
    const inset = 36;
    const ts = b.kind === "gate" ? 15 : b.kind === "check" ? 14 : 17, tl = b.kind === "check" ? 3 : 2;
    pr.push(txt(b.x + inset, b.y + 8, b.w - 2 * inset + 14, 52, wrap(b.label, ts, b.w - 2 * inset + 14, tl, true), ts, "ink", { bold: true, valign: "middle", align: "middle" }));
    if (b.sub) pr.push(txt(b.x + 12, b.y + 60, b.w - 24, b.kind === "check" ? 24 : b.kind === "gate" ? 22 : 44, wrap(b.sub, 12, b.w - 24, b.kind === "check" ? 1 : b.kind === "gate" ? 2 : 3), 12, "muted"));
  }
  const withO = (list: Prim[]) => (o === undefined ? list : list.map((x) => ({ ...x, o })));
  const group: Group = { tag: "g", attrs, ...(m.title ? { title: m.title } : {}), prims: withO(pr) };
  if (m.zone) group.prims.push(...withO(m.zone));
  if (m.badge) group.prims.push(...m.badge);
  // lane pills inside a stage box (process mode): clickable
  if (ov && !sel && (b.kind === "stage" || b.kind === "human" || b.kind === "subprocess")) {
    const here = (ov.lanes ?? []).filter((l) => !l.finished && l.stages.some((s) => s.name === b.stage && (s.mark === "current" || s.mark === "blocked")));
    let x = b.x + 10; const y = b.y + b.h - 26;
    here.slice(0, 2).forEach((l) => {
      const label = l.slug.length > 15 ? `${l.slug.slice(0, 14)}…` : l.slug, w = Math.min(b.w - 20, textWidth(label, 11) + 16);
      if (x + w > b.x + b.w - 34) return;
      kids.push({ tag: "g", attrs: { class: "bp-pill", "data-lane": l.slug, tabindex: "0", role: "link" }, title: `${l.slug} · ${l.status}`,
        prims: [{ k: "rect", x, y, w, h: 20, r: 10, p: P("panel", STATUS_COLOR[l.status], 2.5) }, txt(x, y, w, 20, [label], 11, "ink", { valign: "middle" })] });
      x += w + 6;
    });
    if (here.length > 2) kids.push({ tag: "g", attrs: { class: "bp-pill-more" }, prims: [txt(x, y, 40, 20, [`+${here.length - 2}`], 12, "muted", { align: "start", valign: "middle", bold: true })] });
  }
  if (kids.length) group.kids = kids;
  return group;
}

// ── SVG ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Theme = "vars" | "light" | "dark";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n1 = (v: number) => String(Math.round(v * 10) / 10);
const colour = (t: string, theme: Theme) => (t === "none" ? "none" : theme === "vars" ? `var(--bp-${t})` : (PALETTE[t] ?? PALETTE.ink!)[theme === "dark" ? 1 : 0]);

/** The path of orthogonal `pts` with each corner rounded by `r` (clamped to half of the shorter leg); `f` maps each point. */
export function roundedPath(pts: Pt[], r: number, f: (p: Pt) => Pt = (p) => p): string {
  const q = pts.map(f), at = (p: Pt) => `${n1(p.x)} ${n1(p.y)}`, d = [`M${at(q[0]!)}`];
  for (let i = 1; i + 1 < q.length; i++) {
    const a = q[i - 1]!, b = q[i]!, c = q[i + 1]!, l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y), k = Math.min(r, l1 / 2, l2 / 2);
    const u = l1 ? { x: (b.x - a.x) / l1, y: (b.y - a.y) / l1 } : { x: 0, y: 0 }, v = l2 ? { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 } : { x: 0, y: 0 };
    d.push(`L${at({ x: b.x - u.x * k, y: b.y - u.y * k })} Q${at(b)} ${at({ x: b.x + v.x * k, y: b.y + v.y * k })}`);
  }
  d.push(`L${at(q[q.length - 1]!)}`);
  return d.join(" ");
}
export const CORNER = 14;
const FONT = "DejaVu Sans, Verdana, system-ui, sans-serif";

function primSvg(p: Prim, theme: Theme, arrows: Set<string>): string {
  const op = p.o !== undefined ? ` opacity="${p.o}"` : "";
  const paint = (a: Paint) => `fill="${colour(a.fill, theme)}" stroke="${colour(a.stroke, theme)}" stroke-width="${a.sw}"${a.dash ? ` stroke-dasharray="${a.dash.join(" ")}"` : ""}`;
  switch (p.k) {
    case "rect": return `<rect x="${n1(p.x)}" y="${n1(p.y)}" width="${n1(p.w)}" height="${n1(p.h)}"${p.r ? ` rx="${p.r}"` : ""} ${paint(p.p)}${op}/>`;
    case "ellipse": return `<ellipse cx="${n1(p.cx)}" cy="${n1(p.cy)}" rx="${n1(p.rx)}" ry="${n1(p.ry)}" ${paint(p.p)}${op}/>`;
    case "poly": return `<path d="${p.pts.map((q, i) => `${i ? "L" : "M"}${n1(q.x)} ${n1(q.y)}`).join(" ")}${p.closed ? " Z" : ""}" ${paint(p.p)} stroke-linejoin="round" stroke-linecap="round"${op}/>`;
    case "flow": {
      if (p.arrow) arrows.add(p.color);
      return `<path d="${roundedPath(p.pts, CORNER)}" fill="none" stroke="${colour(p.color, theme)}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"${p.dash ? ` stroke-dasharray="${p.dash.join(" ")}"` : ""}${p.arrow ? ` marker-end="url(#bp-arrow-${p.color})"` : ""}${op}/>`;
    }
    case "text": {
      const lh = p.size * 1.22, bh = p.lines.length * lh;
      const top = p.valign === "top" ? p.y : p.valign === "middle" ? p.y + (p.h - bh) / 2 : p.y + p.h - bh;
      const x = p.align === "start" ? p.x : p.align === "end" ? p.x + p.w : p.x + p.w / 2, anchor = p.align;
      return p.lines.map((l, i) => `<text x="${n1(x)}" y="${n1(top + i * lh + lh / 2 + p.size * 0.35)}" font-size="${p.size}" font-family="${FONT}"${p.bold ? ' font-weight="700"' : ""} text-anchor="${anchor}" fill="${colour(p.color, theme)}"${op}>${esc(l)}</text>`).join("");
    }
  }
}
function groupSvg(g: Group, theme: Theme, arrows: Set<string>): string {
  const attrs = Object.entries(g.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<${g.tag}${attrs}>${g.title ? `<title>${esc(g.title)}</title>` : ""}${g.prims.map((p) => primSvg(p, theme, arrows)).join("")}${(g.kids ?? []).map((k) => groupSvg(k, theme, arrows)).join("")}</${g.tag}>`;
}
const cssVars = (i: 0 | 1) => Object.entries(PALETTE).map(([k, v]) => `--bp-${k}:${v[i]}`).join(";");

/** The drawing as an SVG document string. `vars`: colours are CSS variables (light, and dark under prefers-color-scheme),
 *  so a page that embeds it themes it; `light` / `dark`: literal colours, for a converter that ignores variables. */
export function svgOf(d: Drawing, theme: Theme = "vars"): string {
  const arrows = new Set<string>(), body = d.groups.map((g) => groupSvg(g, theme, arrows)).join("\n");
  const defs = [...arrows].sort().map((t) => `<marker id="bp-arrow-${t}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0.5 L10 5 L0 9.5 Z" fill="${colour(t, theme)}"/></marker>`).join("");
  const style = theme === "vars" ? `<style>svg.bpmn{${cssVars(0)}}@media (prefers-color-scheme: dark){svg.bpmn{${cssVars(1)}}}svg.bpmn .bp-pill{cursor:pointer}svg.bpmn .bp-pill:hover rect,svg.bpmn .bp-pill:focus rect{stroke-width:4}</style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" class="bpmn" viewBox="0 0 ${n1(d.width)} ${n1(d.height)}" width="${n1(d.width)}" height="${n1(d.height)}" role="img" aria-label="${esc(`BPMN diagram of the govern process ${d.name}`)}">${style}<defs>${defs}</defs>\n${body}\n</svg>\n`;
}

/** Process → layout and drawing, with the overlay when there is one. */
export function viewOf(p: Process, ov?: Overlay): ProcessView {
  const L = layout(p);
  return { layout: L, drawing: draw(L, ov) };
}
/** Process → SVG string (the one-call entry): layout, drawing, markup. */
export const processSvg = (p: Process, ov?: Overlay, theme: Theme = "vars"): string => svgOf(viewOf(p, ov).drawing, theme);
export type { Layout, Box, Flow, Pt };
