#!/usr/bin/env node
// govern — run a PALS Notes video through its workflow from inside a conversation, cheaply.
// The manual for the AI operating it is SKILL.md (govern manual). Usage: govern help.
import { spawnSync } from "node:child_process";
import { readFileSync, globSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { GovernError, fail, parseArgs, opt, flag, many, flagNames, secondsOpt, nowIso, readJsonl, kTok, clip, type Args, type FlagSpec } from "./lib/util.ts";
import { REPO, PROJECTS, stagesOf, load, save, create, stageOf, brief, appendLedger, resolveFile, ledgerFile, projectDir, checkSlug, checkOf, pendingCheckChanges, blockedBy, laneState, stateFile, argvOf, commandLine, type Project, type Command } from "./lib/project.ts";
import { processes, getProcess, processOf, listLine, show } from "./lib/process.ts";
import * as jobs from "./lib/jobs.ts";
import { ask, readPrompt, PROMPTS } from "./lib/codex.ts";
import { report, currentCtx, CTX_WARN } from "./lib/usage.ts";
import * as queue from "./lib/queue.ts";
import { desk } from "./lib/desk.ts";
import { tune, chooseRunner } from "./lib/tune.ts";
import { checkRecipient, requireAs, resolveAs } from "./lib/sessions.ts";
import { installSkill, skillDrift, sha256File } from "./lib/skill.ts";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "SKILL.md");

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
      if (!r.ok) fail(`${p.slug}: cannot skip stage ${s}: check ${chk} failed (${r.why})\n${r.text}\nnext: fix it, then govern advance ${p.slug}`);
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
  if (flag(a, "open")) {
    const session = engine === "claude" ? randomUUID() : undefined;
    appendLedger(p.slug, { kind: "work", stage, engine, session, skillSha: sha256File(SKILL) });
    const first = `Video work session (registered by govern work ${p.slug} ${stage}). Use the govern skill: run \`govern brief ${p.slug}\` first and work from it; do not explore the repository. Then ask me what we change.`;
    const args = engine === "claude" ? ["--session-id", session!, first] : ["-C", REPO, first];
    const r = spawnSync(engine, args, { cwd: REPO, stdio: "inherit" });
    appendLedger(p.slug, { kind: "done", engine, session });
    process.exitCode = r.status ?? 0;
    return;
  }
  appendLedger(p.slug, { kind: "work", stage, engine, session: engine === "claude" ? process.env.CLAUDE_CODE_SESSION_ID : undefined, skillSha: sha256File(SKILL) });
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
function runCheck(p: Project, name: string, stage = p.stage): { ok: boolean; exit: number | null | undefined; why: string; text: string } {
  const st = jobs.start(p, name, [], false);
  const ok = st.exit === 0;
  appendLedger(p.slug, { kind: "check", stage, name, ok, exit: st.exit, job: st.id });
  return { ok, exit: st.exit, why: jobs.ending(st), text: jobs.summary(p, st) };
}

/** Run the stage's check, set the lane's own check for a stage, or record the owner's acceptance of a stage's pending
 *  check changes (lib/project.ts, pendingCheckChanges). A set's `from` is the stage's effective check before it. */
function cmdCheck(a: Args): void {
  const p = load(a._[1]);
  if (flag(a, "accept")) {
    const stage = stageOf(a._[2], p);
    const quote = opt(a, "quote");
    if (!quote || quote.trim().length < 2) fail(`--quote is required: the owner's own words accepting the change to the check of stage ${stage} (only the owner accepts)`);
    if (!pendingCheckChanges(p, readJsonl(ledgerFile(p.slug))).some((x) => x.stage === stage)) return out(`${p.slug}: stage ${stage} has no change to accept — nothing changed`);
    p.notes.push({ at: nowIso(), stage: p.stage, text: `owner accepted the changes to the check of stage ${stage}: "${quote}"` });
    save(p);
    appendLedger(p.slug, { kind: "check-accept", stage, quote });
    return out(`${p.slug}: the owner accepted the changes to the check of stage ${stage}`);
  }
  const set = opt(a, "set");
  if (set) {
    const stage = stageOf(opt(a, "stage") ?? p.stage, p);
    const from = checkOf(p, stage) ?? null;
    if (from === set) return out(`${p.slug}: stage ${stage} is already checked by "${set}" — nothing changed`);
    p.checks = { ...(p.checks ?? {}), [stage]: set };
    save(p);
    appendLedger(p.slug, { kind: "check-set", stage, from, to: set });
    return out(`${p.slug}: stage ${stage} checked by "${set}"${p.commands[set] ? "" : ` (name it: govern cmd ${p.slug} ${set} -- …)`}`);
  }
  const name = checkOf(p);
  if (!name) return out(`${p.slug}: stage ${p.stage} has no check (set one: govern check ${p.slug} --set <command> --stage ${p.stage})`);
  const r = runCheck(p, name);
  out(`check ${name}: ${r.ok ? "ok" : `failed (${r.why})`}\n${r.text}`);
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
    if (!r.ok) fail(`${p.slug}: check ${chk} failed (${r.why})\n${r.text}`);
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
    process.stderr.write(`${p.slug}: stage ${p.stage} is not done — check ${chk} failed (${r.why})\n${r.text}\n` +
      `next: govern check ${p.slug} after fixing, or govern advance ${p.slug} / govern note ${p.slug} "…" if the stage changed\n`);
    process.exitCode = 2;
  } catch { process.exitCode = 0; }
}

