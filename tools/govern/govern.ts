#!/usr/bin/env node
// govern — run a PALS Notes video through its workflow from inside a conversation, cheaply.
// The manual for the AI operating it is SKILL.md (govern manual). Usage: govern help.
import { spawnSync } from "node:child_process";
import { readFileSync, globSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { GovernError, fail, parseArgs, opt, nowIso, readJsonl, kTok, clip, type Args } from "./lib/util.ts";
import { REPO, PROJECTS, stagesOf, load, save, create, stageOf, brief, appendLedger, resolveFile, ledgerFile, projectDir, checkSlug, checkOf, blockedBy, laneState, stateFile, type Project } from "./lib/project.ts";
import { processes, getProcess, processOf, listLine, show } from "./lib/process.ts";
import * as jobs from "./lib/jobs.ts";
import { ask, readPrompt, PROMPTS } from "./lib/codex.ts";
import { report, currentCtx, CTX_WARN } from "./lib/usage.ts";
import * as queue from "./lib/queue.ts";
import { desk } from "./lib/desk.ts";
import { tune, chooseRunner } from "./lib/tune.ts";
import { checkRecipient, requireAs, resolveAs } from "./lib/sessions.ts";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "SKILL.md");

const HELP = `govern — run lanes of work (videos, software, ops, any process) through their stages with agents (manual: govern manual)

start / state
  govern new <slug> (--process NAME | --kind long|short|ops) [--title T] [--lang en|pt-BR] [--parent <slug>]
  govern work <slug> <stage> [--engine claude|codex] [--open]   start a work segment, print the brief
  govern brief <slug>            the compact context (stage, exit condition, approvals, files, decisions)
  govern status [<slug>]         one line per video, or the brief of one
  govern note <slug> "<decision>"          record a decision (state lives in files, not in the chat)
  govern approve <slug> <gate> --quote "<the owner's words>"   (gates come from the lane's process)
  govern done <slug>             end the current work segment
  govern cmd <slug> [<name> -- <argv…>] | --rm <name>      list or set the video's commands
  govern file <slug> <name> <path-or-glob>                 name a file (a glob means its newest match)

process: stages, exit checks, gates, dependencies
  govern process list  ·  govern process show <name>      built-in and workspace processes (processes/*.json)
  govern check <slug> [--set <command> --stage <stage>]   run the stage's exit check (or set the lane's own: ledgered, the brief flags it)
  govern advance <slug> [--note "<evidence>"]             next stage: needs the check to pass (or --note when none and none is required) and the gate
  govern dep <slug> [--after <lane>[:<stage>]] [--rm <lane>]   this lane waits on another (all of it, or past a stage)
  govern hook stop               Claude Code Stop hook: keeps a session on its lane until the stage's check passes (3 tries)

run without a model in the loop
  govern run <slug> <command> [--bg] [-- extra args]      foreground prints a summary; --bg returns a job id
  govern wait <slug> [<job>|last] [--timeout 540]          block until it ends; exit code = the job's (124 = still running)
  govern jobs <slug>  ·  govern log <slug> [<job>] [--tail 40] [--grep RE]

codex one-shot steps (verified JSON)
  govern prompts                 list the steps
  govern ask <slug> <step> [--file F]… [--var K=V]… [--image PNG]… [--effort low|medium|high] [--model M]

measure
  govern usage [<slug>…] [--since YYYY-MM-DD]   tokens and tool calls per video and segment, against the chat baseline
  govern ctx                     this Claude Code session's context size now
  govern manual  ·  govern install-skill [<skills dir>]   the AI's operating manual (SKILL.md)

task queue between agents (one fresh headless session per message; nothing runs while the queue waits)
  govern task send --to auto|codex|claude|owner|<session> --project P --task T --kind TASK --summary S (--body B | --body-file F)
                   [--file REPO-RELATIVE-PATH]… [--reply-to ID] [--write] [--from NAME]     --to must be a runner, owner or a LIVE session name
  govern task list [--to X] [--state open|claimed|done|failed] [--project P]  ·  govern task show <id>
  govern task inbox [--as NAME] [--all] [--hook]    open messages for NAME (default: GOVERN_AS, else this session); --hook is silent when empty
  govern task close <id> [--as NAME] [--note T]  ·  govern task forward <id> --to NAME [--as NAME]
  govern task reply <id> --kind K --summary S (--body B | --body-file F) [--as NAME]   answer the sender, then close <id>
  govern task dispatch [--max N] [--only codex|claude] [--loop --interval 30]  ·  govern task install-service
  (sessions are not woken by the queue: tell them "govern task show <id>" with SendMessage; the dispatcher runs codex, claude
   and the runners named in the queue's config.json, and stops a thread after maxRuns dispatched runs)

the owner's screen
  govern desk                    every lane, your inbox, the queue, today's tokens (reads files only)
  govern tune                    measure the last 24 h and record the tuning decision (the dispatcher runs it hourly)

publish (prints the commands; the publish guard hook must see them)
  govern publish <slug>

stages: govern process list`;

