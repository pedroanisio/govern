import { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const GOVERN = join(HERE, "..", "govern.ts");
export const FAKE = join(HERE, "fake-codex.ts");
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

/** A throwaway repo: PALS-Notes/projects, packages, a WORKFLOW.md with the stage table, empty transcript dirs, and a
 *  HOME (with XDG dirs) of its own, so nothing reads or writes the developer's ~/.claude, ~/.codex or ~/.config. */
export function makeEnv(): Env {
  const root = tempDir("test");
  const projects = join(root, "PALS-Notes", "projects");
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(root, "PALS-Notes", "packages"), { recursive: true });
  const wf = join(root, "WORKFLOW.md");
  writeFileSync(wf, "| # | Stage | Use | Exit when |\n|---|---|---|---|\n| 1 | Plan | x | the subject passes the [depth test](a.md) |\n| 2 | Script | x | a timed screenplay; no *not verified* row |\n");
  for (const d of ["claude"]) mkdirSync(join(root, d), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const fakeBin = join(root, "fake-codex.sh");
  writeFileSync(fakeBin, `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${FAKE} "$@"\n`, { mode: 0o755 });
  return {
    root, projects,
    env: {
      GOVERN_REPO: root, GOVERN_PROJECTS: projects, GOVERN_WORKFLOW: wf, GOVERN_CODEX_BIN: fakeBin,
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

/** The parent's environment without any GOVERN_* and without the compaction window: those come from the test, never
 *  from the session running it (Claude Code exports its settings env). */
export function parentEnv(): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_AUTO_COMPACT_WINDOW: _, ...inherited } = process.env;
  for (const k of Object.keys(inherited)) if (k.startsWith("GOVERN_") || k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || AGENT_MARKERS.includes(k)) delete inherited[k];
  return inherited;
}

/** The variables a Codex shell carries (lib/approval.ts): never inherited from the session running the tests. */
const AGENT_MARKERS = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_SANDBOX"];

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

export function govern(e: Env, args: string[], env: Record<string, string> = {}, input?: string) {
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
