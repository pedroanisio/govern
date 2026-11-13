import { gateApproved } from './business.ts';
// Capabilities and profiles: what a queued agent may do, named once, and the sealed command line each engine gets for it.
// A capability is one grant (Claude permission patterns, the Codex equivalent, a side-effect class, secret NAMES only). A
// profile is a list of capabilities plus an engine and model. Built-ins live in tools/govern/capabilities/*.json; a
// workspace adds or overrides its own in its capabilities folder (GOVERN_CAPABILITIES, else govern.config.json
// "capabilities", else a capabilities folder beside the lanes), like processes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, sha256 } from "./util.ts";
import { obj, arr, str, literal, check, reject, parseFile, record } from "./shape.ts";
import { load } from "./project.ts";
import { projectsDir, capabilitiesDir } from "./workspace.ts";
import { processOf } from "./process.ts";
import { CHECK, type CheckDef } from "./replycheck.ts";
import { CODEX_PARTIAL } from "./codexhome.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN = resolve(HERE, "..", "capabilities");

export const EFFECTS = ["read", "write", "spend", "publish", "push"] as const;
export type Effect = (typeof EFFECTS)[number];
/** Classes that act outside the task's folder: a profile holding one runs only for a lane whose gate of that name is approved. */
export const GUARDED: readonly Effect[] = ["spend", "publish", "push"];
/** Commands that push, publish or spend: an allow pattern that can run one must come with a capability of that guarded effect. */
export const GUARDED_COMMANDS: readonly { cmd: string; effect: Effect }[] = [
  { cmd: "git push", effect: "push" }, { cmd: "gh pr merge", effect: "push" },
  { cmd: "gh release create", effect: "publish" }, { cmd: "npm publish", effect: "publish" }, { cmd: "docker push", effect: "publish" },
  { cmd: "twine upload", effect: "publish" }, { cmd: "cargo publish", effect: "publish" },
  { cmd: "claude", effect: "spend" }, { cmd: "codex", effect: "spend" }, { cmd: "grok", effect: "spend" }, { cmd: "elevenlabs", effect: "spend" },
];
/** Why `allow` needs a guarded effect that `effect` does not declare (undefined: fine). Bare `Bash` or `Bash(*)` can run anything. */
export function guardedPatternProblem(allow: string, effect: Effect): string | undefined {
  const m = /^Bash(?:\((.*)\))?$/.exec(allow.trim());
  if (!m) return undefined;
  const x = (m[1] ?? "").replace(/:?\*$/, "").trim();
  const hit = GUARDED_COMMANDS.filter(({ cmd }) => x === cmd || cmd.startsWith(`${x} `) || x.startsWith(`${cmd} `) || x === "");
  if (!hit.length || hit.some((h) => h.effect === effect)) return undefined;
  return `its allow pattern "${allow}" can run ${hit.map((h) => h.cmd).join(", ")}; declare effect ${[...new Set(hit.map((h) => h.effect))].join(" or ")} (it says ${effect}) so the lane's gate applies`;
}
/** What Grok Build gets for a capability: `--tools` names (Claude-style names, as grok's headless mode takes them), `--allow` rules
 *  for the tools that need one under the permission mode, and the permission mode (default dontAsk: nothing prompts, an unlisted tool is refused). */
export interface GrokMap { tools: string[]; allow?: string[]; /** `--deny` rules: they win over every allow. */ deny?: string[]; permissionMode?: "acceptEdits" }
export interface CodexMap { sandbox?: "read-only" | "workspace-write"; config?: string[]; addDirs?: string[] }
/** What the self-test asks and what govern checks in the reply; `{nonce}` is replaced by the run's random text. */
export interface Probe { instruction: string; expect?: string; file?: { path: string; contains: string };
  /** An argv govern itself runs (with a timeout); its output must appear in the model's reply. */
  expectCmd?: string[] }
