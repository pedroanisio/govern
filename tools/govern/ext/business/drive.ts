// govern drive: runs the stages a process gives to an agent. When such a stage is active, its task goes through the queue
// to the declared runner or profile (the dispatcher runs it, sealed to the profile); the agent's reply is consumed here:
// a BLOCKED, unverified or invalid reply is retried with its reason up to the stage's attempts, then left to the
// operator; a valid one has its body parsed as the stage's typed outputs (case fields, unknown ones refused), applied,
// and the stage advanced through `govern advance`, so its exit check, gates and dependencies decide as for anyone.
//
// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as queue from "../../lib/queue.ts";
import { load, save, laneSlugs, ledgerFile, appendLedger, type Project } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { activeStages, setData, gateApproved } from "../../lib/business.ts";
import { transaction } from "../../lib/lifecycle.ts";
import { stateDir } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { fail, readJsonl } from "../../lib/util.ts";
import type { AgentDef } from "../../lib/business-schema.ts";
import type { Value } from "../../lib/business-schema.ts";

/** The queue name the driver sends as and reads replies for. */
export const DRIVER = "govern-drive";
/** Reply kinds that can finish a stage; any other (BLOCKED, PROGRESS, NOTICE) cannot. */
const FINISHING = new Set(["HANDOFF", "ACK", "REVIEW", "DECISION"]);
const GOVERN_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "govern.ts");

/** The driver's record of one agent stage of one lane: the task in flight, which entry of the stage it is for (the number
 *  of advances out of the stage before it), which attempt, and whether it is waiting, done or failed. */
export interface Run { task: string; round: number; attempt: number; state: "sent" | "done" | "failed"; reason?: string }
export interface DriveReport { lines: string[]; failed: string[] }

const dir = () => join(stateDir(), "drive");
const file = () => join(dir(), "state.json");
function readRuns(): Record<string, Run> {
  if (!existsSync(file())) return {};
  try { return JSON.parse(readFileSync(file(), "utf8")) as Record<string, Run>; } catch (e) { return fail(`${file()} is not valid JSON (${(e as Error).message})`, 1); }
}
function writeRuns(runs: Record<string, Run>): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(runs, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file());
}

/** How many times the lane has advanced out of `stage`: a new entry into the stage has a higher round than the last task. */
const roundOf = (slug: string, stage: string): number => readJsonl(ledgerFile(slug)).filter((e) => e.kind === "advance" && e.from === stage).length;

