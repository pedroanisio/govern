import { gateApproved } from './business.ts';
// The owner's one screen: every lane, the owner's inbox, the queue and today's tokens. Reads files only: no model,
// transcript scan beyond today's transcripts, which an index keeps parsed (the full report is `govern usage`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, kTok, clip } from "./util.ts";
import { load, ledgerFile, stagesOf, laneState, driftWarning, laneSlugs, laneRows } from "./project.ts";
import { processOf } from "./process.ts";
import * as queue from "./queue.ts";
import { tag } from "./replycheck.ts";
import { registry, readCheck, checkState, profileHash } from "./caps.ts";
import { tuningState } from "./tune.ts";
import { coreManualTokens } from "./skill.ts";
import * as allowances from "./allowances.ts";
import { machineSummary, machineEntries, stateDir } from "./resources.ts";
import { deskLines } from "./reap.ts";
import { deskLines as sliceLines } from "./slice.ts";
import { deskUsage, unattributedLines, type Stray } from "./usage.ts";

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const today = () => new Date().toISOString().slice(0, 10);

/** The queue dispatcher's record (dispatcher.json) and whether its process is alive; undefined when it never ran. */
export function dispatcherInfo(): { running: boolean; pid: number; started: string; interval: number } | undefined {
  const f = join(queue.QUEUE(), "dispatcher.json");
  if (!existsSync(f)) return undefined;
  const d = JSON.parse(readFileSync(f, "utf8"));
  let running = false;
  try { process.kill(d.pid, 0); running = true; } catch { /* gone */ }
  return { running, pid: d.pid, started: d.started, interval: d.interval };
}

/** One status line for the queue dispatcher: not running (with how to start it), running (pid, age, interval), or its
 *  last pid gone. */
export function dispatcherState(): string {
  const d = dispatcherInfo();
  if (!d) return "dispatcher: not running (install: govern task install-service)";
  return d.running ? `dispatcher: running (pid ${d.pid}, since ${ago(d.started)} ago, every ${d.interval}s)` : `dispatcher: NOT running (last pid ${d.pid} gone; install: govern task install-service)`;
}

/** Model use on `day` (YYYY-MM-DD) per lane: queue runs (the queue's ledger) and codex asks (each lane's ledger).
 *  Chat sessions are not here: they are read from transcripts by `govern usage`. */
export function tokensOn(slugs: string[], day: string): Map<string, { calls: number; input: number; output: number; usd: number }> {
  const byLane = new Map<string, { calls: number; input: number; output: number; usd: number }>();
  const add = (lane: string, u: any, calls = 1) => {
    const x = byLane.get(lane) ?? { calls: 0, input: 0, output: 0, usd: 0 };
    x.calls += calls; x.input += u?.input ?? 0; x.output += u?.output ?? 0; x.usd += u?.costUsd ?? 0;
    byLane.set(lane, x);
  };
  for (const e of readJsonl(join(queue.QUEUE(), "ledger.jsonl"))) if (String(e.t).startsWith(day)) { add(e.project, e.usage); if (e.repair?.usage) add(e.project, e.repair.usage, 0); }
  for (const s of slugs) for (const e of readJsonl(ledgerFile(s))) if ((e.kind === "ask" || e.kind === "conversation") && String(e.t).startsWith(day)) add(s, e.usage, e.calls ?? 1);
  for (const e of readJsonl(join(stateDir(), "conversations", "ledger.jsonl"))) if (String(e.t).startsWith(day)) add(`conversation:${e.conversation}`, e.usage, 1);
  return byLane;
}

/** What became of the replies the dispatcher filed on `day`, from the queue's ledger: checked, shape only (no check declared, or an older entry
 *  with no mark), unverified, and how many of those had their envelope repaired. A run that failed filed no reply and is not counted. */
export function repliesToday(day: string): string {
  const n = { checked: 0, "shape only": 0, unverified: 0, repaired: 0 };
  for (const e of readJsonl(join(queue.QUEUE(), "ledger.jsonl"))) {
    if (!String(e.t).startsWith(day) || e.kind === "relay" || e.ok !== true) continue;
    n[e.verification === "checked" ? "checked" : e.verification === "unverified" ? "unverified" : "shape only"]++;
    if (e.repaired === true) n.repaired++;
  }
  return `replies today: ${n.checked} checked · ${n["shape only"]} shape only · ${n.unverified} unverified · ${n.repaired} repaired`;
}