// A reader that stops early (govern brief x | head) is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); throw e; });
const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");

// What the session does about it by itself: the owner is never asked to /clear (context is the session's job).
const CTX_ADVICE = "keep state in files (govern note, memory), offload model work with `govern task send --to codex`, " +
  "wait on jobs in the background, and let auto-compaction (window tuned hourly by govern tune) shrink the rest";

function ctxFooter(): void {
  const c = currentCtx();
  if (c && c.ctx > CTX_WARN) out(`⚠ this session reads ${kTok(c.ctx)} per call (limit ${kTok(CTX_WARN)}): ${CTX_ADVICE}.`);
}

function engineOf(a: Args): "claude" | "codex" {
  const e = opt(a, "engine") ?? (process.env.CLAUDE_CODE_SESSION_ID ? "claude" : "codex");
  if (e !== "claude" && e !== "codex") fail("--engine must be claude or codex");
  return e as "claude" | "codex";
}

/** Whether the process lets only a passing check move the lane past `stage` (no note, no skip). */
const requiresCheck = (p: Project, stage: string) => processOf(p).stages.find((s) => s.name === stage)?.requires === "check";
const setCheckHint = (p: Project, stage: string) => `set one: govern check ${p.slug} --set <command> --stage ${stage}`;

/** Moving forward skips stages, so each skipped stage must be passable the way advance would pass it: not while
 *  blocked, a passing check where the stage has one (or requires one), and no open gate. Going back, or staying, is always allowed. */
function passSkipped(p: Project, to: string): void {
  const list = stagesOf(p);
  const from = list.indexOf(p.stage), target = list.indexOf(to);
  if (target <= from) return;
  const b = blockedBy(p);
  if (b.length) fail(`${p.slug} is blocked by ${b.join(", ")}`);
  for (const s of list.slice(Math.max(from, 0), target)) {
    const chk = checkOf(p, s);
    if (chk) {
      const r = runCheck(p, chk, s);
      if (!r.ok) fail(`${p.slug}: cannot skip stage ${s}: check ${chk} failed (exit ${r.exit})\n${r.text}\nnext: fix it, then govern advance ${p.slug}`);
    } else if (requiresCheck(p, s)) fail(`${p.slug}: cannot skip stage ${s}: it requires a check and has none (${setCheckHint(p, s)})`);
    const gate = processOf(p).gates.find((g) => g.stage === s && !p.approvals[g.name]);
    if (gate) fail(`${p.slug}: cannot skip stage ${s}: needs the owner's ${gate.name} approval (govern approve ${p.slug} ${gate.name} --quote "…")`);
  }
}

function cmdWork(a: Args): void {
  const p = load(a._[1]);
  const stage = stageOf(a._[2], p);
  passSkipped(p, stage);
  p.stage = stage;
  save(p);
  const engine = engineOf(a);
  if (a.opts.open) {
    const session = engine === "claude" ? randomUUID() : undefined;
    appendLedger(p.slug, { kind: "work", stage, engine, session });
    const first = `Video work session (registered by govern work ${p.slug} ${stage}). Use the govern skill: run \`govern brief ${p.slug}\` first and work from it; do not explore the repository. Then ask me what we change.`;
    const args = engine === "claude" ? ["--session-id", session!, first] : ["-C", REPO, first];
    const r = spawnSync(engine, args, { cwd: REPO, stdio: "inherit" });
    appendLedger(p.slug, { kind: "done", engine, session });
    process.exitCode = r.status ?? 0;
    return;
  }
  appendLedger(p.slug, { kind: "work", stage, engine, session: engine === "claude" ? process.env.CLAUDE_CODE_SESSION_ID : undefined });
  out(brief(p));
}

