import { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as peer from "../ext/peer/peer.ts";
import * as mesh from "../ext/peer/mesh.ts";
import * as queue from "../lib/queue.ts";
import { registry, readCheck, checkState, checkFile, profileHash, capsOf } from "../lib/caps.ts";
import { writeJson } from "../lib/util.ts";
import { type Headers } from "../lib/peer-id.ts";
import { EXTENSION_NAMES } from "../lib/ext-registry.ts";
import type { Cmd } from "../lib/cli.ts";

/** The whole command table: the core's and every extension's commands (the table the core alone held before the extensions). */
export async function fullTable(): Promise<readonly Cmd[]> {
  const { COMMANDS } = await import("../govern.ts");
  const exts = await Promise.all(EXTENSION_NAMES.map((n) => import(`../ext/${n}/index.ts`) as Promise<{ commands: Cmd[] }>));
  return [...COMMANDS, ...exts.flatMap((x) => x.commands)];
}

export const HERE = dirname(fileURLToPath(import.meta.url));
export const GOVERN = join(HERE, "..", "govern.ts");
export const FAKE = join(HERE, "fake-codex.ts");
export const FAKE_GROK = join(HERE, "fake-grok.ts");
export const fixture = (name: string) => join(HERE, "fixtures", name);

export interface Env { root: string; projects: string; env: { HOME: string; [name: string]: string } }

/** `v`, which the test relies on being there: an index, match group or lookup that came back empty fails the test here,
 *  naming `what`, rather than as a TypeError further on. */
export function present<T>(v: T | undefined, what: string): T {
  if (v === undefined) assert.fail(`expected ${what}, got undefined`);
  return v;
}

// Every dir makeEnv or tempDir creates is removed when its test file finishes (a root-level hook of the file importing this).
const roots: string[] = [];
after(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 3 }); });

/** A fresh dir under the system temp dir (govern-<name>-XXXXXX), removed when the test file finishes. */
export function tempDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `govern-${name}-`));
  roots.push(d);
  return d;
}

/** Runs once, before any test of a file importing this module: the test process itself gets a throwaway workspace,
 *  HOME and working directory, so code run in-process and any child resolve to a temp folder even when they set nothing.
 *  Whatever GOVERN_* a shell or a service exported is dropped first (GOVERN_TEST_* is the suite's own input), and GOVERN_CEILING keeps a search for a workspace
 *  from leaving the temp folder when that folder sits inside a real workspace. */
function isolate(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("GOVERN_") && !k.startsWith("GOVERN_TEST_")) delete process.env[k];
  process.env.GOVERN_CEILING = tmpdir();
  const root = tempDir("sandbox"), home = join(root, "home"), projects = join(root, "projects");
  mkdirSync(home); mkdirSync(projects);
  writeFileSync(join(root, "govern.config.json"), JSON.stringify({ projects: "projects", queue: "queue", processes: "processes", state: "state" }));
  Object.assign(process.env, {
    GOVERN_REPO: root, GOVERN_CLAUDE_PROJECTS: join(root, "claude"), GOVERN_CODEX_SESSIONS: join(root, "codex-sessions"),
    GOVERN_SESSIONS_DIR: join(home, ".claude", "sessions"), GOVERN_CLAUDE_SETTINGS: join(home, ".claude", "settings.json"),
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
  });
  process.chdir(root);
}
isolate();

/** A throwaway repo: PALS-Notes/projects, packages, a WORKFLOW.md with the stage table, empty transcript dirs, and a
 *  HOME (with XDG dirs) of its own, so nothing reads or writes the developer's ~/.claude, ~/.codex or ~/.config. */
