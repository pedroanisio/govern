// govern doctor: whether this box can run its lanes. A box is a host or a container; its manifest (box.json, BOX.md) names
// the engines, the workspaces, the units each depends on, its Slack connection, and the images and commands that prove the
// rest. Every probe is deterministic and reads only, except a check command the manifest declares, which runs as declared.
// Each finding says who can fix a failure: the agent (a command it can run) or the operator (a login, a secret, a sudo step).
// `govern onboard` drives a lane through these groups; a model fixes, this module alone decides what passes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { arr, bool, check, literal, name, obj, parseFile, posInt, reject, str, type Shape } from "./shape.ts";
import { clip, fail, GovernError, usage } from "./util.ts";
import { config, findRepo, inRepo, FOLDER_OVERRIDES, CONFIG_FILE } from "./workspace.ts";
import { processes } from "./process.ts";
import { registry, checkProblem, extraDir, readCheck, checkState, profileHash } from "./caps.ts";
import { QUEUE } from "./queue.ts";
import { classify, unitProperties } from "./services.ts";
import { enabledNames, loadExtension } from "./ext.ts";

/** The manifest version this govern reads: any 1.x.y. */
export const BOX_SCHEMA = "1.0.0";
/** The probe groups, in the order they run and `govern onboard` takes them. */
export const GROUPS = ["govern", "engines", "workspaces", "services", "slack", "checks"] as const;
export type Group = (typeof GROUPS)[number];
export type Status = "ok" | "fail" | "skip";
/** Who can fix a failure: the agent working the box, or the operator (a login, a secret, a sudo step, a Slack invite). */
export type Actor = "agent" | "operator";
/** What the box can do about a failure by itself (govern onboard's "Fix it" button runs it, lib/onboard.ts): start a unit,
 *  make a secret file private, turn the slack extension on, run the profiles' self-tests, or write the bot token the
 *  operator pastes. Only a failing finding carries one, and only a probe attaches it. */
export type Action =
  | { kind: "enable-unit"; unit: string }
  | { kind: "chmod-private"; file: string }
  | { kind: "enable-extension"; workspace: string; extension: "slack" }
  | { kind: "self-test"; workspace: string }
  | { kind: "slack-token"; file: string; variable: string };
export interface Finding { id: string; group: Group; status: Status; actor: Actor; evidence: string; fix?: string; action?: Action }

export type Engine = "claude" | "codex" | "grok";
export interface BoxCheck { name: string; argv: [string, ...string[]]; timeoutSec?: number; actor?: Actor }
export interface BoxWorkspace { path: string; name?: string; units?: string[]; slack?: boolean; images?: string[]; checks?: BoxCheck[] }
export interface Box {
  schema: string;
  /** The release every probe expects to find running. */
  govern?: { version: string };
  engines?: Engine[];
  /** systemd-user: units are user units of this account; none: a container whose entrypoint supervises them (unit probes skip). */
  supervisor?: "systemd-user" | "none";
  workspaces?: BoxWorkspace[];
}

/** The default manifest: ~/.config/govern/box.json. */
export const defaultBoxFile = (): string => join(homedir(), ".config", "govern", "box.json");
/** Engines a box needs when its manifest names none: the squads' profiles use both. */
const DEFAULT_ENGINES: Engine[] = ["claude", "codex"];
const CHECK_TIMEOUT_SEC = 120, PROBE_MS = 15_000, STABLE_MS = 60_000;

const semver1: Shape<string> = (v, p) => { const s = str(v, p); if (!/^1\.\d+\.\d+$/.test(s)) reject(p, `must be a 1.x.y version (this govern reads box manifest ${BOX_SCHEMA})`); return s; };
const unit: Shape<string> = (v, p) => { const s = str(v, p); if (!/^[A-Za-z0-9@._:\\-]+\.(service|timer|socket|target|path)$/.test(s)) reject(p, "must name a systemd unit (name.service, .timer, .socket, .target or .path)"); return s; };
const version: Shape<string> = (v, p) => { const s = str(v, p); if (!/^\d+\.\d+\.\d+$/.test(s)) reject(p, "must be a version x.y.z"); return s; };
const actor = literal<Actor>("agent", "operator");
const BOX = obj({ schema: semver1 }, {
  govern: obj({ version }),
  engines: arr(literal<Engine>("claude", "codex", "grok")),
  supervisor: literal("systemd-user", "none"),
  workspaces: arr(obj({ path: name }, {
    name, units: arr(unit), slack: bool, images: arr(name),
    checks: arr(obj({ name, argv: arr(name, { nonEmpty: true }) }, { timeoutSec: posInt, actor })),
  })),
});