export interface Capability {
  name: string; description: string; call: string;
  claude: { allow: string[]; permissionMode?: "acceptEdits" };
  /** Absent: not available on codex. */
  codex?: CodexMap;
  /** Absent: not available on grok. */
  grok?: GrokMap;
  effect: Effect;
  resource?: string; cost?: string;
  /** Names of environment variables the capability needs, never values. */
  secrets: string[];
  /** The lane gate that must be approved (default: the class name), for a guarded class. */
  gate?: string;
  probe?: Probe;
  file: string;
}
export interface Profile {
  name: string; description: string; engine: "claude" | "codex" | "grok"; model?: string; capabilities: string[];
  /** Absolute path of the MCP config the sealed Claude session loads (none by default). */
  mcpConfig?: string;
  /** Whatever the value, the dispatcher runs a profile only after a self-test of its current definition passed (it runs the check itself when there is none).
   *  "optional" means only that a capability with no probe does not fail the check. */
  selfTest: "required" | "optional";
  /** The check run against this profile's queue replies (lib/replycheck.ts); it does not change what the profile may do, so it is not in the self-test hash. */
  check?: CheckDef;
  /** The named reply checks of the capabilities file that defines this profile (`checks` there); a sender picks one with `--check NAME`. */
  checks?: Record<string, CheckDef>;
  file: string;
}
/** The six profiles the fixed access levels (--to claude|codex|grok, with or without --write) became. */
export const LEGACY_PROFILES = ["claude-read", "claude-write", "codex-read", "codex-write", "grok-read", "grok-write"] as const;
const RESERVED = ["claude", "codex", "grok", "owner", "auto"];
const IDENT = /^[a-z0-9][a-z0-9.-]*$/;

const ident = (v: unknown, p: string): string => {
  if (typeof v !== "string" || !IDENT.test(v)) return reject(p, `must be lowercase letters, digits, dots and dashes (got ${JSON.stringify(v)})`);
  return v;
};
const secretName = (v: unknown, p: string): string => {
  if (typeof v !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(v)) return reject(p, "must be an environment variable NAME (like DEPLOY_TOKEN), never a value");
  return v;
};
const CODEX = obj({}, { sandbox: literal("read-only", "workspace-write"), config: arr(str), addDirs: arr(str) });
const GROK = obj({ tools: arr(str, { nonEmpty: true }) }, { allow: arr(str), deny: arr(str), permissionMode: literal("acceptEdits") });
const PROBE = obj({ instruction: str }, { expect: str, file: obj({ path: str, contains: str }), expectCmd: arr(str, { nonEmpty: true }) });
const CAP = obj(
  { name: ident, description: str, call: str, claude: obj({ allow: arr(str) }, { permissionMode: literal("acceptEdits") }), effect: literal(...EFFECTS) },
  { codex: CODEX, grok: GROK, resource: str, cost: str, secrets: arr(secretName), gate: ident, probe: PROBE });
const PROFILE = obj({ name: ident, engine: literal("claude", "codex", "grok"), capabilities: arr(ident, { nonEmpty: true }) },
  { description: str, model: str, mcpConfig: str, selfTest: literal("required", "optional"), check: CHECK });
/** `checks`: named reply checks, for the profiles this file defines; a sender picks one with `govern task send --check NAME`. */
const FILE = obj({ version: literal(1) }, { capabilities: arr(CAP), profiles: arr(PROFILE), checks: record(CHECK) });

export const extraDir = capabilitiesDir;

export interface Registry { caps: Map<string, Capability>; profiles: Map<string, Profile> }

function readDir(dir: string): { caps: Capability[]; profiles: Profile[] } {
  const caps: Capability[] = [], profiles: Profile[] = [];
  if (!existsSync(dir)) return { caps, profiles };
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const file = join(dir, f);
    const v = parseFile(file, readFileSync(file, "utf8"), FILE);
    for (const [kind, list] of [["capability", v.capabilities ?? []], ["profile", v.profiles ?? []]] as const) {
      const seen = new Set<string>();
      list.forEach((x, i) => {
        if (seen.has(x.name)) check(file, null, () => reject(`$.${kind === "capability" ? "capabilities" : "profiles"}[${i}].name`, `${kind} "${x.name}" is already defined in this file`));
        seen.add(x.name);
      });
    }
    for (const c of v.capabilities ?? []) {
      if (c.probe && !c.probe.expect && !c.probe.file && !c.probe.expectCmd) fail(`${file}: capability ${c.name}: its probe needs an expect, an expectCmd or a file to verify`);
      for (const a of c.claude.allow) { const why = guardedPatternProblem(a, c.effect); if (why) fail(`${file}: capability ${c.name}: ${why}`); }
      caps.push({ ...c, secrets: c.secrets ?? [], file });
    }
    for (const p of v.profiles ?? []) {
      if (RESERVED.includes(p.name)) fail(`${file}: profile name "${p.name}" is reserved (it is a runner or recipient)`);
      profiles.push({ ...p, description: p.description ?? "", selfTest: p.selfTest ?? "required", ...(v.checks ? { checks: v.checks } : {}), ...(p.mcpConfig ? { mcpConfig: resolve(dirname(file), p.mcpConfig) } : {}), file });
    }
  }
  return { caps, profiles };
}

