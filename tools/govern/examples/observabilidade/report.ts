// The visual production report of the Grafana watcher (grafana-watch.ts --report) as a scene-render 1.1 document: header
// with the window and status, four figures, errors per app over the window, the last 24 h in 2 h columns, and the checked
// insights. Pure: the same data gives the same scene, so the scene is what tests read.

export type Status = "Normal" | "Atenção" | "Crítico";
export interface ReportData {
  window: string;
  status: Status;
  coverage: number;
  total: number;
  totalChange: string;
  spikes: number;
  alerts: number;
  down: number;
  rows: { app: string; errors: number; change: string; spike: boolean }[];
  buckets: { label: string; value: number | null }[];
  insights: string[];
}

const W = 1600, H = 1000;
const C = { bg: "#0E1B3D", panel: "#16264F", text: "#FFFFFF", soft: "#9FB0D9", faint: "#6F7FA8", bar: "#5CF2D6", spike: "#F2A93B", up: "#FF7B7B", down: "#5CF2D6", empty: "#2A3A66" };
const STATUS: Record<Status, string> = { Normal: "#1FB57A", Atenção: "#E09B2D", Crítico: "#E5484D" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
export const fmt = (n: number) => n.toLocaleString("pt-BR");
const changeColor = (c: string) => c.startsWith("+") && c !== "+0%" ? C.up : c.startsWith("-") ? C.down : C.soft;

export function reportScene(d: ReportData): string {
  const assets: string[] = [], nodes: string[] = [];
  let n = 0;
  const text = (s: string, x: number, y: number, w: number, h: number, size: number, o: { color?: string; bold?: boolean; align?: "start" | "center" | "end"; lines?: number; valign?: "top" | "middle" } = {}) => {
    const id = `t${++n}`;
    assets.push(`    <text id="${id}" text="${esc(s)}" width="${w}" height="${h}" size="${size}" color="${o.color ?? C.text}"${o.bold ? ` style="bold"` : ""}` +
      ` align="${o.align ?? "start"}" verticalAlign="${o.valign ?? "top"}" maxLines="${o.lines ?? 1}" overflow="ellipsis"/>`);
    nodes.push(`    <layer id="l${n}" asset="${id}" x="${x}" y="${y}"/>`);
  };
  const rect = (x: number, y: number, w: number, h: number, fill: string, r = 0) =>
    nodes.push(`    <shape id="s${++n}" shape="${r ? "rounded-rect" : "rect"}" x="${x}" y="${y}" width="${w}" height="${Math.max(h, 1)}"${r ? ` radius="${r}"` : ""} fill="${fill}"/>`);

  // Header
  text("Saúde de produção · prd", 40, 34, 1100, 64, 46, { bold: true });
  text(`${d.window} · últimas 2h${d.coverage < 90 ? ` · cobertura ${d.coverage}%` : ""}`, 42, 100, 1100, 36, 24, { color: C.soft });
  rect(1300, 40, 260, 70, STATUS[d.status], 35);
  text(d.status, 1300, 40, 260, 70, 32, { bold: true, align: "center", valign: "middle" });

  // Four figures
  const tiles: [string, string, string?][] = [
    ["Erros (2h)", fmt(d.total), d.totalChange === "—" ? "sem dado das 2h anteriores" : `${d.totalChange} vs. 2h anteriores`],
    ["Apps em pico", String(d.spikes)], ["Alertas ativos", String(d.alerts)], ["Targets fora do ar", String(d.down)],
  ];
  tiles.forEach(([label, value, sub], i) => {
    const x = 40 + i * 385;
    rect(x, 160, 365, 160, C.panel, 20);
    text(label, x + 24, 178, 320, 32, 22, { color: C.soft });
    text(value, x + 24, 214, 320, 70, 56, { bold: true, color: i > 0 && value !== "0" ? STATUS[i === 1 ? "Atenção" : "Crítico"] : C.text });
    if (sub) text(sub, x + 24, 282, 320, 30, 20, { color: changeColor(sub) });
  });

  // Errors per app over the window
  rect(40, 350, 900, 580, C.panel, 20);
  text("Erros por app (2h) e variação vs. 2h anteriores", 64, 368, 860, 36, 24, { bold: true });
  const top = d.rows.slice(0, 8), max = Math.max(1, ...top.map((r) => r.errors));
  if (!top.length) text("nenhum erro registrado na janela", 64, 430, 860, 34, 22, { color: C.soft });
  top.forEach((r, i) => {
    const y = 424 + i * 62, w = Math.round((r.errors / max) * 300);
    text(r.app.replace(/^prd\//, ""), 64, y + 4, 356, 30, 20, { color: C.text });
    rect(430, y, 274, 34, C.empty, 8);
    rect(430, y, Math.max(Math.round(w * 274 / 300), 6), 34, r.spike ? C.spike : C.bar, 8);
    text(fmt(r.errors), 716, y + 4, 100, 30, 20, { bold: true, align: "end" });
    text(r.change, 826, y + 4, 100, 30, 20, { color: changeColor(r.change), align: "end" });
  });

  // The last 24 h in 2 h columns
  rect(970, 350, 590, 250, C.panel, 20);
  text("Últimas 24h · erros a cada 2h", 994, 368, 540, 36, 24, { bold: true });
  const bmax = Math.max(1, ...d.buckets.map((b) => b.value ?? 0));
  d.buckets.forEach((b, i) => {
    const x = 994 + i * 46, h = b.value === null ? 6 : Math.round((b.value / bmax) * 140);
    rect(x, 550 - h, 34, h, b.value === null ? C.empty : i === d.buckets.length - 1 ? C.text : C.bar, 4);
    if (i % 3 === 2 || i === d.buckets.length - 1) text(b.label, x - 12, 558, 60, 24, 16, { color: C.faint, align: "center" });
  });

  // Insights
  rect(970, 620, 590, 310, C.panel, 20);
  text("Insights (IA, verificados)", 994, 638, 540, 34, 22, { bold: true });
  if (!d.insights.length) text("sem insights verificados nesta rodada", 994, 684, 540, 30, 19, { color: C.soft });
  d.insights.slice(0, 3).forEach((s, i) => text(`• ${s}`, 994, 678 + i * 84, 542, 84, 16, { lines: 4 }));

  text("Fonte: Grafana (Loki, Prometheus, Alertmanager) via govern · erros = linhas com ERROR ou Exception · insights de IA: revise antes de agir", 40, 950, 1520, 30, 18, { color: C.faint });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<scene version="1.2">`,
    `  <project width="${W}" height="${H}" fps="1" duration="1" background="${C.bg}"/>`,
    `  <styles>`, `    <textStyle id="bold" weight="700"/>`, `  </styles>`,
    `  <assets>`, ...assets, `  </assets>`,
    `  <composition>`, ...nodes, `  </composition>`,
    `</scene>`, "",
  ].join("\n");
}
