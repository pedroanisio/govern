#!/usr/bin/env node
import { installSystemUnit } from "./lib/dispatch-service.ts";
import * as lifecycle from './lib/lifecycle.ts';
import { enterRuntime } from './lib/lifecycle-runtime.ts';
import { withLaneLock } from './lib/lane-lock.ts';
// govern — run lanes of work (videos, software, ops, any process) through their stages with agents, cheaply and under the owner's gates.
// The manual for the AI operating it is SKILL.md (govern manual). Usage: govern help.
import { activeStages, enterTasks, isGraph, requireActive, validateRequired, nextStages, completeStage, authenticatedPerson, requireHumanComplete, gateApproved, policyVote, rejectRoute, ownerApproval } from './lib/business.ts';
import { value } from './lib/business-schema.ts';
import { check, record } from './lib/shape.ts';
import { spawnSync } from "node:child_process";
import { readFileSync, globSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { GovernError, EXIT_STATE, fail, usage, parseArgs, opt, flag, many, flagNames, secondsOpt, nowIso, readJsonl, kTok, clip, type Args, type FlagSpec } from "./lib/util.ts";
import { stagesOf, load, save, create, stageOf, brief, appendLedger, resolveFile, ledgerFile, projectDir, checkSlug, checkOf, pendingCheckChanges, importUnaccepted, importQuarantined, quarantineDetail, blockedBy, laneState, driftWarning, laneSlugs, laneRows, stateFile, argvOf, commandLine, frozenMessage, type Project, type Command } from "./lib/project.ts";
import { importBundle } from "./lib/importlane.ts";
import * as conversation from "./lib/conversation.ts";
import { processes, getProcess, processOf, listLine, show, manualOf } from "./lib/process.ts";
import { repo, findRepo, projectsDir, packagesDir, initWorkspace, stateDir, decideConfig } from "./lib/workspace.ts";
import { emptyRecord, PROTO } from "./lib/shape.ts";
import * as jobs from "./lib/jobs.ts";
import { ask, readPrompt, promptFiles } from "./lib/codex.ts";
import { report, currentCtx, CTX_WARN } from "./lib/usage.ts";
import { laneByCwd, recordLane } from "./lib/attribution.ts";
import * as queue from "./lib/queue.ts";
import { tag, verdict } from "./lib/replycheck.ts";
import { desk } from "./lib/desk.ts";
import { listLines, showLines, place } from "./lib/resources.ts";
import * as reaping from "./lib/reap.ts";
import * as slicing from "./lib/slice.ts";
import * as allowances from "./lib/allowances.ts";
import { registry, getProfile, listText, showText, failing, writes, readCheck, checkState, profileHash } from "./lib/caps.ts";
import { asksForChanges, WRITE_RULE } from "./lib/writeask.ts";
import { checkProfile } from "./lib/capcheck.ts";
import { tune, chooseRunner } from "./lib/tune.ts";
import { verifyQuote, GROK_MARKERS } from "./lib/approval.ts";
import { buildBundle, defaultBundleName } from "./lib/bundle.ts";
import { parseAddress } from "./lib/peer-id.ts";
import { EXTENSIONS, EXTENSION_FLAGS } from "./lib/ext-registry.ts";
import * as extensions from "./lib/ext.ts";
import { out, jsonValue, core, type Cmd, type Sub, type Line } from "./lib/cli.ts";
import { processSvg, viewOf, type Overlay } from "./lib/processview.ts";
import { sceneOf, canvasFor } from "./lib/processscene.ts";
import { readLane, readLanes } from "./lib/lanestate.ts";
import * as artifacts from "./lib/artifacts.ts";
import { checkRecipient, requireAs, resolveAs } from "./lib/sessions.ts";
import { installSkill, skillDrift, sha256File, approxTokens, BYTES_PER_TOKEN } from "./lib/skill.ts";
import { HELP_RULES, TOPICS } from "./lib/helprules.ts";
import { writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import { constants, homedir, tmpdir, userInfo } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "SKILL.md");
const REFERENCE = resolve(HERE, "REFERENCE.md");
const laneLockDir = (slug: string | undefined) => join(stateDir(), "lane-locks", createHash("sha256").update(stateFile(checkSlug(slug))).digest("hex"));

// A reader that stops early (govern brief x | head) is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); throw e; });

// What the session does about it by itself: the owner is never asked to /clear (context is the session's job).
const CTX_ADVICE = "keep state in files (govern note, memory), offload model work with `govern task send --to codex`, " +
  "wait on jobs in the background, and let auto-compaction (window tuned hourly by govern tune) shrink the rest";

function ctxFooter(): void {
  const c = currentCtx();
  if (c && c.ctx > CTX_WARN) out(`⚠ this session reads ${kTok(c.ctx)} per call (limit ${kTok(CTX_WARN)}): ${CTX_ADVICE}.`);
}

/** The engines a work segment runs on (`govern work --engine`); the dispatcher's built-in runners are the same set. */
export const ENGINES = ["claude", "codex", "grok"] as const;
type Engine = (typeof ENGINES)[number];
/** The engine of a work segment: --engine, else the session running govern (Claude Code by CLAUDE_CODE_SESSION_ID, Grok
 *  by the GROK_AGENT / GROK_SESSION_ID its shells export), else codex. */
function engineOf(a: Args): Engine {
  const e = opt(a, "engine") ?? (process.env.CLAUDE_CODE_SESSION_ID ? "claude" : process.env.GROK_AGENT || process.env.GROK_SESSION_ID ? "grok" : "codex");
  if (!(ENGINES as readonly string[]).includes(e)) usage(`--engine must be ${ENGINES.slice(0, -1).join(", ")} or ${ENGINES.at(-1)}`);
  return e as Engine;
}
/** The id of the running session of `engine` (what the usage report finds its transcript by); codex has none. */
const sessionOf = (engine: Engine): string | undefined =>
  engine === "claude" ? process.env.CLAUDE_CODE_SESSION_ID : engine === "grok" ? process.env.GROK_SESSION_ID : undefined;

/** Whether the process lets only a passing check move the lane past `stage` (no note, no skip). */
const requiresCheck = (p: Project, stage: string) => processOf(p).stages.find((s) => s.name === stage)?.requires === "check";
const setCheckHint = (p: Project, stage: string) => `set one: govern check ${p.slug} --set <command> --stage ${stage}`;

/** Moving forward skips stages, so each skipped stage must be passable the way advance would pass it: not while
 *  blocked, a passing check where the stage has one (or requires one), and no open gate. Going back, or staying, is always allowed. */
function passSkipped(p: Project, to: string): void {
  const list = stagesOf(p);
  const from = list.indexOf(p.stage), target = list.indexOf(to);
  if (isGraph(processOf(p))) { requireActive(p, to); return; }
  if (target <= from) return;
  const b = blockedBy(p);
  if (b.length) fail(`${p.slug} is blocked by ${b.join(", ")}`);
  const led = readJsonl(ledgerFile(p.slug));
  for (const s of list.slice(Math.max(from, 0), target)) {
    const def=processOf(p).stages.find(x=>x.name===s)!;
    if(def.event||def.call||def.foreach||def.onError||def.timer)fail(`${p.slug}: lifecycle stage ${s} must be completed with govern advance, not skipped`);
    validateRequired(p, s);
    requireHumanComplete(p, s);
    const chk = checkOf(p, s);
    if (chk) {
      if (importUnaccepted(p, led, s)) fail(`${p.slug}: cannot skip stage ${s}: its check "${chk}" was imported and the owner has not accepted it (govern check ${p.slug} ${s} --accept --quote "…")`);
      const r = runCheck(p, chk, s);
      if (!r.ok) fail(`${p.slug}: cannot skip stage ${s}: check ${chk} failed (${r.why})\n${r.text}\nnext: fix it, then govern advance ${p.slug}`);
    } else if (requiresCheck(p, s)) fail(`${p.slug}: cannot skip stage ${s}: it requires a check and has none (${setCheckHint(p, s)})`);
    const gate = processOf(p).gates.find((g) => g.stage === s && !gateApproved(p, g));
    if (gate) fail(`${p.slug}: cannot skip stage ${s}: needs the owner's ${gate.name} approval (govern approve ${p.slug} ${gate.name} --quote "…")`);
  }
}

/** The environment of an interactive session opened by `work --open`: it must not look like it runs inside the session that
 *  opened it, or the segment it later registers would record the parent's engine. So the other engines' markers are removed:
 *  Claude's (CLAUDECODE, CLAUDE_CODE_*) unless the child is Claude, Grok's (GROK_AGENT, GROK_SESSION_ID) unless the child is Grok. */
function openEnv(engine: Engine): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (engine !== "claude" && (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_"))) delete env[k];
    if (engine !== "grok" && GROK_MARKERS.includes(k)) delete env[k];
  }
  return env;
}

function cmdWork(a: Args): void {
  const p = withLaneLock(laneLockDir(a._[1]), () => {
    const p = load(a._[1]), stage = stageOf(a._[2], p);
    passSkipped(p, stage); if(!p.workflow&&p.stage!==stage)enterRuntime(p,[stage],true); p.stage=stage; enterTasks(p); save(p); return p;
  });
  const stage = p.stage;
  const engine = engineOf(a);
  if (flag(a, "open")) {
    const session = engine === "codex" ? undefined : randomUUID();
    appendLedger(p.slug, { kind: "work", stage, engine, session, skillSha: sha256File(SKILL), referenceSha: sha256File(REFERENCE) });
    const kind = processOf(p).name, label = kind.charAt(0).toUpperCase() + kind.slice(1);
    const first = `${label} work session (registered by govern work ${p.slug} ${stage}). Use the govern skill: run \`govern brief ${p.slug}\` first and work from it; do not explore the repository. Then ask me what we change.`;
    const args = engine === "codex" ? ["-C", repo(), first] : ["--session-id", session!, first];
    const bin = process.env[`GOVERN_${engine.toUpperCase()}_BIN`] ?? engine;
    const r = spawnSync(bin, args, { cwd: repo(), stdio: "inherit", env: openEnv(engine) });
    const exitCode = r.error ? 1 : r.signal ? 128 + constants.signals[r.signal] : r.status ?? 1;
    const error = r.error?.message, signal = r.signal ?? undefined;
    appendLedger(p.slug, { kind: "done", engine, session, exitCode, error, signal });
    if (error) process.stderr.write(`govern: could not run ${bin}: ${error}\n`);
    else if (signal) process.stderr.write(`govern: ${bin} terminated by ${signal}\n`);
    process.exitCode = exitCode;
    return;
  }
  appendLedger(p.slug, { kind: "work", stage, engine, session: sessionOf(engine), skillSha: sha256File(SKILL), referenceSha: sha256File(REFERENCE) });
  out(brief(p));
}

function cmdStatus(a: Args): void {
  if (a._[1]) return out(brief(load(a._[1])));
  const slugs = laneSlugs();
  if (!slugs.length) return out("nothing under govern yet (govern new <slug> --process NAME, or --kind long|short|ops)");
  const { rows, failed } = laneRows(slugs, (s, p) => {
    const led = readJsonl(ledgerFile(s));
    const lastJob = led.filter((e) => e.kind === "job").pop();
    const gates = processOf(p).gates;
    const ap = gates.map((g) => (gateApproved(p, g) ? g.name.charAt(0).toUpperCase() : "·")).join("");
    const list = stagesOf(p);
    const parts = [`${s.padEnd(36)} ${p.kind.padEnd(5)} ${list.indexOf(p.stage) + 1}/${list.length} ${p.stage.padEnd(12)}`, gates.length ? `approvals ${ap}` : "",
      laneState(p), p.workflow && !p.finished ? `active ${p.workflow.active.join(', ')}` : '', lastJob ? `last job ${lastJob.name} ${lastJob.status}` : ""];
    const drift = driftWarning(p, led);
    return parts.filter(Boolean).join("  ").trimEnd() + (drift ? `\n    ${drift}` : "");
  });
  for (const r of rows) out(r);
  if (failed) unreadable(failed, slugs.length);
}

/** After a listing printed every lane: some could not be read, which is a failed check (exit 1), not a usage error. */
function unreadable(failed: number, total: number): never { return fail(`${failed} of ${total} lanes could not be read (shown above with ✖)`, 1); }

function cmdApprove(a: Args): void {
  const p = load(a._[1]);
  const gates = processOf(p).gates;
  const g = gates.find((x) => x.name === a._[2]) ?? fail(`gate must be one of ${gates.map((x) => x.name).join(", ") || "(none: this process has no gates)"}`);
  const gate = g.name;
  if (g.policy) return cmdPolicyDecision(a, p, g, 'approve');
  const quote = opt(a, "quote");
  ownerApproval(p, g, opt(a, "by"), quote, () => verifyQuote(quote!));
  const { by, source } = p.approvals[gate]!;
  save(p);
  appendLedger(p.slug, { kind: "approve", gate, quote, by, source });
  out(`${p.slug}: ${gate} approved`);
}

function cmdPolicyDecision(a: Args, p: Project, g: import('./lib/process.ts').GateDef, decision: 'approve'|'reject'): void {
  const actor=authenticatedPerson(processOf(p), opt(a,'by'));
  const quote=opt(a,'quote');
  if(!quote || quote.trim().length<2) usage('--quote is required: the human decision');
  const source=verifyQuote(quote!);
  const vote=policyVote(p,g,actor,decision,quote!);
  if(decision==='reject') rejectRoute(p,g);
  p.notes.push({at:vote.at,stage:p.stage,text:`${actor} ${decision} ${g.name}: "${quote}"`});
  save(p);
  appendLedger(p.slug,{kind:decision,gate:g.name,...vote,source});
  out(`${p.slug}: ${g.name} ${decision} by ${actor} · ${gateApproved(p,g) ? 'approved' : 'not approved'}`);
}
/** A flag's value as a number above 0 (an estimate), or undefined when the flag is absent. */
function amountOpt(a: Args, k: string): number | undefined {
  const v = opt(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : usage(`--${k} must be a positive number: ${JSON.stringify(v)}`);
}

/** `govern allow <allowance> --extra N --quote "…"`: the allowance's decision owner raises its limit for the current period, in their own words. */
function cmdAllow(a: Args): void {
  const al = allowances.allowanceNamed(a._[1] ?? usage("govern allow <allowance> --extra N --quote \"…\" (govern usage lists the allowances)"));
  const extra = amountOpt(a, "extra") ?? usage("--extra must be a positive number: the amount to add to the limit");
  const owner = al.owner, by = opt(a, "by");
  if (by === undefined && owner !== "owner") fail(`allowance ${al.name} is decided by ${owner}: pass --by ${owner}`);
  if (by !== undefined && by !== owner) fail(`allowance ${al.name} is decided by ${owner}, not ${by}`);
  const quote = opt(a, "quote");
  if (!quote || quote.trim().length < 2) usage(`--quote is required: ${owner}'s own words approving ${extra} ${allowances.unitName(al)} more for ${al.name} (only ${owner} approves)`);
  const source = verifyQuote(quote!);
  allowances.grant(al, extra, quote!, source, owner);
  out(`${al.name}: +${extra} ${allowances.unitName(al)} approved by ${owner} · limit ${Math.round((al.limit + allowances.status(al).extra) * 1e6) / 1e6}`);
}

/** What of the lane's work is in flight: a running job, a running turn of a conversation bound to it, or a claimed queue
 *  task for it, each named. Empty when nothing is. */
function laneInFlight(slug: string): string[] {
  const found: string[] = [];
  for (const id of jobs.list(slug)) if (jobs.state(slug, id).status === "running") found.push(`running job ${id}`);
  for (const c of conversation.list()) if (c.lane === slug && c.runs.some((r) => r.state === "running")) found.push(`running conversation ${c.id}`);
  for (const { state, m } of queue.all()) if (state === "claimed" && (m.lane === slug || m.project === slug)) found.push(`claimed queue task ${m.id}`);
  return found;
}

/** Freeze lane `p` now, in the owner's own `quote` (verified exactly as govern approve verifies one), optionally
 *  naming where the work continued. On an already-frozen lane, only a given `continuedAs` changes anything (it is
 *  recorded; nothing else is). Refused while any of the lane's work is in flight. Shared by `govern freeze` and
 *  `govern export --freeze`, which freezes inside the same transaction lock it then reads the lane under. */
function freezeLane(p: Project, quote: string, continuedAs?: string): void {
  const source = verifyQuote(quote);
  if (p.frozen) {
    if (!continuedAs) return;
    p.frozen = { ...p.frozen, continuedAs };
    save(p, { allowFrozen: true });
    appendLedger(p.slug, { kind: "freeze", continuedAs });
    return;
  }
  const inFlight = laneInFlight(p.slug);
  if (inFlight.length) fail(`${p.slug}: cannot freeze while work is in flight: ${inFlight.join(", ")}`);
  const at = nowIso();
  p.frozen = { at, by: "owner", quote, source, ...(continuedAs ? { continuedAs } : {}) };
  save(p, { allowFrozen: true });
  appendLedger(p.slug, { kind: "freeze", at, quote, by: "owner", source, ...(continuedAs ? { continuedAs } : {}) });
}

/** `govern freeze <slug> --quote Q [--continued-as TEXT]`: stop the lane's work and make it read-only. */
function cmdFreeze(a: Args): void {
  const p = load(a._[1]);
  const quote = opt(a, "quote");
  if (!quote || quote.trim().length < 2) usage("--quote is required: the owner's own words freezing the lane");
  const continuedAs = opt(a, "continued-as");
  const wasFrozen = !!p.frozen;
  freezeLane(p, quote, continuedAs);
  if (wasFrozen) return out(continuedAs ? `${p.slug}: continued as ${continuedAs}` : `${p.slug}: ${frozenMessage(p.slug, p.frozen!)}`);
  out(`${p.slug}: frozen`);
}

/** `govern export <slug> [--template] [--out FILE] [--exclude GLOB]… [--freeze --quote Q]`: read the lane under its
 *  transaction lock (optionally freezing it first, inside that same lock) and write one bundle file, mode 600. The
 *  export's own ledger entry is appended once the file is written, outside the lock (lib/bundle.ts; PLAN, Export). */
function cmdExport(a: Args): void {
  const slug = checkSlug(a._[1]);
  const template = flag(a, "template");
  const excludes = many(a, "exclude");
  const doFreeze = flag(a, "freeze");
  const quote = opt(a, "quote");
  if (doFreeze && (!quote || quote.trim().length < 2)) usage("--quote is required with --freeze: the owner's own words freezing the lane");
  if (!doFreeze && quote !== undefined) usage("--quote is only used together with --freeze");
  const bundle = lifecycle.transaction(slug, () => {
    if (doFreeze) freezeLane(load(slug), quote!);
    return buildBundle(slug, { template, excludes });
  });
  const target = resolve(opt(a, "out") ?? defaultBundleName(slug));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(bundle), { mode: 0o600 });
  appendLedger(slug, { kind: "export", mode: bundle.body.mode, bundleSha256: bundle.sha256, out: target, ledgerOffset: bundle.body.source.ledgerOffset });
  out(`${slug}: exported ${bundle.body.mode} bundle to ${target} (sha256 ${bundle.sha256})`);
}

/** `govern import <bundle> [--as SLUG] [--drop-deps]`: verify a bundle (untrusted input) end to end, then write the new
 *  lane into a temporary folder under the lanes folder and rename it into place, so a failed import leaves nothing
 *  behind (lib/importlane.ts; PLAN, Import). */
function cmdImport(a: Args): void {
  const bundlePath = resolve(a._[1] ?? usage("govern import <bundle> [--as SLUG] [--drop-deps]"));
  const r = importBundle(bundlePath, { as: opt(a, "as"), dropDeps: flag(a, "drop-deps") });
  out(`${r.slug}: imported ${r.mode} bundle from ${bundlePath} (sha256 ${r.bundleSha256}) — every imported check needs the owner's acceptance before it can pass a stage`);
  out(quarantineDetail(load(r.slug)).join("\n"));
}

/** `govern clone <slug> --as NEW [--template] [--exclude GLOB]…`: export the lane to a bundle file under the
 *  workspace's state folder, import it as NEW, then delete the file. The source's govern.json stays byte-identical;
 *  its ledger gains only the export entry (lib/bundle.ts, lib/importlane.ts; PLAN, Clone). */
function cmdClone(a: Args): void {
  const slug = checkSlug(a._[1]);
  const as = opt(a, "as") ?? usage("govern clone <slug> --as NEW [--template] [--exclude GLOB]…");
  const template = flag(a, "template");
  const excludes = many(a, "exclude");
  const bundle = lifecycle.transaction(slug, () => buildBundle(slug, { template, excludes }));
  // A per-call name: the default name has one-second precision, so two clones of one lane in a second would share it.
  const tmp = join(stateDir(), `clone-${randomUUID()}-${defaultBundleName(slug)}`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, JSON.stringify(bundle), { mode: 0o600, flag: "wx" });
  appendLedger(slug, { kind: "export", mode: bundle.body.mode, bundleSha256: bundle.sha256, out: tmp, ledgerOffset: bundle.body.source.ledgerOffset });
  try {
    // A clone's bundle is one this workspace wrote to itself (above, exclusively), so its commands already run
    // here: `via: "clone"` exempts it from the quarantine every other import sits in (lib/project.ts, importQuarantined).
    // Not when the source is itself a quarantined import: its commands have never run here, and the copy stays
    // quarantined until the owner accepts it, as the source does.
    const trusted = !importQuarantined(readJsonl(ledgerFile(slug)));
    const r = importBundle(tmp, { as, dropDeps: false, ...(trusted ? { via: "clone" as const } : {}) });
    out(`${slug}: cloned as ${r.slug} (${r.mode} bundle, sha256 ${r.bundleSha256})`);
  } finally {
    unlinkSync(tmp);
  }
}

/** `govern unfreeze <slug> --quote Q`: lift a freeze, in the owner's own words. */
function cmdUnfreeze(a: Args): void {
  const p = load(a._[1]);
  if (!p.frozen) return out(`${p.slug}: not frozen — nothing changed`);
  const quote = opt(a, "quote");
  if (!quote || quote.trim().length < 2) usage("--quote is required: the owner's own words lifting the freeze");
  const source = verifyQuote(quote!);
  delete p.frozen;
  save(p, { allowFrozen: true });
  appendLedger(p.slug, { kind: "unfreeze", quote, by: "owner", source });
  out(`${p.slug}: unfrozen`);
}

/** Run the stage's exit check as a foreground job; records it in the ledger, prints nothing. Refuses, before starting
 *  the job, when the check is an imported one the owner has not accepted (lib/project.ts, importUnaccepted): every
 *  caller — a plain `check`, `advance`, the Stop hook — goes through here, so the owner's acceptance is the only way
 *  an imported check ever runs. */
function runCheck(p: Project, name: string, stage = p.stage): { ok: boolean; exit: number | null | undefined; why: string; text: string } {
  if (importUnaccepted(p, readJsonl(ledgerFile(p.slug)), stage)) fail(`${p.slug}: stage ${stage}'s check "${name}" was imported and the owner has not accepted it: govern check ${p.slug} ${stage} --accept --quote "…"`);
  const st = jobs.start(p, name, [], false);
  const ok = st.exit === 0;
  appendLedger(p.slug, { kind: "check", stage, name, ok, exit: st.exit, job: st.id });
  return { ok, exit: st.exit, why: jobs.ending(st), text: jobs.summary(p, st) };
}

/** Run the stage's check, set the lane's own check for a stage, or record the owner's acceptance of a stage's pending
 *  check changes (lib/project.ts, pendingCheckChanges). A set's `from` is the stage's effective check before it. */
function cmdCheck(a: Args): void {
  const p = load(a._[1]);
  if (flag(a, "accept-import")) {
    const quote = opt(a, "quote");
    if (!quote || quote.trim().length < 2) usage(`--quote is required: the owner's own words accepting the import of ${p.slug} (only the owner accepts)`);
    if (!importQuarantined(readJsonl(ledgerFile(p.slug)))) fail(`${p.slug}: nothing to accept — it is not a quarantined import`);
    const source = verifyQuote(quote!);
    p.notes.push({ at: nowIso(), stage: p.stage, text: `owner accepted the import of ${p.slug}: "${quote}"` });
    save(p);
    appendLedger(p.slug, { kind: "import-accept", quote, by: "owner", source });
    return out(`${p.slug}: the owner accepted the import`);
  }
  if (flag(a, "accept")) {
    const stage = stageOf(a._[2], p);
    const quote = opt(a, "quote");
    if (!quote || quote.trim().length < 2) usage(`--quote is required: the owner's own words accepting the change to the check of stage ${stage} (only the owner accepts)`);
    if (!pendingCheckChanges(p, readJsonl(ledgerFile(p.slug))).some((x) => x.stage === stage)) return out(`${p.slug}: stage ${stage} has no change to accept — nothing changed`);
    const source = verifyQuote(quote!);
    p.notes.push({ at: nowIso(), stage: p.stage, text: `owner accepted the changes to the check of stage ${stage}: "${quote}"` });
    save(p);
    appendLedger(p.slug, { kind: "check-accept", stage, quote, by: "owner", source });
    return out(`${p.slug}: the owner accepted the changes to the check of stage ${stage}`);
  }
  const set = opt(a, "set");
  if (set) {
    const stage = stageOf(opt(a, "stage") ?? p.stage, p);
    const from = checkOf(p, stage) ?? null;
    if (from === set) return out(`${p.slug}: stage ${stage} is already checked by "${set}" — nothing changed`);
    const checks = p.checks ?? emptyRecord<string>();
    checks[stage] = set;
    p.checks = checks;
    save(p);
    appendLedger(p.slug, { kind: "check-set", stage, from, to: set });
    return out(`${p.slug}: stage ${stage} checked by "${set}"${p.commands[set] ? "" : ` (name it: govern cmd ${p.slug} ${set} -- …)`}`);
  }
  if (opt(a, "stage")) { const stage = stageOf(opt(a, "stage"), p); if (p.workflow) requireActive(p, stage); p.stage = stage; }
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
  const selected = opt(a, "stage");
  if (selected) { requireActive(p, selected); p.stage = stageOf(selected, p); }
  const b = blockedBy(p);
  if (b.length) fail(`${p.slug} is blocked by ${b.join(", ")}`);
  if (p.finished) fail(`${p.slug} is already finished`);
  requireActive(p);
  const attemptedStage=p.stage;if(lifecycle.tickTimers(p)){save(p);if(!activeStages(p).includes(attemptedStage)){out(`${p.slug}: routed by deadline escalation to ${p.stage}`);return;}p.stage=attemptedStage;}
  const stageDef=processOf(p).stages.find(s=>s.name===p.stage)!;
  if(stageDef.call||stageDef.foreach)lifecycle.syncChild(p,p.stage);
  lifecycle.requireLifecycleReady(p);
  validateRequired(p);
  requireHumanComplete(p);
  const destinations = nextStages(p);
  const note = opt(a, "note");
  const chk = checkOf(p);
  if (chk) {
    if (importUnaccepted(p, readJsonl(ledgerFile(p.slug)), p.stage)) fail(`${p.slug}: stage ${p.stage}'s check "${chk}" was imported and the owner has not accepted it: govern check ${p.slug} ${p.stage} --accept --quote "…"`);
    lifecycle.beginAttempt(p);
    let r:ReturnType<typeof runCheck>;
    try{r=runCheck(p,chk);}catch(e){if(e instanceof GovernError && stageDef.onError)lifecycle.checkFailed(p,e.message);throw e;}
    if (!r.ok) {lifecycle.checkFailed(p, `${chk}: ${r.why}`);fail(`${p.slug}: check ${chk} failed (${r.why})\n${r.text}`,stageDef.onError?1:EXIT_STATE);}
    lifecycle.checkSucceeded(p);
  } else if (requiresCheck(p, p.stage)) fail(`${p.slug}: stage ${p.stage} requires a check and has none: a note cannot pass it (${setCheckHint(p, p.stage)})`);
  else if (!note) fail(`${p.slug}: stage ${p.stage} has no check: give the evidence with --note "…"`);
  const gate = processOf(p).gates.find((g) => g.stage === p.stage && !gateApproved(p, g));
  if (gate) fail(`${p.slug}: needs the owner's ${gate.name} approval (govern approve ${p.slug} ${gate.name} --quote "…")`);
  const from = p.stage;
  const passed = { authority: chk ? "check" : "note", ...(chk ? { check: chk } : {}), ...(note ? { note } : {}) };
  if (note) p.notes.push({ at: nowIso(), stage: from, text: note });
  completeStage(p, destinations);
  save(p);
  appendLedger(p.slug, { kind: "advance", from, to: p.finished ? "finished" : p.stage, destinations, ...passed });
  out(p.finished ? `${p.slug}: ${from} was the last stage — lane finished` : `${p.slug}: ${from} → ${activeStages(p).join(', ')}${chk ? ` (check ${chk} ok)` : ""}`);
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
    const [given, stage] = add.split(":");
    const o = load(given);
    const lane = o.slug; // the folder's slug: `--after ./l2` waits on l2
    if (lane === p.slug) fail(`${p.slug} cannot wait on itself`);
    if (stage) stageOf(stage, o);
    const loop = waitPath(lane, p.slug);
    if (loop) fail(`${p.slug} cannot wait on ${lane}: ${loop.join(" → ")} already waits the other way`);
    p.after = [...(p.after ?? []).filter((x) => !(x.lane === lane && x.stage === stage)), { lane, ...(stage ? { stage } : {}) }];
  }
  if (rm) { const gone = checkSlug(rm); p.after = (p.after ?? []).filter((x) => x.lane !== gone); }
  if (add || rm) { save(p); appendLedger(p.slug, { kind: "dep", after: p.after ?? [] }); }
  const labels = (p.after ?? []).map((x) => (x.stage ? `${x.lane}:${x.stage}` : x.lane));
  out(labels.length ? `${p.slug}: after ${labels.join(", ")}` : `${p.slug}: no dependencies`);
}