/** `raw` (the contents of `file`, already parsed) as a box manifest: typed, unknown keys refused, each workspace path made
 *  absolute (`~/` is `home`, a relative path is the manifest's folder's), a path or a workspace name given twice refused. */
export function parseBox(file: string, raw: unknown, home = homedir()): Box {
  const b = check(file, raw, BOX) as Box;
  const seen = new Map<string, string>();
  b.workspaces?.forEach((w, i) => {
    w.path = w.path === "~" ? home : w.path.startsWith("~/") ? join(home, w.path.slice(2)) : resolve(dirname(file), w.path);
    for (const [k, v] of [["path", w.path], ["name", wsName(w)]] as const) {
      if (seen.has(`${k}:${v}`)) check(file, null, () => reject(`$.workspaces[${i}].${k}`, `${v} is listed twice`));
      seen.set(`${k}:${v}`, v);
    }
  });
  return b;
}

/** The manifest at `file`, else the default one when it exists; undefined when neither is given or there. */
export function loadBox(file?: string): Box | undefined {
  const f = file ?? defaultBoxFile();
  if (!existsSync(f)) return file ? fail(`${file}: no such box manifest`) : undefined;
  return parseBox(f, parseFile(f, readFileSync(f, "utf8"), (v) => v));
}

const wsName = (w: BoxWorkspace): string => w.name ?? basename(w.path);
const finding = (group: Group, id: string, status: Status, evidence: string, o: { actor?: Actor; fix?: string; action?: Action } = {}): Finding =>
  ({ id, group, status, actor: o.actor ?? "agent", evidence, ...(o.fix && status === "fail" ? { fix: o.fix } : {}), ...(o.action && status === "fail" ? { action: o.action } : {}) });

/** A program's run: its exit code (null when it did not start or was stopped), its output, and why it did not run. */
interface Ran { code: number | null; out: string; err: string; error?: string }
function runProgram(cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}): Ran {
  const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: "utf8", timeout: o.timeoutMs ?? PROBE_MS, maxBuffer: 8 << 20 });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const error = code === "ENOENT" ? "not found" : code === "ETIMEDOUT" || r.signal === "SIGTERM" ? `timed out after ${Math.round((o.timeoutMs ?? PROBE_MS) / 1000)} s`
    : r.error ? `could not run (${code ?? r.error.name})` : undefined;
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", ...(error ? { error } : {}) };
}
/** The last `n` non-empty lines of a run's output, one line, clipped. */
const tail = (r: Ran, n = 3): string => clip([...r.out.split("\n"), ...r.err.split("\n")].map((l) => l.trim()).filter(Boolean).slice(-n).join(" · "), 300);
const firstLine = (s: string): string => clip(s.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 120);

// ---------------------------------------------------------------- govern

function governGroup(box: Box): Finding[] {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const running = (JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string }).version;
  const want = box.govern?.version;
  const major = Number(process.versions.node.split(".")[0]);
  return [
    finding("govern", "govern:version", !want || want === running ? "ok" : "fail",
      want && want !== running ? `runs ${running}; the box wants ${want}` : `govern ${running} (${here})`,
      { fix: `install govern ${want} (jumpserver: playbooks/govern.yml with govern_version=${want}; or the govern-v${want} release tarball)` }),
    finding("govern", "govern:node", major >= 24 ? "ok" : "fail", `node ${process.versions.node}${major >= 24 ? "" : "; govern needs 24 or newer"}`,
      { fix: "install Node 24 or newer (the release's /opt/govern/node, or nodejs.org)" }),
  ];
}

// ---------------------------------------------------------------- engines

