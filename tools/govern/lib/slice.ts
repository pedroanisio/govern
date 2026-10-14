// Recipe jobs (`govern slice <lane> <recipe>`): one job that starts machines of a resource under a tag, splits a piece of
// work into named pieces, lets one worker loop per machine claim and run them, joins and verifies the result, and brings
// the machines down whatever happened. The recipe is declared in the lane's process (lib/process.ts); govern does not pick
// a provider, move work between resources or keep machines warm: the resource's own start/stop commands do the provider's
// part, and the pieces are plain commands (no model in the loop).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, readJson, writeJson, GovernError } from "./util.ts";
import { load, governDir, type Project } from "./project.ts";
import { processOf, type Recipe } from "./process.ts";
import { place } from "./resources.ts";
import * as jobs from "./jobs.ts";
import * as reaping from "./reap.ts";

const RUNNER = fileURLToPath(new URL("./sliceRunner.ts", import.meta.url));
export const jobName = (recipe: string) => `slice-${recipe}`;

/** The piece names a split may print: the same characters as any govern name, so a name is one path part and never `..`. */
const SAFE_PIECE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What a running slice writes beside its job (job folder/slice.json) for the desk and the job's ledger line. */
export interface Progress { recipe: string; machines: number; phase: string; tag?: string; total: number; done: number; failed: number; up: number; downFailed?: string[] }

function recipeOf(p: Project, name: string): Recipe {
  const all = processOf(p).recipes ?? {};
  return Object.hasOwn(all, name) ? all[name]! : fail(`${p.slug}: no recipe "${name}" in process ${processOf(p).name} (have: ${Object.keys(all).join(", ") || "none"})`);
}

/** `govern slice`: check everything that can be refused (recipe, machine count, resource, allowance) and start the runner as
 *  an ordinary job, which reserves machines x estimate before anything runs. */
export function start(slug: string, recipeName: string, o: { machines?: number; estimate?: number; bg: boolean }): jobs.JobState {
  const p = load(slug);
  const r = recipeOf(p, recipeName);
  const machines = o.machines ?? r.machines;
  const res = place(p.slug, r.resource, undefined)!;
  if (res.allowance?.maxMachines !== undefined && machines > res.allowance.maxMachines)
    fail(`refused: ${p.slug}/${recipeName} asks for ${machines} machines, ${res.name} allows at most ${res.allowance.maxMachines} machines (allowance maxMachines)`, 1);
  if (!res.commands?.start || !res.commands.stop) fail(`${res.name} needs a start and a stop command to run a recipe (govern.config.json: resources[].commands)`);
  const name = jobName(recipeName);
  const argv = [process.execPath, "--disable-warning=ExperimentalWarning", RUNNER, p.slug, recipeName, String(machines),
    String(r.timeout ?? (o.estimate !== undefined ? o.estimate * 3600 : jobs.DEFAULT_TIMEOUT))];
  const derived: Project = { ...p, commands: { ...p.commands, [name]: { argv, resource: r.resource, ...(r.timeout ? { timeout: r.timeout } : {}) } } };
  return jobs.start(derived, name, [], o.bg, undefined, o.estimate, false, { recipe: recipeName, machines });
}

// ---- the runner (the job's process)

const log = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");

/** What a piece's file in todo/ and doing/ holds: tries so far, and the machines (by id) that had it. */
interface PieceState { attempts: number; tried: string[] }

/** Runs the recipe inside the job (GOVERN_JOB_DIR): returns the exit code. `deadline` is the seconds the work may take
 *  (pieces included, down not): at that time the pieces are stopped and nothing more is run but `down`. The machines are
 *  brought down in every case, including a failed step, a piece list that is refused, a worker that throws, a deadline,
 *  and a stop (SIGTERM/SIGINT/SIGHUP) while pieces run. */