/** `text` with {lane}, {stage}, {title} and {data.FIELD} filled from the case (a missing field reads "(none)"). */
export function render(text: string, p: Project, stage: string): string {
  return text.replace(/\{(lane|stage|title|data\.([A-Za-z0-9_-]+))\}/g, (_m, w: string, field?: string) => {
    if (w === "lane") return p.slug;
    if (w === "stage") return stage;
    if (w === "title") return p.title;
    const v = p.data?.[field!];
    return v === undefined ? "(none)" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** The reply body as the stage's outputs: a JSON object whose keys are all declared outputs. Fails naming what is wrong. */
export function outputsOf(body: string, outputs: readonly string[]): Record<string, Value> {
  if (!outputs.length) return {};
  let v: unknown;
  try { v = JSON.parse(body); } catch { return fail("the reply body is not a JSON object"); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("the reply body is not a JSON object");
  for (const k of Object.keys(v as object)) if (!outputs.includes(k)) fail(`${k} is not an output of this stage (outputs: ${outputs.join(", ")})`);
  return v as Record<string, Value>;
}

function send(p: Project, stage: string, a: AgentDef, round: number, attempt: number, previous?: string): Run {
  const t = queue.resolveTarget(a.to, { write: a.write === true, ...(a.profile ? { profile: a.profile } : {}) });
  const body = render(a.body, p, stage) + (previous ? `\n\nThe previous attempt failed: ${previous}\nCorrect that and answer again.` : "");
  const m = queue.send({ project: p.slug, task: a.task, kind: "TASK", from: DRIVER, to: a.to, summary: render(a.summary, p, stage), body,
    files: a.files ?? [], access: t.access, ...(t.profile ? { profile: t.profile } : {}), lane: p.slug,
    ...(a.check ? { check: a.check } : {}), ...(a.verify ? { verify: a.verify } : {}), ...(a.timeout ? { timeoutSec: a.timeout } : {}) });
  appendLedger(p.slug, { kind: "drive-sent", stage, task: m.id, attempt, ...(previous ? { previous } : {}) });
  return { task: m.id, round, attempt, state: "sent" };
}

/** A govern command as its own process (check, advance, run): the same rules, locks and ledger as at a terminal. */
function governRun(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN_TS, ...args],
    { encoding: "utf8", env: { ...process.env, ...env }, timeout: 35 * 60_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const tail = (text: string) => text.split("\n").slice(-12).join("\n");

/** What finishing a stage came to: advanced; a failure the agent or command may fix (retry); or one only the operator can. */
type Outcome = { advanced: true } | { retry: string } | { fail: string };

/** Apply `data` to the lane, run the stage's check, and advance the stage. */
function finish(slug: string, stage: string, data: Record<string, Value>, note: string, source: Record<string, unknown>): Outcome {
  try {
    if (Object.keys(data).length) transaction(slug, () => { const q = load(slug); setData(q, data); save(q); });
  } catch (e) { return { retry: `the data is refused: ${(e as Error).message}` }; }
  if (Object.keys(data).length) appendLedger(slug, { kind: "data", fields: Object.keys(data), by: DRIVER, ...source });
  const q = load(slug), on = q.workflow ? ["--stage", stage] : [];
  if (processOf(q).stages.find((s) => s.name === stage)?.check || q.checks?.[stage]) {
    const chk = governRun(["check", slug, ...on]);
    if (chk.code !== 0) return { retry: `the stage check failed: ${tail(chk.out)}` };
  }
  const adv = governRun(["advance", slug, ...on, "--note", note]);
  return adv.code === 0 ? { advanced: true } : { fail: `advance refused: ${adv.out}` };
}

/** Bring every active agent and service stage (of every lane, or of `lanes`) one step on. An agent stage: send its task
 *  once its gates are approved, wait for the reply, consume it. A service stage: run its command and read the outputs it
 *  wrote. One line per stage; `failed` names the stages left to the operator. */
export function drive(o: { lanes?: string[] } = {}): DriveReport {
  const report: DriveReport = { lines: [], failed: [] };
  mkdirSync(join(dir(), "outputs"), { recursive: true, mode: 0o700 });
  withLaneLock(join(dir(), "lock"), () => {
    const runs = readRuns();
    for (const slug of o.lanes ?? laneSlugs()) {
      let p: Project;
      try { p = load(slug); } catch (e) { report.lines.push(`${slug}: ${(e as Error).message}`); report.failed.push(slug); continue; }
      for (const stage of activeStages(p)) {
        const def = processOf(p).stages.find((s) => s.name === stage), a = def?.agent, svc = def?.service;
        const held = processOf(p).gates.filter((g) => g.stage === stage && !gateApproved(p, g)).map((g) => g.name);
        const waiting = () => report.lines.push(`${slug} ${stage}: waiting for the ${held.join(", ")} gate${held.length === 1 ? "" : "s"}`);
        if (!a && !svc) {
          // Not an agent's or a command's: advanced once its person has completed the task, its gates are approved and
          // its item cases or child case have finished. An event stage is `govern tick --advance`'s.
          if (!def || def.event) continue;
          if (def.human && !p.humanTasks?.[stage]?.completedAt) continue;
          if (held.length) { waiting(); continue; }
          if (def.call || def.foreach) {
            const sub = governRun(["subprocess", slug, stage]);
            if (sub.code !== 0) { report.lines.push(`${slug} ${stage}: not advanced: ${tail(sub.out)}`); report.failed.push(`${slug}:${stage}`); continue; }
            if (!/child complete/.test(sub.out)) { report.lines.push(`${slug} ${sub.out}`); continue; }
          }
          const adv = governRun(["advance", slug, ...(p.workflow ? ["--stage", stage] : []), "--note",
            def.human ? "the human task is completed" : def.call || def.foreach ? "its sub-cases finished" : "nothing to do but its gates and routes"]);
          report.lines.push(`${slug} ${stage}: ${adv.code === 0 ? "advanced" : `not advanced: ${tail(adv.out)}`}`);
          if (adv.code !== 0) report.failed.push(`${slug}:${stage}`);
          continue;
        }
        const key = `${slug}:${stage}`, round = roundOf(slug, stage), attempts = (a ?? svc)!.attempts ?? 1;
        const line = (s: string) => report.lines.push(`${slug} ${stage}: ${s}`);
        const failed = (run: Run, reason: string) => {
          runs[key] = { ...run, state: "failed", reason };
          appendLedger(slug, { kind: "drive-failed", stage, task: run.task, attempt: run.attempt, reason });
          line(`failed after ${run.attempt} attempt${run.attempt === 1 ? "" : "s"}: ${reason}`);
          report.failed.push(key);
        };
        let run = runs[key];
        if (run && run.round >= round && run.state === "failed") {
          line(`failed after ${run.attempt} attempt${run.attempt === 1 ? "" : "s"}: ${run.reason}`);
          report.failed.push(key);
          continue;
        }
        if (run && run.round >= round && run.state === "done") continue;
        if (svc) {
          if (held.length) { waiting(); continue; }
          if (!run || run.round < round) run = runs[key] = { task: `command ${svc.command}`, round, attempt: 1, state: "sent" };
          const retryOrFail = (reason: string) => {
            if (run!.attempt < attempts) { runs[key] = { ...run!, attempt: run!.attempt + 1 }; line(`retried (attempt ${run!.attempt + 1} of ${attempts}): ${reason}`); }
            else failed(run!, reason);
          };
          const outFile = join(dir(), "outputs", `${slug.replace(/\//g, "__")}--${stage}.json`);
          rmSync(outFile, { force: true });
          const r = governRun(["run", slug, svc.command], { GOVERN_OUTPUTS: outFile });
          if (r.code !== 0) { retryOrFail(`the command failed: ${tail(r.out)}`); continue; }
          let data: Record<string, Value> = {};
          if ((svc.outputs ?? []).length) {
            if (!existsSync(outFile)) { retryOrFail("the command wrote no outputs to $GOVERN_OUTPUTS"); continue; }
            try { data = outputsOf(readFileSync(outFile, "utf8"), svc.outputs!); } catch (e) { retryOrFail((e as Error).message); continue; }
          }
          const end = finish(slug, stage, data, `command ${svc.command}`, { command: svc.command });
          if ("advanced" in end) { runs[key] = { ...run, state: "done" }; line("advanced"); }
          else if ("retry" in end) retryOrFail(end.retry);
          else failed(run, end.fail);
          continue;
        }
        if (!run || run.round < round) {
          if (held.length) { waiting(); continue; }
          run = runs[key] = send(p, stage, a!, round, 1);
          line(`sent (${run.task})`);
          continue;
        }
        const retryOrFail = (reason: string) => {
          if (run!.attempt < attempts) {
            runs[key] = send(load(slug), stage, a!, round, run!.attempt + 1, reason);
            line(`retried (attempt ${run!.attempt + 1} of ${attempts}): ${reason}`);
          } else failed(run!, reason);
        };
        const task = queue.find(run.task);
        if (!task) { retryOrFail(`the task ${run.task} is no longer in the queue`); continue; }
        if (task.state === "failed") { retryOrFail(`the task failed: ${task.m.result?.error ?? task.m.result?.note ?? "no reason recorded"}`); continue; }
        const reply = queue.all().find((x) => x.state === "open" && x.m.replyTo === run!.task && x.m.to === DRIVER);
        if (!reply) { line(`waiting (${run.task})`); continue; }
        queue.close(reply.m.id, DRIVER, "consumed by govern drive");
        if (reply.m.verification?.state === "unverified") { retryOrFail(`the reply failed its content check (govern task show ${reply.m.id})`); continue; }
        if (reply.m.kind === "BLOCKED") { retryOrFail(`the agent is blocked: ${reply.m.body.trim() || reply.m.summary}`); continue; }
        if (!FINISHING.has(reply.m.kind)) { retryOrFail(`a ${reply.m.kind} reply does not finish the stage`); continue; }
        let data: Record<string, Value>;
        try { data = outputsOf(reply.m.body, a!.outputs ?? []); } catch (e) { retryOrFail((e as Error).message); continue; }
        const end = finish(slug, stage, data, `agent reply ${reply.m.id}`, { reply: reply.m.id });
        if ("advanced" in end) { runs[key] = { ...run, state: "done" }; line("advanced"); }
        else if ("retry" in end) retryOrFail(end.retry);
        else failed(run, end.fail);
      }
    }
    writeRuns(runs);
  });
  return report;
}