function cmdMigrate(a:Args):void {
  const quote=opt(a,'quote');if(!quote||quote.trim().length<2)usage('--quote is required: the human migration decision');const source=verifyQuote(quote!);
  const map=check('stage map',jsonValue(opt(a,'map')),record((x,p)=>typeof x==='string'?x:fail(`${p} must be a stage name`))),data=check('migration data',jsonValue(opt(a,'data')),record((x,p)=>x===null?null:value(x,p)));
  lifecycle.transaction(checkSlug(a._[2]),()=>{const p=load(a._[2]);lifecycle.migrate(p,map,data,quote!);appendLedger(p.slug,{kind:'migration-source',source});out(`${p.slug}: migrated to revision ${p.processSnapshot!.revision}`);});
}
function cmdProcess(a: Args): void {
  if (a._[1] === "show") return out(show(getProcess(a._[2] ?? usage("govern process show <name>"))));
  if (a._[1] && a._[1] !== "list") usage("govern process list|show <name>");
  for (const p of processes().values()) out(listLine(p));
}

/** The lane where session `sid` has an open work segment: the one whose latest work/done entry for the session is a work entry
 *  (the latest such entry when several lanes qualify). `hookOpened`: that entry says the SessionStart hook opened it. */
function openSegment(sid: string): { slug: string; at: number; t: string; stage: string; hookOpened: boolean; entries: Record<string, unknown>[] } | undefined {
  let hit: ReturnType<typeof openSegment>;
  for (const f of globSync("**/govern.json", { cwd: projectsDir() })) {
    const slug = dirname(f);
    const entries = readJsonl(ledgerFile(slug));
    let at = -1;
    entries.forEach((e, i) => { if ((e.kind === "work" || e.kind === "done") && e.session === sid) at = i; });
    const latest = entries[at];
    if (latest === undefined || latest.kind !== "work") continue;
    const t = String(latest.t);
    if (!hit || t > hit.t) hit = { slug, at, t, stage: String(latest.stage), hookOpened: latest.openedBy === "hook", entries };
  }
  return hit;
}