/** Every capability and profile by name (a workspace entry overrides a built-in of the same name), references resolved. */
export function registry(): Registry {
  const caps = new Map<string, Capability>(), profiles = new Map<string, Profile>();
  const given = process.env.GOVERN_CAPABILITIES, extra = extraDir();
  if (given && (!extra || !existsSync(extra))) fail(`GOVERN_CAPABILITIES=${given} does not exist (unset it to use the default capabilities folder)`);
  for (const d of [BUILTIN, extra]) {
    if (!d) continue;
    const r = readDir(d);
    for (const c of r.caps) {
      if (d !== BUILTIN && caps.has(c.name)) fail(`${c.file}: capability "${c.name}" is a built-in and cannot be redefined; pick another name`);
      caps.set(c.name, c);
    }
    for (const p of r.profiles) profiles.set(p.name, p);
  }
  for (const p of profiles.values()) {
    for (const c of p.capabilities) {
      const cap = caps.get(c);
      if (!cap) fail(`${p.file}: profile ${p.name}: unknown capability ${c} (have: ${[...caps.keys()].join(", ")})`);
      if (p.engine === "codex" && !cap!.codex) fail(`${p.file}: profile ${p.name}: capability ${c} is not available on codex`);
      if (p.engine === "grok" && !cap!.grok) fail(`${p.file}: profile ${p.name}: capability ${c} is not available on grok (it has no grok mapping; grok profiles support only: ${[...caps.values()].filter((x) => x.grok).map((x) => x.name).join(", ")})`);
    }
    if (p.mcpConfig && !existsSync(p.mcpConfig)) fail(`${p.file}: profile ${p.name}: mcpConfig ${p.mcpConfig} does not exist`);
  }
  return { caps, profiles };
}

/** The profile named `name` in `reg` (default: the registry, read now); fails, listing the profiles there are, when absent. */
export function getProfile(name: string, reg = registry()): Profile {
  return reg.profiles.get(name) ?? fail(`no profile "${name}" (have: ${[...reg.profiles.keys()].join(", ")})`);
}
/** The capabilities a profile grants, in its order (registry() has already refused an unknown one). */
export const capsOf = (reg: Registry, p: Profile): Capability[] => p.capabilities.map((c) => reg.caps.get(c)!);
/** The distinct effect classes of a profile's capabilities, sorted. */
export const classesOf = (reg: Registry, p: Profile): Effect[] => [...new Set(capsOf(reg, p).map((c) => c.effect))].sort();
/** Whether the profile may change files. */
export const writes = (reg: Registry, p: Profile): boolean => capsOf(reg, p).some((c) => c.effect === "write");

// ---------------------------------------------------------------- the sealed command lines

export interface ClaudeSpec { allow: string[]; acceptEdits: boolean }
/** The Claude permissions of a profile: the union of its capabilities' allow rules, and acceptEdits when any of
 *  them asks for it. */
export function claudeSpec(reg: Registry, p: Profile): ClaudeSpec {
  const cs = capsOf(reg, p);
  return { allow: [...new Set(cs.flatMap((c) => c.claude.allow))], acceptEdits: cs.some((c) => c.claude.permissionMode === "acceptEdits") };
}
/** The Claude argv of a sealed session: only the profile's tools, no user, project or local settings, only its MCP config.
 *  maxBudgetUsd: the model dollars reserved for the run (an allowance), passed as `--max-budget-usd` so the run cannot outspend it.
 *  `--setting-sources ""` is the SDK's way to say "no sources"; the CLI help does not state that an empty value is valid. */
