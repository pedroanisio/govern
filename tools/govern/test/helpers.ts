import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const GOVERN = join(HERE, "..", "govern.ts");
export const FAKE = join(HERE, "fake-codex.ts");
export const fixture = (name: string) => join(HERE, "fixtures", name);

export interface Env { root: string; projects: string; env: Record<string, string> }

/** A throwaway repo: PALS-Notes/projects, packages, a WORKFLOW.md with the stage table, empty transcript dirs. */
export function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "govern-test-"));
  const projects = join(root, "PALS-Notes", "projects");
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(root, "PALS-Notes", "packages"), { recursive: true });
  const wf = join(root, "WORKFLOW.md");
  writeFileSync(wf, "| # | Stage | Use | Exit when |\n|---|---|---|---|\n| 1 | Plan | x | the subject passes the [depth test](a.md) |\n| 2 | Script | x | a timed screenplay; no *not verified* row |\n");
  for (const d of ["claude"]) mkdirSync(join(root, d), { recursive: true });
  const fakeBin = join(root, "fake-codex.sh");
  writeFileSync(fakeBin, `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${FAKE} "$@"\n`, { mode: 0o755 });
  return {
    root, projects,
    env: {
      GOVERN_REPO: root, GOVERN_PROJECTS: projects, GOVERN_WORKFLOW: wf, GOVERN_CODEX_BIN: fakeBin,
      GOVERN_CLAUDE_PROJECTS: join(root, "claude"), GOVERN_CODEX_SESSIONS: join(root, "codex-sessions"),
      FAKE_CODEX_ARGV_OUT: join(root, "argv.log"), FAKE_CODEX_STDIN_OUT: join(root, "stdin.log"), FAKE_CODEX_COUNTER: join(root, "count"),
      CLAUDE_CODE_SESSION_ID: "",
    },
  };
}

export function govern(e: Env, args: string[], env: Record<string, string> = {}) {
  // The compaction window comes from the test, never from the session running it (Claude Code exports its settings env).
  const { CLAUDE_CODE_AUTO_COMPACT_WINDOW: _, ...inherited } = process.env;
  const base = { ...inherited, ...e.env, ...env };
  if (!base.CLAUDE_CODE_SESSION_ID) delete base.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, ...args], { env: base, encoding: "utf8", timeout: 60000 });
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
