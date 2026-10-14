// Auto-tuning loop, measurement and decision side. It runs no model: it measures the last 24 h from the engines' own
// transcripts and the queue ledger, decides with bounded, damped rules and records the decision with its evidence.
//
// Knob 1, Claude Code's compaction window (CLAUDE_CODE_AUTO_COMPACT_WINDOW): a session compacts itself when its context
// nears the window, so the window caps what every call re-reads. The loop lowers the window while the median context
// of main-session calls is over the target, and raises it when automatic compactions come too often. It applies the
// decision to env.CLAUDE_CODE_AUTO_COMPACT_WINDOW in ~/.claude/settings.json (new sessions read it), only that key,
// with a backup, at most once per holdHours: the owner authorised this on 2026-10-12 ("autorizo o ajuste automatico").
//
// Knob 2, the queue's runner for `--to auto` (govern's own decision, applied): the cheapest runner whose recent replies
// pass verification; one task in ten goes to the other runner so its numbers stay current.
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { readJsonl, kTok, nowIso } from "./util.ts";
import { tuningLogFile } from "./workspace.ts";
import * as queue from "./queue.ts";

const CLAUDE_DIR = () => process.env.GOVERN_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
const SETTINGS = () => process.env.GOVERN_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
export const VAR = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

export const RULES = {
  targetCtx: Number(process.env.GOVERN_TARGET_CTX ?? 150000), // median context per main-session call
  minWindow: 100000, maxWindow: 500000, step: 50000, firstWindow: 300000,
  maxAutoCompactsPer100Turns: 10,
  minCalls: 30, // fewer main-session calls in 24 h: not enough evidence
  holdHours: 6, // at most one change of the window in this time
};

export interface Metrics { calls: number; medianCtx: number; p90Ctx: number; ownerTurns: number; autoCompacts: number; manualCompacts: number; sessions: number; subagentCalls: number }

/** Main-session Claude Code metrics over the last `hours` (default 24), from transcripts under the Claude projects folder
 *  modified since then: call count and median/p90 context per call, owner turns, auto and manual compactions, sessions,
 *  subagent calls. No projects folder gives all zeros. */
export function measure(hours = 24): Metrics {
  const since = Date.now() - hours * 3600e3;
  const ctx: number[] = [];
  const m: Metrics = { calls: 0, medianCtx: 0, p90Ctx: 0, ownerTurns: 0, autoCompacts: 0, manualCompacts: 0, sessions: 0, subagentCalls: 0 };
  const root = CLAUDE_DIR();
  if (!existsSync(root)) return m;
  for (const proj of readdirSync(root)) {
    const pdir = join(root, proj);
    let entries: string[] = [];
    try { entries = readdirSync(pdir); } catch { continue; }
    for (const f of entries) {
      const full = join(pdir, f);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs < since) continue;
      if (st.isDirectory()) {
        const sub = join(full, "subagents");
        if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith(".jsonl")) m.subagentCalls += calls(join(sub, s), since).length;
        continue;
      }
      if (!f.endsWith(".jsonl")) continue;
      m.sessions++;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line.includes("compact_boundary") && !line.includes('"human"')) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (!(Date.parse(o.timestamp) >= since)) continue;
        if (o.subtype === "compact_boundary") { if (o.compactMetadata?.trigger === "auto") m.autoCompacts++; else m.manualCompacts++; }
        else if (o.type === "user" && o.origin?.kind === "human") m.ownerTurns++;
      }
      ctx.push(...calls(full, since));
    }
  }
  ctx.sort((a, b) => a - b);
  // with no calls the index is -1, which holds nothing: 0
  const q = (p: number) => ctx[Math.min(ctx.length - 1, Math.floor(p * ctx.length))] ?? 0;
  return { ...m, calls: ctx.length, medianCtx: q(0.5), p90Ctx: q(0.9) };
}