export function claudeArgs(reg: Registry, p: Profile, model: string, maxBudgetUsd?: number, schema?: string): string[] {
  const s = claudeSpec(reg, p);
  const tools = claudeTools(s);
  return ["-p", "--output-format", "json", "--model", model, ...(schema ? ["--json-schema", schema] : []), ...(maxBudgetUsd !== undefined ? ["--max-budget-usd", String(maxBudgetUsd)] : []), ...(s.acceptEdits ? ["--permission-mode", "acceptEdits"] : []),
    "--allowedTools", ...s.allow, "--tools", ...tools, "--disallowedTools", ...CLAUDE_BUILTIN.filter((t) => !tools.includes(t)),
    "--setting-sources", "", "--strict-mcp-config", ...(p.mcpConfig ? ["--mcp-config", p.mcpConfig] : [])];
}
/** Claude Code's built-in tools that can act on files, the shell, the web or other agents (from its tools reference, not
 *  from `claude --help`, so a new built-in is not listed until added here). The ones a profile does not grant are disallowed. */
export const CLAUDE_BUILTIN: readonly string[] = ["Agent", "Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write"];
/** The built-in tools named by the allow patterns, in grant order (`Bash(gh repo view:*)` names Bash; mcp__ tools are not built-in). */
export function claudeTools(s: ClaudeSpec): string[] {
  return [...new Set(s.allow.map((a) => a.replace(/\(.*$/, "")).filter((t) => CLAUDE_BUILTIN.includes(t)))];
}
export interface CodexSpec { sandbox: "read-only" | "workspace-write"; config: string[]; addDirs: string[] }
/** The Codex equivalent: the strongest sandbox any capability asks for, and every -c setting and add-dir. */
export function codexSpec(reg: Registry, p: Profile): CodexSpec {
  const cs = capsOf(reg, p).map((c) => c.codex!);
  return { sandbox: cs.some((c) => c.sandbox === "workspace-write") ? "workspace-write" : "read-only",
    config: [...new Set(cs.flatMap((c) => c.config ?? []))], addDirs: [...new Set(cs.flatMap((c) => c.addDirs ?? []))] };
}

export interface GrokSpec { tools: string[]; allow: string[]; deny: string[]; acceptEdits: boolean }
/** Denied in every grok run whatever the profile: MCP tools (a user's or project's MCP servers are an unreviewed capability) and the login file. */
export const GROK_BASE_DENY = ["MCPTool(*)", "Read(**/auth.json)"];
/** The Grok equivalent: every capability's tools, allow and deny rules, and acceptEdits when any capability asks for it. The base denies come last. */
export function grokSpec(reg: Registry, p: Profile): GrokSpec {
  const cs = capsOf(reg, p).map((c) => c.grok!);
  return { tools: [...new Set(cs.flatMap((c) => c.tools))], allow: [...new Set(cs.flatMap((c) => c.allow ?? []))], deny: [...new Set([...cs.flatMap((c) => c.deny ?? []), ...GROK_BASE_DENY])], acceptEdits: cs.some((c) => c.permissionMode === "acceptEdits") };
}
/** The profile-specific part of a sealed grok argv (the dispatcher adds --prompt-file, --output-format, --model and --cwd):
 *  only the profile's tools, a permission mode that never prompts, one --allow per rule and one --deny per rule. The environment half of the seal
 *  (private HOME, compat loaders off) is in queue.ts `grokEnv`. */
export function grokArgs(reg: Registry, p: Profile): string[] {
  const s = grokSpec(reg, p);
  return ["--tools", s.tools.join(","), "--permission-mode", s.acceptEdits ? "acceptEdits" : "dontAsk", ...s.allow.flatMap((a) => ["--allow", a]), ...s.deny.flatMap((d) => ["--deny", d])];
}

// ---------------------------------------------------------------- identity of a definition

const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "file").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
/** The sha256 of everything that decides what a session of this profile can do: engine, model, each capability's
 *  definition and the MCP config's path and content. A change to any of it is a new hash. */
export function profileHash(reg: Registry, p: Profile): string {
  const mcp = p.mcpConfig ? { path: p.mcpConfig, content: readFileSync(p.mcpConfig, "utf8") } : null;
  return sha256(JSON.stringify(stable({ engine: p.engine, model: p.model ?? null, capabilities: capsOf(reg, p), mcp })));
}