export function makeEnv(name = "test"): Env {
  const root = tempDir(name);
  const projects = join(root, "PALS-Notes", "projects");
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(root, "PALS-Notes", "packages"), { recursive: true });
  const wf = join(root, "WORKFLOW.md");
  writeFileSync(wf, "| # | Stage | Use | Exit when |\n|---|---|---|---|\n| 1 | Plan | x | the subject passes the [depth test](a.md) |\n| 2 | Script | x | a timed screenplay; no *not verified* row |\n");
  for (const d of ["claude"]) mkdirSync(join(root, d), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // the workspace's govern.config.json: where the lanes, the queue, the packages and the video process's tools live
  writeFileSync(join(root, "govern.config.json"), JSON.stringify({
    projects: "PALS-Notes/projects", queue: "PALS-Notes/queue", processes: "PALS-Notes/processes", packages: "PALS-Notes/packages", workflow: "WORKFLOW.md",
    tuningLog: "PALS-Notes/costs/tuning.jsonl", paths: { filmBuild: "film_build.py" },
    baseline: { mainMedianCtx: 468000, subagentMedianCtx: 202000, source: "test baseline" },
  }));
  const fakeBin = join(root, "fake-codex.sh");
  writeFileSync(fakeBin, `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${FAKE} "$@"\n`, { mode: 0o755 });
  // The fake grok: a test never reaches the real binary, whatever is on PATH.
  const fakeGrok = join(root, "fake-grok.sh");
  writeFileSync(fakeGrok, `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${FAKE_GROK} "$@"\n`, { mode: 0o755 });
  return {
    root, projects,
    env: {
      GOVERN_REPO: root, GOVERN_PROJECTS: projects, GOVERN_WORKFLOW: wf, GOVERN_CODEX_BIN: fakeBin,
      GOVERN_EXTENSIONS: EXTENSION_NAMES.join(","), // every subsystem test runs with every extension enabled; test/ext.test.ts runs without

      GOVERN_GROK_BIN: fakeGrok, GOVERN_GROK_SESSIONS: join(root, "grok-sessions"), FAKE_GROK_ARGV_OUT: join(root, "grok.log"),
      GOVERN_CLAUDE_PROJECTS: join(root, "claude"), GOVERN_CODEX_SESSIONS: join(root, "codex-sessions"),
      FAKE_CODEX_ARGV_OUT: join(root, "argv.log"), FAKE_CODEX_STDIN_OUT: join(root, "stdin.log"), FAKE_CODEX_COUNTER: join(root, "count"),
      CLAUDE_CODE_SESSION_ID: "",
      GOVERN_AS: "owner", // the sender of a test's `task send`, never the session running the tests
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
      GOVERN_SESSIONS_DIR: join(home, ".claude", "sessions"), GOVERN_CLAUDE_SETTINGS: join(home, ".claude", "settings.json"),
    },
  };
}

/** The parent's environment without any GOVERN_* (GOVERN_CEILING stays: see isolate) and without the compaction window:
 *  those come from the test, never from the session running it (Claude Code exports its settings env). */
export function parentEnv(): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_AUTO_COMPACT_WINDOW: _, ...inherited } = process.env;
  for (const k of Object.keys(inherited)) if ((k.startsWith("GOVERN_") && k !== "GOVERN_CEILING") || k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || AGENT_MARKERS.includes(k)) delete inherited[k];
  return inherited;
}

/** The variables a Codex shell carries (lib/approval.ts): never inherited from the session running the tests. */
const AGENT_MARKERS = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_SANDBOX", "GROK_AGENT", "GROK_SESSION_ID"];

/** Run the next govern calls of this Env as a registered Claude Code session: the test process (every govern child's
 *  parent) is entered in the registry with `sessionId`, and `lines` become that session's transcript. Without a call to
 *  this, a test's approvals come from a plain terminal. */