const INSTALL: Record<Engine, string> = {
  claude: "npm install -g @anthropic-ai/claude-code (jumpserver: playbooks/ai-cli.yml)",
  codex: "npm install -g @openai/codex (jumpserver: playbooks/ai-cli.yml)",
  grok: "install the grok CLI and put it on PATH, or set GOVERN_GROK_BIN",
};
const binOf = (e: Engine): string => ({ claude: process.env.GOVERN_CLAUDE_BIN, codex: process.env.GOVERN_CODEX_BIN, grok: process.env.GOVERN_GROK_BIN })[e] ?? e;

/** claude auth status prints a JSON object with a boolean loggedIn; anything else is not evidence of a login. */
function claudeLogin(r: Ran): { ok: boolean; evidence: string } {
  let v: unknown;
  try { v = JSON.parse(r.out); } catch { return { ok: false, evidence: `not the JSON claude auth status prints: ${tail(r, 1) || "(no output)"}` }; }
  if (typeof v !== "object" || v === null || Array.isArray(v) || typeof (v as { loggedIn?: unknown }).loggedIn !== "boolean")
    return { ok: false, evidence: "not the JSON claude auth status prints (no boolean loggedIn)" };
  const s = v as { loggedIn: boolean; authMethod?: unknown };
  return s.loggedIn ? { ok: true, evidence: `logged in${typeof s.authMethod === "string" ? ` (${clip(s.authMethod, 40)})` : ""}` } : { ok: false, evidence: "not logged in" };
}