// ---------------------------------------------------------------- guarded classes

/** Why `p` may not run for `lane` (or undefined: it may). A profile with a spend, publish or push capability runs only
 *  for a lane whose process declares the matching gate and whose owner approved it. */
export function guardProblem(reg: Registry, p: Profile, lane: string | undefined, laneGiven: boolean, project: string): string | undefined {
  if (laneGiven && lane !== project && capsOf(reg, p).some((c) => GUARDED.includes(c.effect))) {
    const parent = existsSync(join(projectsDir(), project, "govern.json")) ? load(project).parent : undefined;
    if (lane !== parent) return `--lane ${lane} must be the message's project (${project}) or its parent lane${parent ? ` (${parent})` : " (it has none)"}`;
  }
  for (const c of capsOf(reg, p)) {
    if (!GUARDED.includes(c.effect)) continue;
    const gate = c.gate ?? c.effect;
    const what = `profile ${p.name} holds ${c.name}, a ${c.effect} capability`;
    if (!lane) return `it needs a lane: pass --lane <slug> for a lane whose "${gate}" gate is approved (${what})`;
    if (!existsSync(join(projectsDir(), lane, "govern.json"))) return laneGiven ? `--lane ${lane}: no such lane (${what})` : `it needs a lane: pass --lane <slug> for a lane whose "${gate}" gate is approved (${what})`;
    const l = load(lane);
    if (!processOf(l).gates.some((g) => g.name === gate)) return `lane ${lane}'s process "${processOf(l).name}" has no "${gate}" gate, so it cannot authorise profile ${p.name} (${what})`;
    if (!gateApproved(l, processOf(l).gates.find(g=>g.name===gate)!)) return `lane ${lane} has not approved its "${gate}" gate (${what}; govern approve ${lane} ${gate} --quote "…")`;
  }
  return undefined;
}

// ---------------------------------------------------------------- self-test records

export interface ProbeResult { capability: string; status: "ok" | "refused" | "error" | "invalid" | "untested" | "leaked"; evidence: string }
/** negative: "none applicable" when the profile lacks no capability the negative probe could ask for (every tool of every absent capability is already granted, or the engine has no per-tool grant). */
export interface CheckRecord { version: 1; profile: string; hash: string; at: string; model: string; ok: boolean; results: ProbeResult[]; negative?: "none applicable" }
const RECORD = obj({ version: literal(1), profile: str, hash: str, at: str, model: str, ok: (v, p) => (typeof v === "boolean" ? v : reject(p, "must be true or false")),
  results: arr(obj({ capability: str, status: literal("ok", "refused", "error", "invalid", "untested", "leaked"), evidence: str })) }, { negative: literal("none applicable") });

/** File tools whose probes act on a file in the task's folder. */
const FILE_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"]);
/** Whether Claude allow pattern `a` is already granted by `held` as far as a probe can tell: the same pattern, the bare tool
 *  (`Bash`, `Bash(*)`) that includes it, or, for a file tool, its grant on the task's folder (`Read(./**)`): every probe works
 *  on a file there, so the folder grant would let the probe of the bare tool succeed without any grant being wrong. */