/** Claude Code Stop hook. `{"decision":"block","reason":…}` on stdout (exit 0) keeps the session working while its lane's
 *  stage check fails; 3 refusals per work segment at most. The JSON form, not exit 2: govern's 2 means a usage error. It closes nothing: Stop fires after every response, a segment lasts a session
 *  (see `hook session-end`). Silent and exit 0 on anything else, including its own errors. */
function cmdHook(a: Args): void {
  if (a._[1] === "session-start") return hookSessionStart();
  if (a._[1] === "session-end") return hookSessionEnd();
  if (a._[1] !== "stop") usage("govern hook stop|session-start|session-end");
  try {
    const sid = String(JSON.parse(readFileSync(0, "utf8")).session_id ?? "");
    if (!sid) return;
    const hit = openSegment(sid);
    if (!hit) return;
    stopRefused(hit.slug, hit.entries.slice(hit.at + 1), sid);
  } catch { process.exitCode = 0; }
}

/** Claude Code SessionEnd hook: closes the work segment the SessionStart hook opened for the session (a `done` entry with
 *  closedBy "hook"). A segment opened by `govern work` is left alone. Prints nothing; never fails. */
function hookSessionEnd(): void {
  try {
    const j: unknown = JSON.parse(readFileSync(0, "utf8"));
    const sid = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>)["session_id"] : undefined;
    if (typeof sid !== "string" || !sid) return;
    const hit = openSegment(sid);
    if (hit?.hookOpened) appendLedger(hit.slug, { kind: "done", engine: "claude", session: sid, closedBy: "hook" });
  } catch { process.exitCode = 0; }
}

/** Whether the Stop hook refuses this stop (the block decision on stdout): the lane's check fails and fewer than 3 refusals
 *  were ledgered since the segment opened. */
function stopRefused(slug: string, since: Record<string, unknown>[], sid: string): boolean {
  const blocks = since.filter((e) => e.kind === "stop-block" && e.session === sid).length;
  if (blocks >= 3) { process.stderr.write(`govern: ${slug}: stopped 3 times in this segment with the check failing; letting the session stop\n`); return false; }
  const p = load(slug);
  const chk = checkOf(p);
  if (!chk || !p.commands[chk]) return false;
  const r = runCheck(p, chk);
  if (r.ok) return false;
  appendLedger(p.slug, { kind: "stop-block", session: sid, stage: p.stage, check: chk });
  const reason = `${p.slug}: stage ${p.stage} is not done — check ${chk} failed (${r.why})\n${r.text}\n` +
    `next: govern check ${p.slug} after fixing, or govern advance ${p.slug} / govern note ${p.slug} "…" if the stage changed`;
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  return true;
}

/** Claude Code SessionStart hook: a session that works in a lane's folder (or runs with GOVERN_LANE=<slug>) gets a work
 *  segment on the lane's current stage without running `govern work`; one line names the lane and stage. Nothing is printed
 *  and nothing changes when no lane matches, the lane is finished, or the session already has an open segment. Never fails. */
function hookSessionStart(): void {
  try {
    let input: Record<string, unknown> = {};
    try { const j: unknown = JSON.parse(readFileSync(0, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) input = j as Record<string, unknown>; } catch { /* no usable input */ }
    const sid = typeof input["session_id"] === "string" && input["session_id"] ? input["session_id"] : process.env.CLAUDE_CODE_SESSION_ID ?? "";
    if (!sid) return;
    const cwd = typeof input["cwd"] === "string" && input["cwd"] ? input["cwd"] : process.cwd();
    const named = process.env.GOVERN_LANE?.trim();
    const byName = named && existsSync(stateFile(checkSlug(named))) ? checkSlug(named) : undefined;
    const slug = byName ?? laneByCwd(cwd);
    if (!slug) return;
    if (byName) recordLane(sid, byName);
    const open = openSegment(sid);
    if (open) { if (open.slug === slug) out(`govern: ${slug}: work segment open on stage ${open.stage}`); return; }
    const p = load(slug);
    if (p.finished) return;
    appendLedger(slug, { kind: "work", stage: p.stage, engine: "claude", session: sid, skillSha: sha256File(SKILL), openedBy: "hook", via: byName ? "GOVERN_LANE" : "cwd" });
    out(`govern: ${slug}: work segment opened on stage ${p.stage}`);
  } catch { process.exitCode = 0; }
}

/** Whether two stored commands run the same argv with the same timeout (a plain argv has the default one). */
const sameCommand = (a: string[] | Command, b: string[] | Command) =>
  JSON.stringify([argvOf(a), Array.isArray(a) ? null : a.timeout ?? null, Array.isArray(a) ? null : a.resource ?? null]) === JSON.stringify([argvOf(b), Array.isArray(b) ? null : b.timeout ?? null, Array.isArray(b) ? null : b.resource ?? null]);

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
  const timeout = secondsOpt(a, "timeout"), resource = opt(a, "resource");
  if (resource !== undefined) place(p.slug, resource, undefined);
  const from = p.commands[name] ?? null;
  const to: string[] | Command = timeout === undefined && resource === undefined ? argv : { argv, ...(timeout !== undefined ? { timeout } : {}), ...(resource !== undefined ? { resource } : {}) };
  if (from && sameCommand(from, to)) return out(`${p.slug}: ${name} is already ${commandLine(to)} — nothing changed`);
  p.commands[name] = to;
  save(p);
  appendLedger(p.slug, { kind: "cmd-set", name, from, to, stages: stagesChecking(p, name) });
  out(`${p.slug}: ${name} = ${commandLine(to)}`);
}

function cmdFile(a: Args): void {
  const p = load(a._[1]);
  const [name, pat] = [a._[2], a._[3]];
  if (!name || !pat) { for (const k of Object.keys(p.files)) { const f = resolveFile(p, k); out(`${k}: ${p.files[k]} → ${f ? relative(repo(), f) : "(none)"}`); } return; }
  p.files[name] = pat;
  save(p);
  const f = resolveFile(p, name);
  out(`${p.slug}: ${name} = ${pat} → ${f ? relative(repo(), f) : "(nothing matches yet)"}`);
}

function cmdRun(a: Args): void {
  const p = load(a._[1]);
  const name = a._[2];
  if (!name) usage(`govern run ${p.slug} <command> (have: ${Object.keys(p.commands).join(", ") || "none"})`);
  const st = jobs.start(p, name, a._.slice(3), flag(a, "bg"), opt(a, "on"), amountOpt(a, "estimate"), flag(a, "override-resource"));
  if (st.queued) return out(`job ${st.id} queued on ${st.queued.resource} (${st.queued.ahead} ahead) · wait with: govern wait ${p.slug} ${st.id}`);
  if (st.status === "running") return out(`job ${st.id} started in the background · wait with: govern wait ${p.slug} ${st.id}`);
  out(jobs.summary(p, st));
  process.exitCode = jobs.exitCode(st);
}