function cmdStatus(a: Args): void {
  if (a._[1]) return out(brief(load(a._[1])));
  const slugs = globSync("**/govern.json", { cwd: PROJECTS }).map((f) => dirname(f)).sort();
  if (!slugs.length) return out("nothing under govern yet (govern new <slug> --process NAME, or --kind long|short|ops)");
  for (const s of slugs) {
    const p = load(s);
    const lastJob = readJsonl(ledgerFile(s)).filter((e) => e.kind === "job").pop();
    const gates = processOf(p).gates;
    const ap = gates.map((g) => (p.approvals[g.name] ? g.name[0].toUpperCase() : "·")).join("");
    const list = stagesOf(p);
    const parts = [`${s.padEnd(36)} ${p.kind.padEnd(5)} ${list.indexOf(p.stage) + 1}/${list.length} ${p.stage.padEnd(12)}`, gates.length ? `approvals ${ap}` : "",
      laneState(p), lastJob ? `last job ${lastJob.name} ${lastJob.status}` : ""];
    out(parts.filter(Boolean).join("  ").trimEnd());
  }
}

function cmdApprove(a: Args): void {
  const p = load(a._[1]);
  const gates = processOf(p).gates;
  const g = gates.find((x) => x.name === a._[2]) ?? fail(`gate must be one of ${gates.map((x) => x.name).join(", ") || "(none: this process has no gates)"}`);
  const gate = g.name;
  const quote = opt(a, "quote");
  if (!quote || quote.trim().length < 2) fail(`--quote is required: the owner's own words approving the ${gate} (only the owner approves)`);
  for (const need of g.needs ?? []) if (!p.approvals[need]) fail(g.message ?? `needs the ${need} approval first`);
  p.approvals[gate] = { at: nowIso(), quote: quote! };
  p.notes.push({ at: nowIso(), stage: p.stage, text: `owner approved ${gate}: "${quote}"` });
  save(p);
  appendLedger(p.slug, { kind: "approve", gate, quote });
  out(`${p.slug}: ${gate} approved`);
}

/** Run the stage's exit check as a foreground job; records it in the ledger, prints nothing. */
function runCheck(p: Project, name: string, stage = p.stage): { ok: boolean; exit: number | null | undefined; text: string } {
  const st = jobs.start(p, name, [], false);
  const ok = st.exit === 0;
  appendLedger(p.slug, { kind: "check", stage, name, ok, exit: st.exit, job: st.id });
  return { ok, exit: st.exit, text: jobs.summary(p, st) };
}

function cmdCheck(a: Args): void {
  const p = load(a._[1]);
  const set = opt(a, "set");
  if (set) {
    const stage = stageOf(opt(a, "stage") ?? p.stage, p);
    const from = checkOf(p, stage) ?? null;
    p.checks = { ...(p.checks ?? {}), [stage]: set };
    save(p);
    appendLedger(p.slug, { kind: "check-set", stage, from, to: set });
    return out(`${p.slug}: stage ${stage} checked by "${set}"${p.commands[set] ? "" : ` (name it: govern cmd ${p.slug} ${set} -- …)`}`);
  }
  const name = checkOf(p);
  if (!name) return out(`${p.slug}: stage ${p.stage} has no check (set one: govern check ${p.slug} --set <command> --stage ${p.stage})`);
  const r = runCheck(p, name);
  out(`check ${name}: ${r.ok ? "ok" : `failed (exit ${r.exit})`}\n${r.text}`);
  if (!r.ok) process.exitCode = 1;
}

/** Move the lane to its next stage: not while blocked, only with a passing check (or evidence when none and none is
 *  required), never past an open gate. The ledger entry records which of the two passed it, and the note. */
function cmdAdvance(a: Args): void {
  const p = load(a._[1]);
  const b = blockedBy(p);
  if (b.length) fail(`${p.slug} is blocked by ${b.join(", ")}`);
  if (p.finished) fail(`${p.slug} is already finished`);
  const note = opt(a, "note");
  const chk = checkOf(p);
  if (chk) {
    const r = runCheck(p, chk);
    if (!r.ok) fail(`${p.slug}: check ${chk} failed (exit ${r.exit})\n${r.text}`);
  } else if (requiresCheck(p, p.stage)) fail(`${p.slug}: stage ${p.stage} requires a check and has none: a note cannot pass it (${setCheckHint(p, p.stage)})`);
  else if (!note) fail(`${p.slug}: stage ${p.stage} has no check: give the evidence with --note "…"`);
  const gate = processOf(p).gates.find((g) => g.stage === p.stage && !p.approvals[g.name]);
  if (gate) fail(`${p.slug}: needs the owner's ${gate.name} approval (govern approve ${p.slug} ${gate.name} --quote "…")`);
  const list = stagesOf(p);
  const from = p.stage, i = list.indexOf(from);
  const passed = { authority: chk ? "check" : "note", ...(chk ? { check: chk } : {}), ...(note ? { note } : {}) };
  if (note) p.notes.push({ at: nowIso(), stage: from, text: note });
  if (i === list.length - 1) {
    p.finished = nowIso();
    save(p);
    appendLedger(p.slug, { kind: "advance", from, to: "finished", ...passed });
    return out(`${p.slug}: ${from} was the last stage — lane finished`);
  }
  p.stage = list[i + 1];
  save(p);
  appendLedger(p.slug, { kind: "advance", from, to: p.stage, ...passed });
  out(`${p.slug}: ${from} → ${p.stage}${chk ? ` (check ${chk} ok)` : ""}`);
}