/** The desk's text, with how many of its `lanes` could not be read (each shown as a ✖ row; the caller exits 1). */
export function desk(extensionLines: readonly string[] = []): { text: string; failed: number; lanes: number } {
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
    const gate = !gates.length ? "" : (() => { const g = gates.find((x) => !gateApproved(p, x)); return g ? `needs ${g.name}` : "all approved"; })();
    const note = p.notes.at(-1);
    const list = stagesOf(p);
    const state = laneState(p);
    const drift = driftWarning(p, led);
    return `  ${s.padEnd(40)} ${p.kind.padEnd(5)} ${`${list.indexOf(p.stage) + 1}/${list.length} ${p.stage}`.padEnd(16)} ${gate.padEnd(13)} ${open.padEnd(14)} ${p.workflow && !p.finished ? `active ${p.workflow.active.join(", ")} · ` : ""}${state ? `${state} · ` : ""}${note ? `${ago(note.at)}: ${clip(note.text, 60)}` : ""}`.trimEnd() + (drift ? `\n      ${drift}` : "");
  }, "  ");
  L.push(...rows);
  const alerts=slugs.flatMap(s=>{try{return (load(s).alerts??[]).filter(a=>!a.acknowledgedAt).map(a=>`  ${s} ${a.id}: ${clip(a.message,100)}`);}catch{return [];}});
  if(alerts.length)L.push('',`TIMER ALERTS (${alerts.length})`,...alerts);
  // ---- owner inbox
  const msgs = queue.all();
  const inbox = msgs.filter((x) => x.state === "open" && x.m.to === "owner");
  L.push("", `YOUR INBOX (${inbox.length})${inbox.length ? "  · read: govern task show <id>" : ""}`);
  for (const { m } of inbox.slice(-10)) L.push(`  ${m.id} ${m.kind.padEnd(8)} from ${m.from} [${m.project}] ${clip(m.summary, 80)}${m.verification ? ` ${tag(m.verification)}` : ""}`);
  // ---- queue
  const count = (state: string, to?: string) => msgs.filter((x) => x.state === state && (!to || x.m.to === to)).length;
  const bad = msgs.filter((x) => x.m.verification?.state === "unverified" && x.state !== "done").length;
  L.push("", `${tuningState()} · manual ≈ ${coreManualTokens()} tokens`);
  let runners: readonly string[] = queue.BUILTIN_RUNNERS;
  try { runners = queue.plainRunners(); } catch (e) { L.push(`queue: config error — ${e instanceof Error ? e.message : String(e)}`); }
  const claims = msgs.filter((x) => x.state === "claimed").map(({ m }) => ({ m, holder: queue.claimState(m) }));
  const limitOf = (r: string): number => { try { return queue.runnerLimit(r); } catch { return 1; } }; // a bad config is already reported above
  const perRunner = runners.map((r) => `${r}: ${count("open", r)} waiting, running ${claims.filter((x) => x.m.to === r && x.holder === "live").length}/${limitOf(r)}`);
  L.push("", `QUEUE  ${perRunner.join(" · ")} · failed: ${count("failed")} (govern task triage) · ${dispatcherState()} · ${repliesToday(day)}`);
  for (const { m, holder } of claims) if (holder === "live" && queue.grokBound(m)) L.push(`  ${m.id}: running · ${queue.grokBound(m)}`);
  for (const { m, holder } of claims) if (holder !== "live")
    L.push(`  ${m.id}: ${holder} holder${holder === "dead" ? ` (${m.claim!.by})` : ""} · inspect: govern task show ${m.id}${holder === "unknown" ? ` · recover: govern task reclaim ${m.id} --note "<why>"` : " · recovered on next dispatch"}`);
  if (bad) L.push(`unverified replies: ${bad}  · their content is kept but no check passed: govern task show <id>`);
  const asked = msgs.filter((x) => (x.state === "open" || x.state === "claimed") && (x.m.check || x.m.verify));
  if (asked.length) L.push(`checks asked of replies (--check, --verify): ${asked.map(({ m }) => `${m.id}: ${[...(m.check ?? []), ...(m.verify ? ["verify"] : [])].join("+")}`).join(" · ")}`);
  // ---- profiles with work queued or a check on record
  const reg = registry();
  const byProfile = [...reg.profiles.values()].map((p) => {
    const n = msgs.filter((x) => x.state === "open" && x.m.profile === p.name).length;
    const st = checkState(readCheck(queue.QUEUE(), p.name), profileHash(reg, p));
    return { p, n, st };
  }).filter((x) => x.n || x.st !== "none");
  if (byProfile.length) L.push("", `PROFILES  ${byProfile.map(({ p, n, st }) => `${p.name}: ${n} queued${st === "none" ? "" : `, check ${st}`}`).join(" · ")}`);
  // ---- tokens today (queue runs, codex asks, and chat sessions attributed to a lane)
  const byLane = tokensOn(slugs, day);
  const partly = new Set<string>();
  let stray: Stray[] = [], attributed = new Set<string>(), chatNote = "";
  try {
    const u = deskUsage(day);
    stray = u.stray; attributed = u.attributed;
    for (const [lane, c] of u.chat) {
      const x = byLane.get(lane) ?? { calls: 0, input: 0, output: 0, usd: 0 };
      x.calls += c.calls; x.input += c.input; x.output += c.output; x.usd += c.usd;
      byLane.set(lane, x);
      if (c.partly) partly.add(lane);
    }
  } catch (e) { chatNote = `  chat sessions unreadable: ${(e as Error).message}`; }
  L.push("", "TOKENS TODAY (queue runs, codex asks and chat sessions attributed to a lane by segment, GOVERN_LANE or folder; a run is a queue run or a model call)");
  if (!byLane.size) L.push("  (none)");
  for (const [lane, x] of [...byLane].sort((a, b) => b[1].input - a[1].input))
    L.push(`  ${lane.padEnd(40)} ${String(x.calls).padStart(3)} runs ${kTok(x.input).padStart(7)} in ${kTok(x.output).padStart(6)} out${x.usd ? `  $${x.usd.toFixed(2)}` : ""}${partly.has(lane) ? "  (partly unsegmented)" : ""}`);
  if (chatNote) L.push(chatNote);
  // ---- sessions that belong to no lane, and lanes with work and no session
  L.push("", ...unattributedLines(stray, attributed));
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
  try { L.push(...sliceLines(slugs)); } catch (e) { L.push(`  slices unreadable: ${(e as Error).message}`); }
  try { L.push(...deskLines()); } catch (e) { L.push(`  instance scan unreadable: ${(e as Error).message}`); }
  const allow = allowances.shown();
  if (allow.length) L.push("", "ALLOWANCES (used, reserved, left; raise one with govern allow)", ...allow.map((l) => `  ${l}`));
  L.push(...extensionLines);
  return { text: L.join("\n"), failed, lanes: slugs.length };
}
