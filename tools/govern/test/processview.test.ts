// The process view: graph, layout invariants, SVG with and without the live overlay, and the scene document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./helpers.ts";
import { parseProcess, type Process } from "../lib/process.ts";
import { layout } from "../lib/processlayout.ts";
import { conditionLabel, type Layout, type Box } from "../lib/processgraph.ts";
import { processSvg, viewOf, svgOf, wrap, ago } from "../lib/processview.ts";
import { sceneOf, canvasFor } from "../lib/processscene.ts";
import type { LaneState } from "../lib/lanestate.ts";

const parse = (name: string, o: unknown) => parseProcess(`${name}.json`, JSON.stringify(o));
const PN = parseProcess("pn.json", readFileSync(fixture("pn-process.json"), "utf8"));
const FAN: Process = parse("fan", {
  version: 1, name: "fan", description: "a & b <split>", stages: [
    { name: "scope", next: [{ to: ["a", "b"] }] },
    { name: "a", check: "ca", next: [{ to: ["merge"] }] },
    { name: "b", next: [{ to: ["merge"] }] },
    { name: "merge", join: { mode: "all", stages: ["a", "b"] }, next: [{ to: ["scope"], when: { field: "n", op: "lt", value: 3 }, loop: { maxIterations: 3, stages: ["scope", "a", "b", "merge"] } }, { to: ["ok"] }] },
    { name: "ok", human: { assignee: "alice" }, next: [] },
  ],
  gates: [{ name: "sign", stage: "ok", owner: "legal" }, { name: "approve", stage: "merge", owner: "owner" }, { name: "second", stage: "merge", owner: "owner", needs: ["approve"] }],
  fields: { n: { type: "integer" } }, people: { alice: { user: "alice", roles: ["editor"] } },
});
const LINEAR: Process = parse("lin", { version: 1, name: "lin", description: "", stages: [{ name: "one" }, { name: "two" }] });

const edgeOf = (b: Box, p: { x: number; y: number }) => {
  const onX = Math.abs(p.x - b.x) < 0.2 || Math.abs(p.x - (b.x + b.w)) < 0.2, onY = Math.abs(p.y - b.y) < 0.2 || Math.abs(p.y - (b.y + b.h)) < 0.2;
  return (onX && p.y >= b.y - 0.2 && p.y <= b.y + b.h + 0.2) || (onY && p.x >= b.x - 0.2 && p.x <= b.x + b.w + 0.2);
};

function invariants(L: Layout, p: Process): void {
  const box = new Map(L.boxes.map((b) => [b.id, b]));
  assert.equal(box.size, L.boxes.length, "box ids are unique");
  for (const s of p.stages) {
    assert.ok(box.has(`s:${s.name}`), `stage ${s.name} placed`);
    if (s.check) { assert.ok(box.has(`c:${s.name}`), `check of ${s.name}`); assert.ok(box.has(`x:${s.name}`), `gateway of ${s.name}`); assert.equal(box.get(`c:${s.name}`)!.lane, "checks"); }
  }
  for (const g of p.gates) {
    const b = box.get(`g:${g.name}`); assert.ok(b, `gate ${g.name} placed`);
    assert.equal(b.lane, g.owner ?? "owner");
    assert.ok(L.lanes.some((l) => l.id === b.lane && b.y >= l.y && b.y + b.h <= l.y + l.h), "a gate sits inside its lane");
    const stage = box.get(`s:${g.stage}`);
    if (stage) assert.ok(b.x + b.w > stage.x + stage.w, `gate ${g.name} stands after the stage it holds`);
    for (const n of g.needs ?? []) {
      const need = box.get(`g:${n}`)!;
      if (p.gates.find((x) => x.name === n)!.stage === g.stage) assert.ok(b.x >= need.x + need.w, `gate ${g.name} after the gate ${n} it needs`);
    }
  }
  for (const [i, a] of L.boxes.entries()) for (const b of L.boxes.slice(i + 1))
    assert.ok(a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01, `${a.id} and ${b.id} overlap`);
  for (const f of L.flows) {
    const from = box.get(f.from)!, to = box.get(f.to)!, pts = f.points;
    assert.ok(pts.length >= 2);
    assert.ok(edgeOf(from, pts[0]!), `flow ${f.id} starts on the edge of ${f.from}`);
    assert.ok(edgeOf(to, pts[pts.length - 1]!), `flow ${f.id} ends on the edge of ${f.to}`);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!, c = pts[i + 1]!;
      assert.ok(a.x === c.x || a.y === c.y, `flow ${f.id} is orthogonal`);
      for (const b of L.boxes) {
        if (b.id === f.from || b.id === f.to) continue;
        const hit = Math.max(a.x, c.x) > b.x + 0.5 && Math.min(a.x, c.x) < b.x + b.w - 0.5 && Math.max(a.y, c.y) > b.y + 0.5 && Math.min(a.y, c.y) < b.y + b.h - 0.5;
        assert.ok(!hit, `flow ${f.id} crosses ${b.id}`);
      }
    }
  }
  assert.ok(L.boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= L.width && b.y + b.h <= L.height), "everything is inside the canvas");
}