/** The chain of "after" links from lane `from` that reaches lane `to`, or null. Lanes that no longer exist end a chain. */
function waitPath(from: string, to: string, seen = new Set<string>()): string[] | null {
  if (from === to) return [to];
  if (seen.has(from) || !existsSync(stateFile(from))) return null;
  seen.add(from);
  for (const x of load(from).after ?? []) {
    const rest = waitPath(x.lane, to, seen);
    if (rest) return [from, ...rest];
  }
  return null;
}

function cmdDep(a: Args): void {
  const p = load(a._[1]);
  const add = opt(a, "after"), rm = opt(a, "rm");
  if (add) {
    const [lane, stage] = add.split(":");
    const o = load(lane);
    if (lane === p.slug) fail(`${p.slug} cannot wait on itself`);
    if (stage) stageOf(stage, o);
    const loop = waitPath(lane, p.slug);
    if (loop) fail(`${p.slug} cannot wait on ${lane}: ${loop.join(" → ")} already waits the other way`);
    p.after = [...(p.after ?? []).filter((x) => !(x.lane === lane && x.stage === stage)), { lane, ...(stage ? { stage } : {}) }];
  }
  if (rm) p.after = (p.after ?? []).filter((x) => x.lane !== rm);
  if (add || rm) { save(p); appendLedger(p.slug, { kind: "dep", after: p.after ?? [] }); }
  const labels = (p.after ?? []).map((x) => (x.stage ? `${x.lane}:${x.stage}` : x.lane));
  out(labels.length ? `${p.slug}: after ${labels.join(", ")}` : `${p.slug}: no dependencies`);
}

function cmdProcess(a: Args): void {
  if (a._[1] === "show") return out(show(getProcess(a._[2] ?? fail("govern process show <name>"))));
  if (a._[1] && a._[1] !== "list") fail("govern process list|show <name>");
  for (const p of processes().values()) out(listLine(p));
}

/** Claude Code Stop hook. Exit 2 (stderr = the reason) keeps the session working while its lane's stage check fails;
 *  3 refusals per work segment at most. Silent and exit 0 on anything else, including its own errors. */
function cmdHook(a: Args): void {
  if (a._[1] !== "stop") fail("govern hook stop");
  try {
    const sid = String(JSON.parse(readFileSync(0, "utf8")).session_id ?? "");
    if (!sid) return;
    // This session's lane: the one whose latest work/done entry for the session is a work entry.
    let hit: { slug: string; at: number; entries: Record<string, unknown>[] } | undefined;
    for (const f of globSync("**/govern.json", { cwd: PROJECTS })) {
      const slug = dirname(f);
      const entries = readJsonl(ledgerFile(slug));
      let at = -1;
      entries.forEach((e, i) => { if ((e.kind === "work" || e.kind === "done") && e.session === sid) at = i; });
      if (at < 0 || entries[at].kind !== "work") continue;
      if (!hit || String(entries[at].t) > String(hit.entries[hit.at].t)) hit = { slug, at, entries };
    }
    if (!hit) return;
    const blocks = hit.entries.slice(hit.at + 1).filter((e) => e.kind === "stop-block" && e.session === sid).length;
    if (blocks >= 3) { process.stderr.write(`govern: ${hit.slug}: stopped 3 times in this segment with the check failing; letting the session stop\n`); return; }
    const p = load(hit.slug);
    const chk = checkOf(p);
    if (!chk || !p.commands[chk]) return;
    const r = runCheck(p, chk);
    if (r.ok) return;
    appendLedger(p.slug, { kind: "stop-block", session: sid, stage: p.stage, check: chk });
    process.stderr.write(`${p.slug}: stage ${p.stage} is not done — check ${chk} failed (exit ${r.exit})\n${r.text}\n` +
      `next: govern check ${p.slug} after fixing, or govern advance ${p.slug} / govern note ${p.slug} "…" if the stage changed\n`);
    process.exitCode = 2;
  } catch { process.exitCode = 0; }
}