/** `govern slice <lane> <recipe>`: a recipe job (split, pieces on machines, join, verify, machines always down). */
function cmdSlice(a: Args): void {
  const p = load(a._[1]);
  const recipe = a._[2] ?? usage(`govern slice ${p.slug} <recipe> [--machines N] [--estimate HOURS] [--bg]`);
  const m = opt(a, "machines");
  const machines = m === undefined ? undefined : /^[1-9]\d*$/.test(m) ? Number(m) : usage(`--machines must be a positive whole number: ${JSON.stringify(m)}`);
  const st = slicing.start(p.slug, recipe, { ...(machines !== undefined ? { machines } : {}), ...(amountOpt(a, "estimate") !== undefined ? { estimate: amountOpt(a, "estimate")! } : {}), bg: flag(a, "bg") });
  if (st.queued) return out(`job ${st.id} queued on ${st.queued.resource} (${st.queued.ahead} ahead) · wait with: govern wait ${p.slug} ${st.id}`);
  if (st.status === "running") return out(`job ${st.id} started in the background · wait with: govern wait ${p.slug} ${st.id}`);
  out(jobs.summary(p, st));
  process.exitCode = jobs.exitCode(st);
}

function cmdWait(a: Args): void {
  const p = load(a._[1]);
  const id = jobs.find(p.slug, a._[2]);
  const timeout = secondsOpt(a, "timeout") ?? 540;
  const st = jobs.wait(p.slug, id, timeout);
  if (st.timedOut) { out(`job ${id} still running after ${timeout}s · wait again with: govern wait ${p.slug} ${id}`); process.exitCode = 124; return; }
  jobs.recordEnd(p.slug, id);
  out(jobs.summary(p, st));
  process.exitCode = jobs.exitCode(st);
}

