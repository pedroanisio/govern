#!/usr/bin/env node
import * as lifecycle from './lib/lifecycle.ts';
import { enterRuntime } from './lib/lifecycle-runtime.ts';
import { eventServer } from './lib/event-server.ts';
import { SUBS as CONVERSATION_SUBS } from './lib/conversation-cli.ts';
import { withLaneLock } from './lib/lane-lock.ts';
// govern — run lanes of work (videos, software, ops, any process) through their stages with agents, cheaply and under the owner's gates.
// The manual for the AI operating it is SKILL.md (govern manual). Usage: govern help.
import { activeStages, enterTasks, isGraph, requireActive, validateRequired, nextStages, completeStage, setData, authenticatedPerson, humanAction, requireHumanComplete, gateApproved, policyVote, rejectRoute, ownerApproval } from './lib/business.ts';
import { scalar, value } from './lib/business-schema.ts';
import { check, record } from './lib/shape.ts';
import { spawnSync } from "node:child_process";
import { readFileSync, globSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { GovernError, fail, parseArgs, opt, flag, many, flagNames, secondsOpt, nowIso, readJsonl, kTok, clip, type Args, type FlagSpec } from "./lib/util.ts";
import { stagesOf, load, save, create, stageOf, brief, appendLedger, resolveFile, ledgerFile, projectDir, checkSlug, checkOf, pendingCheckChanges, blockedBy, laneState, laneSlugs, laneRows, stateFile, argvOf, commandLine, type Project, type Command } from "./lib/project.ts";
import { processes, getProcess, processOf, listLine, show, manualOf } from "./lib/process.ts";
import { repo, findRepo, projectsDir, packagesDir, initWorkspace, stateDir } from "./lib/workspace.ts";
import { emptyRecord, PROTO } from "./lib/shape.ts";
import * as jobs from "./lib/jobs.ts";
import { ask, readPrompt, promptFiles } from "./lib/codex.ts";
import { report, currentCtx, CTX_WARN } from "./lib/usage.ts";
import * as queue from "./lib/queue.ts";
import { tag, verdict } from "./lib/replycheck.ts";
import * as jev from "./lib/decide.ts";
import { desk } from "./lib/desk.ts";
import { listLines, showLines, place } from "./lib/resources.ts";
import * as reaping from "./lib/reap.ts";
import * as qr from "./lib/qr.ts";
import * as slicing from "./lib/slice.ts";
import * as allowances from "./lib/allowances.ts";
import { registry, getProfile, listText, showText, failing } from "./lib/caps.ts";
import { checkProfile } from "./lib/capcheck.ts";
import { tune, chooseRunner } from "./lib/tune.ts";
import { verifyQuote, origin, GROK_MARKERS } from "./lib/approval.ts";
import * as remote from "./lib/remote.ts";
import * as artifacts from "./lib/artifacts.ts";
import * as remotePair from "./lib/remote-pair.ts";
import { checkRecipient, requireAs, resolveAs } from "./lib/sessions.ts";
import { installSkill, skillDrift, sha256File } from "./lib/skill.ts";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "SKILL.md");
const laneLockDir = (slug: string | undefined) => join(stateDir(), "lane-locks", createHash("sha256").update(stateFile(checkSlug(slug))).digest("hex"));

// A reader that stops early (govern brief x | head) is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); throw e; });
const out = (s: string): void => { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); };

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
  if (!(ENGINES as readonly string[]).includes(e)) fail(`--engine must be ${ENGINES.slice(0, -1).join(", ")} or ${ENGINES.at(-1)}`);
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
  for (const s of list.slice(Math.max(from, 0), target)) {
    const def=processOf(p).stages.find(x=>x.name===s)!;
    if(def.event||def.call||def.foreach||def.onError||def.timer)fail(`${p.slug}: lifecycle stage ${s} must be completed with govern advance, not skipped`);
    validateRequired(p, s);
    requireHumanComplete(p, s);
    const chk = checkOf(p, s);
    if (chk) {
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
    appendLedger(p.slug, { kind: "work", stage, engine, session, skillSha: sha256File(SKILL) });
    const kind = processOf(p).name, label = kind.charAt(0).toUpperCase() + kind.slice(1);
    const first = `${label} work session (registered by govern work ${p.slug} ${stage}). Use the govern skill: run \`govern brief ${p.slug}\` first and work from it; do not explore the repository. Then ask me what we change.`;
    const args = engine === "codex" ? ["-C", repo(), first] : ["--session-id", session!, first];
    const bin = process.env[`GOVERN_${engine.toUpperCase()}_BIN`] ?? engine;
    const r = spawnSync(bin, args, { cwd: repo(), stdio: "inherit", env: openEnv(engine) });
    appendLedger(p.slug, { kind: "done", engine, session });
    process.exitCode = r.status ?? 0;
    return;
  }
  appendLedger(p.slug, { kind: "work", stage, engine, session: sessionOf(engine), skillSha: sha256File(SKILL) });
  out(brief(p));
}

