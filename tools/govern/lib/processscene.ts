// A process drawing (lib/processview.ts) as a scene-render 1.1 document: shapes, paths with an arrow marker at the end
// and text assets with layers, the vocabulary the engine validates. The drawing is scaled to fit the canvas.
import { PALETTE, roundedPath, CORNER, type Drawing, type Group, type Prim } from "./processview.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
const n1 = (v: number) => String(Math.round(v * 10) / 10);

/** A palette token as #RRGGBB or, with an opacity, #RRGGBBAA; "none" is fully transparent. */
function hex(token: string, o = 1): string {
  if (token === "none") return "#00000000";
  const base = (PALETTE[token] ?? PALETTE.ink!)[0];
  return o >= 1 ? base : `${base}${Math.round(o * 255).toString(16).padStart(2, "0").toUpperCase()}`;
}

export interface SceneOptions { width: number; height: number }

/** The canvas that fits a drawing of `w` x `h` at `width` (and `height`; when it is absent, the height that keeps the aspect). */
export const canvasFor = (w: number, h: number, width = 3840, height?: number): { width: number; height: number } =>
  ({ width, height: height ?? Math.ceil((width * h) / w / 2) * 2 });

/** The scene document (XML text) of `d` on a canvas of `o.width` x `o.height`, centred, scaled to fit. */
export function sceneOf(d: Drawing, o: SceneOptions): string {
  const s = Math.min(o.width / d.width, o.height / d.height), ox = (o.width - d.width * s) / 2, oy = (o.height - d.height * s) / 2;
  const X = (x: number) => n1(ox + x * s), Y = (y: number) => n1(oy + y * s), L = (v: number) => n1(v * s);
  const assets: string[] = [], items: string[] = [];
  let id = 0;
  const shape = (z: number, attrs: string) => items.push(`    <shape id="s-${++id}" z="${z}" ${attrs}/>`);
  const pathShape = (z: number, dAttr: string, fill: string, stroke: string, sw: number, extra = "") =>
    shape(z, `x="0" y="0" shape="path" width="${n1(o.width)}" height="${n1(o.height)}" path="${dAttr}" fill="${fill}" stroke="${stroke}" strokeWidth="${n1(sw * s)}" strokeJoin="round" strokeCap="round"${extra}`);
  const prim = (p: Prim, zShape: number, zText: number): void => {
    const op = p.o ?? 1;
    if (p.k === "rect") shape(zShape, `x="${X(p.x)}" y="${Y(p.y)}" shape="${p.r ? "rounded-rect" : "rect"}" width="${L(p.w)}" height="${L(p.h)}" radius="${L(p.r)}" fill="${hex(p.p.fill, op)}" stroke="${hex(p.p.stroke, op)}" strokeWidth="${p.p.stroke === "none" ? 0 : n1(p.p.sw * s)}"${p.p.dash ? ` dash="${p.p.dash.map((v) => n1(v * s)).join(" ")}"` : ""}`);
    else if (p.k === "ellipse") shape(zShape, `x="${X(p.cx - p.rx)}" y="${Y(p.cy - p.ry)}" shape="ellipse" width="${L(2 * p.rx)}" height="${L(2 * p.ry)}" fill="${hex(p.p.fill, op)}" stroke="${hex(p.p.stroke, op)}" strokeWidth="${n1(p.p.sw * s)}"`);
    else if (p.k === "poly") pathShape(zShape, p.pts.map((q, i) => `${i ? "L" : "M"}${X(q.x)} ${Y(q.y)}`).join(" ") + (p.closed ? " Z" : ""), hex(p.p.fill, op), hex(p.p.stroke, op), p.p.sw);
    else if (p.k === "flow") pathShape(zShape, roundedPath(p.pts, CORNER * s, (q) => ({ x: ox + q.x * s, y: oy + q.y * s })), "#00000000", hex(p.color, op), 3.5, `${p.arrow ? ' markerEnd="arrow" markerSize="3.6"' : ""}${p.dash ? ` dash="${p.dash.map((v) => n1(v * s)).join(" ")}"` : ""}`);
    else if (p.lines.length) {
      const slack = 0.25 * p.w, w = p.w + slack, x = p.align === "start" ? p.x : p.align === "end" ? p.x - slack : p.x - slack / 2, t = `t-${++id}`;
      assets.push(`    <text id="${t}" text="${esc(p.lines.join("\n"))}" width="${Math.ceil(w * s)}" height="${Math.ceil(p.h * s)}" size="${n1(p.size * s)}" color="${hex(p.color, op)}" align="${p.align === "middle" ? "center" : p.align}" verticalAlign="${p.valign}" lineHeight="1.22" wrap="word" font="DejaVu Sans"${p.bold ? ' weight="700"' : ""}/>`);
      items.push(`    <layer id="l-${id}" z="${zText}" x="${X(x)}" y="${Y(p.y)}" asset="${t}"/>`);
    }
  };
  const walk = (g: Group, back: boolean): void => {
    const cls = g.attrs.class ?? "";
    const [zs, zt] = back || cls.includes("bp-back") ? [0, 1] : cls.includes("bp-flows") || cls.includes("bp-flow ") || cls.startsWith("bp-flow") ? [3, 3] : cls.includes("bp-labels") ? [5, 7] : [4, 6];
    for (const p of g.prims) prim(p, zs, zt);
    for (const k of g.kids ?? []) walk(k, false);
  };
  for (const g of d.groups) walk(g, false);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<scene version="1.1">\n  <project width="${o.width}" height="${o.height}" fps="30" duration="1" background="${hex("bg")}" supersample="2"/>\n  <assets>\n${assets.join("\n")}\n  </assets>\n  <composition>\n${items.join("\n")}\n  </composition>\n</scene>\n`;
}