test("a linear process with checks and gates is laid out: every stage, check and gate placed, in its lane, after what it follows", () => {
  const L = layout(PN);
  invariants(L, PN);
  assert.deepEqual(L.lanes.map((l) => l.id), ["owner", "coordinator", "agents", "checks"].filter((id) => id !== "owner" || PN.gates.some((g) => (g.owner ?? "owner") === "owner")));
  const xs = PN.stages.map((s) => L.boxes.find((b) => b.id === `s:${s.name}`)!.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "stages run left to right in order");
  assert.ok(L.flows.some((f) => f.kind === "fail" && f.label === "gap"), "a failing check loops back to its stage");
  assert.ok(L.flows.some((f) => f.kind === "pass"));
});

test("a graph process with a split, a join, conditional routes, a loop back, a human stage and a custom owner lane", () => {
  const L = layout(FAN);
  invariants(L, FAN);
  assert.deepEqual(L.lanes.map((l) => l.id), ["owner", "legal", "agents", "checks"]);
  const ids = L.boxes.map((b) => b.id);
  assert.ok(ids.some((i) => i.startsWith("p:scope")), "a parallel split after scope");
  assert.ok(ids.includes("j:merge"), "a parallel join before merge");
  assert.equal(L.boxes.find((b) => b.id === "s:ok")!.kind, "human");
  const labels = L.flows.map((f) => f.label).filter(Boolean);
  assert.ok(labels.includes("loop ≤ 3"), `a conditional route is labelled (${labels.join(" | ")})`);
  assert.ok(labels.includes("else"), "the fallback is labelled else");
  assert.ok(L.flows.some((f) => f.kind === "route" && f.to === "s:scope"), "a route back to an earlier stage is drawn");
  assert.ok(L.flows.some((f) => f.from === "start") && L.flows.some((f) => f.to === "end"));
});

test("a process with no check and no gate is only agents and flows", () => {
  const L = layout(LINEAR); invariants(L, LINEAR);
  assert.deepEqual(L.lanes.map((l) => l.id), ["agents"]);
  assert.equal(L.flows.length, 3);
});

test("every built-in process lays out under the invariants", () => {
  for (const f of ["video", "dev", "ops"]) {
    const p = parseProcess(`${f}.json`, readFileSync(new URL(`../processes/${f}.json`, import.meta.url), "utf8"));
    invariants(layout(p), p);
  }
});

test("layout and SVG are deterministic: the same process gives the same bytes", () => {
  assert.equal(JSON.stringify(layout(FAN)), JSON.stringify(layout(FAN)));
  assert.equal(processSvg(PN), processSvg(PN));
  assert.equal(processSvg(FAN, { now: 1, lanes: [] }), processSvg(FAN, { now: 1, lanes: [] }));
});

test("the SVG themes by CSS variables (light and dark), escapes names and has no NaN", () => {
  const svg = processSvg(FAN);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="bpmn" viewBox="0 0 [\d.]+ [\d.]+"/);
  assert.match(svg, /var\(--bp-l2f\)/); assert.match(svg, /prefers-color-scheme: dark/);
  assert.ok(!svg.includes("NaN") && !svg.includes("undefined"));
  assert.match(svg, /marker-end="url\(#bp-arrow-line\)"/);
  const light = processSvg(FAN, undefined, "light");
  assert.ok(!light.includes("var(--bp-") && !light.includes("<style>"), "a literal-colour SVG needs no variables");
  assert.ok(!/<[^>]*[a-z]="[^"]*<[^"]*"/.test(svg), "no raw < in an attribute");
});

const lane = (o: Partial<LaneState> & { slug: string }): LaneState => ({
  title: o.slug, kind: "pn", process: { name: "pn", revision: 2, hash: "0".repeat(64) }, stage: "plan", stageIndex: 1, stageTotal: 4,
  stages: [{ name: "plan", mark: "current" }, { name: "build", mark: "todo" }, { name: "review", mark: "todo" }, { name: "ship", mark: "todo" }],
  gates: [], checks: [], jobs: [], blocked: [], waitingOn: [], lastActivity: "2026-10-15T11:00:00.000Z", status: "idle", ...o,
});
const NOW = Date.parse("2026-10-15T12:00:00.000Z");