function cmdStatus(a: Args): void {
  if (a._[1]) return out(brief(load(a._[1])));
  const slugs = laneSlugs();
  if (!slugs.length) return out("nothing under govern yet (govern new <slug> --process NAME, or --kind long|short|ops)");
  const { rows, failed } = laneRows(slugs, (s, p) => {
    const lastJob = readJsonl(ledgerFile(s)).filter((e) => e.kind === "job").pop();
    const gates = processOf(p).gates;
    const ap = gates.map((g) => (gateApproved(p, g) ? g.name.charAt(0).toUpperCase() : "·")).join("");
    const list = stagesOf(p);
    const parts = [`${s.padEnd(36)} ${p.kind.padEnd(5)} ${list.indexOf(p.stage) + 1}/${list.length} ${p.stage.padEnd(12)}`, gates.length ? `approvals ${ap}` : "",
      laneState(p), p.workflow ? `active ${p.workflow.active.join(', ')}` : '', lastJob ? `last job ${lastJob.name} ${lastJob.status}` : ""];
    return parts.filter(Boolean).join("  ").trimEnd();
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
  if(!quote || quote.trim().length<2) fail('--quote is required: the human decision');
  const source=verifyQuote(quote!);
  const vote=policyVote(p,g,actor,decision,quote!);
  if(decision==='reject') rejectRoute(p,g);
  p.notes.push({at:vote.at,stage:p.stage,text:`${actor} ${decision} ${g.name}: "${quote}"`});
  save(p);
  appendLedger(p.slug,{kind:decision,gate:g.name,...vote,source});
  out(`${p.slug}: ${g.name} ${decision} by ${actor} · ${gateApproved(p,g) ? 'approved' : 'not approved'}`);
}
function cmdData(a:Args):void {
  const p=load(a._[1]), text=opt(a,'set');
  if(text!==undefined) {
    let raw:unknown; try {raw=JSON.parse(text);} catch {fail('--set must be a JSON object');}
    const patch=check('case data',raw,record(value));
    setData(p,patch); save(p); appendLedger(p.slug,{kind:'data',fields:Object.keys(patch)});
  }
  out(JSON.stringify(p.data??{},null,2));
}
function cmdHumanInbox(a:Args):void {
  const requested=opt(a,'as'), user=userInfo().username, rows:string[]=[];
  let authenticated=false;
  for(const slug of laneSlugs()) {
    const p=load(slug), pr=processOf(p);
    const actor=Object.keys(pr.people??{}).find(id=>pr.people![id]!.user===user && (!requested || id===requested));
    if(!actor) continue;
    authenticated=true;
    for(const stage of activeStages(p)) {
      const def=pr.stages.find(s=>s.name===stage)?.human, task=p.humanTasks?.[stage];
      if(!def || task?.completedAt) continue;
      if(task?.assignee===actor || (!task?.assignee && def.role && pr.people![actor]!.roles?.includes(def.role))) rows.push(`${slug} ${stage}: ${task?.assignee ? `assigned to ${actor}` : `unclaimed (${def.role})`}`);
    }
  }
  if(requested && !authenticated) fail(`OS account ${user} is not authenticated as ${requested}`);
  out(rows.join('\n')||'(no human tasks for this account)');
}
function cmdHuman(a:Args):void {
  const p=load(a._[1]), action=a._[2]??'list';
  if(action==='list') { out(Object.entries(p.humanTasks??{}).map(([s,t])=>`${s}: ${t.completedAt ? `completed by ${t.completedBy}` : t.assignee??'unclaimed'}${activeStages(p).includes(s)?' (active)':''}`).join('\n')||'(no human tasks)'); return; }
  if(!['claim','delegate','complete'].includes(action)) fail('human action must be list, claim, delegate or complete');
  const stage=a._[3]??fail('human action requires a stage'), quote=opt(a,'quote');
  if(!quote || quote.trim().length<2) fail('--quote is required: the human instruction');
  const actor=authenticatedPerson(processOf(p),opt(a,'as')), source=verifyQuote(quote!);
  humanAction(p,stage,action as 'claim'|'delegate'|'complete',actor,quote!,opt(a,'to'));
  save(p); appendLedger(p.slug,{kind:'human-'+action,stage,by:actor,to:opt(a,'to'),quote,source});
  out(`${p.slug}: ${stage} ${action} by ${actor}`);
}

/** A flag's value as a number above 0 (an estimate), or undefined when the flag is absent. */
function amountOpt(a: Args, k: string): number | undefined {
  const v = opt(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fail(`--${k} must be a positive number: ${JSON.stringify(v)}`);
}

/** `govern allow <allowance> --extra N --quote "…"`: the allowance's decision owner raises its limit for the current period, in their own words. */
function cmdAllow(a: Args): void {
  const al = allowances.allowanceNamed(a._[1] ?? fail("govern allow <allowance> --extra N --quote \"…\" (govern usage lists the allowances)"));
  const extra = amountOpt(a, "extra") ?? fail("--extra must be a positive number: the amount to add to the limit");
  const owner = al.owner, by = opt(a, "by");
  if (by === undefined && owner !== "owner") fail(`allowance ${al.name} is decided by ${owner}: pass --by ${owner}`);
  if (by !== undefined && by !== owner) fail(`allowance ${al.name} is decided by ${owner}, not ${by}`);
  const quote = opt(a, "quote");
  if (!quote || quote.trim().length < 2) fail(`--quote is required: ${owner}'s own words approving ${extra} ${allowances.unitName(al)} more for ${al.name} (only ${owner} approves)`);
  const source = verifyQuote(quote!);
  allowances.grant(al, extra, quote!, source, owner);
  out(`${al.name}: +${extra} ${allowances.unitName(al)} approved by ${owner} · limit ${Math.round((al.limit + allowances.status(al).extra) * 1e6) / 1e6}`);
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
    lifecycle.beginAttempt(p);
    let r:ReturnType<typeof runCheck>;
    try{r=runCheck(p,chk);}catch(e){if(e instanceof GovernError && stageDef.onError)lifecycle.checkFailed(p,e.message);throw e;}
    if (!r.ok) {lifecycle.checkFailed(p, `${chk}: ${r.why}`);fail(`${p.slug}: check ${chk} failed (${r.why})\n${r.text}`,stageDef.onError?1:2);}
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

function jsonValue(text:string|undefined,fallback:unknown={}):unknown {try{return text===undefined?fallback:JSON.parse(text);}catch{return fail('value must be valid JSON');}}
function cmdEvent(a:Args):void {
  const p=load(a._[1]),name=a._[2]??fail('event name required'),id=opt(a,'id')??fail('--id required'),correlation=check('correlation',jsonValue(opt(a,'correlation'),null),scalar);
  const data=check('event data',jsonValue(opt(a,'data')),record(scalar)),generation=secondsOpt(a,'generation');if(generation!==undefined&&!Number.isSafeInteger(generation))fail('--generation must be a positive safe integer');
  const accepted=lifecycle.deliverEvent(p,name,id,correlation,data,generation);save(p);out(accepted?'event accepted; stage ready':'duplicate event ignored');
}
function cmdRecover(a:Args):void {
  const p=load(a._[1]),stage=opt(a,'stage')??p.stage;requireActive(p,stage);p.stage=stage;
  const action=opt(a,'action');if(action!=='retry'&&action!=='compensated')fail('--action must be retry or compensated');
  const quote=opt(a,'quote');if(!quote||quote.trim().length<2)fail('--quote is required: the human recovery decision');
  const source=verifyQuote(quote!);lifecycle.recover(p,action as 'retry'|'compensated',quote!);save(p);appendLedger(p.slug,{kind:'recover-source',source});out(`${p.slug}: recovery recorded`);
}
function cmdMigrate(a:Args):void {
  const quote=opt(a,'quote');if(!quote||quote.trim().length<2)fail('--quote is required: the human migration decision');const source=verifyQuote(quote!);
  const map=check('stage map',jsonValue(opt(a,'map')),record((x,p)=>typeof x==='string'?x:fail(`${p} must be a stage name`))),data=check('migration data',jsonValue(opt(a,'data')),record((x,p)=>x===null?null:value(x,p)));
  lifecycle.transaction(checkSlug(a._[2]),()=>{const p=load(a._[2]);lifecycle.migrate(p,map,data,quote!);appendLedger(p.slug,{kind:'migration-source',source});out(`${p.slug}: migrated to revision ${p.processSnapshot!.revision}`);});
}
function cmdTick(a:Args):void {
  const interval=secondsOpt(a,'interval')??30,advance=flag(a,'advance');
  const once=()=>{
    let failed=false;
    for(const slug of a._[1]?[checkSlug(a._[1])]:laneSlugs())try{lifecycle.transaction(slug,()=>{
      const p=load(slug);if(p.finished)return;const emitted=lifecycle.tickTimers(p);save(p);if(emitted)out(`${slug}: ${emitted} timer alerts`);
      if(!advance)return;
      for(const stage of [...activeStages(p)]){
        const current=load(slug);if(!activeStages(current).includes(stage))continue;
        const s=processOf(current).stages.find(s=>s.name===stage)!,r=current.runtime?.[stage];
        if(s.call||s.foreach)lifecycle.syncChild(current,stage);
        if(!(r?.eventId||r?.childSynced||r?.batch?.synced||(r?.retryAt&&Date.parse(r.retryAt)<=Date.now())))continue;
        const args=parseArgs([slug,'--stage',stage,'--note','Declared workflow event, child completion or scheduled retry verified'],{value:['stage','note']},'advance');args._.unshift('advance');cmdAdvance(args);
      }
    });}catch(e){if(!(e instanceof GovernError))throw e;failed=true;out(`${slug}: blocked: ${e.message}`);}
    if(failed&&!flag(a,'loop'))process.exitCode=1;
  };
  once();if(flag(a,'loop'))setInterval(once,interval*1000);
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
    let hit: { slug: string; at: number; t: string; entries: Record<string, unknown>[] } | undefined;
    for (const f of globSync("**/govern.json", { cwd: projectsDir() })) {
      const slug = dirname(f);
      const entries = readJsonl(ledgerFile(slug));
      let at = -1;
      entries.forEach((e, i) => { if ((e.kind === "work" || e.kind === "done") && e.session === sid) at = i; });
      const latest = entries[at];
      if (latest === undefined || latest.kind !== "work") continue;
      const t = String(latest.t);
      if (!hit || t > hit.t) hit = { slug, at, t, entries };
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
  if (!name) fail(`govern run ${p.slug} <command> (have: ${Object.keys(p.commands).join(", ") || "none"})`);
  const st = jobs.start(p, name, a._.slice(3), flag(a, "bg"), opt(a, "on"), amountOpt(a, "estimate"), flag(a, "override-resource"));
  if (st.queued) return out(`job ${st.id} queued on ${st.queued.resource} (${st.queued.ahead} ahead) · wait with: govern wait ${p.slug} ${st.id}`);
  if (st.status === "running") return out(`job ${st.id} started in the background · wait with: govern wait ${p.slug} ${st.id}`);
  out(jobs.summary(p, st));
  process.exitCode = st.exit ?? 1;
}

/** `govern slice <lane> <recipe>`: a recipe job (split, pieces on machines, join, verify, machines always down). */
function cmdSlice(a: Args): void {
  const p = load(a._[1]);
  const recipe = a._[2] ?? fail(`govern slice ${p.slug} <recipe> [--machines N] [--estimate HOURS] [--bg]`);
  const m = opt(a, "machines");
  const machines = m === undefined ? undefined : /^[1-9]\d*$/.test(m) ? Number(m) : fail(`--machines must be a positive whole number: ${JSON.stringify(m)}`);
  const st = slicing.start(p.slug, recipe, { ...(machines !== undefined ? { machines } : {}), ...(amountOpt(a, "estimate") !== undefined ? { estimate: amountOpt(a, "estimate")! } : {}), bg: flag(a, "bg") });
  if (st.queued) return out(`job ${st.id} queued on ${st.queued.resource} (${st.queued.ahead} ahead) · wait with: govern wait ${p.slug} ${st.id}`);
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
  const vars = emptyRecord<string>();
  for (const kv of many(a, "var")) {
    const i = kv.indexOf("=");
    if (i < 1) fail(`--var needs NAME=VALUE: ${kv}`);
    if (kv.slice(0, i) === PROTO) fail(`--var ${kv}: "${PROTO}" is not a name`);
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
  if (!name) {
    out(readFileSync(SKILL, "utf8"));
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
/** `rowLine` shows the reply mark after the summary. */
const rowLine = ({ state, m }: { state: string; m: queue.Message }) => {
  const u = m.result?.usage;
  return `${m.id} ${state.padEnd(7)} ${m.kind.padEnd(8)} ${m.from}→${m.to} [${m.project}/${m.task}] ${clip(m.summary, 70)}${m.verification ? ` ${tag(m.verification)}` : ""}${u ? ` · ${kTok(u.input)} in, ${kTok(u.output)} out, ${m.result!.seconds}s` : ""}`;
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
    const t = queue.resolveTarget(to, { write: flag(a, "write"), profile: opt(a, "profile") });
    const lane = opt(a, "lane"), estimateUsd = amountOpt(a, "estimate-usd");
    const m = queue.send({
      ...(t.profile ? { profile: t.profile } : {}), ...(lane ? { lane } : {}),
      project: opt(a, "project") ?? "", task: opt(a, "task") ?? "", kind: opt(a, "kind") ?? "TASK", from: opt(a, "from") ?? resolveAs() ?? fail("cannot tell who is sending (no parent process is a registered Claude Code session): pass --from NAME"),
      to, ...(routed ? { routed: true } : {}), summary: opt(a, "summary") ?? "", body, files: many(a, "file"), replyTo: opt(a, "reply-to"),
      access: t.access, ...(estimateUsd !== undefined ? { estimateUsd } : {}),
    });
    out(`queued ${m.id} (${m.kind} to ${m.to}${m.profile && (m.profile !== `${m.to}-read` || opt(a, "profile")) && m.profile !== m.to ? `, profile ${m.profile}` : ""})`);
    jev.shadowTask(m);
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
    for (const m of queue.thread(hit!.m)) out(`--- ${m.id} [${m.kind}] ${m.from}→${m.to} ${m.created}${m.profile ? `\nprofile: ${m.profile}${m.lane ? ` · lane ${m.lane}` : ""}` : ""}\n${m.summary}\n${m.body}${m.files.length ? `\nfiles: ${m.files.join(", ")}` : ""}${m.verification ? `\n${verdict(m.verification)}` : ""}${m.result ? `\nresult: ${JSON.stringify(m.result)}` : ""}`);
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
    if (!flag(a, "loop")) { if (opt(a, "reap-every")) fail("--reap-every needs --loop (it lists on the loop's timer; a single dispatch never lists instances)"); once(); return; }
    const secs = Number(opt(a, "interval") ?? 30);
    const pidf = join(queue.QUEUE(), "dispatcher.json");
    mkdirSync(queue.QUEUE(), { recursive: true });
    writeFileSync(pidf, JSON.stringify({ pid: process.pid, started: nowIso(), interval: secs }) + "\n");
    const stop = () => { try { if (existsSync(pidf) && JSON.parse(readFileSync(pidf, "utf8")).pid === process.pid) unlinkSync(pidf); } catch { /* gone */ } process.exit(0); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    // setTimeout, not a blocking sleep: signals are handled only when the event loop turns.
    // The tuning measurement runs hourly in the same loop: reading transcripts, no model.
    let lastTune = 0, lastReap = 0;
    const reapEvery = secondsOpt(a, "reap-every");
    const tick = () => {
      once();
      if (reapEvery && Date.now() - lastReap >= reapEvery * 1000) {
        lastReap = Date.now();
        try { for (const r of reaping.scan([], REAP_TIMEOUT)) out(`[reap] ${r.resource}: ${r.status === "ok" ? `${r.orphans.length} with no job` : r.why}`); } catch (e) { out(`[reap] failed: ${(e as Error).message}`); }
      }
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
    writeFileSync(unit, serviceUnit(bin, opt(a, "interval") ?? "30", secondsOpt(a, "reap-every")));
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
/** `govern remote pair | devices | revoke ID`, or with no subcommand serve the remote API (off loopback only over TLS). */
function cmdRemote(a: Args): void {
  const sub = a._[1];
  if (["pair", "requests", "confirm", "refuse", "link"].includes(sub ?? "") && origin().kind !== "terminal")
    fail("pair a device from the owner's own terminal, not from an agent session: a paired device approves gates", 1);
  if (sub === "requests") {
    out(remotePair.requests().map((r) => `${r.id}  ${r.code}  ${r.name}  lanes: ${r.lanes?.join(", ") ?? "all"}  expires ${r.expires}`).join("\n") || "(no open pairing requests)");
    return;
  }
  if (sub === "confirm") {
    const lanes = many(a, "lane");
    const d = remotePair.confirmPairing(a._[2] ?? fail("govern remote confirm <id> --code NNNNNN"), opt(a, "code") ?? fail("--code is required"),
      { person: opt(a, "person"), lanes: lanes.length ? lanes : undefined, all: flag(a, "all") });
    out(`${d.id} (${d.name}) paired as ${d.person}; lanes: ${d.lanes?.join(", ") ?? "all"}`);
    return;
  }
  if (sub === "refuse") {
    const id = a._[2] ?? fail("govern remote refuse <id>");
    remotePair.refusePairing(id); out(`${id} refused`); return;
  }
  if (sub === "link") {
    const url = opt(a, "url") ?? "http://127.0.0.1:5002", cert = opt(a, "tls-cert"), lane = opt(a, "lane");
    if (!/^https?:\/\/[^\s]+$/.test(url)) fail("--url must be the server's http(s) address, as the phone reaches it");
    const q = new URLSearchParams({ url });
    if (cert) q.set("pin", remote.certPin(readFileSync(cert, "utf8")));
    if (lane) q.set("lane", checkSlug(lane));
    const link = `govern-remote://pair?${q}`;
    out(`pairing link (request pairing from the phone): ${link}`);
    if (!flag(a, "no-qr")) out(qr.render(qr.encode(link), { colour: process.stdout.isTTY === true }));
    return;
  }
  if (sub === "pair") {
    const minutes = Number(opt(a, "minutes") ?? 10);
    const { code, expires } = remote.createPairing(opt(a, "as") ?? "owner", minutes);
    const url = opt(a, "url"), cert = opt(a, "tls-cert");
    if (cert && !url) fail("--tls-cert needs --url (the pin goes into the pairing link)");
    out(`pairing code ${code} (one device, until ${expires}; ${remote.PAIR_ATTEMPTS} wrong tries void it)`);
    if (url) {
      if (!/^https?:\/\/[^\s]+$/.test(url)) fail("--url must be the server's http(s) address, as the phone reaches it");
      const q = new URLSearchParams({ url, code });
      if (cert) q.set("pin", remote.certPin(readFileSync(cert, "utf8")));
      const link = `govern-remote://pair?${q}`;
      out(`pairing link (paste it in the app): ${link}`);
      if (!flag(a, "no-qr")) out(`or scan it with the phone's camera (it opens the app with the form filled in):\n${qr.render(qr.encode(link), { colour: process.stdout.isTTY === true })}`);
    }
    return;
  }
  if (sub === "devices") {
    const all = remote.devices();
    out(all.map((d) => `${d.id}  ${d.name.padEnd(24)} ${d.person.padEnd(10)} lanes: ${d.lanes?.join(", ") ?? "all"} paired ${d.pairedAt.slice(0, 16)}${d.revokedAt ? `  REVOKED ${d.revokedAt.slice(0, 16)}` : ""}`).join("\n") || "(no paired devices: govern remote pair)");
    return;
  }
  if (sub === "revoke") {
    const d = remote.revoke(a._[2] ?? fail("govern remote revoke <device-id>"));
    out(`${d.id} (${d.name}) revoked`);
    return;
  }
  const host = opt(a, "host") ?? "127.0.0.1", port = Number(opt(a, "port") ?? 5002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be 1..65535");
  const certFile = opt(a, "tls-cert"), keyFile = opt(a, "tls-key");
  if (!certFile !== !keyFile) fail("--tls-cert and --tls-key go together");
  if (!certFile && !remote.loopback(host))
    fail(`${host} is reachable from other machines: serve TLS (--tls-cert, --tls-key), or keep loopback and publish it with tailscale serve`);
  const tls = certFile ? { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile!, "utf8") } : undefined;
  const server = remote.remoteServer({ tls });
  server.on("error", (e) => { process.stderr.write(`remote: ${e.message}\n`); process.exitCode = 1; });
  server.listen(port, host, () => out(`govern remote (${remote.devices().filter((d) => !d.revokedAt).length} paired devices) on ${tls ? "https" : "http"}://${host}:${port}${tls ? ` · certificate pin ${remote.certPin(tls.cert)}` : ""}`));
}

/** The text of the user service: every Environment= and the ExecStart binary quoted, and the state folders of this shell passed on. */
function serviceUnit(bin: string, interval: string, reapEvery: number | undefined): string {
  const env: [string, string][] = [["PATH", process.env.PATH ?? ""], ["GOVERN_REPO", repo()], ["GOVERN_QUEUE", queue.QUEUE()]];
  for (const k of ["GOVERN_STATE", "GOVERN_PROJECTS"]) if (process.env[k]) env.push([k, process.env[k]!]);
  return [
    "[Unit]", "Description=govern task dispatcher (one fresh codex/claude/grok session per queued message)", "",
    "[Service]", `WorkingDirectory=${repo().replace(/%/g, "%%")}`,
    `ExecStart=${unitWord(bin, true)} task dispatch --loop --interval ${interval}${reapEvery ? ` --reap-every ${reapEvery}` : ""}`,
    ...env.map(([k, v]) => `Environment=${unitWord(`${k}=${v}`)}`), "Restart=on-failure", "RestartSec=30", "",
    "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

// ── The command table ────────────────────────────────────────────────────────────────────────────────────────────────
// One entry per command drives dispatch, flag parsing (every flag a command reads is declared on it: lib/util.ts parseArgs
// refuses any other, and opt/flag/many refuse to read an undeclared one) and the help text below.

/** One help line: the usage after `govern <command>[ <sub>]`, and what it does. */
type Line = readonly [usage: string, help?: string];
export interface Sub { lines: readonly Line[]; flags?: FlagSpec; run: (a: Args) => void | Promise<void> }
export interface Cmd {
  name: string;
  section: number;
  lines?: readonly Line[];
  flags?: FlagSpec;
  run?: (a: Args) => void | Promise<void>;
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
    "(sessions are not woken by the queue: tell them \"govern task show <id>\" with SendMessage; the dispatcher runs codex, claude, grok",
    " and the runners named in the queue's config.json, and stops a thread after maxRuns dispatched runs)"]],
  ["the owner's screen"],
  ["publish (prints the commands; the publish guard hook must see them)"],
];

/** How long a provider command (start, stop, list) may run when --timeout is not given. */
const REAP_TIMEOUT = 120;
const TASK_SUBS = "govern task send|list|show|inbox|close|reply|forward|dispatch|install-service (govern help)";

export const COMMANDS: readonly Cmd[] = [
  {name:'conversation',section:0,footer:false,subs:CONVERSATION_SUBS,noSub:'govern conversation create|list|show|history|send|run|cancel|recover|context|events|close (govern help)'},
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
      if (!text) fail("govern note <slug> \"<decision>\"");
      p.notes.push({ at: nowIso(), stage: p.stage, text });
      save(p);
      appendLedger(p.slug, { kind: "note", text });
      out(`${p.slug}: noted (${p.notes.length})`);
    } },
  { name: "approve", section: 0, flags: { value: ["quote", "by"] },
    lines: [["<slug> <gate> --quote \"<the owner's words>\" [--by NAME]", "(gates come from the lane's process; --by: the gate's decision owner,\nrequired when the process names one other than owner. In a Claude session the quote\nmust be in a message the person typed; a Codex or Grok session is refused)"]], run: cmdApprove },
  { name: "reject", section: 1, flags: { value: ["quote", "by"] },
    lines: [["<slug> <gate> --quote Q [--by PERSON]", "reject a policy gate; follows rejectTo when declared, otherwise blocks the gate"]],
    run: (a) => { const p=load(a._[1]); const g=processOf(p).gates.find(g=>g.name===a._[2])??fail('unknown gate'); cmdPolicyDecision(a,p,g,'reject'); } },
  { name: "data", section: 1, flags: { value: ["set"] },
    lines: [["<slug> [--set JSON]", "read or merge typed case fields; changed data invalidates policy votes and active human task completion"]], run: cmdData },
  { name: "human-inbox", section: 1, flags: { value: ["as"] },
    lines: [["[--as PERSON]", "active tasks assigned to this OS account or claimable through its process roles"]], run: cmdHumanInbox },
  { name: "human", section: 1, flags: { value: ["as", "to", "quote"] },
    lines: [["<slug> [list | claim|delegate|complete STAGE] [--as PERSON] [--to PERSON] [--quote Q]", "list, claim, delegate or complete stage tasks; person identity is mapped to the current OS account; mutations require verified human words"]], run: cmdHuman },
  { name: "allow", section: 0, flags: { value: ["extra", "quote", "by"] },
    lines: [["<allowance> --extra N --quote \"<the decision owner's words>\" [--by NAME]", "raise an allowance's limit by N for its current period (govern.config.json: allowances; govern usage\nlists them). --by: the allowance's decision owner, required when it names one other than owner. The quote must\ncontain N as a number (10 matches 10 and 10.0, not 100) and grants once per allowance and period. In a\nClaude session the quote must be in a message the person typed; a Codex or Grok session is refused)"]], run: cmdAllow },
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
  { name: "check", section: 1, flags: { value: ["set", "stage", "quote"], bool: ["accept"] },
    lines: [["<slug> [--set <command> --stage <stage>]", "run the stage's exit check (or set the lane's own: ledgered; a swap is flagged)"],
      ["<slug> <stage> --accept --quote \"<the owner's words>\"", "the owner accepts that stage's flagged check changes"]], run: cmdCheck },
  { name: "advance", section: 1, flags: { value: ["note", "stage"] },
    lines: [["<slug> [--stage STAGE] [--note \"<evidence>\"]", "next stage: needs the check to pass (or --note when none and none is required) and the gate"]], run: cmdAdvance },
  {name:'event',section:1,flags:{value:['id','correlation','data','generation']},lines:[["<slug> <name> --id ID --correlation JSON [--data JSON] [--generation N]","deliver a deduplicated event to one matching active stage; adapters supply a stable id"]],run:cmdEvent},
  {name:'event-listen',section:1,flags:{value:['port']},lines:[["[--port 5001]","loopback POST /events listener; Bearer token comes from GOVERN_WEBHOOK_TOKEN (minimum 16 characters)"]],run:a=>{
    const token=process.env.GOVERN_WEBHOOK_TOKEN??fail('GOVERN_WEBHOOK_TOKEN is not set; configure it securely before starting the listener');
    const port=Number(opt(a,'port')??5001);if(!Number.isInteger(port)||port<1||port>65535)fail('--port must be 1..65535');
    const server=eventServer(token);server.on('error',e=>{process.stderr.write(`event listener: ${e.message}\n`);process.exitCode=1;});server.listen(port,'127.0.0.1',()=>out(`event listener ready on port ${port}`));
  }},
  {name:'tick',section:1,flags:{value:['interval'],bool:['advance','loop']},lines:[["[<slug>] [--advance] [--loop --interval 30]","emit due reminders/escalations; optionally advance ready event, child and retry stages through normal checks and gates"]],run:cmdTick},
  {name:'alerts',section:1,flags:{value:['ack']},lines:[["<slug> [--ack ID]","list timer alerts or acknowledge one; acknowledgement does not approve a gate"]],run:a=>{
    const p=load(a._[1]),id=opt(a,'ack');if(id){const alert=p.alerts?.find(x=>x.id===id)??fail('unknown alert');alert.acknowledgedAt=nowIso();save(p);appendLedger(p.slug,{kind:'alert-ack',id});}
    out((p.alerts??[]).map(x=>`${x.id} ${x.kind} ${x.acknowledgedAt?'acknowledged':'open'}: ${x.message}`).join('\n')||'(no alerts)');
  }},
  {name:'subprocess',section:1,lines:[["<slug> <stage>","start the declared child if needed and sync its outputs only after it finishes"]],run:a=>{
    const p=load(a._[1]),stage=a._[2]??p.stage,ready=lifecycle.syncChild(p,stage);out(`${stage}: ${ready?'child complete; outputs synced':`waiting for ${p.runtime![stage]!.batch ? `${Object.keys(p.runtime![stage]!.batch!.children).length}/${p.runtime![stage]!.batch!.items.length} item cases` : p.runtime![stage]!.child}`}`);
  }},
  {name:'recover',section:1,flags:{value:['stage','action','quote']},lines:[["<slug> [--stage S] --action retry|compensated --quote Q","human recovery: reset exhausted retries, or confirm compensation after investigating an uncertain result"]],run:cmdRecover},
  { name: "dep", section: 1, flags: { value: ["after", "rm"] },
    lines: [["<slug> [--after <lane>[:<stage>]] [--rm <lane>]", "this lane waits on another (all of it, or past a stage)"]], run: cmdDep },
  { name: "hook", section: 1, footer: false, noSub: "govern hook stop",
    subs: { stop: { lines: [["", "Claude Code Stop hook: keeps a session on its lane until the stage's check passes (3 tries)"]], run: cmdHook } } },

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
      if (!/^[1-9]\d*$/.test(n)) fail(`--count must be a whole number, 1 or more: ${JSON.stringify(n)}`);
      const { rec, problem } = reaping.up(a._[1] ?? fail("govern up <resource> [--lane <slug>] [--count N]"), { lane: opt(a, "lane"), count: Number(n), timeout: secondsOpt(a, "timeout") ?? REAP_TIMEOUT });
      if (problem) fail(problem, 1);
      out([`started ${rec.resource}: tag ${rec.tag}`, ...rec.ids].join("\n"));
    } },
  { name: "down", section: 2, flags: { value: ["timeout"], bool: ["forget"] },
    lines: [["<tag|id> [--forget] [--timeout 120]", "run the stop command (placeholder {id}) for a tag's instances or one id, and book the machine time from up;\n" +
      "--forget books it without running stop, for a machine that is already gone"]],
    run: (a) => {
      const r = reaping.down(a._[1] ?? fail("govern down <tag|id> [--forget]"), { timeout: secondsOpt(a, "timeout") ?? REAP_TIMEOUT, forget: flag(a, "forget") });
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

  { name: "decide", section: 4, noSub: "govern decide ask|report",
    subs: {
      ask: { flags: { value: ["questions", "state", "state-file", "purpose"], bool: ["json"] },
        lines: [["--questions <file.json> (--state \"<text>\" | --state-file <file>) [--purpose <name>] [--json]",
          "ask Jev (TypeSafe System One: probabilities, no text) typed questions about a state; recorded in the queue's decisions.jsonl\n" +
          "(choice: {key: description}, score: [levels…], noul: yes/no; key TYPESAFE_API_KEY or the config's decide.envFile)"]],
        run: (a) => {
          const text = opt(a, "state"), file = opt(a, "state-file");
          if ((text === undefined) === (file === undefined)) fail("give the state with --state or --state-file (one of them)");
          const state = text ?? readFileSync(file!, "utf8");
          if (!state.trim()) fail("the state is empty");
          const qs = jev.loadQuestions(opt(a, "questions") ?? fail("--questions <file.json> is required"));
          const d = jev.decide(state, qs, { purpose: opt(a, "purpose") ?? "ask" });
          out(flag(a, "json") ? JSON.stringify(d, null, 2) : jev.show(d));
        } },
      report: { lines: [["", "how well Jev's recorded answers predicted outcomes: per yes/no question Brier and ECE against the task's\n" +
        "first-try result in the queue ledger, per score question ok rate, cost and time in five buckets (decide.shadow: true\n" +
        "in the workspace config asks about every TASK sent)"]], run: () => out(jev.report()) },
    } },

  { name: "help", section: 5, footer: false, lines: [["[<command>]", "this text, or one command's lines (also: govern <command> --help)"]],
    run: (a) => out(a._[1] ? commandHelp(a._[1]) : HELP) },
  { name: "manual", section: 5, footer: false, lines: [["[<process>]", "the AI's operating manual (SKILL.md), or the manual of one process's kind of work"]], run: cmdManual },
  { name: "install-skill", section: 5, footer: false, flags: { bool: ["check"] },
    lines: [["[<skills dir>] [--check]", "install SKILL.md as the govern skill (default: the repo's .claude/skills), atomically and\n" +
      "read back by sha256; --check installs nothing and exits 1 when the installed copy is missing or differs"]],
    run: (a) => {
      const dest = join(a._[1] ?? join(repo(), ".claude", "skills"), "govern", "SKILL.md");
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
      send: { flags: { value: ["to", "project", "task", "kind", "summary", "body", "body-file", "reply-to", "from", "profile", "lane", "estimate-usd"], multi: ["file"], bool: ["write"] },
        lines: [["--to auto|codex|claude|grok|owner|<session> --project P --task T --kind TASK --summary S (--body B | --body-file F)\n" +
          "[--file REPO-RELATIVE-PATH]… [--reply-to ID] [--write | --profile P] [--lane SLUG] [--from NAME] [--estimate-usd N]", "--to must be a runner, a profile, owner or a LIVE session name;\n--profile P (govern caps) seals the run to P's capabilities; --lane names the lane whose gate authorises a spend, publish or push profile;\n--estimate-usd N: what the run is expected to cost, reserved against a matching allowance (govern allow)"]], run: cmdTask },
      list: { flags: { value: ["to", "state", "project"] }, lines: [["[--to X] [--state open|claimed|done|failed] [--project P]", "the queue's messages; a dispatcher reply ends with [checked], [unverified] or [shape only] (content check, declared per profile, in queue config.json checks, or built in for REVIEW)"]], run: cmdTask },
      show: { lines: [["<id>", "a message and its thread; a dispatcher reply also shows its check (checked, UNVERIFIED with the reason, or shape only)"]], run: cmdTask },
      inbox: { flags: { value: ["as"], bool: ["all", "hook"] },
        lines: [["[--as NAME] [--all] [--hook]", "open messages for NAME (default: GOVERN_AS, else this session);\n--hook is silent when empty"]], run: cmdTask },
      close: { flags: { value: ["as", "note"] }, lines: [["<id> [--as NAME] [--note T]", "close a message addressed to NAME"]], run: cmdTask },
      forward: { flags: { value: ["to", "as"] }, lines: [["<id> --to NAME [--as NAME]", "pass a message on to another recipient"]], run: cmdTask },
      reply: { flags: { value: ["kind", "summary", "body", "body-file", "as"] },
        lines: [["<id> --kind K --summary S (--body B | --body-file F) [--as NAME]", "answer the sender, then close <id>"]], run: cmdTask },
      dispatch: { flags: { value: ["max", "only", "interval", "reap-every"], bool: ["loop"] },
        lines: [["[--max N] [--only codex|claude|grok] [--loop --interval 30 [--reap-every S]]", "run the open messages addressed to runners; --reap-every lists each resource's tagged instances\nevery S seconds into state for the desk (off by default; lists only, never stops a machine)"]], run: cmdTask },
      "install-service": { flags: { value: ["interval", "reap-every"] }, lines: [["[--interval 30] [--reap-every S]", "a user systemd service running dispatch --loop"]], run: cmdTask },
    } },

  { name: "caps", section: 6, flags: { bool: ["check"] },
    lines: [["", "the capabilities and profiles a queued agent can run under, with each profile's last self-test"],
      ["<profile>", "its permission patterns, Codex mapping, side-effect classes and secret names"],
      ["--check <profile>", "self-test the grants: one probe per capability in a sealed session (haiku), recorded with the profile's hash;\nthe dispatcher refuses a profile whose last check failed or predates its definition.\nAlso one negative probe (a capability the profile lacks must be refused); a capability with no probe is untested and fails a required check"]],
    run: (a) => {
      const reg = registry(), name = a._[1];
      if (flag(a, "check")) {
        const rec = checkProfile(queue.QUEUE(), reg, name ?? fail("govern caps --check <profile>"));
        for (const r of rec.results) out(`  ${r.capability.padEnd(10)} ${r.status === "invalid" ? "" : `${r.status.padEnd(8)} `}${r.evidence}`.trimEnd());
        const bad = failing(rec.results, getProfile(name!, reg));
        out(bad.length ? `${rec.profile}: check FAILED (${bad.join(", ")})` : `${rec.profile}: check passed (${rec.results.length} probe${rec.results.length === 1 ? "" : "s"})`);
        if (bad.length) process.exitCode = 1;
        return;
      }
      // With no workspace there is no queue, hence no self-test records and no runner overrides: list the built-in profiles alone.
      const ws = findRepo() !== undefined;
      const qdir = ws ? queue.QUEUE() : join(tmpdir(), "govern-no-queue");
      out(name ? showText(reg, qdir, getProfile(name, reg)) : listText(reg, qdir, ws ? queue.shadowing() : []));
    } },

  { name: "desk", section: 7, lines: [["", "every lane, your inbox, the queue, today's tokens (reads files only)"]], run: () => {
    const d = desk();
    out(d.text);
    if (d.failed) unreadable(d.failed, d.lanes);
  } },
  { name: "artifact", section: 7, noSub: "govern artifact add|list (lane evidence)",
    subs: {
      add: { flags: { value: ["name", "title", "caption"] },
        lines: [["<slug> <file> [--name N] [--title T] [--caption C]", "copy evidence into the lane and record its digest and version"]],
        run: (a) => { out(JSON.stringify(artifacts.add(checkSlug(a._[2]), a._[3] ?? fail("govern artifact add <slug> <file>"), { name: opt(a, "name"), title: opt(a, "title"), caption: opt(a, "caption") }), null, 2)); } },
      list: { lines: [["<slug>", "list artifacts with current digests and reviews"]],
        run: (a) => { const slug = checkSlug(a._[2]); load(slug); out(JSON.stringify(artifacts.list(slug), null, 2)); } },
    } },
  { name: "remote", section: 7, noSub: "govern remote pair|requests|confirm|refuse|link|devices|revoke|serve (the protocol: tools/govern/REMOTE.md)",
    subs: {
      pair: { flags: { value: ["as", "minutes", "url", "tls-cert"], bool: ["no-qr"] },
        lines: [["[--as PERSON] [--minutes 10] [--url URL] [--tls-cert F] [--no-qr]", "a one-time code that pairs one phone (govern-remote app) as PERSON (default owner); only from the\nowner's own terminal. --url and --tls-cert add the server and its certificate pin to the printed pairing link,\nalso drawn as a QR code the phone's camera opens in the app (--no-qr: the link only)"]], run: cmdRemote },
      requests: { lines: [["", "open phone pairing requests with comparison code, name, lanes and expiry; owner's terminal only"]], run: cmdRemote },
      confirm: { flags: { value: ["code", "person"], multi: ["lane"], bool: ["all"] },
        lines: [["<id> --code NNNNNN [--lane S]... [--all] [--person P]", "compare the phone's code and pair it; defaults to requested lanes and owner; with no requested lanes choose --lane SLUG (repeatable) or --all"]], run: cmdRemote },
      refuse: { lines: [["<id>", "refuse a phone's pairing request; owner's terminal only"]], run: cmdRemote },
      link: { flags: { value: ["url", "tls-cert", "lane"], bool: ["no-qr"] },
        lines: [["[--url URL] [--tls-cert F] [--lane S] [--no-qr]", "print a QR and link for phone-initiated pairing (default http://127.0.0.1:5002); owner's terminal only"]], run: cmdRemote },
      devices: { lines: [["", "the paired devices: id, name, person, lanes, when paired, revoked"]], run: cmdRemote },
      revoke: { lines: [["<device-id>", "the device's token and key stop working at once (its open stream ends too)"]], run: cmdRemote },
      serve: { flags: { value: ["host", "port", "tls-cert", "tls-key"] },
        lines: [["[--host 127.0.0.1] [--port 5002] [--tls-cert F --tls-key F]", "serve the remote API to paired devices; a host other than loopback needs TLS\n(or keep loopback and publish it with tailscale serve)"]], run: cmdRemote },
    } },
  { name: "tune", section: 7, lines: [["", "measure the last 24 h and record the tuning decision (the dispatcher runs it hourly)"]], run: () => out(tune()) },

  { name: "publish", section: 8, lines: [["<slug>", "the publish commands, once the final and publish gates are approved and the package is filed"]], run: cmdPublish },
];

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

/** Every flag any command or subcommand declares: a value flag never takes one of these words as its value
 *  (`advance l1 --note --bg` forgot the note), while any other word, `--verbose test passes` included, is the value. */
const FLAG_WORDS: ReadonlySet<string> = new Set(
  COMMANDS.flatMap((c) => [c.flags, ...Object.values(c.subs ?? {}).map((s) => s.flags)])
    .flatMap((f) => [...(withHelp(f).bool ?? []), ...(f?.value ?? []), ...(f?.multi ?? [])]),
);

async function main(argv: string[]): Promise<void> {
  const name = argv[0];
  if (name === undefined || name === "-h" || name === "--help") return void out(HELP);
  if (name.startsWith("--")) fail(`the command comes first: govern <command> [<args>] [--flags] (got ${name} first; govern help)`);
  const c = byName.get(name) ?? unknownCommand(name);
  let entry: { flags?: FlagSpec; run?: (a: Args) => void | Promise<void> } = c, label = c.name, sub: string | undefined, rest = argv.slice(1);
  const lead = [name];
  if (c.subs) {
    const word = argv[1];
    const given = word !== undefined && !word.startsWith("--");
    if (!given && word === "--help" && argv.length === 2) return void out(commandHelp(c.name));
    sub = given ? word : c.defaultSub;
    const named = sub && Object.hasOwn(c.subs, sub) ? c.subs[sub] : undefined;
    if (!named) fail(c.noSub ?? `govern ${c.name} ${Object.keys(c.subs).join("|")}`);
    entry = named;
    label = `${c.name} ${sub}`;
    if (given) { rest = argv.slice(2); lead.push(word); }
  }
  const a = parseArgs(rest, withHelp(entry.flags), label, FLAG_WORDS);
  if (flag(a, "help")) return void out(commandHelp(c.name, sub));
  a._.unshift(...lead);
  const mutations = new Set(['new','note','approve','reject','data','human','advance','cmd','file','dep','check','event','alerts','subprocess','recover']);
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