/** Context of each API call in a transcript since `since` (one entry per message id). */
function calls(file: string, since: number): number[] {
  const byId = new Map<string, number>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const o = JSON.parse(line); const u = o.message?.usage;
      if (o.type === "assistant" && u && Date.parse(o.timestamp) >= since)
        byId.set(o.message.id, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    } catch { /* partial line */ }
  }
  return [...byId.values()];
}

/** The window new Claude Code sessions use: the environment, else settings.json env, else Claude Code's default. */
export function currentWindow(): number | undefined {
  const parse = (v: unknown) => (v ? Number(String(v).replace(/k$/i, "000")) : undefined);
  if (process.env[VAR]) return parse(process.env[VAR]);
  try { return parse(JSON.parse(readFileSync(SETTINGS(), "utf8")).env?.[VAR]); } catch { return undefined; }
}

export interface Decision { knob: string; from?: number; to?: number; change: boolean; reason: string; metrics: Metrics }

/** The compaction-window decision for metrics `m` and current window `cur`: hold with too few calls or within the hold
 *  period after `lastChangeAt`; lower it when median context is over target; raise it when auto-compactions per 100 owner
 *  turns are high and context is low; else keep. Pure: it changes nothing. */
export function decideWindow(m: Metrics, cur: number | undefined, lastChangeAt?: number, now = Date.now()): Decision {
  const R = RULES;
  const base = { knob: "compact-window", from: cur, metrics: m };
  if (m.calls < R.minCalls) return { ...base, to: cur, change: false, reason: `only ${m.calls} main-session calls in 24 h (< ${R.minCalls}): no evidence for a change` };
  if (lastChangeAt !== undefined && now - lastChangeAt < R.holdHours * 3600e3)
    return { ...base, to: cur, change: false, reason: `last change ${Math.round((now - lastChangeAt) / 60000)} min ago: hold ${R.holdHours} h so sessions started under it can be measured` };
  const per100 = m.ownerTurns ? (m.autoCompacts / m.ownerTurns) * 100 : 0;
  if (m.medianCtx > R.targetCtx) {
    const to = cur === undefined ? R.firstWindow : Math.max(R.minWindow, cur - R.step);
    if (to === cur) return { ...base, to, change: false, reason: `median context ${kTok(m.medianCtx)} > ${kTok(R.targetCtx)}, but the window is at its floor ${kTok(R.minWindow)}` };
    return { ...base, to, change: true, reason: `median context ${kTok(m.medianCtx)} per call > target ${kTok(R.targetCtx)}: lower the compaction window` };
  }
  if (cur !== undefined && per100 > R.maxAutoCompactsPer100Turns && m.medianCtx < 0.6 * R.targetCtx) {
    const to = Math.min(R.maxWindow, cur + R.step);
    if (to !== cur) return { ...base, to, change: true, reason: `${per100.toFixed(1)} automatic compactions per 100 owner turns (> ${R.maxAutoCompactsPer100Turns}): raise the window` };
  }
  return { ...base, to: cur, change: false, reason: `median context ${kTok(m.medianCtx)} within target, ${per100.toFixed(1)} automatic compactions per 100 owner turns: keep` };
}

/** Whether a command resolves: a path that is an executable file, or a name found on PATH. */
function resolves(bin: string): boolean {
  const ok = (f: string) => { try { return statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0; } catch { return false; } };
  return bin.includes("/") ? ok(bin) : (process.env.PATH ?? "").split(":").filter(Boolean).some((d) => ok(join(d, bin)));
}

type Runner = "codex" | "claude" | "grok";
/** The runners `--to auto` may pick: codex and claude as before, grok only where its binary resolves (GOVERN_GROK_BIN, else PATH). */
function candidates(): Runner[] {
  return ["codex", "claude", ...(resolves(process.env.GOVERN_GROK_BIN ?? "grok") ? (["grok"] as const) : [])];
}