test("the live overlay counts lanes per stage with clickable slug pills, gates pending and checks failing", () => {
  const lanes = [
    lane({ slug: "a", status: "running" }),
    lane({ slug: "b", stage: "build", status: "blocked-by-check", stages: [{ name: "plan", mark: "done" }, { name: "build", mark: "blocked" }, { name: "review", mark: "todo" }, { name: "ship", mark: "todo" }],
      checks: [{ stage: "build", command: "built", ok: false, at: "2026-10-15T11:55:00.000Z", failure: "FAIL: no media" }] }),
    lane({ slug: "c", gates: [{ name: "plan-review", stage: "plan", owner: "coordinator", decision: "pending", needs: [] }] }),
  ];
  const svg = processSvg(PN, { now: NOW, lanes });
  assert.match(svg, /data-lane="a"/); assert.match(svg, /data-lane="b"/); assert.match(svg, /data-lane="c"/);
  assert.match(svg, /3 lanes · 1 running/);
  assert.match(svg, /<title>plan: a, c<\/title>/, "the plan stage holds a and c");
  assert.match(svg, /<title>build: b<\/title>/);
  assert.match(svg, /plan-review: pending on c/); assert.match(svg, /check build: failing on b/);
});

test("the selected-lane mode marks done, current, blocked and not-yet stages and shows each gate decision and check result", () => {
  const sel = lane({
    slug: "s", stage: "build", stageIndex: 2, status: "blocked-by-check",
    stages: [{ name: "plan", mark: "done" }, { name: "build", mark: "blocked" }, { name: "review", mark: "todo" }, { name: "ship", mark: "todo" }],
    gates: [{ name: "plan-review", stage: "plan", owner: "coordinator", decision: "approved", needs: [], by: "coordinator", at: "2026-10-15T09:00:00.000Z", quote: "ok" },
      { name: "go", stage: "plan", owner: "owner", decision: "rejected", needs: ["plan-review"], by: "owner", at: "2026-10-15T10:00:00.000Z", quote: "no" },
      { name: "ship-ok", stage: "ship", owner: "owner", decision: "waiting", needs: [] }],
    checks: [{ stage: "plan", command: "planned", ok: true, at: "2026-10-14T11:00:00.000Z" }, { stage: "build", command: "built", ok: false, at: "2026-10-15T11:00:00.000Z", failure: "FAIL: 3 beats have no media" }],
  });
  const svg = processSvg(PN, { now: NOW, lanes: [sel], selected: sel });
  for (const c of ["bp-done", "bp-blocked", "bp-todo", "bp-approved", "bp-rejected", "bp-waiting", "bp-pass", "bp-fail"]) assert.ok(svg.includes(c), `${c} is marked`);
  assert.match(svg, /✓ approved by coordinator · 3h/); assert.match(svg, /✗ rejected by owner · 2h/); assert.match(svg, /✗ fail · 1h/);
  assert.match(svg, /FAIL: 3 beats have no media/);
  assert.match(svg, /lane s · blocked-by-check · stage 2\/4/);
  assert.ok(!svg.includes('class="bp-pill"'), "the selected mode has no other lane's pills");
});

test("the scene is a 1.1 document: one arrow path per flow, unique ids, text assets with layers, scaled onto the canvas", () => {
  const v = viewOf(PN), c = canvasFor(v.drawing.width, v.drawing.height, 3840);
  const xml = sceneOf(v.drawing, c);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<scene version="1\.1">/);
  assert.equal((xml.match(/markerEnd="arrow"/g) ?? []).length, v.layout.flows.length + 2, "a flow each, plus the two legend arrows");
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((xml.match(/<text /g) ?? []).length, (xml.match(/<layer /g) ?? []).length);
  assert.match(xml, new RegExp(`<project width="3840" height="${c.height}"`));
  assert.ok(!xml.includes("NaN"));
  assert.deepEqual(canvasFor(2000, 1000, 3840, 2160), { width: 3840, height: 2160 });
  assert.equal(canvasFor(2000, 1000, 3840).height, 1920);
});

test("helpers: conditions as text, wrapping at hyphens and ages", () => {
  assert.equal(conditionLabel({ all: [{ field: "a", op: "eq", value: "x" }, { not: { field: "b", op: "exists" } }] }), "a = x and not (b exists)");
  assert.equal(conditionLabel({ field: "k", op: "in", value: ["p", "q"] }), "k in [p, q]");
  assert.deepEqual(wrap("check harvest-codex-news", 14, 140, 3, true), ["check harvest-", "codex-news"]);
  assert.deepEqual(wrap("a b c d e f g h", 10, 30, 1), ["a b …"]);
  assert.equal(ago("2026-10-15T11:59:50.000Z", NOW), "now"); assert.equal(ago("2026-10-15T11:30:00.000Z", NOW), "30m"); assert.equal(ago("2026-10-12T12:00:00.000Z", NOW), "3d");
  void svgOf;
});