/** Whether two stored commands run the same argv with the same timeout (a plain argv has the default one). */
const sameCommand = (a: string[] | Command, b: string[] | Command) =>
  JSON.stringify([argvOf(a), Array.isArray(a) ? null : a.timeout ?? null]) === JSON.stringify([argvOf(b), Array.isArray(b) ? null : b.timeout ?? null]);

/** The stages of the lane's process whose effective check is the command `name`. */
const stagesChecking = (p: Project, name: string) => stagesOf(p).filter((s) => checkOf(p, s) === name);

/** List, set or remove a lane's commands. A set or a removal is ledgered with the command as govern.json stores it
 *  (an argv array, or {argv, timeout}) and the stages it is the check of, because a check is only as good as the
 *  command it names: redefining or removing such a command is flagged like a swap of the check itself. */
function cmdCmd(a: Args): void {
  const p = load(a._[1]);
  const rm = opt(a, "rm");
  if (rm) {
    const from = p.commands[rm];
    if (from === undefined) return out(`${p.slug}: no command ${rm} — nothing changed`);
    delete p.commands[rm];
    save(p);
    appendLedger(p.slug, { kind: "cmd-rm", name: rm, from, stages: stagesChecking(p, rm) });
    return out(`${p.slug}: removed command ${rm}`);
  }
  const name = a._[2];
  if (!name) { for (const [k, v] of Object.entries(p.commands)) out(`${k}: ${commandLine(v)}`); return; }
  const argv = a._.slice(3);
  if (!argv.length) fail(`give the argv after --: govern cmd ${p.slug} ${name} -- {python} build.py --preview`);
  const timeout = secondsOpt(a, "timeout");
  const from = p.commands[name] ?? null;
  const to: string[] | Command = timeout === undefined ? argv : { argv, timeout };
  if (from && sameCommand(from, to)) return out(`${p.slug}: ${name} is already ${commandLine(to)} — nothing changed`);
  p.commands[name] = to;
  save(p);
  appendLedger(p.slug, { kind: "cmd-set", name, from, to, stages: stagesChecking(p, name) });
  out(`${p.slug}: ${name} = ${commandLine(to)}`);
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
  const st = jobs.start(p, name, a._.slice(3), flag(a, "bg"));
  if (st.status === "running") return out(`job ${st.id} started in the background · wait with: govern wait ${p.slug} ${st.id}`);
  out(jobs.summary(p, st));
  process.exitCode = st.exit ?? 1;
}

function cmdWait(a: Args): void {
  const p = load(a._[1]);
  const id = jobs.find(p.slug, a._[2]);
  const timeout = secondsOpt(a, "timeout") ?? 540;
  const st = jobs.wait(p.slug, id, timeout);
  if (st.timedOut) { out(`job ${id} still running after ${timeout}s · wait again with: govern wait ${p.slug} ${id}`); process.exitCode = 124; return; }
  jobs.recordEnd(p.slug, id);
  out(jobs.summary(p, st));
  process.exitCode = st.exit ?? 1;
}