function engineGroup(box: Box): Finding[] {
  const out: Finding[] = [];
  for (const e of box.engines ?? DEFAULT_ENGINES) {
    const bin = binOf(e), v = runProgram(bin, ["--version"]);
    const installed = !v.error && v.code === 0;
    out.push(finding("engines", `engines:${e}:installed`, installed ? "ok" : "fail",
      installed ? `${bin}: ${firstLine(v.out) || "answers --version"}` : `${bin}: ${v.error ?? `--version exited ${v.code}: ${tail(v, 1)}`}`, { fix: INSTALL[e] }));
    const id = `engines:${e}:login`;
    if (!installed) { out.push(finding("engines", id, "skip", `${e} is not installed`)); continue; }
    if (e === "grok") { out.push(finding("engines", id, "skip", "grok has no login probe; caps --check of a grok profile proves it")); continue; }
    if (e === "claude") {
      const l = claudeLogin(runProgram(bin, ["auth", "status"]));
      out.push(finding("engines", id, l.ok ? "ok" : "fail", l.evidence, { actor: "operator", fix: `claude auth login (or run claude and /login) as ${userInfo().username}` }));
    } else {
      const l = runProgram(bin, ["login", "status"]);
      const ok = !l.error && l.code === 0;
      out.push(finding("engines", id, ok ? "ok" : "fail", ok ? firstLine(l.out || l.err) || "logged in" : `not logged in: ${l.error ?? tail(l, 1)}`,
        { actor: "operator", fix: `codex login as ${userInfo().username} (on a headless box: codex login --device-auth)` }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- workspaces

const isWorkspace = (p: string): boolean => existsSync(join(p, ".govern")) || existsSync(join(p, CONFIG_FILE));
/** `f` inside workspace `w`, a GovernError turned into a failing finding. */
function attempt(group: Group, id: string, w: BoxWorkspace, f: () => { evidence: string; problem?: string; fix?: string; action?: Action }, fixDefault?: string): Finding {
  try {
    const r = inRepo(w.path, f);
    return finding(group, id, r.problem ? "fail" : "ok", r.problem ?? r.evidence, { fix: r.fix ?? fixDefault, ...(r.action ? { action: r.action } : {}) });
  } catch (e) {
    if (e instanceof GovernError) return finding(group, id, "fail", clip(e.message, 400), { fix: fixDefault });
    throw e;
  }
}

function workspaceGroup(ws: BoxWorkspace[]): Finding[] {
  const out: Finding[] = [];
  for (const w of ws) {
    const n = wsName(w), id = (k: string) => `workspaces:${n}:${k}`;
    if (!isWorkspace(w.path)) {
      out.push(finding("workspaces", id("found"), "fail", `${w.path} is not a govern workspace (no .govern/ or ${CONFIG_FILE})`,
        { fix: `copy the squad's definitions (jumpserver: playbooks/govern-squad.yml), or govern init ${w.path}` }));
      continue;
    }
    out.push(finding("workspaces", id("found"), "ok", w.path));
    const cfg = attempt("workspaces", id("config"), w, () => { config(); return { evidence: "config parses" }; }, "correct the field the evidence names");
    out.push(cfg);
    if (cfg.status === "fail") continue;
    out.push(attempt("workspaces", id("processes"), w, () => ({ evidence: `${processes().size} processes load` }), "correct the process file the evidence names"));
    out.push(attempt("workspaces", id("profiles"), w, () => {
      const reg = registry(), dir = extraDir(), q = QUEUE();
      const mine = [...reg.profiles.values()].filter((p) => dir !== undefined && p.file.startsWith(dir + sep));
      const bad = mine.filter((p) => checkProblem(q, reg, p) !== undefined);
      // Named by state, so the evidence reads as one sentence: never tested, changed since the test, the test failed.
      const by = (s: string) => bad.filter((p) => { const r = readCheck(q, p.name); return (r === "unreadable" ? "none" : checkState(r, profileHash(reg, p))) === s; }).map((p) => p.name);
      const parts = [["never self-tested", by("none")], ["changed since their self-test", by("stale")], ["failed their self-test", by("failed")]]
        .filter(([, ns]) => ns!.length).map(([what, ns]) => `${what}: ${(ns as string[]).join(", ")}`);
      return bad.length
        ? { evidence: "", problem: `${bad.length} of ${mine.length} profiles are not verified (${parts.join("; ")}); the dispatcher tests one before its first message and holds its work if it fails`,
          fix: `GOVERN_REPO=${w.path} govern caps --check --all`, action: { kind: "self-test", workspace: w.path } }
        : { evidence: mine.length ? `${mine.length} profile${mine.length === 1 ? "" : "s"} with a passing self-test of their current definition` : "no profiles of its own" };
    }, "correct the capabilities file the evidence names"));
  }
  return out;
}

// ---------------------------------------------------------------- services

/** A unit is healthy for the box when a timer, socket, path or target is active, a long-running service is up and stable, and
 *  a oneshot service is running or last exited 0. */
function judgeUnit(p: Record<string, string>, u: string, now: number): { ok: boolean; state: string; fix: string; start?: boolean } {
  const restart = `systemctl --user enable --now ${u}`, logs = `journalctl --user -u ${u} -n 50`;
  if (p.LoadState !== "loaded")
    return { ok: false, state: p.LoadState === "not-found" ? "not found: the unit file is not installed" : `load state ${p.LoadState || "unknown"}`,
      fix: `install ${u} (the squad's systemd/ folder, govern task install-service, govern slack install-service), then systemctl --user daemon-reload && ${restart}` };
  const c = classify(p, now);
  if (c.health === "problem") return { ok: false, state: c.state, fix: `${logs}; fix the cause, then systemctl --user restart ${u}` };
  const active = p.ActiveState === "active";
  if (!u.endsWith(".service")) return { ok: active, state: p.ActiveState || "unknown", fix: restart, start: p.ActiveState === "inactive" };
  if (active) {
    const up = /^@(\d+)$/.exec(p.ActiveEnterTimestamp ?? "")?.[1];
    if (p.Type !== "oneshot" && up !== undefined && now - Number(up) * 1000 < STABLE_MS) return { ok: false, state: "up for less than 60 s: run doctor again to see it stay up", fix: logs };
    return { ok: true, state: "active", fix: restart };
  }
  if (p.ActiveState === "activating") return { ok: true, state: "running now", fix: restart };
  if (p.ActiveState === "inactive" && p.Type === "oneshot") return { ok: p.Result === "success", state: p.Result === "success" ? "inactive; last run succeeded" : `inactive; last result ${p.Result || "unknown"}`, fix: logs };
  return { ok: false, state: `${p.ActiveState || "unknown"}: not running`, fix: restart, start: p.ActiveState === "inactive" };
}

function serviceGroup(box: Box, ws: BoxWorkspace[], now: number): Finding[] {
  const want = ws.map((w) => {
    let watch: string[] = [];
    try { watch = isWorkspace(w.path) ? inRepo(w.path, () => config().watch?.user ?? []) : []; } catch (e) { if (!(e instanceof GovernError)) throw e; }
    return { w, units: [...new Set([...(w.units ?? []), ...watch])] };
  });
  const all = want.flatMap((x) => x.units.map((u) => ({ n: wsName(x.w), u })));
  if (!all.length) return [finding("services", "services", "skip", "no units declared (box.json units, or the workspaces' watch.user)")];
  if (box.supervisor === "none") return all.map(({ n, u }) => finding("services", `services:${n}:${u}`, "skip", "supervisor none: the container's entrypoint runs this, not systemd"));
  const user = userInfo().username, linger = runProgram("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  const lingers = !linger.error && linger.code === 0 && linger.out.trim() === "yes";
  const out = [finding("services", "services:linger", lingers ? "ok" : "fail",
    lingers ? `${user} lingers: user units run without a login` : `${user} does not linger (${linger.error ?? (linger.out.trim() || tail(linger, 1))}): user units stop at logout`,
    { actor: "operator", fix: `sudo loginctl enable-linger ${user}` })];
  for (const { n, u } of all) {
    const p = unitProperties("user", u);
    if ("gap" in p) { out.push(finding("services", `services:${n}:${u}`, "fail", `user units not readable: ${p.gap}`, { fix: "run doctor in the box user's session (systemctl --user needs its bus)" })); continue; }
    const j = judgeUnit(p, u, now);
    out.push(finding("services", `services:${n}:${u}`, j.ok ? "ok" : "fail", j.state, { fix: j.fix, ...(j.start ? { action: { kind: "enable-unit", unit: u } as const } : {}) }));
  }
  return out;
}

// ---------------------------------------------------------------- slack

/** What an extension's doctor probe is given: the workspace (already GOVERN_REPO while it runs), the clock and the fetch to use. */
export interface DoctorTarget { name: string; path: string; now: number; request: typeof fetch }

async function slackGroup(ws: BoxWorkspace[], now: number, request: typeof fetch): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const w of ws) {
    const n = wsName(w);
    if (!isWorkspace(w.path)) { out.push(finding("slack", `slack:${n}`, "skip", "not a workspace (see workspaces)")); continue; }
    let on: boolean;
    try { on = inRepo(w.path, () => enabledNames().includes("slack")); }
    catch (e) { if (e instanceof GovernError) { out.push(finding("slack", `slack:${n}`, "skip", "config unreadable (see workspaces)")); continue; } throw e; }
    if (!on) {
      out.push(w.slack ? finding("slack", `slack:${n}:enabled`, "fail", "the box wants Slack here; the workspace does not enable the slack extension",
          { fix: `GOVERN_REPO=${w.path} govern ext enable slack`, action: { kind: "enable-extension", workspace: w.path, extension: "slack" } })
        : finding("slack", `slack:${n}`, "skip", "the workspace does not enable slack"));
      continue;
    }
    const old = process.env.GOVERN_REPO;
    process.env.GOVERN_REPO = w.path;
    try {
      const x = await loadExtension("slack");
      if (!x.doctor) throw new GovernError("ext/slack/index.ts exports no doctor");
      out.push(...await x.doctor({ name: n, path: w.path, now, request }));
    } catch (e) {
      if (!(e instanceof GovernError)) throw e;
      out.push(finding("slack", `slack:${n}:config`, "fail", clip(e.message, 400), { fix: "correct the slack section of the workspace config" }));
    } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
  }
  return out;
}

// ---------------------------------------------------------------- checks

function checkGroup(ws: BoxWorkspace[]): Finding[] {
  const out: Finding[] = [];
  for (const w of ws) {
    const n = wsName(w);
    for (const image of w.images ?? []) {
      const r = runProgram("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
      const ok = !r.error && r.code === 0;
      out.push(finding("checks", `checks:${n}:image:${image}`, ok ? "ok" : "fail", ok ? `${image} ${clip(r.out.trim(), 24)}` : `${image}: ${r.error ? `docker ${r.error}` : tail(r, 1)}`,
        { fix: `build it on this box (its Dockerfile is under ~/govern/squad/docker/; jumpserver: govern_squad_images), or docker pull ${image}` }));
    }
    for (const c of w.checks ?? []) {
      if (!existsSync(w.path) || !statSync(w.path).isDirectory()) { out.push(finding("checks", `checks:${n}:${c.name}`, "skip", `${w.path} is not there (see workspaces)`)); continue; }
      const [cmd, ...args] = c.argv;
      const program = !isAbsolute(cmd) && cmd.includes("/") ? join(w.path, cmd) : cmd;
      const r = runProgram(program, args, { cwd: w.path, timeoutMs: (c.timeoutSec ?? CHECK_TIMEOUT_SEC) * 1000 });
      const ok = !r.error && r.code === 0;
      out.push(finding("checks", `checks:${n}:${c.name}`, ok ? "ok" : "fail", ok ? tail(r, 1) || "exit 0" : r.error ? `${c.argv.join(" ")}: ${r.error}` : `exit ${r.code}: ${tail(r)}`,
        { actor: c.actor ?? "agent", fix: `run ${c.argv.join(" ")} in ${w.path} and fix what it reports` }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the run

/** Every finding of `box` (undefined: the current workspace, if any, and the default engines), group by group. */
export async function doctor(box: Box | undefined, o: { only?: readonly Group[]; now?: number; request?: typeof fetch } = {}): Promise<Finding[]> {
  const b: Box = box ?? { schema: BOX_SCHEMA };
  const here = findRepo();
  const ws: BoxWorkspace[] = b.workspaces ?? (here ? [{ path: here }] : []);
  if (ws.length > 1) {
    const set = FOLDER_OVERRIDES.filter((v) => process.env[v]);
    if (set.length) usage(`${set.join(", ")} would point every workspace of the box at one folder: unset ${set.length > 1 ? "them" : "it"} to check ${ws.length} workspaces`);
  }
  const only = new Set(o.only ?? GROUPS), now = o.now ?? Date.now();
  const none = (g: Group): Finding[] => [finding(g, g, "skip", `no box manifest (${defaultBoxFile().replace(homedir(), "~")}) and no workspace here`)];
  const out: Finding[] = [];
  for (const g of GROUPS) {
    if (!only.has(g)) continue;
    if (g === "govern") out.push(...governGroup(b));
    else if (g === "engines") out.push(...engineGroup(b));
    else if (!ws.length) out.push(...none(g));
    else if (g === "workspaces") out.push(...workspaceGroup(ws));
    else if (g === "services") out.push(...serviceGroup(b, ws, now));
    else if (g === "slack") out.push(...await slackGroup(ws, now, o.request ?? fetch));
    else out.push(...checkGroup(ws));
  }
  return out;
}

/** The groups `--only` names (comma-separated), in GROUPS order; an unknown one is a usage error. */
export function parseOnly(text: string | undefined): Group[] | undefined {
  if (text === undefined) return undefined;
  const want = text.split(",").map((s) => s.trim()).filter(Boolean);
  for (const g of want) if (!(GROUPS as readonly string[]).includes(g)) usage(`unknown group "${g}" (groups: ${GROUPS.join(", ")})`);
  if (!want.length) usage(`--only names no group (groups: ${GROUPS.join(", ")})`);
  return GROUPS.filter((g) => want.includes(g));
}

const MARK: Record<Status, string> = { ok: "✔", fail: "✖", skip: "–" };
/** The text report: one count line, then each finding, a failure followed by its fix and who can apply it. */
export function report(fs: readonly Finding[]): string {
  const count = (s: Status) => fs.filter((f) => f.status === s).length;
  const failed = fs.filter((f) => f.status === "fail"), op = failed.filter((f) => f.actor === "operator").length;
  const width = Math.min(Math.max(0, ...fs.map((f) => f.id.length)), 56);
  return [`govern doctor: ${count("ok")} ok, ${failed.length} failed${op ? ` (${op} for the operator)` : ""}, ${count("skip")} skipped`,
    ...fs.flatMap((f) => [`${MARK[f.status]} ${f.id.padEnd(width)}  ${f.evidence}`, ...(f.fix ? [`    fix (${f.actor}): ${f.fix}`] : [])])].join("\n");
}