function cmdCmd(a: Args): void {
  const p = load(a._[1]);
  const rm = opt(a, "rm");
  if (rm) { delete p.commands[rm]; save(p); return out(`${p.slug}: removed command ${rm}`); }
  const name = a._[2];
  if (!name) { for (const [k, v] of Object.entries(p.commands)) out(`${k}: ${v.join(" ")}`); return; }
  const argv = a._.slice(3);
  if (!argv.length) fail(`give the argv after --: govern cmd ${p.slug} ${name} -- {python} build.py --preview`);
  p.commands[name] = argv;
  save(p);
  out(`${p.slug}: ${name} = ${argv.join(" ")}`);
}

function cmdFile(a: Args): void {
  const p = load(a._[1]);
  const [name, pat] = [a._[2], a._[3]];
  if (!name || !pat) { for (const k of Object.keys(p.files)) { const f = resolveFile(p, k); out(`${k}: ${p.files[k]} → ${f ? relative(REPO, f) : "(none)"}`); } return; }
  p.files[name] = pat;
  save(p);
  const f = resolveFile(p, name);
  out(`${p.slug}: ${name} = ${pat} → ${f ? relative(REPO, f) : "(nothing matches yet)"}`);
}

function cmdRun(a: Args): void {
  const p = load(a._[1]);
  const name = a._[2];
  if (!name) fail(`govern run ${p.slug} <command> (have: ${Object.keys(p.commands).join(", ") || "none"})`);
  const st = jobs.start(p, name, a._.slice(3), Boolean(a.opts.bg));
  if (st.status === "running") return out(`job ${st.id} started in the background · wait with: govern wait ${p.slug} ${st.id}`);
  out(jobs.summary(p, st));
  process.exitCode = st.exit ?? 1;
}

function cmdWait(a: Args): void {
  const p = load(a._[1]);
  const id = jobs.find(p.slug, a._[2]);
  const st = jobs.wait(p.slug, id, Number(opt(a, "timeout") ?? 540));
  if (st.timedOut) { out(`job ${id} still running after ${opt(a, "timeout") ?? 540}s · wait again with: govern wait ${p.slug} ${id}`); process.exitCode = 124; return; }
  appendLedger(p.slug, { kind: "job", id, name: st.name, bg: true, status: st.status, exit: st.exit, seconds: st.seconds });
  out(jobs.summary(p, st));
  process.exitCode = st.exit ?? 1;
}

function cmdAsk(a: Args): void {
  const p = load(a._[1]);
  const step = a._[2];
  if (!step) fail("govern ask <slug> <step> (see govern prompts)");
  const vars: Record<string, string> = {};
  for (const kv of a.multi.var ?? []) { const i = kv.indexOf("="); if (i < 1) fail(`--var needs NAME=VALUE: ${kv}`); vars[kv.slice(0, i)] = kv.slice(i + 1); }
  const r = ask(p, step, { files: a.multi.file, vars, images: a.multi.image, effort: opt(a, "effort"), model: opt(a, "model") });
  const u = r.usage;
  const meter = `codex ${step}: ${r.calls} call${r.calls > 1 ? "s" : ""}, ${r.turns} turns, ${kTok(u.input)} in (${u.input ? Math.round((u.cached / u.input) * 100) : 0}% cached), ${kTok(u.output)} out, ${r.seconds}s`;
  if (!r.ok) { out(`${meter}\nFAILED verification (nothing to use):\n- ${r.errors.join("\n- ")}\nraw: ${relative(REPO, r.out)}`); process.exitCode = 3; return; }
  out(`${meter} · verified · ${relative(REPO, r.out)}`);
  out(JSON.stringify(r.value, null, 1));
}

function cmdPrompts(): void {
  for (const f of globSync("*.md", { cwd: PROMPTS }).sort()) {
    const pf = readPrompt(f.replace(/\.md$/, ""));
    out(`${pf.name.padEnd(14)} ${pf.meta.effort ? `[${pf.meta.effort}] ` : ""}${pf.meta.description ?? ""}`);
  }
}