export function asSession(e: Env, sessionId: string, lines: unknown[] = [], project = "proj"): string {
  write(join(present(e.env.GOVERN_SESSIONS_DIR, "GOVERN_SESSIONS_DIR"), `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, name: "tester", cwd: e.root }));
  return write(join(e.root, "claude", project, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
/** A transcript line for a message the person typed. */
export const typed = (text: string | unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: "user", uuid: `u-${Math.abs(hash(JSON.stringify(text)))}`, timestamp: "2026-10-14T09:00:00.000Z", origin: { kind: "human" }, message: { role: "user", content: text }, ...extra });
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/** A govern child's environment: parentEnv(), then the test's own, then the call's. */
export function childEnv(e: Env, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = { ...parentEnv(), ...e.env, ...env };
  if (!base.CLAUDE_CODE_SESSION_ID) delete base.CLAUDE_CODE_SESSION_ID;
  return base;
}

/** The dispatcher runs a profile only after a passing self-test of its current definition (it runs the check itself when there is none, with the
 *  fake binaries the tests use, which cannot answer probes). Tests that exercise something else give every "optional" profile that has no
 *  record a passing one first, in the workspace of process.env. A test of the self-test itself sets GOVERN_TEST_UNCHECKED=1 in its Env. */
export function seedChecks(): void {
  if (process.env.GOVERN_TEST_UNCHECKED) return;
  try {
    const reg = registry(), q = queue.QUEUE();
    for (const p of reg.profiles.values()) {
      const rec = readCheck(q, p.name), hash = profileHash(reg, p);
      if (p.selfTest !== "optional" || rec === "unreadable" || checkState(rec, hash) !== "none") continue;
      writeJson(checkFile(q, p.name), { version: 1, profile: p.name, hash, at: "2026-10-16T00:00:00.000Z", model: "seeded", ok: true, results: capsOf(reg, p).map((c) => ({ capability: c.name, status: "ok", evidence: "seeded by the test helper" })) });
    }
  } catch { /* no workspace or a broken capabilities folder: the dispatcher reports it */ }
}

export function govern(e: Env, args: string[], env: Record<string, string> = {}, input?: string) {
  if (args[0] === "task" && args[1] === "dispatch") {
    const back = process.env;
    process.env = childEnv(e, env);
    try { seedChecks(); } finally { process.env = back; }
  }
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, ...args], { env: childEnv(e, env), encoding: "utf8", timeout: 60000, ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export const jsonl = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
export const write = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); return p; };
export const reply = (e: Env, name: string, value: unknown, usage = { input_tokens: 20000, cached_input_tokens: 12000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 0 }) =>
  write(join(e.root, `${name}.jsonl`), [
    { type: "thread.started", thread_id: "t-1" }, { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: typeof value === "string" ? value : JSON.stringify(value) } },
    { type: "turn.completed", usage },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");

/** Merges keys into the workspace config makeEnv wrote, so projects, queue and the rest survive. */
export function setConfig(e: Env, keys: Record<string, unknown>): void {
  const f = join(e.root, "govern.config.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...keys }));
}

/** `govern peer serve` for workspace `e` on a free loopback port: its URL, and a stop that waits for the exit. */
export async function servePeer(e: Env) {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "peer", "serve", "--port", String(port)], { env: childEnv(e), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.stdout.on("data", () => { if (output.includes("http://127.0.0.1:")) done(); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
      child.once("error", reject);
    });
  } catch (e) { child.kill(); throw e; }
  return { url: `http://127.0.0.1:${port}`, stop: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const end = once(child, "exit"); child.kill(); await end; } };
}

// An in-process federation: each origin is a host's workspace, and a POST runs that host's route there.
export const NOW = Date.parse("2026-10-15T12:00:00.000Z"), DAY = 86400_000;
export const use = (e: Env) => { process.env = childEnv(e); };
export const lower = (h: Headers = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
export const ROUTES: Record<string, (b: Buffer, h: Headers, now: number) => peer.Response> = {
  "/v1/peer/deliver": peer.receive, "/v1/peer/directory": peer.serveDirectory, "/v1/peer/telemetry": peer.serveTelemetry, "/v1/peer/lanes": peer.serveLanes, "/v1/peer/process": peer.serveProcess, "/v1/mesh/join": mesh.serveJoin, "/v1/mesh/sync": mesh.serveSync,
};
/** An in-process network: each origin is a host's workspace; a call runs the route there at `clock()`. */
export function network(hosts: Record<string, Env>, clock = () => NOW, tap?: (u: string, b: Buffer, h: Headers) => void): peer.Post {
  return async (u, bytes, headers) => {
    tap?.(u, bytes, headers);
    const { origin, pathname } = new URL(u), host = hosts[origin], back = process.env;
    if (!host) throw new Error(`no host at ${origin}`);
    use(host);
    try { const r = ROUTES[pathname]!(bytes, lower(headers), clock()); return { status: r.status, text: r.bytes ? r.bytes.toString() : JSON.stringify(r.body), headers: lower(r.headers) }; }
    finally { process.env = back; }
  };
}
export const policy = (allow: string[] = ["codex"], projects = ["p"]) => ({ allow, projects });
/** Hosts a (registrar), b and c, each joined with one invite; b synced after c joined so every host knows every other. */
export async function trio() {
  const a = makeEnv("mesh-a"), b = makeEnv("mesh-b"), c = makeEnv("mesh-c");
  const hosts = { "https://a.example": a, "https://b.example": b, "https://c.example": c }, post = network(hosts);
  for (const [e, n] of [[a, "a"], [b, "b"], [c, "c"]] as const) { use(e); peer.identity(n); }
  use(a); mesh.create({ name: "lab", url: "https://a.example", policy: policy(), now: NOW });
  for (const [e, u] of [[b, "https://b.example"], [c, "https://c.example"]] as const) {
    use(a); const { code } = mesh.invite({ now: NOW });
    use(e); await mesh.join(code, { url: u, policy: policy(), post, now: () => NOW });
  }
  use(b); await mesh.sync({ post, now: () => NOW });
  return { a, b, c, hosts, post };
}
export const task = (to: string, extra: Partial<queue.Message> = {}) => { seedChecks(); return queue.send({ project: "p", task: "t", kind: "TASK", from: "alice", to, summary: "check this", body: "evidence", files: [], access: "read-only", ...extra }); };