export async function runSlice(slug: string, recipeName: string, machines: number, deadline: number = jobs.DEFAULT_TIMEOUT): Promise<number> {
  const p = load(slug), recipe = recipeOf(p, recipeName);
  const jobDir = process.env["GOVERN_JOB_DIR"] ?? fail("govern slice runs inside a job (GOVERN_JOB_DIR is not set)");
  const pieces = join(jobDir, "pieces"), out = join(jobDir, "out");
  for (const d of ["todo", "doing", "done", "failed", "log"]) mkdirSync(join(pieces, d), { recursive: true });
  mkdirSync(out, { recursive: true });
  // Where a stop finds the runner: it is sent SIGTERM alone while it brings the machines down (jobs.stop).
  writeFileSync(join(jobDir, "runner.pid"), `${process.pid}\n`);
  const prog: Progress = { recipe: recipeName, machines, phase: "prepare", total: 0, done: 0, failed: 0, up: 0 };
  const save = (phase?: string) => { if (phase) prog.phase = phase; writeJson(join(jobDir, "slice.json"), prog); };
  save();

  let aborted = false, timedOut = false, signalled = false, inflight = 0;
  const active = new Set<ChildProcess>();
  const waiters: (() => void)[] = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  /** Every command runs in a group of its own (detached), so a signal reaches what it started too. */
  const signalGroup = (c: ChildProcess, sig: NodeJS.Signals) => {
    try { process.kill(-c.pid!, sig); } catch { try { c.kill(sig); } catch { /* already gone */ } }
  };
  const abort = () => { aborted = true; for (const c of active) signalGroup(c, "SIGTERM"); wake(); };
  const onStop = () => { signalled = true; abort(); };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, onStop);
  const timer = setTimeout(() => { timedOut = true; log(`timed out after ${deadline}s: stopping the pieces`); abort(); }, deadline * 1000);

  const expand = (argv: string[], v: Record<string, string> = {}) => jobs.expand(p, argv).map((a) =>
    a.replace(/\{(piece|pieces|tag|id|out)\}/g, (_, k: string) => ({ pieces, out, tag: prog.tag ?? "", ...v })[k] ?? ""));
  /** Runs one command; resolves with its exit code (null: killed by a signal) and stdout when asked for. */
  const run = (argv: string[], v: Record<string, string>, o: { capture?: boolean; log?: string; timeout?: number } = {}) => new Promise<{ code: number | null; stdout: string }>((done) => {
    const [cmd, ...rest] = expand(argv, v);
    const stdio: ("ignore" | "pipe" | "inherit" | number)[] = ["ignore", o.capture ? "pipe" : "inherit", "inherit"];
    const env = { ...process.env, GOVERN_PIECES: pieces, GOVERN_OUT: out, GOVERN_TAG: prog.tag ?? "", ...(v["piece"] ? { GOVERN_PIECE: v["piece"] } : {}), ...(v["id"] ? { GOVERN_ID: v["id"] } : {}) };
    let child: ChildProcess;
    const fd = o.log ? openSync(o.log, "a") : undefined;
    try {
      if (fd !== undefined) { stdio[1] = fd; stdio[2] = fd; }
      child = spawn(cmd!, rest, { cwd: join(governDir(slug), ".."), stdio, env, detached: true });
    } finally { if (fd !== undefined) closeSync(fd); }
    active.add(child);
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    const limit = o.timeout ? setTimeout(() => signalGroup(child, "SIGKILL"), o.timeout * 1000) : undefined;
    const end = (code: number | null) => { clearTimeout(limit); active.delete(child); done({ code, stdout }); };
    child.on("error", (e) => { log(`could not run ${cmd}: ${e.message}`); end(127); });
    child.on("close", end);
    // The slice was stopped between the check and the spawn: this one must not outlive it.
    if (aborted) signalGroup(child, "SIGTERM");
  });
  const step = async (name: keyof Recipe & string, capture = false) => {
    if (aborted) throw new GovernError(`${name} not run: the slice was stopped`, 1);
    save(name);
    log(`${name}: ${(recipe[name as "split"] as string[]).join(" ")}`);
    const r = await run(recipe[name as "split"] as string[], {}, { capture });
    if (r.code !== 0) throw new GovernError(`${name} failed (${r.code === null ? "killed" : `exit ${r.code}`})`, 1);
    return r.stdout;
  };

  let code = 0;
  try {
    if (recipe.prepare) await step("prepare");
    save("up");
    // The tag is saved the moment up has one: an up that fails after start has run still leaves it for down.
    const { rec, problem } = reaping.up(recipe.resource, { lane: slug, count: machines, timeout: jobs.SLICE_STOP_SECONDS, onTag: (tag) => { prog.tag = tag; save(); } });
    prog.up = rec.ids.length; save();
    if (problem) throw new GovernError(problem, 1);
    if (aborted) throw new GovernError("stopped", 1);
    const names = parsePieces(await step("split", true));
    prog.total = names.length; save();
    log(`${names.length} pieces over ${machines} machines`);
    for (const n of names) writeJson(join(pieces, "todo", n), { attempts: 0, tried: [] } satisfies PieceState);
    save("pieces");
    const ended = await Promise.allSettled(rec.ids.map((id, i) => worker(id, i, rec.ids).catch((e: unknown) => {
      log(`the worker of machine ${id} failed: ${(e as Error).message}: stopping the other pieces`);
      abort();
      throw e;
    })));
    const broke = ended.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (broke) throw new GovernError(`a worker failed: ${(broke.reason as Error).message}`, 1);
    if (aborted) throw new GovernError(timedOut ? `timed out after ${deadline}s with ${prog.done} of ${prog.total} pieces done: join and verify not run` : "stopped before every piece was done", 1);
    if (prog.failed) throw new GovernError(`${prog.failed} of ${prog.total} pieces failed after ${recipe.attempts ?? 2} attempts (${readdirSync(join(pieces, "failed")).sort().join(", ")}): join and verify not run`, 1);
    await step("join");
    await step("verify");
  } catch (e) {
    log(`slice ${recipeName} failed: ${(e as Error).message}`);
    code = e instanceof GovernError ? e.code : 1;
  } finally {
    clearTimeout(timer);
    if (prog.tag) {
      save("down");
      try {
        const d = reaping.down(prog.tag, { timeout: jobs.SLICE_STOP_SECONDS, forget: false });
        if (d.lines.length) log(d.lines.join("\n"));
        if (d.problems.length) {
          prog.downFailed = d.problems;
          log(`machines NOT all brought down: ${d.problems.join("; ")}\ntag ${prog.tag} stays recorded: govern down ${prog.tag}, or govern reap`);
          code = code || 1;
        } else prog.up = 0;
      } catch (e) { prog.downFailed = [(e as Error).message]; log(`down failed: ${(e as Error).message} (tag ${prog.tag}: govern reap lists it)`); code = code || 1; }
    }
    save("ended");
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(s, onStop);
  }
  return timedOut ? 124 : signalled && code === 1 ? 143 : code;

  /** One machine's loop: claim the next piece by an atomic rename into doing/m<index>/ (the machine's id stays inside the
   *  piece's file, never in a path), run it, and file it by its exit. */
  async function worker(id: string, index: number, all: string[]): Promise<void> {
    const mine = join(pieces, "doing", `m${index}`);
    mkdirSync(mine, { recursive: true });
    for (;;) {
      if (aborted) return;
      const got = claim(id, mine, all);
      if (!got) {
        if (!inflight && !readdirSync(join(pieces, "todo")).length) return;
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      inflight++;
      busy.add(id);
      const { name, file } = got;
      const was = readJson<PieceState>(file);
      const attempts = was.attempts + 1;
      log(`piece ${name} on ${id} (attempt ${attempts})`);
      const r = await run(recipe.piece, { piece: name, id }, { log: join(pieces, "log", `${name}.log`), ...(recipe.pieceTimeout ? { timeout: recipe.pieceTimeout } : {}) });
      if (r.code === 0) { renameSync(file, join(pieces, "done", name)); prog.done++; }
      else if (aborted) renameSync(file, join(pieces, "todo", name));
      else {
        writeJson(file, { attempts, tried: [...was.tried, id] } satisfies PieceState);
        if (attempts >= (recipe.attempts ?? 2)) { renameSync(file, join(pieces, "failed", name)); prog.failed++; log(`piece ${name} failed for good (exit ${r.code})`); }
        else { renameSync(file, join(pieces, "todo", name)); log(`piece ${name} failed (exit ${r.code}), will be tried again`); }
      }
      busy.delete(id);
      inflight--;
      save();
      wake();
    }
  }
  /** The next piece for machine `id`, but not one that failed on this machine while another machine that has not tried it is idle. */
  function claim(id: string, mine: string, all: string[]): { name: string; file: string } | undefined {
    for (const name of readdirSync(join(pieces, "todo")).sort()) {
      const from = join(pieces, "todo", name);
      const tried = readJson<PieceState>(from).tried;
      if (tried.includes(id) && all.some((o) => o !== id && !tried.includes(o) && !busy.has(o))) continue;
      const file = join(mine, name);
      try { renameSync(from, file); return { name, file }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return undefined;
  }
}
const busy = new Set<string>();

/** The piece names a split printed, one per line: at least one, each one safe as a path part, none twice. */
export function parsePieces(stdout: string): string[] {
  const names = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!names.length) throw new GovernError("split printed no pieces", 1);
  const seen = new Set<string>();
  for (const n of names) {
    if (!SAFE_PIECE.test(n) || n.includes("..")) throw new GovernError(`piece name ${JSON.stringify(n)} is not safe: letters, digits, "." "_" "-", starting with a letter or digit, no ".." or "/"`, 1);
    if (seen.has(n)) throw new GovernError(`piece name ${JSON.stringify(n)} is printed twice`, 1);
    seen.add(n);
  }
  return names;
}

/** The desk's lines for the slices that are running: pieces done of the total, and machines up. */
export function deskLines(slugs: string[]): string[] {
  const L: string[] = [];
  for (const slug of slugs) {
    for (const id of jobs.list(slug)) {
      const f = join(resolve(governDir(slug), "jobs"), id, "slice.json");
      if (!existsSync(f) || jobs.state(slug, id).status !== "running") continue;
      try {
        const s = readJson<Progress>(f);
        L.push(`  slice ${slug}/${id} ${s.recipe}: ${s.done}/${s.total} pieces done${s.failed ? `, ${s.failed} failed` : ""}, ${s.up} machine${s.up === 1 ? "" : "s"} up (${s.phase})`);
      } catch { /* being written */ }
    }
  }
  return L;
}