/** The runner for `--to auto`: cheapest mean input among available runners with ≥ 90 % verified replies over their last 30 runs
 *  (at least 3 runs). One message in ten goes to another candidate, rotating, so every runner's numbers stay current. */
export function chooseRunner(seq: number): { runner: Runner; reason: string } {
  const runs = readJsonl(join(queue.QUEUE(), "ledger.jsonl"));
  const stats = candidates().map((r) => {
    const last = runs.filter((e) => e.agent === r).slice(-30);
    // a run with no recorded usage (timeout, incomplete report) has unknown input: it is left out of the mean, never counted as zero
    const metered = last.filter((e) => typeof e.usage?.input === "number");
    return { r, n: last.length, okRate: last.length ? last.filter((e) => e.ok).length / last.length : 0, meanIn: metered.length ? metered.reduce((a, e) => a + e.usage.input, 0) / metered.length : Infinity };
  });
  const good = stats.filter((s) => s.n >= 3 && s.okRate >= 0.9).sort((a, b) => a.meanIn - b.meanIn);
  const best = good[0]?.r ?? "codex";
  if (good.length && seq % 10 === 9) {
    const others = stats.map((x) => x.r).filter((r) => r !== best);
    const other = others[Math.floor(seq / 10) % others.length];
    if (other) return { runner: other, reason: `exploration (1 in 10) keeps ${other}'s numbers current` };
  }
  const s = stats.find((x) => x.r === best)!;
  return { runner: best, reason: good.length ? `${best}: ${Math.round(s.okRate * 100)}% verified, mean ${kTok(Math.round(s.meanIn))} in over its last ${s.n} runs` : "fewer than 3 verified runs per runner: codex by default" };
}

/** Write only env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, keeping every other setting; the previous file is kept as a backup. */
function applyWindow(w: number): void {
  const f = SETTINGS();
  const s = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  if (existsSync(f)) copyFileSync(f, `${f}.govern-tune.bak`);
  s.env = { ...(s.env ?? {}), [VAR]: String(w) };
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, f);
}

/** One loop turn: measure, decide, apply, record. Returns the line for the log and the desk. */
export function tune(o: { dryRun?: boolean } = {}): string {
  const m = measure(24);
  const last = readJsonl(tuningLogFile()).filter((e) => e.knob === "compact-window" && e.applied).pop();
  const d = decideWindow(m, currentWindow(), last ? Date.parse(last.t) : undefined);
  const applied = d.change && !o.dryRun;
  if (applied) applyWindow(d.to!);
  mkdirSync(dirname(tuningLogFile()), { recursive: true });
  if (!o.dryRun) appendFileSync(tuningLogFile(), JSON.stringify({ t: nowIso(), ...d, applied }) + "\n");
  const w = (x?: number) => (x === undefined ? "default" : kTok(x));
  return `compact window ${w(d.from)}${d.change ? ` → ${applied ? "SET" : "would set"} ${w(d.to)}` : ""} · ${d.reason} · 24 h: ${m.calls} calls in ${m.sessions} sessions, median ${kTok(m.medianCtx)}, p90 ${kTok(m.p90Ctx)}, ${m.ownerTurns} owner turns, ${m.autoCompacts} auto + ${m.manualCompacts} manual compactions, ${m.subagentCalls} subagent calls`;
}

/** One status line: the current compact window and the last `govern tune` decision from the tuning log, or "never measured". */
export function tuningState(): string {
  const last = readJsonl(tuningLogFile()).pop();
  const cur = currentWindow();
  if (!last) return `tuning: compact window ${cur === undefined ? "default" : kTok(cur)} · never measured (govern tune)`;
  return `tuning: compact window ${cur === undefined ? "default" : kTok(cur)} (auto) · ${last.t.slice(0, 16).replace("T", " ")}: ${last.applied ? `set ${kTok(last.to)} — ` : ""}${last.reason}`;
}