function cmdPublish(a: Args): void {
  const p = load(a._[1]);
  const missing = (["final", "publish"] as const).filter((g) => !p.approvals[g]);
  if (missing.length) fail(`${p.slug}: no owner approval recorded for: ${missing.join(", ")} (govern approve ${p.slug} <gate> --quote "…")`);
  const vpkg = resolveFile(p, "vpkg"), release = resolveFile(p, "release");
  if (!vpkg) fail(`${p.slug}: name the filed package first: govern file ${p.slug} vpkg ../../packages/<file>.vpkg.zip`);
  if (!release) fail(`${p.slug}: name the release manifest: govern file ${p.slug} release <path>/release.json`);
  const pkgs = join(REPO, "PALS-Notes", "packages");
  if (dirname(vpkg!) !== pkgs) fail(`${relative(REPO, vpkg!)} is not filed in PALS-Notes/packages`);
  const sha = spawnSync("sha256sum", [vpkg!], { encoding: "utf8" }).stdout.split(" ")[0];
  const sums = globSync("channel-vpkg-SHA256SUMS-*.txt", { cwd: pkgs }).some((f) => readFileSync(join(pkgs, f), "utf8").includes(sha));
  if (!sha || !sums) fail(`${relative(REPO, vpkg!)}: sha256 not in any channel-vpkg-SHA256SUMS-*.txt (file the package first)`);
  const base = vpkg!.split("/").pop();
  out(`${p.slug}: approvals ✓ (final, publish) · package filed ✓ ${base}`);
  out(`On the publishing host (smm), with the release manifest ${relative(REPO, release!)} copied there:`);
  out(`  1. plan:  smm youtube publish release.json --upload`);
  out(`  2. apply: PACKAGE_FILED=${base} smm youtube publish release.json --upload --apply`);
  out(`Then read the result back, and run: govern note ${p.slug} "published <videoId> at <time>"`);
}

/** Recipient of a new message: runner, auto (the tuning loop picks the runner), owner or a live session. */
function recipient(to: string): { to: string; routed: boolean } {
  checkRecipient(to, queue.runners());
  if (to !== "auto") return { to, routed: false };
  const c = chooseRunner(queue.all().filter((x) => x.m.routed).length);
  out(`auto → ${c.runner} (${c.reason})`);
  return { to: c.runner, routed: true };
}
/** The queue does not wake a session: say so when a message goes to one. */
function wakeNote(m: queue.Message): void {
  if (!queue.runners().includes(m.to) && m.to !== "owner")
    out(`sessions are not woken by the queue: also tell ${m.to} "govern task show ${m.id}" (SendMessage)`);
}
const rowLine = ({ state, m }: { state: string; m: queue.Message }) => {
  const u = m.result?.usage;
  return `${m.id} ${state.padEnd(7)} ${m.kind.padEnd(8)} ${m.from}→${m.to} [${m.project}/${m.task}] ${clip(m.summary, 70)}${u ? ` · ${kTok(u.input)} in, ${kTok(u.output)} out, ${m.result!.seconds}s` : ""}`;
};

function cmdInbox(a: Args): void {
  if (a.opts.hook) {
    // For a UserPromptSubmit/SessionStart hook: silent unless there is something to say, and it never fails.
    try {
      const name = resolveAs({ as: opt(a, "as") });
      if (!name) return;
      const rows = queue.all().filter((x) => x.state === "open" && x.m.to === name);
      if (!rows.length) return;
      out(`govern queue: ${rows.length} open message(s) for ${name}:`);
      rows.slice(0, 5).forEach(({ m }) => out(`  ${m.id} [${m.kind}] ${clip(m.summary, 80)}`));
      if (rows.length > 5) out(`  +${rows.length - 5} more`);
    } catch { /* a hook must not break the session */ }
    return;
  }
  const name = requireAs(opt(a, "as"));
  const rows = queue.all().filter((x) => x.m.to === name && (a.opts.all || x.state === "open"));
  if (!rows.length) return out("(no messages)");
  rows.forEach((r) => out(rowLine(r)));
}