function cmdAsk(a: Args): void {
  const p = load(a._[1]);
  const step = a._[2];
  if (!step) fail("govern ask <slug> <step> (see govern prompts)");
  const vars: Record<string, string> = {};
  for (const kv of many(a, "var")) { const i = kv.indexOf("="); if (i < 1) fail(`--var needs NAME=VALUE: ${kv}`); vars[kv.slice(0, i)] = kv.slice(i + 1); }
  const r = ask(p, step, { files: many(a, "file"), vars, images: many(a, "image"), effort: opt(a, "effort"), model: opt(a, "model") });
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
  if (flag(a, "hook")) {
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
  const rows = queue.all().filter((x) => x.m.to === name && (flag(a, "all") || x.state === "open"));
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
      to, ...(routed ? { routed: true } : {}), summary: opt(a, "summary") ?? "", body, files: many(a, "file"), replyTo: opt(a, "reply-to"),
      access: flag(a, "write") ? "write" : "read-only",
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
    if (!flag(a, "loop")) { once(); return; }
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
  fail(TASK_SUBS);
}

// ── The command table ────────────────────────────────────────────────────────────────────────────────────────────────
// One entry per command drives dispatch, flag parsing (every flag a command reads is declared on it: lib/util.ts parseArgs
// refuses any other, and opt/flag/many refuse to read an undeclared one) and the help text below.

/** One help line: the usage after `govern <command>[ <sub>]`, and what it does. */
type Line = readonly [usage: string, help?: string];
export interface Sub { lines: readonly Line[]; flags?: FlagSpec; run: (a: Args) => void }
export interface Cmd {
  name: string;
  section: number;
  lines?: readonly Line[];
  flags?: FlagSpec;
  run?: (a: Args) => void;
  /** Subcommands: the word right after the command, each with its own flags. */
  subs?: Record<string, Sub>;
  /** The subcommand a bare `govern <name>` runs; without one, a missing or unknown subcommand is refused with `noSub`. */
  defaultSub?: string;
  noSub?: string;
  /** Print the context-size warning after the command (default true). */
  footer?: boolean;
}

const SECTIONS: readonly (readonly [title: string, notes?: readonly string[]])[] = [
  ["start / state"],
  ["process: stages, exit checks, gates, dependencies"],
  ["run without a model in the loop", ["<job> is an id, a unique id prefix, or a command name (that command's newest job)"]],
  ["codex one-shot steps (verified JSON)"],
  ["measure"],
  ["this help and the operating manual"],
  ["task queue between agents (one fresh headless session per message; nothing runs while the queue waits)", [
    "(sessions are not woken by the queue: tell them \"govern task show <id>\" with SendMessage; the dispatcher runs codex, claude",
    " and the runners named in the queue's config.json, and stops a thread after maxRuns dispatched runs)"]],
  ["the owner's screen"],
  ["publish (prints the commands; the publish guard hook must see them)"],
];

const TASK_SUBS = "govern task send|list|show|inbox|close|reply|forward|dispatch|install-service (govern help)";

export const COMMANDS: readonly Cmd[] = [
  { name: "new", section: 0, footer: false, flags: { value: ["kind", "process", "title", "lang", "parent"] },
    lines: [["<slug> (--process NAME | --kind long|short|ops) [--title T] [--lang en|pt-BR] [--parent <slug>]", "create a lane and print its brief"]],
    run: (a) => {
      const p = create(checkSlug(a._[1]), { kind: opt(a, "kind"), process: opt(a, "process"), title: opt(a, "title"), lang: opt(a, "lang"), parent: opt(a, "parent") });
      out(`created ${relative(REPO, join(projectDir(p.slug), "govern.json"))}`);
      out(brief(p));
    } },
  { name: "work", section: 0, flags: { value: ["engine"], bool: ["open"] },
    lines: [["<slug> <stage> [--engine claude|codex] [--open]", "start a work segment, print the brief"]], run: cmdWork },
  { name: "brief", section: 0, lines: [["<slug>", "the compact context (stage, exit condition, approvals, files, decisions)"]], run: (a) => out(brief(load(a._[1]))) },
  { name: "status", section: 0, lines: [["[<slug>]", "one line per lane, or the brief of one"]], run: cmdStatus },
  { name: "note", section: 0, lines: [["<slug> \"<decision>\"", "record a decision (state lives in files, not in the chat)"]],
    run: (a) => {
      const p = load(a._[1]);
      const text = a._.slice(2).join(" ").trim();
      if (!text) fail("govern note <slug> \"<decision>\"");
      p.notes.push({ at: nowIso(), stage: p.stage, text });
      save(p);
      appendLedger(p.slug, { kind: "note", text });
      out(`${p.slug}: noted (${p.notes.length})`);
    } },
  { name: "approve", section: 0, flags: { value: ["quote"] },
    lines: [["<slug> <gate> --quote \"<the owner's words>\"", "(gates come from the lane's process)"]], run: cmdApprove },
  { name: "done", section: 0, flags: { value: ["engine"] }, lines: [["<slug> [--engine claude|codex]", "end the current work segment"]],
    run: (a) => { const p = load(a._[1]); appendLedger(p.slug, { kind: "done", engine: engineOf(a), session: process.env.CLAUDE_CODE_SESSION_ID }); out(`${p.slug}: segment closed`); } },
  { name: "cmd", section: 0, flags: { value: ["timeout", "rm"] },
    lines: [["<slug> [<name> [--timeout S] -- <argv…>] | --rm <name>", "list or set the lane's commands (S: foreground limit, default 1800; ledgered;\nredefining or removing a stage's check command is flagged)"]],
    run: cmdCmd },
  { name: "file", section: 0, lines: [["<slug> <name> <path-or-glob>", "name a file (a glob means its newest match)"]], run: cmdFile },

  { name: "process", section: 1, defaultSub: "list", noSub: "govern process list|show <name>",
    subs: {
      list: { lines: [["", "built-in and workspace processes (processes/*.json)"]], run: cmdProcess },
      show: { lines: [["<name>", "one process: its stages, exit checks and gates"]], run: cmdProcess },
    } },
  { name: "check", section: 1, flags: { value: ["set", "stage", "quote"], bool: ["accept"] },
    lines: [["<slug> [--set <command> --stage <stage>]", "run the stage's exit check (or set the lane's own: ledgered; a swap is flagged)"],
      ["<slug> <stage> --accept --quote \"<the owner's words>\"", "the owner accepts that stage's flagged check changes"]], run: cmdCheck },
  { name: "advance", section: 1, flags: { value: ["note"] },
    lines: [["<slug> [--note \"<evidence>\"]", "next stage: needs the check to pass (or --note when none and none is required) and the gate"]], run: cmdAdvance },
  { name: "dep", section: 1, flags: { value: ["after", "rm"] },
    lines: [["<slug> [--after <lane>[:<stage>]] [--rm <lane>]", "this lane waits on another (all of it, or past a stage)"]], run: cmdDep },
  { name: "hook", section: 1, footer: false, noSub: "govern hook stop",
    subs: { stop: { lines: [["", "Claude Code Stop hook: keeps a session on its lane until the stage's check passes (3 tries)"]], run: cmdHook } } },

  { name: "run", section: 2, flags: { bool: ["bg"] },
    lines: [["<slug> <command> [--bg] [-- extra args]", "foreground prints a summary; --bg returns a job id"]], run: cmdRun },
  { name: "wait", section: 2, flags: { value: ["timeout"] },
    lines: [["<slug> [<job>|last] [--timeout 540]", "block until it ends; exit code = the job's (124 = still running)"]], run: cmdWait },
  { name: "jobs", section: 2, lines: [["<slug>", "the lane's latest jobs: status, exit code, seconds"]],
    run: (a) => { const p = load(a._[1]); for (const id of jobs.list(p.slug).slice(-15)) { const s = jobs.state(p.slug, id); out(`${id} ${s.status}${s.exit != null ? ` exit ${s.exit}` : ""}${s.seconds != null ? ` ${s.seconds}s` : ""}`); } } },
  { name: "log", section: 2, flags: { value: ["tail", "grep"] }, lines: [["<slug> [<job>] [--tail 40] [--grep RE]", "a job's log"]],
    run: (a) => { const p = load(a._[1]); const id = jobs.find(p.slug, a._[2]); out(jobs.tail(p.slug, id, Number(opt(a, "tail") ?? 40), opt(a, "grep")).join("\n") || "(empty log)"); } },
  { name: "kill", section: 2,
    lines: [["<slug> [<job>]", "stop a job (default: the latest running) and what it started: its process tree, a --bg job's group,\n" +
      "and (Linux) every process marked with its GOVERN_JOB_DIR; its own pid only while still that job"]],
    run: (a) => { const p = load(a._[1]); const k = jobs.kill(p.slug, a._[2]); out(`job ${k.id} ${k.outcome}`); } },

  { name: "prompts", section: 3, footer: false, lines: [["", "list the steps"]], run: cmdPrompts },
  { name: "ask", section: 3, flags: { multi: ["file", "var", "image"], value: ["effort", "model"] },
    lines: [["<slug> <step> [--file F]… [--var K=V]… [--image PNG]… [--effort low|medium|high] [--model M]", "one codex step, its reply verified"]], run: cmdAsk },

  { name: "usage", section: 4, footer: false, flags: { value: ["since"] },
    lines: [["[<slug>…] [--since YYYY-MM-DD]", "tokens and tool calls per lane and segment, against the chat baseline"]],
    run: (a) => { const since = opt(a, "since"); out(report(a._.length > 1 ? a._.slice(1).map(checkSlug) : undefined, since ? Date.parse(since) : undefined)); } },
  { name: "ctx", section: 4, footer: false, lines: [["", "this Claude Code session's context size now"]],
    run: () => { const x = currentCtx(); out(x ? `context now ${kTok(x.ctx)} per call (limit ${kTok(CTX_WARN)})${x.ctx > CTX_WARN ? ` ⚠ over: ${CTX_ADVICE}` : ""}` : "not in a Claude Code session (no CLAUDE_CODE_SESSION_ID) or no transcript yet"); } },

  { name: "help", section: 5, footer: false, lines: [["[<command>]", "this text, or one command's lines (also: govern <command> --help)"]],
    run: (a) => out(a._[1] ? commandHelp(a._[1]) : HELP) },
  { name: "manual", section: 5, footer: false, lines: [["", "the AI's operating manual (SKILL.md)"]], run: () => out(readFileSync(SKILL, "utf8")) },
  { name: "install-skill", section: 5, footer: false, flags: { bool: ["check"] },
    lines: [["[<skills dir>] [--check]", "install SKILL.md as the govern skill (default: the repo's .claude/skills), atomically and\n" +
      "read back by sha256; --check installs nothing and exits 1 when the installed copy is missing or differs"]],
    run: (a) => {
      const dest = join(a._[1] ?? join(REPO, ".claude", "skills"), "govern", "SKILL.md");
      if (flag(a, "check")) {
        const drift = skillDrift(SKILL, dest);
        if (drift) fail(drift, 1);
        out(`${dest} is current (sha256 ${sha256File(SKILL)})`);
        return;
      }
      const sha = installSkill(SKILL, dest);
      out(`installed ${dest} (sha256 ${sha}); refresh it with govern install-skill after editing tools/govern/SKILL.md`);
    } },

  { name: "task", section: 6, noSub: TASK_SUBS,
    subs: {
      send: { flags: { value: ["to", "project", "task", "kind", "summary", "body", "body-file", "reply-to", "from"], multi: ["file"], bool: ["write"] },
        lines: [["--to auto|codex|claude|owner|<session> --project P --task T --kind TASK --summary S (--body B | --body-file F)\n" +
          "[--file REPO-RELATIVE-PATH]… [--reply-to ID] [--write] [--from NAME]", "--to must be a runner, owner or a LIVE session name"]], run: cmdTask },
      list: { flags: { value: ["to", "state", "project"] }, lines: [["[--to X] [--state open|claimed|done|failed] [--project P]", "the queue's messages"]], run: cmdTask },
      show: { lines: [["<id>", "a message and its thread"]], run: cmdTask },
      inbox: { flags: { value: ["as"], bool: ["all", "hook"] },
        lines: [["[--as NAME] [--all] [--hook]", "open messages for NAME (default: GOVERN_AS, else this session);\n--hook is silent when empty"]], run: cmdTask },
      close: { flags: { value: ["as", "note"] }, lines: [["<id> [--as NAME] [--note T]", "close a message addressed to NAME"]], run: cmdTask },
      forward: { flags: { value: ["to", "as"] }, lines: [["<id> --to NAME [--as NAME]", "pass a message on to another recipient"]], run: cmdTask },
      reply: { flags: { value: ["kind", "summary", "body", "body-file", "as"] },
        lines: [["<id> --kind K --summary S (--body B | --body-file F) [--as NAME]", "answer the sender, then close <id>"]], run: cmdTask },
      dispatch: { flags: { value: ["max", "only", "interval"], bool: ["loop"] },
        lines: [["[--max N] [--only codex|claude] [--loop --interval 30]", "run the open messages addressed to runners"]], run: cmdTask },
      "install-service": { flags: { value: ["interval"] }, lines: [["[--interval 30]", "a user systemd service running dispatch --loop"]], run: cmdTask },
    } },

  { name: "desk", section: 7, lines: [["", "every lane, your inbox, the queue, today's tokens (reads files only)"]], run: () => out(desk()) },
  { name: "tune", section: 7, lines: [["", "measure the last 24 h and record the tuning decision (the dispatcher runs it hourly)"]], run: () => out(tune()) },

  { name: "publish", section: 8, lines: [["<slug>", "the publish commands, once the final and publish gates are approved and the package is filed"]], run: cmdPublish },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** Help lines: `  govern <name>[ <sub>] <usage>`, then the help after it (on lines of its own when the usage is long). */
function helpLines(head: string, lines: readonly Line[]): string[] {
  const r: string[] = [];
  for (const [usage, help] of lines) {
    const [first, ...more] = `  govern ${head}${usage ? ` ${usage}` : ""}`.split("\n");
    const left = [first, ...more.map((m) => `${" ".repeat(head.length + 10)}${m}`)];
    const helps = (help ?? "").split("\n").filter(Boolean);
    const last = left.length - 1;
    if (helps.length && left[last].length <= 46) {
      left[last] = `${left[last].padEnd(48)}${helps.shift()}`;
      r.push(...left, ...helps.map((h) => `${" ".repeat(48)}${h}`));
    } else r.push(...left, ...helps.map((h) => `      ${h}`));
  }
  return r;
}
const cmdLines = (c: Cmd, only?: string): string[] =>
  c.subs ? Object.entries(c.subs).filter(([s]) => !only || s === only).flatMap(([s, sub]) => helpLines(`${c.name} ${s}`, sub.lines)) : helpLines(c.name, c.lines ?? []);

function unknownCommand(name: string): never {
  return fail(`unknown command "${name}" (commands: ${COMMANDS.map((c) => c.name).join(", ")}; govern help)`);
}

/** One command's help lines: all its subcommands, or only `sub`. */
export function commandHelp(name: string, sub?: string): string {
  const c = byName.get(name) ?? unknownCommand(name);
  return cmdLines(c, sub).join("\n");
}

export const HELP = [
  "govern — run lanes of work (videos, software, ops, any process) through their stages with agents (manual: govern manual)",
  ...SECTIONS.flatMap(([title, notes], i) => ["", title, ...COMMANDS.filter((c) => c.section === i).flatMap((c) => cmdLines(c)), ...(notes ?? []).map((n) => `  ${n}`)]),
  "",
  "stages: govern process list",
].join("\n");

/** Every command takes --help: its own help lines instead of running. */
const withHelp = (f: FlagSpec | undefined): FlagSpec => ({ ...f, bool: [...(f?.bool ?? []), "help"] });

function main(argv: string[]): void {
  const name = argv[0];
  if (name === undefined || name === "-h" || name === "--help") return void out(HELP);
  if (name.startsWith("--")) fail(`the command comes first: govern <command> [<args>] [--flags] (got ${name} first; govern help)`);
  const c = byName.get(name) ?? unknownCommand(name);
  let entry: { flags?: FlagSpec; run?: (a: Args) => void } = c, label = c.name, sub: string | undefined, rest = argv.slice(1);
  const lead = [name];
  if (c.subs) {
    const word = argv[1];
    const given = word !== undefined && !word.startsWith("--");
    if (!given && word === "--help" && argv.length === 2) return void out(commandHelp(c.name));
    sub = given ? word : c.defaultSub;
    if (!sub || !Object.hasOwn(c.subs, sub)) fail(c.noSub ?? `govern ${c.name} ${Object.keys(c.subs).join("|")}`);
    entry = c.subs[sub!];
    label = `${c.name} ${sub}`;
    if (given) { rest = argv.slice(2); lead.push(word); }
  }
  const a = parseArgs(rest, withHelp(entry.flags), label);
  if (flag(a, "help")) return void out(commandHelp(c.name, sub));
  a._.unshift(...lead);
  entry.run!(a);
  if (c.footer !== false) ctxFooter();
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (e) {
    if (e instanceof GovernError) { process.stderr.write(`govern: ${e.message}\n`); process.exitCode = e.code; }
    else throw e;
  }
}

