// The owner's one screen: every lane, the owner's inbox, the queue and today's tokens. Reads files only: no model,
// no transcript scan (that is `govern usage`).
import { existsSync, readFileSync, globSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonl, kTok, clip } from "./util.ts";
import { PROJECTS, ledgerFile, stagesOf, laneState, load } from "./project.ts";
import { processOf } from "./process.ts";
import * as queue from "./queue.ts";
import { tuningState } from "./tune.ts";

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const today = () => new Date().toISOString().slice(0, 10);

export function dispatcherState(): string {
  const f = join(queue.QUEUE(), "dispatcher.json");
  if (!existsSync(f)) return "dispatcher: not running (start: govern task dispatch --loop, or the govern-dispatch user service)";
  const d = JSON.parse(readFileSync(f, "utf8"));
  let alive = false;
  try { process.kill(d.pid, 0); alive = true; } catch { /* gone */ }
  return alive ? `dispatcher: running (pid ${d.pid}, since ${ago(d.started)} ago, every ${d.interval}s)` : `dispatcher: NOT running (last pid ${d.pid} gone)`;
}

export function desk(): string {
  const L: string[] = [];
  const slugs = globSync("**/govern.json", { cwd: PROJECTS }).map((f) => dirname(f)).sort();
  const day = today();
  // ---- lanes
  L.push(`LANES (${slugs.length})`);
  for (const s of slugs) {
    const p = load(s);
    const led = readJsonl(ledgerFile(s));
    const lastWork = [...led].reverse().find((e) => e.kind === "work" || e.kind === "done");
    const open = lastWork?.kind === "work" ? `● ${lastWork.engine} ${ago(lastWork.t)}` : "";
    const gates = processOf(p).gates;
    const gate = !gates.length ? "" : (() => { const g = gates.find((x) => !p.approvals[x.name]); return g ? `needs ${g.name}` : "all approved"; })();
    const note = p.notes.at(-1);
    const list = stagesOf(p);
    const state = laneState(p);
    L.push(`  ${s.padEnd(40)} ${p.kind.padEnd(5)} ${`${list.indexOf(p.stage) + 1}/${list.length} ${p.stage}`.padEnd(16)} ${gate.padEnd(13)} ${open.padEnd(14)} ${state ? `${state} · ` : ""}${note ? `${ago(note.at)}: ${clip(note.text, 60)}` : ""}`.trimEnd());
  }
  // ---- owner inbox
  const msgs = queue.all();
  const inbox = msgs.filter((x) => x.state === "open" && x.m.to === "owner");
  L.push("", `YOUR INBOX (${inbox.length})${inbox.length ? "  · read: govern task show <id>" : ""}`);
  for (const { m } of inbox.slice(-10)) L.push(`  ${m.id} ${m.kind.padEnd(8)} from ${m.from} [${m.project}] ${clip(m.summary, 80)}`);
  // ---- queue
  const count = (state: string, to?: string) => msgs.filter((x) => x.state === state && (!to || x.m.to === to)).length;
  L.push("", tuningState());
  const perRunner = queue.runners().map((r) => `${r}: ${count("open", r)} waiting, ${count("claimed", r)} running`);
  L.push("", `QUEUE  ${perRunner.join(" · ")} · failed: ${count("failed")} · ${dispatcherState()}`);
  // ---- tokens today (queue runs and codex asks; chat sessions: govern usage)
  const byLane = new Map<string, { calls: number; input: number; output: number; usd: number }>();
  const add = (lane: string, u: any, calls = 1) => {
    const x = byLane.get(lane) ?? { calls: 0, input: 0, output: 0, usd: 0 };
    x.calls += calls; x.input += u?.input ?? 0; x.output += u?.output ?? 0; x.usd += u?.costUsd ?? 0;
    byLane.set(lane, x);
  };
  for (const e of readJsonl(join(queue.QUEUE(), "ledger.jsonl"))) if (String(e.t).startsWith(day)) add(e.project, e.usage);
  for (const s of slugs) for (const e of readJsonl(ledgerFile(s))) if (e.kind === "ask" && String(e.t).startsWith(day)) add(s, e.usage, e.calls ?? 1);
  L.push("", `TOKENS TODAY (queue runs and codex asks; chat sessions: govern usage)`);
  if (!byLane.size) L.push("  (none)");
  for (const [lane, x] of [...byLane].sort((a, b) => b[1].input - a[1].input))
    L.push(`  ${lane.padEnd(40)} ${String(x.calls).padStart(3)} runs ${kTok(x.input).padStart(7)} in ${kTok(x.output).padStart(6)} out${x.usd ? `  $${x.usd.toFixed(2)}` : ""}`);
  return L.join("\n");
}
