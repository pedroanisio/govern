// The owner's one screen: every lane, the owner's inbox, the queue and today's tokens. Reads files only: no model,
// no transcript scan (that is `govern usage`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, kTok, clip } from "./util.ts";
import { ledgerFile, stagesOf, laneState, laneSlugs, laneRows } from "./project.ts";
import { processOf } from "./process.ts";
import * as queue from "./queue.ts";
import { tag } from "./replycheck.ts";
import { registry, readCheck, checkState, profileHash } from "./caps.ts";
import { tuningState } from "./tune.ts";
import * as allowances from "./allowances.ts";
import { machineSummary, machineEntries, stateDir } from "./resources.ts";
import { deskLines } from "./reap.ts";

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

/** The desk's text, with how many of its `lanes` could not be read (each shown as a ✖ row; the caller exits 1). */
export function desk(): { text: string; failed: number; lanes: number } {
  const L: string[] = [];
  const slugs = laneSlugs();
  const day = today();
  // ---- lanes
  L.push(`LANES (${slugs.length})`);
  const { rows, failed } = laneRows(slugs, (s, p) => {
    const led = readJsonl(ledgerFile(s));
    const lastWork = [...led].reverse().find((e) => e.kind === "work" || e.kind === "done");
    const open = lastWork?.kind === "work" ? `● ${lastWork.engine} ${ago(lastWork.t)}` : "";
    const gates = processOf(p).gates;
    const gate = !gates.length ? "" : (() => { const g = gates.find((x) => !p.approvals[x.name]); return g ? `needs ${g.name}` : "all approved"; })();
    const note = p.notes.at(-1);
    const list = stagesOf(p);
    const state = laneState(p);
    return `  ${s.padEnd(40)} ${p.kind.padEnd(5)} ${`${list.indexOf(p.stage) + 1}/${list.length} ${p.stage}`.padEnd(16)} ${gate.padEnd(13)} ${open.padEnd(14)} ${state ? `${state} · ` : ""}${note ? `${ago(note.at)}: ${clip(note.text, 60)}` : ""}`.trimEnd();
  }, "  ");
  L.push(...rows);
  // ---- owner inbox
  const msgs = queue.all();
  const inbox = msgs.filter((x) => x.state === "open" && x.m.to === "owner");
  L.push("", `YOUR INBOX (${inbox.length})${inbox.length ? "  · read: govern task show <id>" : ""}`);
  for (const { m } of inbox.slice(-10)) L.push(`  ${m.id} ${m.kind.padEnd(8)} from ${m.from} [${m.project}] ${clip(m.summary, 80)}${m.verification ? ` ${tag(m.verification)}` : ""}`);
  // ---- queue
  const count = (state: string, to?: string) => msgs.filter((x) => x.state === state && (!to || x.m.to === to)).length;
  const bad = msgs.filter((x) => x.m.verification?.state === "unverified" && x.state !== "done").length;
  L.push("", tuningState());
  const perRunner = queue.plainRunners().map((r) => `${r}: ${count("open", r)} waiting, ${count("claimed", r)} running`);
  L.push("", `QUEUE  ${perRunner.join(" · ")} · failed: ${count("failed")} · ${dispatcherState()}`);
  if (bad) L.push(`unverified replies: ${bad}  · their content is kept but no check passed: govern task show <id>`);
  // ---- profiles with work queued or a check on record
  const reg = registry();
  const byProfile = [...reg.profiles.values()].map((p) => {
    const n = msgs.filter((x) => x.state === "open" && x.m.profile === p.name).length;
    const st = checkState(readCheck(queue.QUEUE(), p.name), profileHash(reg, p));
    return { p, n, st };
  }).filter((x) => x.n || x.st !== "none");
  if (byProfile.length) L.push("", `PROFILES  ${byProfile.map(({ p, n, st }) => `${p.name}: ${n} queued${st === "none" ? "" : `, check ${st}`}`).join(" · ")}`);
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
  // ---- machines today (jobs run on resources: seconds, and money where the price is by time)
  L.push("", "MACHINES TODAY (jobs on resources and locally; seconds held, money where time-priced)");
  const rows2 = slugs.flatMap((s) => {
    const m = machineSummary(machineEntries(ledgerFile(s)).filter((e) => String(e["t"]).startsWith(day)));
    return m ? [`  ${s.padEnd(40)} ${m.time}${m.money ? `  ${m.money}` : ""}`] : [];
  });
  // machines started by `govern up` with no lane are booked in the state ledger
  const bare = machineSummary(machineEntries(join(stateDir(), "ledger.jsonl")).filter((e) => String(e["t"]).startsWith(day)));
  if (bare) rows2.push(`  ${"(no lane)".padEnd(40)} ${bare.time}${bare.money ? `  ${bare.money}` : ""}`);
  L.push(...(rows2.length ? rows2 : ["  (none)"]));
  try { L.push(...deskLines()); } catch (e) { L.push(`  instance scan unreadable: ${(e as Error).message}`); }
  const allow = allowances.shown();
  if (allow.length) L.push("", "ALLOWANCES (used, reserved, left; raise one with govern allow)", ...allow.map((l) => `  ${l}`));
  return { text: L.join("\n"), failed, lanes: slugs.length };
}