function cmdAsk(a: Args): void {
  const p = load(a._[1]);
  const step = a._[2];
  if (!step) usage("govern ask <slug> <step> (see govern prompts)");
  const vars = emptyRecord<string>();
  for (const kv of many(a, "var")) {
    const i = kv.indexOf("=");
    if (i < 1) usage(`--var needs NAME=VALUE: ${kv}`);
    if (kv.slice(0, i) === PROTO) usage(`--var ${kv}: "${PROTO}" is not a name`);
    vars[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const r = ask(p, step, { files: many(a, "file"), vars, images: many(a, "image"), effort: opt(a, "effort"), model: opt(a, "model") });
  const u = r.usage;
  const meter = `codex ${step}: ${r.calls} call${r.calls > 1 ? "s" : ""}, ${r.turns} turns, ${kTok(u.input)} in (${u.input ? Math.round((u.cached / u.input) * 100) : 0}% cached), ${kTok(u.output)} out, ${r.seconds}s`;
  if (!r.ok) { out(`${meter}\nFAILED verification (nothing to use):\n- ${r.errors.join("\n- ")}\nraw: ${relative(repo(), r.out)}`); process.exitCode = 3; return; }
  out(`${meter} · verified · ${relative(repo(), r.out)}`);
  out(JSON.stringify(r.value, null, 1));
}

/** The prompts of one process (and the workspace's), or of every process when none is named: each with the file that
 *  wins (the workspace's over a process's) and the processes that file serves. */
function cmdPrompts(a: Args): void {
  const named = a._[1];
  if (named) getProcess(named);
  const scopes = named ? [named] : [...processes().keys(), undefined];
  const byFile = new Map<string, { name: string; serves: string[] }>();
  for (const sc of scopes) for (const { name, file } of promptFiles(sc)) {
    const hit = byFile.get(file) ?? { name, serves: [] };
    hit.serves.push(sc ?? "workspace");
    byFile.set(file, hit);
  }
  const root = findRepo();
  const show = (f: string) => (root && f.startsWith(`${root}/`) ? relative(root, f) : f);
  for (const [file, { name, serves }] of [...byFile].sort((x, y) => x[1].name.localeCompare(y[1].name) || x[0].localeCompare(y[0]))) {
    const pf = readPrompt(name, [dirname(file)]);
    out(`${pf.name.padEnd(14)} ${pf.meta.effort ? `[${pf.meta.effort}] ` : ""}${pf.meta.description ?? ""}  (${show(file)}; ${serves.join(", ")})`);
  }
}

/** The general manual, or a process's own manual (the rules of its kind of work). */
function cmdManual(a: Args): void {
  const name = a._[1];
  if (flag(a, "size")) {
    if (name || flag(a, "full")) usage("govern manual --size takes no process and no --full");
    for (const f of [SKILL, REFERENCE]) {
      const bytes = statSync(f).size;
      out(`${basename(f).padEnd(13)} ${String(bytes).padStart(6)} bytes  ≈ ${approxTokens(bytes)} tokens (bytes / ${BYTES_PER_TOKEN}, an estimate)`);
    }
    out(extensions.docsSizeLine());
    return;
  }
  if (flag(a, "full") && name) usage("govern manual --full is the core manual and REFERENCE.md; it takes no process");
  if (!name) {
    out(readFileSync(SKILL, "utf8"));
    if (flag(a, "full")) out(readFileSync(REFERENCE, "utf8"));
    const have = [...processes().values()].filter((p) => manualOf(p)).map((p) => p.name);
    if (have.length) out(`\nProcess manuals (govern manual <process>): ${have.join(", ")}`);
    return;
  }
  const f = manualOf(getProcess(name));
  if (!f) fail(`${name} has no manual (its process file names none in "manual")`);
  if (!existsSync(f!)) fail(`${name}: manual file not found: ${f}`);
  out(readFileSync(f!, "utf8"));
}

function cmdPublish(a: Args): void {
  const p = load(a._[1]);
  const pr = processOf(p), absent = (["final", "publish"] as const).filter((g) => !pr.gates.some((x) => x.name === g));
  if (absent.length) fail(`${p.slug}: govern publish is for a lane whose process has the gates final and publish; process "${pr.name}" has no ${absent.join(", ")} gate`);
  const missing = (["final", "publish"] as const).filter((g) => !gateApproved(p, pr.gates.find((x) => x.name === g)));
  if (missing.length) fail(`${p.slug}: no owner approval recorded for: ${missing.join(", ")} (govern approve ${p.slug} <gate> --quote "…")`);
  const vpkg = resolveFile(p, "vpkg"), release = resolveFile(p, "release");
  if (!vpkg) fail(`${p.slug}: name the filed package first: govern file ${p.slug} vpkg ../../packages/<file>.vpkg.zip`);
  if (!release) fail(`${p.slug}: name the release manifest: govern file ${p.slug} release <path>/release.json`);
  const pkgs = packagesDir();
  if (dirname(vpkg!) !== pkgs) fail(`${relative(repo(), vpkg!)} is not filed in the packages folder (${relative(repo(), pkgs)})`);
  const sha = spawnSync("sha256sum", [vpkg!], { encoding: "utf8" }).stdout.replace(/ .*/s, "");
  const sums = globSync("channel-vpkg-SHA256SUMS-*.txt", { cwd: pkgs }).some((f) => readFileSync(join(pkgs, f), "utf8").includes(sha));
  if (!sha || !sums) fail(`${relative(repo(), vpkg!)}: sha256 not in any channel-vpkg-SHA256SUMS-*.txt (file the package first)`);
  const base = vpkg!.split("/").pop();
  out(`${p.slug}: approvals ✓ (final, publish) · package filed ✓ ${base}`);
  out(`On the publishing host (smm), with the release manifest ${relative(repo(), release!)} copied there:`);
  out(`  1. plan:  smm youtube publish release.json --upload`);
  out(`  2. apply: PACKAGE_FILED=${base} smm youtube publish release.json --upload --apply`);
  out(`Then read the result back, and run: govern note ${p.slug} "published <videoId> at <time>"`);
}

/** Recipient of a new message: runner, auto (the tuning loop picks the runner), owner, configured mailbox or a live session. */
function recipient(to: string, host?: (peer: string) => void): { to: string; routed: boolean } {
  const address = parseAddress(to);
  if (address) {
    if (address.name === "auto") usage("the receiving host decides routing; --to auto@PEER is not allowed");
    host!(address.peer);
    return { to, routed: false };
  }
  checkRecipient(to, queue.runners());
  if (to !== "auto") return { to, routed: false };
  const c = chooseRunner(queue.all().filter((x) => x.m.routed).length);
  out(`auto → ${c.runner} (${c.reason})`);
  return { to: c.runner, routed: true };
}
/** The peer extension's host check for a `NAME@PEER` recipient, loaded only for one; undefined for a local recipient. A workspace
 *  that does not enable the extension refuses the recipient (exit 4) with the disabled message. */
async function hostCheck(to: string | undefined, via: string): Promise<((peer: string) => void) | undefined> {
  if (to === undefined || !parseAddress(to)) return undefined;
  if (!extensions.isEnabled("peer")) return fail(extensions.disabledMessage(`${via} --to ${to}`, "peer"));
  return (await extensions.loadExtension("peer")).requireHost;
}
/** The decide extension's shadow ask about a sent TASK, when the workspace config turns it on (decide.shadow). Without the extension
 *  there is no ask, and the send says so on stderr; it never fails the send. */
async function shadowTask(m: queue.Message): Promise<void> {
  try {
    if (m.kind !== "TASK" || !decideConfig().shadow) return;
    if (!extensions.isEnabled("decide")) return void process.stderr.write(`govern: decide (shadow): the config asks for it, but the decide extension is not enabled — govern ext enable decide\n`);
    (await extensions.loadExtension("decide")).shadowTask?.(m);
  } catch (e) { process.stderr.write(`govern: decide (shadow): ${(e as Error).message}\n`); }
}
/** The queue does not wake a session: say so when a message goes to one. */
function wakeNote(m: queue.Message): void {
  const address = parseAddress(m.to);
  if (address) return out(`sessions on ${address.peer} are not woken by the queue`);
  if (!queue.runners().includes(m.to) && m.to !== "owner")
    out(`sessions are not woken by the queue: also tell ${m.to} "govern task show ${m.id}" (SendMessage)`);
}
/** `rowLine` shows the reply mark after the summary. */
const rowLine = ({ state, m }: { state: string; m: queue.Message }) => {
  const u = m.result?.usage;
  return `${m.id} ${state.padEnd(7)} ${m.kind.padEnd(8)} ${m.from}→${m.to} [${m.project}/${m.task}] ${clip(m.summary, 70)}${m.verification ? ` ${tag(m.verification)}` : ""}${m.repaired || m.result?.repaired ? " [repaired]" : ""}${m.check ? ` [check: ${m.check.join(", ")}]` : ""}${u ? ` · ${kTok(u.input)} in, ${kTok(u.output)} out, ${m.result!.seconds}s` : ""}`;
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

function localTaskName(name: string, option: string): string {
  if (name.includes("@")) usage(`${option} must be a local name without @; only receive() files a remote sender`);
  return name;
}

/** `--parallel N`: how many messages one dispatcher runs at once (a whole number, 1 or more; default 1). */
function parallelOpt(a: Args): number {
  const v = opt(a, "parallel");
  if (v === undefined) return 1;
  if (!/^[1-9]\d*$/.test(v)) usage(`--parallel must be a whole number, 1 or more: ${JSON.stringify(v)}`);
  return Number(v);
}

/** Refuse (exit 4) a message to a profile with no write capability whose summary or body asks for file changes (lib/writeask.ts). */
function writeRefusal(profile: string, summary: string, body: string): void {
  const reg = registry(), p = getProfile(profile, reg);
  if (writes(reg, p)) return;
  const hit = asksForChanges(`${summary}\n${body}`);
  if (!hit) return;
  const writer = [...reg.profiles.values()].find((x) => x.engine === p.engine && writes(reg, x));
  fail(`profile ${p.name} cannot change files, but the message asks for it (rule: ${WRITE_RULE}; matched "${hit.verb}" and "${hit.object}"). ` +
    `Fix: add --write (or --profile ${writer ? writer.name : "<a write profile>"}) so the task can edit, or --read-only to send it as it is and confirm it needs no edits`);
}

async function cmdTask(a: Args): Promise<void> {
  const sub = a._[1];
  if (sub === "send") {
    const bodyFile = opt(a, "body-file");
    const body = bodyFile ? readFileSync(bodyFile, "utf8") : opt(a, "body") ?? "";
    const { to, routed } = recipient(opt(a, "to") ?? "", await hostCheck(opt(a, "to"), "task send"));
    const address = parseAddress(to);
    if (address && (flag(a, "write") || flag(a, "read-only") || flag(a, "verify") || ["profile", "lane", "estimate-usd", "timeout"].some(k => opt(a, k) !== undefined) || many(a, "file").length || many(a, "check").length))
      usage("the receiving host decides write access, profile, lane, estimate, timeout, files and checks; these options cannot be sent to a peer");
    const checks = [...new Set(many(a, "check"))], verifyArgv = flag(a, "verify") ? a._.slice(2) : [];
    if (flag(a, "verify") && !verifyArgv.length) usage("--verify needs the command after --: govern task send … --verify -- npm test");
    const t = address ? { access: "read-only" as const } : queue.resolveTarget(to, { write: flag(a, "write"), profile: opt(a, "profile") });
    const readOnly = flag(a, "read-only");
    if (readOnly && flag(a, "write")) usage("--read-only and --write contradict each other");
    const summary = opt(a, "summary") ?? "";
    if (!address && t.profile && !readOnly) writeRefusal(t.profile, summary, body);
    const lane = opt(a, "lane"), estimateUsd = amountOpt(a, "estimate-usd"), timeoutSec = secondsOpt(a, "timeout");
    const m = queue.send({
      ...(readOnly && t.profile && !address ? { readOnlyConfirmed: true } : {}),
      ...(t.profile ? { profile: t.profile } : {}), ...(lane ? { lane } : {}),
      project: opt(a, "project") ?? "", task: opt(a, "task") ?? "", kind: opt(a, "kind") ?? "TASK", from: localTaskName(opt(a, "from") ?? resolveAs() ?? fail("cannot tell who is sending (no parent process is a registered Claude Code session): pass --from NAME"), "--from"),
      to, ...(routed ? { routed: true } : {}), summary, body, files: many(a, "file"), replyTo: opt(a, "reply-to"),
      access: t.access, ...(estimateUsd !== undefined ? { estimateUsd } : {}), ...(timeoutSec !== undefined ? { timeoutSec } : {}), ...(checks.length ? { check: checks } : {}), ...(verifyArgv.length ? { verify: verifyArgv } : {}),
    });
    out(`queued ${m.id} (${m.kind} to ${m.to}${m.profile && (m.profile !== `${m.to}-read` || opt(a, "profile")) && m.profile !== m.to ? `, profile ${m.profile}` : ""})`);
    await shadowTask(m);
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
    for (const m of queue.thread(hit!.m)) out(`--- ${m.id} [${m.kind}] ${m.from}→${m.to} ${m.created}${m.profile ? `\nprofile: ${m.profile}${m.lane ? ` · lane ${m.lane}` : ""}` : ""}${queue.grokBound(m) ? `\n${queue.grokBound(m)}` : ""}${m.timeoutSec !== undefined ? `\nlimit: ${m.timeoutSec} s` : ""}${m.retryOf ? `\nretry of ${m.retryOf}: ${m.retryNote}` : ""}${(m.retries ?? []).map((r) => `\nretried as ${r.id}: ${r.note}`).join("")}\n${m.summary}\n${m.body}${m.files.length ? `\nfiles: ${m.files.join(", ")}` : ""}${m.check ? `\ncheck: ${m.check.join(", ")}` : ""}${m.verify ? `\nverify: ${m.verify.join(" ")}` : ""}${queue.repairOf(m) ? `\nenvelope repaired by one ${queue.repairOf(m)!.engine} call` : ""}${m.verification ? `\n${verdict(m.verification)}` : ""}${m.claim ? `\nclaim: ${JSON.stringify(m.claim)} (${queue.claimState(m)})` : ""}${m.result ? `\nresult: ${JSON.stringify(m.result)}` : ""}`);
    return;
  }
  if (sub === "triage") {
    const rows = queue.triage({ all: flag(a, "all"), ...(opt(a, "project") ? { project: opt(a, "project")! } : {}), ...(opt(a, "to") ? { to: opt(a, "to")! } : {}) });
    if (flag(a, "json")) return out(JSON.stringify(rows, null, 2));
    if (!rows.length) return out("no failed messages");
    const age = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 48 * 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
    for (const r of rows)
      out(`${r.id} ${r.state.padEnd(6)} ${r.to} [${r.project}/${r.task}] ${age(r.ageSec)} ago · ${r.cause}: ${r.reason}${r.usage ? ` · ${kTok(r.usage.input)} in, ${kTok(r.usage.output)} out` : ""}${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(3)}` : ""}${r.replyKept ? ` · reply kept: ${r.replyKept}` : ""}`);
    return out(`${rows.length} message(s) · after fixing the cause, send one again with its fix recorded: govern task retry <id> --note "<what was fixed>"`);
  }
  if (sub === "retry") {
    const to = opt(a, "to"), host = await hostCheck(to, "task retry");
    const m = queue.retry(a._[2] ?? "", { note: opt(a, "note") ?? "", ...(to !== undefined ? { to: recipient(to, host).to } : {}), ...(flag(a, "write") ? { write: true } : {}), ...(opt(a, "profile") !== undefined ? { profile: opt(a, "profile")! } : {}), ...(secondsOpt(a, "timeout") !== undefined ? { timeoutSec: secondsOpt(a, "timeout")! } : {}) });
    out(`queued ${m.id} (${m.kind} to ${m.to}, retry of ${m.retryOf})`);
    return wakeNote(m);
  }
  if (sub === "inbox") return cmdInbox(a);
  if (sub === "close") {
    const m = queue.close(a._[2] ?? "", localTaskName(requireAs(opt(a, "as")), "--as"), opt(a, "note"));
    return out(`closed ${m.id}`);
  }
  if (sub === "reclaim") {
    const m = queue.reclaim(a._[2] ?? "", requireAs(opt(a, "as")), opt(a, "note") ?? "");
    return out(`reclaimed ${m.id} → failed · notice ${m.result!.reply}`);
  }
  if (sub === "reply") {
    const bodyFile = opt(a, "body-file"), b = opt(a, "body");
    if (bodyFile === undefined && b === undefined) usage("--body or --body-file is required");
    const by = localTaskName(requireAs(opt(a, "as")), "--as");
    const m = queue.reply(a._[2] ?? "", by, { kind: opt(a, "kind") ?? "", summary: opt(a, "summary") ?? "", body: bodyFile ? readFileSync(bodyFile, "utf8") : b! });
    out(`replied ${m.id} (${m.kind} to ${m.to}); closed ${a._[2]}`);
    return wakeNote(m);
  }
  if (sub === "forward") {
    const { to, routed } = recipient(opt(a, "to") ?? "", await hostCheck(opt(a, "to"), "task forward"));
    const m = queue.forward(a._[2] ?? "", localTaskName(requireAs(opt(a, "as")), "--as"), to, routed);
    out(`forwarded ${a._[2]} to ${m.to} as ${m.id}`);
    return wakeNote(m);
  }
  if (sub === "dispatch") {
    const max = opt(a, "max") ? Number(opt(a, "max")) : undefined;
    const claimed = opt(a, "run-claimed");
    if (claimed !== undefined) return queue.runClaimedBy(claimed).forEach((l) => out(l)); // a worker of --parallel: its parent claimed the message
    const parallel = parallelOpt(a);
    const worker = [process.execPath, ...process.execArgv, join(HERE, "govern.ts")];
    const once = async () => (parallel > 1 ? await queue.dispatchParallel({ max, only: opt(a, "only"), parallel, worker }) : queue.dispatch({ max, only: opt(a, "only") })).forEach((l) => out(l));
    if (!flag(a, "loop")) { if (opt(a, "reap-every")) usage("--reap-every needs --loop (it lists on the loop's timer; a single dispatch never lists instances)"); return once(); }
    const secs = Number(opt(a, "interval") ?? 30);
    const pidf = join(queue.QUEUE(), "dispatcher.json");
    mkdirSync(queue.QUEUE(), { recursive: true });
    writeFileSync(pidf, JSON.stringify({ pid: process.pid, started: nowIso(), interval: secs }) + "\n");
    const stop = () => { try { if (existsSync(pidf) && JSON.parse(readFileSync(pidf, "utf8")).pid === process.pid) unlinkSync(pidf); } catch { /* gone */ } queue.stopWorkers(); process.exit(0); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    // setTimeout, not a blocking sleep: signals are handled only when the event loop turns.
    // The tuning measurement runs hourly in the same loop: reading transcripts, no model.
    let lastTune = 0, lastReap = 0;
    const reapEvery = secondsOpt(a, "reap-every");
    // The loop relays to peers and renews the mesh only where the workspace enables the peer extension.
    let relay: ((max: number | undefined) => Promise<string[]>) | undefined;
    if (extensions.isEnabled("peer")) {
      try { relay = (await extensions.loadExtension("peer")).relay?.(); } catch (e) { out(`[peer] extension unavailable: ${(e as Error).message}`); }
    }
    const tick = async () => {
      try {
        await once();
        if (relay) for (const line of await relay(max)) out(line);
        if (reapEvery && Date.now() - lastReap >= reapEvery * 1000) {
          lastReap = Date.now();
          try { for (const r of reaping.scan([], REAP_TIMEOUT)) out(`[reap] ${r.resource}: ${r.status === "ok" ? `${r.orphans.length} with no job` : r.why}`); } catch (e) { out(`[reap] failed: ${(e as Error).message}`); }
        }
        if (Date.now() - lastTune > 3600e3) { lastTune = Date.now(); try { out(`[tune] ${tune()}`); } catch (e) { out(`[tune] failed: ${(e as Error).message}`); } }
      } catch (e) { out(`[dispatch] failed: ${(e as Error).message}`); }
      finally { setTimeout(tick, secs * 1000); }
    };
    tick();
    return;
  }
  if (sub === "install-service") {
    // A user systemd service, so the dispatcher survives sessions and reboots. It runs a model only when a message waits.
    const system = flag(a, "system");
    const bin = resolve(HERE, "..", "..", "bin", "govern");
    const text = serviceUnit(bin, String(secondsOpt(a, "interval") ?? 30), secondsOpt(a, "reap-every"), system, parallelOpt(a));
    if (system) return out(installSystemUnit(text, flag(a, "write")));
    const unit = join(homedir(), ".config", "systemd", "user", "govern-dispatch.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, text);
    return out(`wrote ${unit}\nenable with: systemctl --user daemon-reload && systemctl --user enable --now govern-dispatch`);
  }
  fail(TASK_SUBS);
}

/** A value as one systemd word: double-quoted, with `\\`, `"` escaped and `%` (a specifier) doubled; `$` doubled too in a command line. */
const unitWord = (v: string, cmd = false) => {
  if (/[\n\r]/.test(v)) fail(`cannot write a line break into the service unit: ${JSON.stringify(v.slice(0, 40))}`);
  const q = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${cmd ? q.replaceAll("$", "$$$$") : q}"`;
};
/** The scene-render program: $SCENE_RENDER, else `scene-render` on PATH; undefined when neither runs. */
function sceneRender(): string | undefined {
  const named = process.env.SCENE_RENDER;
  if (named) return existsSync(named) ? named : undefined;
  return spawnSync("scene-render", ["--version"], { stdio: "ignore" }).error ? undefined : "scene-render";
}

/** `govern bpmn <process|lane>`: the BPMN diagram of a process (with the live state of every lane on it) or of one lane (its own
 *  process, with that lane's progress). Read-only: SVG to a file or stdout, a scene-render scene, or a PNG the engine renders. */
function cmdBpmn(a: Args): void {
  const name = a._[1] ?? usage("govern bpmn <process|lane-slug> [--svg FILE] [--scene FILE] [--png FILE] [--width N] [--height N] [--static]");
  const stat = flag(a, "static"), now = Date.now();
  let p: ReturnType<typeof getProcess>, overlay: Overlay | undefined;
  if (processes().has(name)) {
    p = getProcess(name);
    overlay = stat ? undefined : { now, lanes: readLanes({ now }).lanes.filter((l) => l.process.name === name) };
  } else if (laneSlugs().includes(name)) {
    p = processOf(load(name));
    const sel = readLane(name, { now });
    overlay = stat ? undefined : { now, lanes: [sel], selected: sel };
  } else return fail(`"${name}" is neither a process (${[...processes().keys()].join(", ")}) nor a lane (govern status)`);
  const dim = (k: string): number | undefined => { const v = opt(a, k); if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 64 || n > 16384) fail(`--${k} must be a whole number of pixels, 64..16384`); return n; };
  const svgFile = opt(a, "svg"), sceneFile = opt(a, "scene"), pngFile = opt(a, "png"), width = dim("width"), height = dim("height");
  if ((width || height) && !sceneFile && !pngFile) fail("--width and --height size the scene and the PNG: add --scene FILE or --png FILE");
  let engine: string | undefined;
  if (pngFile) { engine = sceneRender(); if (!engine) fail("--png needs the scene-render engine: set SCENE_RENDER to its path or put scene-render on PATH (no PNG is made without it)"); }
  if (svgFile || !(sceneFile || pngFile)) {
    const svg = processSvg(p, overlay);
    if (svgFile) { writeFileSync(svgFile, svg); out(`wrote ${svgFile}`); } else process.stdout.write(svg + "\n");
  }
  if (sceneFile || pngFile) {
    const v = viewOf(p, overlay), c = canvasFor(v.drawing.width, v.drawing.height, width ?? 3840, height);
    const xml = sceneOf(v.drawing, c), file = sceneFile ?? join(tmpdir(), `govern-bpmn-${process.pid}.scene.xml`);
    writeFileSync(file, xml);
    if (sceneFile) out(`wrote ${sceneFile} (${c.width}x${c.height})`);
    if (pngFile) {
      const r = spawnSync(engine!, ["render", file, "--time", "0", "-o", pngFile], { encoding: "utf8" });
      if (!sceneFile) try { unlinkSync(file); } catch { /* a leftover temp file is harmless */ }
      if (r.error || r.status !== 0) fail(`scene-render failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
      out(`wrote ${pngFile} (${c.width}x${c.height})`);
    }
  }
}


/** The text of the user service: every Environment= and the ExecStart binary quoted, and the state folders of this shell passed on. */
export function serviceUnit(bin: string, interval: string, reapEvery: number | undefined, system = false, parallel = 1): string {
  const env: [string, string][] = [["PATH", process.env.PATH ?? ""], ["GOVERN_REPO", repo()], ["GOVERN_QUEUE", queue.QUEUE()]];
  for (const k of ["GOVERN_STATE", "GOVERN_PROJECTS"]) if (process.env[k]) env.push([k, process.env[k]!]);
  return [
    "[Unit]", "Description=govern task dispatcher (one fresh codex/claude/grok session per queued message)", "",
    "[Service]", ...(system ? [`User=${userInfo().username}`] : []), `WorkingDirectory=${repo().replace(/%/g, "%%")}`,
    `ExecStart=${unitWord(bin, true)} task dispatch --loop --interval ${interval}${reapEvery ? ` --reap-every ${reapEvery}` : ""}${parallel > 1 ? ` --parallel ${parallel}` : ""}`,
    ...env.map(([k, v]) => `Environment=${unitWord(`${k}=${v}`)}`), "Restart=on-failure", "RestartSec=30", "",
    "[Install]", `WantedBy=${system ? "multi-user.target" : "default.target"}`, "",
  ].join("\n");
}

// ── The command table ────────────────────────────────────────────────────────────────────────────────────────────────
// One entry per command drives dispatch, flag parsing (every flag a command reads is declared on it: lib/util.ts parseArgs
// refuses any other, and opt/flag/many refuse to read an undeclared one) and the help text below.

// The entry types (Cmd, Sub, Line) are lib/cli.ts's: the extensions' commands are entries of the same shape. This table holds
// the core commands; an extension's commands come from its ext/<name>/index.ts, loaded when they are used (lib/ext.ts).
export type { Cmd, Sub };

const SECTIONS: readonly (readonly [title: string, notes?: readonly string[]])[] = [
  ["start / state"],
  ["process: stages, exit checks, gates, dependencies"],
  ["run without a model in the loop", ["<job> is an id, a unique id prefix, or a command name (that command's newest job)"]],
  ["codex one-shot steps (verified JSON)"],
  ["measure"],
  ["this help and the operating manual"],
  ["task queue between agents (one fresh headless session per message; nothing runs while the queue waits)", [
    "(sessions are not woken by the queue: tell them \"govern task show <id>\" with SendMessage; the dispatcher runs codex, claude, grok",
    " and the runners named in the queue's config.json, and stops a thread after maxRuns dispatched runs)"]],
  ["the owner's screen"],
  ["publish (prints the commands; the publish guard hook must see them)"],
];

/** How long a provider command (start, stop, list) may run when --timeout is not given. */
const REAP_TIMEOUT = 120;
const TASK_SUBS = "govern task send|list|show|inbox|triage|retry|close|reclaim|reply|forward|dispatch|install-service (govern help)";

export const COMMANDS: readonly Cmd[] = [
  { name: "version", section: 5, footer: false, flags: { bool: ["json"] },
    lines: [["[--json]", "print the package version (also govern --version)"]],
    run: (a) => {
      const { version } = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as { version: string };
      out(flag(a, "json") ? JSON.stringify({ name: "govern", version }) : `govern ${version}`);
    } },
  { name: "init", section: 0, flags: { bool: ["nested"] },
    lines: [["[<dir>] [--nested]", "make <dir> (default: here) a workspace by the convention: .govern/ with projects, queue, processes; inside another workspace only with --nested"]],
    run: (a) => out(`created ${initWorkspace(a._[1] ?? process.cwd(), { nested: flag(a, "nested") })}`) },
  { name: "new", section: 0, footer: false, flags: { value: ["kind", "process", "title", "lang", "parent"], bool:["pin"] },
    lines: [["<slug> (--process NAME | --kind long|short|ops) [--title T] [--lang en|pt-BR] [--parent <slug>] [--pin]", "create a lane and print its brief"]],
    run: (a) => {
      const p = create(checkSlug(a._[1]), { kind: opt(a, "kind"), process: opt(a, "process"), title: opt(a, "title"), lang: opt(a, "lang"), parent: opt(a, "parent"), pin:flag(a,"pin") });
      out(`created ${relative(repo(), join(projectDir(p.slug), "govern.json"))}`);
      out(brief(p));
    } },
  { name: "work", section: 0, flags: { value: ["engine"], bool: ["open"] },
    lines: [["<slug> <stage> [--engine claude|codex|grok] [--open]", "start a work segment, print the brief"]], run: cmdWork },
  { name: "brief", section: 0, lines: [["<slug>", "the compact context (stage, exit condition, approvals, files, decisions)"]], run: (a) => out(brief(load(a._[1]))) },
  { name: "status", section: 0, lines: [["[<slug>]", "one line per lane, or the brief of one"]], run: cmdStatus },
  { name: "note", section: 0, lines: [["<slug> \"<decision>\"", "record a decision (state lives in files, not in the chat)"]],
    run: (a) => {
      const p = load(a._[1]);
      const text = a._.slice(2).join(" ").trim();
      if (!text) usage("govern note <slug> \"<decision>\"");
      p.notes.push({ at: nowIso(), stage: p.stage, text });
      save(p);
      appendLedger(p.slug, { kind: "note", text });
      out(`${p.slug}: noted (${p.notes.length})`);
    } },
  { name: "approve", section: 0, flags: { value: ["quote", "by"] },
    lines: [["<slug> <gate> --quote \"<the owner's words>\" [--by NAME]", "(gates come from the lane's process; --by: the gate's decision owner,\nrequired when the process names one other than owner. In a Claude session the quote\nmust be in a message the person typed; a Codex or Grok session is refused)"]], run: cmdApprove },
  { name: "allow", section: 0, flags: { value: ["extra", "quote", "by"] },
    lines: [["<allowance> --extra N --quote \"<the decision owner's words>\" [--by NAME]", "raise an allowance's limit by N for its current period (govern.config.json: allowances; govern usage\nlists them). --by: the allowance's decision owner, required when it names one other than owner. The quote must\ncontain N as a number (10 matches 10 and 10.0, not 100) and grants once per allowance and period. In a\nClaude session the quote must be in a message the person typed; a Codex or Grok session is refused)"]], run: cmdAllow },
  { name: "freeze", section: 0, flags: { value: ["quote", "continued-as"] },
    lines: [["<slug> --quote \"<the owner's words>\" [--continued-as TEXT]", "stop the lane's work and make it read-only (refused while a job, a conversation turn or a queue task of the lane\nis in flight). On an already-frozen lane, --continued-as only records where the work continued. In a Claude session\nthe quote must be in a message the person typed; a Codex or Grok session is refused"]], run: cmdFreeze },
  { name: "unfreeze", section: 0, flags: { value: ["quote"] },
    lines: [["<slug> --quote \"<the owner's words>\"", "lift a freeze"]], run: cmdUnfreeze },
  { name: "export", section: 0, flags: { bool: ["template", "freeze"], value: ["out", "quote"], multi: ["exclude"] },
    lines: [["<slug> [--template] [--out FILE] [--exclude GLOB]… [--freeze --quote \"<the owner's words>\"]",
      "write the lane to one bundle file (mode 600): reads it under its transaction lock, recording the ledger's line\ncount as ledgerOffset. --template carries configuration only (no files, data, notes, approvals, ledger or\nconversations); --exclude (repeatable) skips matching paths, needed for a directory holding .git; --freeze freezes\nthe lane first, inside the same lock, exactly as govern freeze does"]], run: cmdExport },
  { name: "import", section: 0, flags: { value: ["as"], bool: ["drop-deps"] },
    lines: [["<bundle> [--as SLUG] [--drop-deps]",
      "verify a lane bundle end to end (untrusted input) and write it as a new lane, with a new identity: approvals move\nto history (importedApprovals) and every gate starts closed, every check needs the owner's acceptance\n(govern check <slug> <stage> --accept --quote \"…\") before it can pass a stage, and active stages re-enter their\nruntime so timers restart here. --as names the new slug (default: the bundle's source slug); --drop-deps drops\nafter: references to lanes this workspace does not have, instead of refusing"]], run: cmdImport },
  { name: "clone", section: 0, flags: { bool: ["template"], value: ["as"], multi: ["exclude"] },
    lines: [["<slug> --as NEW [--template] [--exclude GLOB]…",
      "export the lane to a bundle under the workspace's state folder, import it as NEW, then delete the file: the\nsource's govern.json stays byte-identical and its ledger gains only the export entry. Omitting --template\ncontinues NEW at the source's stage with its history and every gate closed; --template starts NEW at the process's\nfirst stage with no history. --exclude (repeatable) skips matching paths, as in govern export"]], run: cmdClone },
  { name: "done", section: 0, flags: { value: ["engine"] }, lines: [["<slug> [--engine claude|codex|grok]", "end the current work segment"]],
    run: (a) => { const p = load(a._[1]); appendLedger(p.slug, { kind: "done", engine: engineOf(a), session: sessionOf(engineOf(a)) }); out(`${p.slug}: segment closed`); } },
  { name: "cmd", section: 0, flags: { value: ["timeout", "rm", "resource"] },
    lines: [["<slug> [<name> [--timeout S] [--resource R] -- <argv…>] | --rm <name>", "list or set the lane's commands (S: foreground limit, default 1800; R: the resource it runs on (checked now), so\nrun needs no --on; ledgered; redefining or removing a stage's check command is flagged)"]],
    run: cmdCmd },
  { name: "file", section: 0, lines: [["<slug> <name> <path-or-glob>", "name a file (a glob means its newest match)"]], run: cmdFile },

  { name: "process", section: 1, defaultSub: "list", noSub: "govern process list|show|pin|migrate",
    subs: {
      list: { lines: [["", "built-in and workspace processes (processes/*.json)"]], run: cmdProcess },
      show: { lines: [["<name>", "one process: its stages, exit checks and gates"]], run: cmdProcess },
      pin: {lines:[["<slug>","freeze the process definition for this lane"]],run:a=>lifecycle.transaction(checkSlug(a._[2]),()=>{const p=load(a._[2]);lifecycle.pin(p);out(`${p.slug}: pinned revision ${p.processSnapshot!.revision}`);})},
      migrate: {flags:{value:['map','data','quote']},lines:[["<slug> [--map JSON] [--data JSON] --quote Q","explicitly migrate to a higher process revision; clears decisions and reinitializes active lifecycle state"]],run:cmdMigrate},
    } },
  { name: "bpmn", section: 1, flags: { value: ["svg", "scene", "png", "width", "height"], bool: ["static"] },
    lines: [["<process|lane> [--svg FILE] [--scene FILE] [--png FILE] [--width N --height N] [--static]", "the BPMN diagram of a process, with the live state of the lanes on it, or of one lane with its own progress (SVG to stdout by default; --scene writes a scene-render scene, --png renders it with $SCENE_RENDER or scene-render on PATH; --static omits the live state)"]],
    run: cmdBpmn },
  { name: "check", section: 1, flags: { value: ["set", "stage", "quote"], bool: ["accept", "accept-import"] },
    lines: [["<slug> [--set <command> --stage <stage>]", "run the stage's exit check (or set the lane's own: ledgered; a swap is flagged)"],
      ["<slug> <stage> --accept --quote \"<the owner's words>\"", "the owner accepts that stage's flagged check changes"],
      ["<slug> --accept-import --quote \"<the owner's words>\"", "the owner accepts an imported lane: lifts the quarantine jobs.start holds it under (every command refused until\nthen) and counts as accepting every stage's flagged check changes too; refused on a lane with nothing to accept"]],
    run: cmdCheck },
  { name: "advance", section: 1, flags: { value: ["note", "stage"] },
    lines: [["<slug> [--stage STAGE] [--note \"<evidence>\"]", "next stage: needs the check to pass (or --note when none and none is required) and the gate"]], run: cmdAdvance },
  { name: "dep", section: 1, flags: { value: ["after", "rm"] },
    lines: [["<slug> [--after <lane>[:<stage>]] [--rm <lane>]", "this lane waits on another (all of it, or past a stage)"]], run: cmdDep },
  { name: "hook", section: 1, footer: false, noSub: "govern hook stop|session-start|session-end",
    subs: {
      stop: { lines: [["", "Claude Code Stop hook: keeps a session on its lane until the stage's check passes (3 tries); closes nothing"]], run: cmdHook },
      "session-start": { lines: [["", "Claude Code SessionStart hook: a session working in a lane's folder (or with GOVERN_LANE=<slug>) gets a work\nsegment on the lane's current stage; silent when no lane matches"]], run: cmdHook },
      "session-end": { lines: [["", "Claude Code SessionEnd hook: closes the work segment the SessionStart hook opened for the session; silent"]], run: cmdHook },
    } },

  { name: "run", section: 2, flags: { bool: ["bg", "override-resource"], value: ["on", "estimate"] },
    lines: [["<slug> <command> [--bg] [--on <resource> [--override-resource]] [--estimate HOURS] [-- extra args]", "foreground prints a summary; --bg returns a job id; --on runs it on a declared resource (every resource is locked unless\nit says lock: false: the job waits its turn, a --bg job shows \"queued on <resource>\"); a command with its own resource refuses a\ndifferent --on unless --override-resource (recorded in the job). On a resource with an allowance (govern allow) the job\nreserves HOURS (else the command's --timeout, else 1800 s; a --bg job needs one of them) and is refused if that does not fit;\nthe reservation also caps the job: it is stopped at its reserved estimate (--bg too)"]], run: cmdRun },
  { name: "slice", section: 2, flags: { bool: ["bg"], value: ["machines", "estimate"] },
    lines: [["<slug> <recipe> [--machines N] [--estimate HOURS] [--bg]", "run a recipe declared in the lane's process as one job: start the machines under a tag, split the work into\npieces, one worker per machine runs them (failed pieces retried), then join and verify; the machines are\nalways brought down. Reserves machines x HOURS on the resource's allowance first; refused above maxMachines"]], run: cmdSlice },
  { name: "wait", section: 2, flags: { value: ["timeout"] },
    lines: [["<slug> [<job>|last] [--timeout 540]", "block until it ends; exit code = the job's (124 = still running)"]], run: cmdWait },
  { name: "jobs", section: 2, lines: [["<slug>", "the lane's latest jobs: status, exit code, seconds, resource (or queued on it)"]],
    run: (a) => {
      const p = load(a._[1]);
      for (const id of jobs.list(p.slug).slice(-15)) {
        const s = jobs.state(p.slug, id), q = s.status === "running" ? jobs.queuedOf(s) : undefined;
        out(`${id} ${s.status}${s.exit != null ? ` exit ${s.exit}` : ""}${s.seconds != null ? ` ${s.seconds}s` : ""}${q ? ` (queued on ${q.resource})` : s.resource ? ` (on ${s.resource})` : ""}`);
      }
    } },
  { name: "resources", section: 2, lines: [["[<name>]", "the declared resources (govern.config.json: resources), or one with its lock holder and the queue behind it"]],
    run: (a) => out((a._[1] ? showLines(a._[1]) : listLines()).join("\n")) },
  { name: "up", section: 2, flags: { value: ["lane", "count", "timeout"] },
    lines: [["<resource> [--lane <slug>] [--count N] [--timeout 120]", "run the resource's start command under a unique govern tag (env GOVERN_TAG, placeholders {tag} {count} {lane} {resource}),\n" +
      "read the instance ids it prints one per line, and record tag, ids, lane and start time (state and ledger)"]],
    run: (a) => {
      const n = opt(a, "count") ?? "1";
      if (!/^[1-9]\d*$/.test(n)) usage(`--count must be a whole number, 1 or more: ${JSON.stringify(n)}`);
      const { rec, problem } = reaping.up(a._[1] ?? usage("govern up <resource> [--lane <slug>] [--count N]"), { lane: opt(a, "lane"), count: Number(n), timeout: secondsOpt(a, "timeout") ?? REAP_TIMEOUT });
      if (problem) fail(problem, 1);
      out([`started ${rec.resource}: tag ${rec.tag}`, ...rec.ids].join("\n"));
    } },
  { name: "down", section: 2, flags: { value: ["timeout"], bool: ["forget"] },
    lines: [["<tag|id> [--forget] [--timeout 120]", "run the stop command (placeholder {id}) for a tag's instances or one id, and book the machine time from up;\n" +
      "--forget books it without running stop, for a machine that is already gone"]],
    run: (a) => {
      const r = reaping.down(a._[1] ?? usage("govern down <tag|id> [--forget]"), { timeout: secondsOpt(a, "timeout") ?? REAP_TIMEOUT, forget: flag(a, "forget") });
      if (r.lines.length) out(r.lines.join("\n"));
      if (r.problems.length) fail(r.problems.join("\n"), 1);
    } },
  { name: "reap", section: 2, flags: { bool: ["yes"], value: ["timeout"] },
    lines: [["[<resource>] [--yes] [--timeout 120]", "run each resource's list command (prints `id tag` lines): show the instances govern started that run with no live job\n" +
      "or lease. Lists only unless --yes, which runs stop and ledgers the reap. Instances without a tag govern recorded are never touched;\n" +
      "a command that fails, times out or prints nothing parseable is reported, never read as \"nothing to reap\""]],
    run: (a) => {
      const r = reaping.reap(a._[1] ? [a._[1]] : [], { yes: flag(a, "yes"), timeout: secondsOpt(a, "timeout") ?? REAP_TIMEOUT });
      if (r.lines.length) out(r.lines.join("\n"));
      if (r.problems.length) fail(r.problems.join("\n"), 1);
    } },
  { name: "log", section: 2, flags: { value: ["tail", "grep"] }, lines: [["<slug> [<job>] [--tail 40] [--grep RE]", "a job's log"]],
    run: (a) => { const p = load(a._[1]); const id = jobs.find(p.slug, a._[2]); out(jobs.tail(p.slug, id, Number(opt(a, "tail") ?? 40), opt(a, "grep")).join("\n") || "(empty log)"); } },
  { name: "kill", section: 2,
    lines: [["<slug> [<job>]", "stop a job (default: the latest running) and what it started: its process tree, a --bg job's group,\n" +
      "and (Linux) every process marked with its GOVERN_JOB_DIR; its own pid only while still that job"]],
    run: (a) => { const p = load(a._[1]); const k = jobs.kill(p.slug, a._[2]); out(`job ${k.id} ${k.outcome}`); } },

  { name: "prompts", section: 3, footer: false, lines: [["[<process>]", "list the steps (those of one process, or of every process)"]], run: cmdPrompts },
  { name: "ask", section: 3, flags: { multi: ["file", "var", "image"], value: ["effort", "model"] },
    lines: [["<slug> <step> [--file F]… [--var K=V]… [--image PNG]… [--effort low|medium|high] [--model M]", "one codex step, its reply verified"]], run: cmdAsk },

  { name: "usage", section: 4, footer: false, flags: { value: ["since"] },
    lines: [["[<slug>…] [--since YYYY-MM-DD]", "tokens and tool calls per lane and segment, against the chat baseline"]],
    run: (a) => { const since = opt(a, "since"); out(report(a._.length > 1 ? a._.slice(1).map(checkSlug) : undefined, since ? Date.parse(since) : undefined)); } },
  { name: "ctx", section: 4, footer: false, lines: [["", "this Claude Code session's context size now"]],
    run: () => { const x = currentCtx(); out(x ? `context now ${kTok(x.ctx)} per call (limit ${kTok(CTX_WARN)})${x.ctx > CTX_WARN ? ` ⚠ over: ${CTX_ADVICE}` : ""}` : "not in a Claude Code session (no CLAUDE_CODE_SESSION_ID) or no transcript yet"); } },

  { name: "help", section: 5, footer: false, flags: { bool: ["topics"] },
    lines: [["[<command> | --topics]", "this text, or one command's lines and rules (also: govern <command> --help); --topics lists the reference documents"]],
    run: async (a) => {
      if (flag(a, "topics")) {
        if (a._[1]) usage("govern help --topics takes no command");
        return out(topicsText());
      }
      out(a._[1] ? await helpFor(a._[1]) : helpText());
    } },
  { name: "ext", section: 5, footer: false, noSub: "govern ext list|enable|disable",
    subs: {
      list: { lines: [["", "every extension with its state (enabled or disabled), its size in bytes and its commands; a workspace enables none by default"]],
        run: () => out(extensions.listText()) },
      enable: { lines: [["<name>", "turn an extension on: writes \"extensions\" in .govern/config.json (created when absent); a govern.config.json workspace is edited by hand"]],
        run: (a) => out(extensions.setEnabled(extensions.infoOf(a._[2]).name, true)) },
      disable: { lines: [["<name>", "turn an extension off: removes it from \"extensions\" in .govern/config.json"]],
        run: (a) => out(extensions.setEnabled(extensions.infoOf(a._[2]).name, false)) },
    } },
  { name: "manual", section: 5, footer: false, flags: { bool: ["full", "size"] },
    lines: [["[<process> | --full | --size]", "the AI's core manual (SKILL.md), or the manual of one process's kind of work;\n--full adds REFERENCE.md; --size prints the bytes and approximate tokens (bytes / 3.6) of both"]], run: cmdManual },
  { name: "install-skill", section: 5, footer: false, flags: { bool: ["check", "replace"] },
    lines: [["[<skills dir>] [--check] [--replace]", "link <skills dir>/govern (default: the repo's .claude/skills) to the tool's tracked folder (tools/govern:\n" +
      "SKILL.md and REFERENCE.md), never a copy; a real directory or file there is refused unless --replace;\n" +
      "--check installs nothing and exits 1 when the entry is missing, a copy, a link elsewhere or has a stale SKILL.md"]],
    run: (a) => {
      const skills = a._[1] ?? join(repo(), ".claude", "skills");
      const dest = join(skills, "govern");
      if (flag(a, "check")) {
        if (flag(a, "replace")) usage("govern install-skill --check installs nothing; --replace belongs to the install");
        const drift = skillDrift(HERE, skills);
        if (drift) fail(drift, 1);
        out(`${dest} is a link to ${HERE}; SKILL.md is current (sha256 ${sha256File(SKILL)}), REFERENCE.md sha256 ${sha256File(REFERENCE)}`);
        return;
      }
      const did = installSkill(HERE, skills, flag(a, "replace"));
      out(`${did}: ${dest} -> ${HERE} (SKILL.md sha256 ${sha256File(SKILL)}, REFERENCE.md sha256 ${sha256File(REFERENCE)}); edits to tools/govern/SKILL.md show at once, there is nothing to refresh`);
      out("add to the hooks of your Claude Code settings so every session on a lane is measured by where it works: SessionStart → govern hook session-start, Stop → govern hook stop, SessionEnd → govern hook session-end");
    } },

  { name: "task", section: 6, noSub: TASK_SUBS,
    subs: {
      send: { flags: { value: ["to", "project", "task", "kind", "summary", "body", "body-file", "reply-to", "from", "profile", "lane", "estimate-usd", "timeout"], multi: ["file", "check"], bool: ["write", "verify", "read-only"] },
        lines: [["--to auto|codex|claude|grok|owner|<session> --project P --task T --kind TASK --summary S (--body B | --body-file F)\n" +
          "[--file REPO-RELATIVE-PATH]… [--reply-to ID] [--write | --profile P | --read-only] [--lane SLUG] [--from NAME] [--estimate-usd N] [--timeout S]\n" +
          "[--check NAME]… [--verify -- ARGV…]", "--check NAME: a content check on the reply besides the kind's (profile capabilities file `checks`, queue config.json `checks.named`, or built in: file-refs, commit-refs, claims-cited);\nan unknown NAME is refused (exit 2); all must pass for [checked]; claims-cited needs --file LEDGER.json ({\"claims\":[{\"id\":…}]}) and requires every id in the reply;\n--verify -- ARGV…: after the reply is filed and the checks pass govern runs ARGV (no shell, 600 s) in the project folder; [checked: verify (exit 0)] only on exit 0, else [unverified] with the exit code and the last 12 lines (queue/replychecks/);\nHANDOFF replies are checked by default: every commit they name must exist in the project's git repository;\nGOVERN_QUEUE_REPAIR=0 turns off the one envelope-repair call a run whose reply does not parse gets (read-only, cheapest model, 120 s);\n--to must be a runner, a profile, owner, a LIVE session name or NAME@PEER;\nremote recipients require a live peer; the receiving host decides write access, profile, lane, estimate, timeout, files and checks;\n--from must be a local name without @; only receive() files a remote sender;\n--profile P (govern caps) seals the run to P's capabilities; --read-only sends a message that asks for file changes to a profile that cannot write (it is refused otherwise: use --write or a write profile); --lane names the lane whose gate authorises a spend, publish or push profile;\n--estimate-usd N: what the run is expected to cost, reserved against a matching allowance (govern allow);\n--timeout S: the run's limit in seconds, used instead of GOVERN_QUEUE_TIMEOUT_SEC and refused above maxTimeoutSec (queue config.json, default 7200)"]], run: cmdTask },
      list: { flags: { value: ["to", "state", "project"] }, lines: [["[--to X] [--state open|claimed|done|failed] [--project P]", "the queue's messages; a dispatcher reply ends with [checked], [unverified] or [shape only] (content check, declared per profile, in queue config.json checks, built in for REVIEW and HANDOFF, or chosen by the sender with --check / --verify), then [repaired] when its envelope needed the one repair call; a task shows [check: NAME]"]], run: cmdTask },
      show: { lines: [["<id>", "a message and its thread, limit, retries, claim holder and result; a dispatcher reply also shows its check (checked, UNVERIFIED with the reason, or shape only); a task shows its check: and verify: and \"envelope repaired by one <engine> call\" when it was"]], run: cmdTask },
      triage: { flags: { value: ["project", "to"], bool: ["all", "json"] },
        lines: [["[--all] [--project P] [--to X] [--json]", "every message in failed/, newest first: id, recipient, project/task, age, the cause (dispatcher error, parse failure, dead claim, expired, held) and its reason,\ntokens and cost where recorded, and the kept reply text if there is one; --all adds replies marked unverified in done/; --json prints an array"]], run: cmdTask },
      retry: { flags: { value: ["note", "to", "profile", "timeout"], bool: ["write"] },
        lines: [["<id> --note T [--to X] [--write | --profile P] [--timeout S]", "file a new open message from a failed or closed one: same recipient, project, task, kind, summary, body and files, threaded to it, with the note recorded on both;\n--to, --write, --profile and --timeout override; refuses without --note, for an open or claimed message and for a third retry of one original; never automatic"]], run: cmdTask },
      inbox: { flags: { value: ["as"], bool: ["all", "hook"] },
        lines: [["[--as NAME] [--all] [--hook]", "open messages for NAME (default: GOVERN_AS, else this session);\n--hook is silent when empty"]], run: cmdTask },
      close: { flags: { value: ["as", "note"] }, lines: [["<id> [--as NAME] [--note T]", "close a message addressed to NAME"]], run: cmdTask },
      reclaim: { flags: { value: ["as", "note"] }, lines: [["<id> --note T [--as NAME]", "fail an abandoned claimed message after inspecting its effects; refuses a live holder, records who and why, charges unknown spend as reserved and sends a BLOCKED notice"]], run: cmdTask },
      forward: { flags: { value: ["to", "as"] }, lines: [["<id> --to NAME [--as NAME]", "pass a message on to another recipient"]], run: cmdTask },
      reply: { flags: { value: ["kind", "summary", "body", "body-file", "as"] },
        lines: [["<id> --kind K --summary S (--body B | --body-file F) [--as NAME]", "answer the sender, then close <id>"]], run: cmdTask },
      dispatch: { flags: { value: ["max", "only", "interval", "reap-every", "parallel", "run-claimed"], bool: ["loop"] },
        lines: [["[--max N] [--only codex|claude|grok] [--parallel N] [--loop --interval 30 [--reap-every S]]", "first fail dead claims and holderless claims older than twice the task's limit (GOVERN_QUEUE_TIMEOUT_SEC, or its --timeout; minimum 3600 s; unknown spend charged as reserved),\n--parallel N runs up to N messages at once in this dispatcher (default 1); a runner never exceeds its queue config.json concurrency (default 1) across all dispatchers, and a message over it stays open;\n--run-claimed ID is what a --parallel worker runs; expire local mail with no live recipient after workspace mailTtlHours (default 72; owner and config mailboxes retained), then run open messages addressed to runners; --loop also relays to live peers;\n--reap-every lists each resource's tagged instances\nevery S seconds into state for the desk (off by default; lists only, never stops a machine)"]], run: cmdTask },
      "install-service": { flags: { bool: ["system", "write"], value: ["interval", "reap-every", "parallel"] }, lines: [["[--interval 30] [--reap-every S] [--parallel N] [--system [--write]]", "install the standard dispatcher user service; --system prints a system unit with current User=, --write writes it only as root (never escalates)"]], run: cmdTask },
    } },

  { name: "caps", section: 6, flags: { bool: ["check", "all"] },
    lines: [["", "the capabilities and profiles a queued agent can run under, with each profile's last self-test"],
      ["<profile>", "its permission patterns, Codex mapping, side-effect classes and secret names"],
      ["--check <profile>", "self-test the grants: one probe per capability in a sealed session (haiku), recorded with the profile's hash;\nthe dispatcher refuses a profile whose last check failed, and runs the check itself (once per profile hash) for one with none or a stale one.\nAlso one negative probe (a capability the profile lacks, whose tools no held capability grants, must be refused; none applicable is recorded as such); a capability with no probe is untested and fails a required check"],
      ["--check --all", "run the check for every profile that has no current passing one (never checked, changed since, or failed); the list shows them as not run, stale (profile changed) or failed"]],
    run: (a) => {
      const reg = registry(), name = a._[1];
      if (flag(a, "all") && !flag(a, "check")) fail("--all goes with --check: govern caps --check --all");
      if (flag(a, "check")) {
        if (flag(a, "all") && name) usage("govern caps --check --all takes no profile name");
        const todo = flag(a, "all") ? [...reg.profiles.values()].filter((p) => checkState(readCheck(queue.QUEUE(), p.name), profileHash(reg, p)) !== "passed").map((p) => p.name)
          : [name ?? usage("govern caps --check <profile> (or --all)")];
        if (!todo.length) out("every profile has a current passing check");
        for (const n of todo) {
          const rec = checkProfile(queue.QUEUE(), reg, n);
          if (todo.length > 1) out(`${n}:`);
          for (const r of rec.results) out(`  ${r.capability.padEnd(10)} ${r.status === "invalid" ? "" : `${r.status.padEnd(8)} `}${r.evidence}`.trimEnd());
          if (rec.negative) out(`  negative: ${rec.negative}`);
          const bad = failing(rec.results, getProfile(n, reg));
          out(bad.length ? `${rec.profile}: check FAILED (${bad.join(", ")})` : `${rec.profile}: check passed (${rec.results.length} probe${rec.results.length === 1 ? "" : "s"})`);
          if (bad.length) process.exitCode = 1;
        }
        return;
      }
      // With no workspace there is no queue, hence no self-test records and no runner overrides: list the built-in profiles alone.
      const ws = findRepo() !== undefined;
      const qdir = ws ? queue.QUEUE() : join(tmpdir(), "govern-no-queue");
      out(name ? showText(reg, qdir, getProfile(name, reg)) : listText(reg, qdir, ws ? queue.shadowing() : []));
    } },

  { name: "desk", section: 7, lines: [["", "every lane, your inbox, the queue, today's tokens (reads files only; an enabled extension adds its own lines)"]], run: async () => {
    const d = desk(await extensions.deskLines());
    out(d.text);
    if (d.failed) unreadable(d.failed, d.lanes);
  } },
  { name: "artifact", section: 7, noSub: "govern artifact add|list (lane evidence)",
    subs: {
      add: { flags: { value: ["name", "title", "caption"] },
        lines: [["<slug> <file> [--name N] [--title T] [--caption C]", "copy evidence into the lane and record its digest and version"]],
        run: (a) => { out(JSON.stringify(artifacts.add(checkSlug(a._[2]), a._[3] ?? usage("govern artifact add <slug> <file>"), { name: opt(a, "name"), title: opt(a, "title"), caption: opt(a, "caption") }), null, 2)); } },
      list: { lines: [["<slug>", "list artifacts with current digests and reviews"]],
        run: (a) => { const slug = checkSlug(a._[2]); load(slug); out(JSON.stringify(artifacts.list(slug), null, 2)); } },
    } },
  { name: "tune", section: 7, lines: [["", "measure the last 24 h and record the tuning decision (the dispatcher runs it hourly)"]], run: () => out(tune()) },

  { name: "publish", section: 8, lines: [["<slug>", "the publish commands, once the final and publish gates are approved and the package is filed"]], run: cmdPublish },
];

// What an extension's commands call back into (tick advances, reject records a policy decision), without importing this file.
core.advance = cmdAdvance;
core.policyDecision = cmdPolicyDecision;

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** Help lines: `  govern <name>[ <sub>] <usage>`, then the help after it (on lines of its own when the usage is long). */
function helpLines(head: string, lines: readonly Line[]): string[] {
  const r: string[] = [];
  for (const [usage, help] of lines) {
    const left = `  govern ${head}${usage ? ` ${usage}` : ""}`.split("\n").map((m, i) => (i ? `${" ".repeat(head.length + 10)}${m}` : m));
    const helps = (help ?? "").split("\n").filter(Boolean);
    const lastLeft = left.at(-1), [firstHelp, ...moreHelps] = helps;
    if (firstHelp !== undefined && lastLeft !== undefined && lastLeft.length <= 46)
      r.push(...left.slice(0, -1), `${lastLeft.padEnd(48)}${firstHelp}`, ...moreHelps.map((h) => `${" ".repeat(48)}${h}`));
    else r.push(...left, ...helps.map((h) => `      ${h}`));
  }
  return r;
}
const cmdLines = (c: Cmd, only?: string): string[] =>
  c.subs ? Object.entries(c.subs).filter(([s]) => !only || s === only).flatMap(([s, sub]) => helpLines(`${c.name} ${s}`, sub.lines)) : helpLines(c.name, c.lines ?? []);

function unknownCommand(name: string): never {
  return usage(`unknown command "${name}" (commands: ${[...COMMANDS.map((c) => c.name), ...EXTENSIONS.flatMap((e) => e.commands)].join(", ")}; govern help)`);
}

/** One command's help lines: all its subcommands, or only `sub`. `extra` holds the commands of a loaded extension, whose names are then known. */
export function commandHelp(name: string, sub?: string, extra: readonly Cmd[] = []): string {
  const c = byName.get(name) ?? extra.find((x) => x.name === name) ?? unknownCommand(name);
  const rules = HELP_RULES[name];
  return [...cmdLines(c, sub), ...(rules ? ["", `rules: ${rules}`] : [])].join("\n");
}

/** What `govern help <command>` and `govern <command> --help` print: a core command's lines and rules; an enabled extension's
 *  command's lines and rules followed by the extension's own manpage text; for a disabled extension, its refusal (exit 4). */
async function helpFor(name: string, sub?: string): Promise<string> {
  const owned = await extensions.commandOf(name);
  return owned ? `${commandHelp(name, sub, owned.ext.commands)}\n\n${owned.ext.manpage.trimEnd()}` : commandHelp(name, sub);
}

/** `govern help --topics`: each reference document with its path (relative to the workspace when it is inside it) and one line;
 *  an extension's documents only while it is enabled, each marked with the extension. */
function topicsText(): string {
  const root = findRepo();
  const show = (file: string, about: string) => {
    const f = join(HERE, file);
    return `${file.padEnd(17)} ${root && f.startsWith(`${root}/`) ? relative(root, f) : f}\n${" ".repeat(18)}${about}`;
  };
  return [...TOPICS.map((t) => show(t.file, t.about)), ...extensions.topicLines(show)].join("\n");
}

/** The overview of the core commands (the extensions' commands are listed by `govern help COMMAND` once enabled). */
export const HELP = [
  "govern — run lanes of work (videos, software, ops, any process) through their stages with agents (manual: govern manual)",
  ...SECTIONS.flatMap(([title, notes], i) => ["", title, ...COMMANDS.filter((c) => c.section === i).flatMap((c) => cmdLines(c)), ...(notes ?? []).map((n) => `  ${n}`)]),
  "",
  "stages: govern process list",
].join("\n");
/** What `govern help` prints: the overview, then one line naming every extension and whether this workspace enables it. */
const helpText = (): string => `${HELP}\n${extensions.extensionsLine()}`;

/** Every command takes --help: its own help lines instead of running. */
const withHelp = (f: FlagSpec | undefined): FlagSpec => ({ ...f, bool: [...(f?.bool ?? []), "help"] });

/** Every flag any command or subcommand declares, the extensions' included whether or not one is loaded: a value flag never takes
 *  one of these words as its value (`advance l1 --note --bg` forgot the note), while any other word, `--verbose test passes`
 *  included, is the value. */
const FLAG_WORDS: ReadonlySet<string> = new Set([
  ...COMMANDS.flatMap((c) => [c.flags, ...Object.values(c.subs ?? {}).map((s) => s.flags)])
    .flatMap((f) => [...(withHelp(f).bool ?? []), ...(f?.value ?? []), ...(f?.multi ?? [])]),
  ...EXTENSION_FLAGS,
]);

/** Leading words that name a command by another spelling: `govern --version` is `govern version`. */
export const ALIASES: Readonly<Record<string, string>> = { "--version": "version" };

async function main(argv: string[]): Promise<void> {
  const name = argv[0] !== undefined && Object.hasOwn(ALIASES, argv[0]) ? ALIASES[argv[0]] : argv[0];
  if (name === undefined || name === "-h" || name === "--help") return void out(helpText());
  if (name.startsWith("--")) usage(`the command comes first: govern <command> [<args>] [--flags] (got ${name} first; govern help)`);
  // A command of an extension: refused (exit 4) when the workspace does not enable it, else loaded from ext/<name>/ for this one call.
  const c = byName.get(name) ?? (await extensions.commandOf(name))?.cmd ?? unknownCommand(name);
  let entry: { flags?: FlagSpec; run?: (a: Args) => void | Promise<void> } = c, label = c.name, sub: string | undefined, rest = argv.slice(1);
  const lead = [name];
  if (c.subs) {
    const word = argv[1];
    const given = word !== undefined && !word.startsWith("--");
    if (!given && word === "--help" && argv.length === 2) return void out(await helpFor(c.name));
    sub = given ? word : c.defaultSub;
    const named = sub && Object.hasOwn(c.subs, sub) ? c.subs[sub] : undefined;
    if (!named) usage(c.noSub ?? `govern ${c.name} ${Object.keys(c.subs).join("|")}`);
    entry = named;
    label = `${c.name} ${sub}`;
    if (given) { rest = argv.slice(2); lead.push(word); }
  }
  const a = parseArgs(rest, withHelp(entry.flags), label, FLAG_WORDS);
  if (flag(a, "help")) return void out(await helpFor(c.name, sub));
  a._.unshift(...lead);
  const mutations = new Set(['new','note','approve','reject','data','human','advance','cmd','file','dep','check','event','alerts','subprocess','recover','freeze','unfreeze']);
  if (mutations.has(name)) withLaneLock(laneLockDir(a._[1]), () => entry.run!(a));
  else await entry.run!(a);
  if (c.footer !== false) ctxFooter();
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (e) {
    if (e instanceof GovernError) { process.stderr.write(`govern: ${e.message}\n`); process.exitCode = e.code; }
    else throw e;
  }
}