function cmdTask(a: Args): void {
  const sub = a._[1];
  if (sub === "send") {
    const bodyFile = opt(a, "body-file");
    const body = bodyFile ? readFileSync(bodyFile, "utf8") : opt(a, "body") ?? "";
    const { to, routed } = recipient(opt(a, "to") ?? "");
    const m = queue.send({
      project: opt(a, "project") ?? "", task: opt(a, "task") ?? "", kind: opt(a, "kind") ?? "TASK", from: opt(a, "from") ?? resolveAs() ?? fail("cannot tell who is sending (no parent process is a registered Claude Code session): pass --from NAME"),
      to, ...(routed ? { routed: true } : {}), summary: opt(a, "summary") ?? "", body, files: a.multi.file ?? [], replyTo: opt(a, "reply-to"),
      access: a.opts.write ? "write" : "read-only",
    });
    out(`queued ${m.id} (${m.kind} to ${m.to})`);
    return wakeNote(m);
  }
  if (sub === "list") {
    const rows = queue.all().filter((x) => (!opt(a, "to") || x.m.to === opt(a, "to")) && (!opt(a, "state") || x.state === opt(a, "state")) && (!opt(a, "project") || x.m.project === opt(a, "project")));
    if (!rows.length) return out("(no messages)");
    rows.forEach((r) => out(rowLine(r)));
    return;
  }
  if (sub === "show") {
    const hit = queue.find(a._[2] ?? "") ?? fail(`no message ${a._[2]}`);
    for (const m of queue.thread(hit!.m)) out(`--- ${m.id} [${m.kind}] ${m.from}→${m.to} ${m.created}\n${m.summary}\n${m.body}${m.files.length ? `\nfiles: ${m.files.join(", ")}` : ""}${m.result ? `\nresult: ${JSON.stringify(m.result)}` : ""}`);
    return;
  }
  if (sub === "inbox") return cmdInbox(a);
  if (sub === "close") {
    const m = queue.close(a._[2] ?? "", requireAs(opt(a, "as")), opt(a, "note"));
    return out(`closed ${m.id}`);
  }
  if (sub === "reply") {
    const bodyFile = opt(a, "body-file"), b = opt(a, "body");
    if (bodyFile === undefined && b === undefined) fail("--body or --body-file is required");
    const by = requireAs(opt(a, "as"));
    const m = queue.reply(a._[2] ?? "", by, { kind: opt(a, "kind") ?? "", summary: opt(a, "summary") ?? "", body: bodyFile ? readFileSync(bodyFile, "utf8") : b! });
    out(`replied ${m.id} (${m.kind} to ${m.to}); closed ${a._[2]}`);
    return wakeNote(m);
  }
  if (sub === "forward") {
    const { to, routed } = recipient(opt(a, "to") ?? "");
    const m = queue.forward(a._[2] ?? "", requireAs(opt(a, "as")), to, routed);
    out(`forwarded ${a._[2]} to ${m.to} as ${m.id}`);
    return wakeNote(m);
  }
  if (sub === "dispatch") {
    const max = opt(a, "max") ? Number(opt(a, "max")) : undefined;
    const once = () => queue.dispatch({ max, only: opt(a, "only") }).forEach((l) => out(l));
    if (!a.opts.loop) { once(); return; }
    const secs = Number(opt(a, "interval") ?? 30);
    const pidf = join(queue.QUEUE(), "dispatcher.json");
    mkdirSync(queue.QUEUE(), { recursive: true });
    writeFileSync(pidf, JSON.stringify({ pid: process.pid, started: nowIso(), interval: secs }) + "\n");
    const stop = () => { try { if (existsSync(pidf) && JSON.parse(readFileSync(pidf, "utf8")).pid === process.pid) unlinkSync(pidf); } catch { /* gone */ } process.exit(0); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    // setTimeout, not a blocking sleep: signals are handled only when the event loop turns.
    // The tuning measurement runs hourly in the same loop: reading transcripts, no model.
    let lastTune = 0;
    const tick = () => {
      once();
      if (Date.now() - lastTune > 3600e3) { lastTune = Date.now(); try { out(`[tune] ${tune()}`); } catch (e) { out(`[tune] failed: ${(e as Error).message}`); } }
      setTimeout(tick, secs * 1000);
    };
    tick();
    return;
  }
  if (sub === "install-service") {
    // A user systemd service, so the dispatcher survives sessions and reboots. It runs a model only when a message waits.
    const unit = join(homedir(), ".config", "systemd", "user", "govern-dispatch.service");
    mkdirSync(dirname(unit), { recursive: true });
    const bin = resolve(HERE, "..", "..", "bin", "govern");
    writeFileSync(unit, [
      "[Unit]", "Description=govern task dispatcher (one fresh codex/claude session per queued message)", "",
      "[Service]", `WorkingDirectory=${REPO}`, `ExecStart=${bin} task dispatch --loop --interval ${opt(a, "interval") ?? 30}`,
      `Environment=PATH=${process.env.PATH}`, `Environment=GOVERN_QUEUE=${queue.QUEUE()}`, "Restart=on-failure", "RestartSec=30", "",
      "[Install]", "WantedBy=default.target", "",
    ].join("\n"));
    return out(`wrote ${unit}\nenable with: systemctl --user daemon-reload && systemctl --user enable --now govern-dispatch`);
  }
  fail("govern task send|list|show|inbox|close|reply|forward|dispatch|install-service (govern help)");
}

function main(argv: string[]): void {
  const a = parseArgs(argv, { bool: ["bg", "open", "help", "write", "loop", "hook", "all"], multi: ["file", "var", "image"] });
  const c = a._[0];
  switch (c) {
    case undefined: case "help": case "-h": return out(HELP);
    case "manual": return out(readFileSync(SKILL, "utf8"));
    case "install-skill": {
      const dest = join(a._[1] ?? join(REPO, ".claude", "skills"), "govern", "SKILL.md");
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(SKILL, dest);
      return out(`installed ${dest} (refresh with govern install-skill after editing tools/govern/SKILL.md)`);
    }
    case "new": {
      const p = create(checkSlug(a._[1]), { kind: opt(a, "kind"), process: opt(a, "process"), title: opt(a, "title"), lang: opt(a, "lang"), parent: opt(a, "parent") });
      out(`created ${relative(REPO, join(projectDir(p.slug), "govern.json"))}`);
      return out(brief(p));
    }
    case "work": cmdWork(a); break;
    case "brief": out(brief(load(a._[1]))); break;
    case "status": cmdStatus(a); break;
    case "note": {
      const p = load(a._[1]);
      const text = a._.slice(2).join(" ").trim();
      if (!text) fail("govern note <slug> \"<decision>\"");
      p.notes.push({ at: nowIso(), stage: p.stage, text });
      save(p);
      appendLedger(p.slug, { kind: "note", text });
      out(`${p.slug}: noted (${p.notes.length})`);
      break;
    }
    case "approve": cmdApprove(a); break;
    case "check": cmdCheck(a); break;
    case "advance": cmdAdvance(a); break;
    case "dep": cmdDep(a); break;
    case "process": cmdProcess(a); break;
    case "hook": return cmdHook(a);
    case "done": { const p = load(a._[1]); appendLedger(p.slug, { kind: "done", engine: engineOf(a), session: process.env.CLAUDE_CODE_SESSION_ID }); out(`${p.slug}: segment closed`); break; }
    case "cmd": cmdCmd(a); break;
    case "file": cmdFile(a); break;
    case "run": cmdRun(a); break;
    case "wait": cmdWait(a); break;
    case "jobs": { const p = load(a._[1]); for (const id of jobs.list(p.slug).slice(-15)) { const s = jobs.state(p.slug, id); out(`${id} ${s.status}${s.exit != null ? ` exit ${s.exit}` : ""}${s.seconds != null ? ` ${s.seconds}s` : ""}`); } break; }
    case "log": { const p = load(a._[1]); const id = jobs.find(p.slug, a._[2]); out(jobs.tail(p.slug, id, Number(opt(a, "tail") ?? 40), opt(a, "grep")).join("\n") || "(empty log)"); break; }
    case "prompts": return cmdPrompts();
    case "ask": cmdAsk(a); break;
    case "usage": { const since = opt(a, "since"); return out(report(a._.length > 1 ? a._.slice(1).map(checkSlug) : undefined, since ? Date.parse(since) : undefined)); }
    case "ctx": { const x = currentCtx(); return out(x ? `context now ${kTok(x.ctx)} per call (limit ${kTok(CTX_WARN)})${x.ctx > CTX_WARN ? ` ⚠ over: ${CTX_ADVICE}` : ""}` : "not in a Claude Code session (no CLAUDE_CODE_SESSION_ID) or no transcript yet"); }
    case "publish": cmdPublish(a); break;
    case "task": cmdTask(a); break;
    case "desk": out(desk()); break;
    case "tune": out(tune()); break;
    default: fail(`unknown command "${c}" (govern help)`);
  }
  ctxFooter();
}

try { main(process.argv.slice(2)); }
catch (e) {
  if (e instanceof GovernError) { process.stderr.write(`govern: ${e.message}\n`); process.exitCode = e.code; }
  else throw e;
}