const coveredBy = (a: string, held: Set<string>): boolean => {
  const tool = a.replace(/\(.*$/, "");
  return held.has(a) || held.has(tool) || held.has(`${tool}(*)`) || (FILE_TOOLS.has(tool) && held.has(`${tool}(./**)`));
};
/** The capability the negative probe asks a session of `p` to use: one the profile lacks, with a probe, that the engine can honour and
 *  whose Claude allow patterns (grok: tools) are not all granted already by the capabilities it holds, so a refusal is possible.
 *  Undefined when there is none (codex has no per-tool grant). */
export function negativeCandidate(reg: Registry, p: Profile): Capability | undefined {
  const held = new Set(p.capabilities);
  const rest = [...reg.caps.values()].filter((c) => !held.has(c.name) && c.probe);
  if (p.engine === "claude") {
    const granted = new Set(capsOf(reg, p).flatMap((c) => c.claude.allow));
    return rest.find((c) => c.claude.allow.length > 0 && c.claude.allow.some((a) => !coveredBy(a, granted)));
  }
  if (p.engine === "grok") {
    const granted = new Set(capsOf(reg, p).flatMap((c) => c.grok?.tools ?? []));
    return rest.find((c) => c.grok && c.grok.tools.some((t) => !granted.has(t)));
  }
  return undefined;
}
/** Where a profile's self-test record lives: <queueDir>/checks/<profile>.json. */
export const checkFile = (queueDir: string, profile: string) => join(queueDir, "checks", `${profile}.json`);
/** The last record of a profile; undefined when none, "unreadable" when it is not a valid record (never trusted). */
export function readCheck(queueDir: string, profile: string): CheckRecord | "unreadable" | undefined {
  const f = checkFile(queueDir, profile);
  if (!existsSync(f)) return undefined;
  try { return parseFile(f, readFileSync(f, "utf8"), RECORD) as CheckRecord; } catch { return "unreadable"; }
}
/** The capabilities whose probe did not pass; an untested one counts unless the profile's self-test is optional. */
export const failing = (results: ProbeResult[], p: Profile): string[] => results.filter((r) => r.status !== "ok" && !(r.status === "untested" && p.selfTest === "optional")).map((r) => r.capability);
export type CheckState = "passed" | "failed" | "stale" | "none";
/** A self-test record against the profile's current hash: "none" when absent or unreadable, "stale" when the hash
 *  differs, else "passed" or "failed" by its ok. */
export function checkState(rec: CheckRecord | "unreadable" | undefined, hash: string): CheckState {
  if (!rec || rec === "unreadable") return "none";
  return rec.hash !== hash ? "stale" : rec.ok ? "passed" : "failed";
}
/** Why the dispatcher refuses `p` on the strength of its self-test record (or undefined: it may run). Every profile needs a passing record of its
 *  current hash, whatever its selfTest; `legacyOptional` (conversations only) keeps the older rule that lets an "optional" profile with no record run. */
export function checkProblem(queueDir: string, reg: Registry, p: Profile, legacyOptional = false): string | undefined {
  const rec = readCheck(queueDir, p.name), hash = profileHash(reg, p), st = checkState(rec, hash);
  const run = `run govern caps --check ${p.name}`;
  if (st === "failed") return `the last self-test of profile ${p.name} failed (${failing((rec as CheckRecord).results, p).join(", ")}); fix the grant and ${run}`;
  if (st === "stale") return `profile ${p.name} changed since its last self-test; ${run}`;
  if (st === "none" && (!legacyOptional || p.selfTest === "required" || rec === "unreadable")) return `profile ${p.name} has not passed a self-test${rec === "unreadable" ? " (its record is unreadable)" : ""}; ${run}`;
  return undefined;
}

// ---------------------------------------------------------------- text

const codexLine = (reg: Registry, p: Profile): string => {
  const missing = capsOf(reg, p).filter((c) => !c.codex).map((c) => c.name);
  if (missing.length) return `not available on codex (${missing.join(", ")})`;
  const s = codexSpec(reg, p);
  return `sandbox ${s.sandbox}${s.config.length ? ` · -c ${s.config.join(" -c ")}` : ""}${s.addDirs.length ? ` · --add-dir ${s.addDirs.join(" --add-dir ")}` : ""}`;
};

/** What the grok seal does not close, verified by `grok inspect` and probes (see docs/govern-features.md 3.12). */
const GROK_PARTIAL = "not fully sealed (project-level config under the cwd, built-in agents and bundled skills still load; no dollar cap, only --max-turns)";
const grokLine = (reg: Registry, p: Profile): string => {
  const missing = capsOf(reg, p).filter((c) => !c.grok).map((c) => c.name);
  if (missing.length) return `not available on grok (${missing.join(", ")})`;
  const s = grokSpec(reg, p);
  return `--tools ${s.tools.join(",")} · --permission-mode ${s.acceptEdits ? "acceptEdits" : "dontAsk"}${s.allow.length ? ` · ${s.allow.map((a) => `--allow ${a}`).join(" ")}` : ""} · ${s.deny.map((d) => `--deny ${d}`).join(" ")}`;
};

/** How a check state reads in `govern caps`: a changed definition is told apart from one never checked and from one that failed. */
export const checkWord = (st: CheckState): string => st === "none" ? "not run" : st === "stale" ? "stale (profile changed)" : st;

/** The `govern caps` listing: each capability (effect, engines, description), each profile (engine, capabilities,
 *  self-test state, seal caveats, untested capabilities), then a warning per queue runner in `shadowing`. */
export function listText(reg: Registry, queueDir: string, shadowing: string[]): string {
  const L = ["CAPABILITIES"];
  for (const c of reg.caps.values()) L.push(`  ${c.name.padEnd(10)} ${c.effect.padEnd(8)} ${["claude", ...(c.codex ? ["codex"] : []), ...(c.grok ? ["grok"] : [])].join(", ").replace(/^claude$/, "claude only")}  ${c.description}`);
  L.push("", "PROFILES");
  for (const p of reg.profiles.values()) {
    const st = checkState(readCheck(queueDir, p.name), profileHash(reg, p));
    const untested = capsOf(reg, p).filter((c) => !c.probe).map((c) => c.name);
    L.push(`  ${p.name.padEnd(14)} ${p.engine.padEnd(7)} ${p.capabilities.join("+").padEnd(22)} check: ${checkWord(st)}${p.engine === "codex" ? `  ${CODEX_PARTIAL}` : p.engine === "grok" ? `  ${GROK_PARTIAL}` : ""}${untested.length ? `  UNTESTED: ${untested.join(", ")}` : ""}`);
  }
  for (const n of shadowing) L.push(`warning: the queue's config.json runner "${n}" shadows the built-in profile ${n} (it runs unsealed)`);
  return L.join("\n");
}

/** The `govern caps <profile>` text: its capabilities with their grants, the claude, codex and grok command-line
 *  mapping, effect classes, secret names, reply check, and the state of its last self-test. */
export function showText(reg: Registry, queueDir: string, p: Profile): string {
  const caps = capsOf(reg, p);
  const rec = readCheck(queueDir, p.name), st = checkState(rec, profileHash(reg, p));
  const L = [`${p.name}: ${p.description || "(no description)"}`, `engine: ${p.engine}${p.model ? ` · model ${p.model}` : ""} · self-test ${p.selfTest}`, `defined in: ${p.file}`, "capabilities:"];
  for (const c of caps) {
    L.push(`  ${c.name.padEnd(10)} ${c.effect.padEnd(8)} ${c.claude.allow.join(", ")}${c.claude.permissionMode ? ` (${c.claude.permissionMode})` : ""}${c.probe ? "" : "  NOT TESTED: no probe"}`);
    const extra = [c.resource && `resource: ${c.resource}`, c.cost && `cost: ${c.cost}`, GUARDED.includes(c.effect) && `needs the lane's "${c.gate ?? c.effect}" gate approved`].filter(Boolean);
    if (extra.length) L.push(`             ${extra.join(" · ")}`);
  }
  L.push(`claude: --allowedTools ${claudeSpec(reg, p).allow.join(" ")}${claudeSpec(reg, p).acceptEdits ? " · --permission-mode acceptEdits" : ""} · --setting-sources "" · --strict-mcp-config${p.mcpConfig ? ` · --mcp-config ${p.mcpConfig}` : " (no MCP servers)"}`);
  L.push(`codex: ${codexLine(reg, p)}${p.engine === "codex" ? ` · ${CODEX_PARTIAL}` : ""}`);
  L.push(`grok: ${grokLine(reg, p)}${p.engine === "grok" ? ` · private HOME and GROK_HOME (login only) · GROK_(CLAUDE|CURSOR)_(AGENTS|HOOKS|MCPS|RULES|SKILLS)_ENABLED=0 GROK_MEMORY=0 · ${GROK_PARTIAL}` : ""}`);
  L.push(`classes: ${classesOf(reg, p).join(", ")}`);
  const secrets = [...new Set(caps.flatMap((c) => c.secrets))];
  L.push(`secrets: ${secrets.length ? `${secrets.join(", ")} (names only)` : "(none)"}`);
  L.push(`reply check: ${p.check ? p.check.argv.join(" ") : "(none: the reply kind decides; govern task send --help)"}`);
  L.push(`check: ${checkWord(st)}${rec && rec !== "unreadable" ? ` (${rec.at}, ${rec.model})` : ""}`);
  if (rec && rec !== "unreadable" && rec.negative) L.push(`negative: ${rec.negative}`);
  return L.join("\n");
}
