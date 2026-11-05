// The workspace govern works in: GOVERN_REPO, else the nearest folder above the cwd that holds a govern.config.json or a
// .govern/ folder; never guessed. A govern.config.json gives every path a lane, the queue, the processes or the tuning log
// live at (relative to it); a .govern/ folder is the convention: each folder defaults inside it, and an optional
// .govern/config.json (same keys, relative to .govern/) overrides. An env override wins over both.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fail } from "./util.ts";
import { obj, str, bool, posInt, record, arr, parseFile, reject, type Shape } from "./shape.ts";
import { RESOURCES } from "./resources.ts";
import { EXTENSION_NAMES } from "./ext-registry.ts";

export const CONFIG_FILE = "govern.config.json";
/** The conventional workspace folder; its parent is the workspace root. */
export const DOT_DIR = ".govern";
/** Where each folder lives inside .govern/ when its config.json does not say. */
export const DOT_DEFAULTS = {
  projects: "projects", queue: "queue", tuningLog: "tuning.jsonl", processes: "processes", state: "state", capabilities: "capabilities",
} as const;

/** The chat baseline `govern usage` compares against, and where it was measured. */
export interface Baseline { mainMedianCtx: number; subagentMedianCtx: number; source: string }
/** What a workspace keeps in its govern.config.json; each path is relative to the file. */
export interface WorkspaceConfig {
  /** The extensions this workspace enables (lib/ext.ts; GOVERN_EXTENSIONS overrides): none by default. */
  extensions?: string[];
  /** The lanes' folder (required unless GOVERN_PROJECTS). */
  mailboxes?: string[]; mailTtlHours?: number;
  projects?: string; queue?: string; processes?: string; workflow?: string; tuningLog?: string; packages?: string; prompts?: string;
  /** Named paths a lane's command can use as {paths.NAME}. */
  paths?: Record<string, string>; baseline?: Baseline;
  /** The workspace's capability grants folder (default: capabilities beside the lanes' folder). */
  capabilities?: string;
  /** The resource registry: a file (relative to the config) or the list itself; lib/resources.ts checks its shape. */
  resources?: unknown;
  /** The allowances: a file (relative to the config) or the list itself; lib/allowances.ts checks its shape. */
  allowances?: unknown;
  /** Where locks and other shared run state live (default: govern-state beside the lanes' folder). */
  state?: string;
  /** The systemd units `govern desk`, `slack digest` and `slack notify` report on (lib/services.ts), by systemctl scope. */
  watch?: { user?: string[]; system?: string[] };
  /** Trusted local NDJSON conversation adapters; task runners remain separate. */
  conversationAdapters?: Record<string, { argv: string[] }>;
  /** Jev decisions (ext/decide/decide.ts): shadow asks about every TASK sent; envFile is a dotenv file holding TYPESAFE_API_KEY. */
  decide?: { shadow?: boolean; envFile?: string };
  /** Slack (ext/slack): the team whose signed requests count; envFile is a dotenv file holding SLACK_SIGNING_SECRET and
   *  SLACK_BOT_TOKEN; channel is where `govern slack notify` posts; labels name the decision buttons. */
  slack?: { team: string; envFile?: string; channel?: string; labels?: { complete?: string; approve?: string; reject?: string };
    botTokenVar?: string; bot?: string[]; requesters?: Record<string, string>; tags?: string[]; inbox?: string;
    /** publishers (Slack user ids) may publish a checked routed reply offered in the review channel (publish.ts). */
    route?: { to: string; profile: string; maxPerHour: number; publishers?: string[]; review?: string };
    alerts?: { listenStaleSec: number; unansweredSec: number };
    /** Every post gets a disposition (ext/slack/triage.ts); rules map posts that need no reply, by name and pattern. */
    triage?: { rules: { name: string; pattern: string }[] };
    /** An agent session's heartbeat file (ext/slack/heartbeat.ts): `notify` posts `blocked:` when its mtime is older than
     *  staleSeconds (default 1800) and `note:` when it moves again; name is who the messages call the session's owner. */
    heartbeat?: { file: string; staleSeconds?: number; name?: string };
    upload?: { roots: string[]; maxBytes: number };
    /** One card per case in the channel, updated in place, with what the case waits on and its alerts in its thread. */
    threads?: boolean;
    /** Send back asks for a reason and editable gate options get an Edit button, both as Slack forms (serve needs the bot token). */
    forms?: boolean };
}
/** A file path, or the list shape lib/resources.ts checks (kept as written: resources() builds the registry). */
const resourcesShape: Shape<unknown> = (v, p) => (typeof v === "string" ? v : (RESOURCES(v, p), v));
/** The extensions a workspace enables: each a name lib/ext-registry.ts knows, none twice. */
export const extensionsShape: Shape<string[]> = (v, p) => {
  const names = arr(str)(v, p), seen = new Set<string>();
  names.forEach((n, i) => {
    if (!EXTENSION_NAMES.includes(n)) reject(`${p}[${i}]`, `unknown extension "${n}" (known: ${EXTENSION_NAMES.join(", ")})`);
    if (seen.has(n)) reject(`${p}[${i}]`, `extension "${n}" is listed twice`);
    seen.add(n);
  });
  return names;
};
/** A full systemd unit name: never read as an option, and always with its type, so a key names one unit. */
const unitName: Shape<string> = (v, p) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9:_.\\@-]*\.(service|socket|timer|path|mount|automount|target|swap|slice|scope|device)$/.test(v)) reject(p, `must be a systemd unit name with its type, such as backup.service`);
  return v as string;
};
/** A string with something besides white space in it; `what` names it in the error. */
const nonEmpty = (what: string): Shape<string> => (v, p) => { const s = str(v, p); if (!s.trim()) reject(p, `must be ${what}`); return s; };
const CONFIG = obj({}, {
  watch: obj({}, { user: arr(unitName), system: arr(unitName) }),
  extensions: extensionsShape,
  mailboxes: arr(str), mailTtlHours: posInt,
  projects: str, queue: str, processes: str, workflow: str, tuningLog: str, packages: str, prompts: str, paths: record(str),
  baseline: obj({ mainMedianCtx: posInt, subagentMedianCtx: posInt, source: str }),
  capabilities: str, resources: resourcesShape, allowances: (v: unknown) => v, state: str, decide: obj({}, { shadow: bool, envFile: str }),
  slack: obj({ team: str }, { envFile: str, channel: str, labels: obj({}, { complete: str, approve: str, reject: str }),
    botTokenVar: (v: unknown, p: string) => { const n = str(v, p); if (/^[A-Za-z_][A-Za-z0-9_]*$/.exec(n)?.[0] !== n) reject(p, "must name an environment variable"); return n; },
    bot: arr(str), requesters: record(str), tags: arr(str), inbox: str,
    route: obj({ to: str, profile: str, maxPerHour: posInt }, { publishers: arr(str, { nonEmpty: true }), review: str }),
    alerts: obj({ listenStaleSec: posInt, unansweredSec: posInt }),
    triage: obj({ rules: arr(obj({ name: str, pattern: (v: unknown, p: string) => {
      const s = str(v, p); try { new RegExp(s); } catch { reject(p, "must be a valid regular expression"); } return s; } })) }),
    upload: obj({ roots: arr(str, { nonEmpty: true }), maxBytes: posInt }),
    heartbeat: obj({ file: nonEmpty("a non-empty path") }, { staleSeconds: posInt, name: nonEmpty("a non-empty name") }),
    threads: bool,
    forms: bool,
  }),
  conversationAdapters: record(obj({argv: arr(str, {nonEmpty: true})})),
});

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** Which marker `dir` holds: "config" (govern.config.json), "dot" (a .govern/ folder) or none; both is refused. */
function marker(dir: string): "config" | "dot" | undefined {
  const cfg = existsSync(join(dir, CONFIG_FILE)), dot = isDir(join(dir, DOT_DIR));
  if (cfg && dot) fail(`${dir} has both ${DOT_DIR}/ and ${CONFIG_FILE}: keep one (move the config's keys to ${DOT_DIR}/config.json, or remove ${DOT_DIR}/)`);
  return cfg ? "config" : dot ? "dot" : undefined;
}
/** The nearest folder at or above `dir` that holds a govern.config.json or a .govern/ folder, or undefined. GOVERN_CEILING
 *  ends the search: that folder and everything above it are not looked at, as git's GIT_CEILING_DIRECTORIES. */
function above(dir: string): string | undefined {
  const ceiling = process.env.GOVERN_CEILING ? resolve(process.env.GOVERN_CEILING) : undefined;
  for (let d = resolve(dir); d !== ceiling; d = dirname(d)) {
    if (marker(d)) return d;
    if (dirname(d) === d) return undefined;
  }
  return undefined;
}
/** The workspace folder, or undefined when there is none (GOVERN_REPO unset and no config above the cwd). */
export const findRepo = (): string | undefined => (process.env.GOVERN_REPO ? resolve(process.env.GOVERN_REPO) : above(process.cwd()));
/** The workspace folder; no workspace is a clear error, never a guess. */
export const repo = (): string =>
  findRepo() ?? fail(`no ${CONFIG_FILE} or ${DOT_DIR}/ at or above ${process.cwd()}: run \`govern init\` in the workspace root, or set GOVERN_REPO to that folder`);
/** True when the workspace follows the .govern/ convention (no govern.config.json). */
const dotted = (): boolean => marker(repo()) === "dot";
/** The workspace's config file: govern.config.json, or .govern/config.json (which need not exist). */
export const configFile = (): string => (dotted() ? join(repo(), DOT_DIR, "config.json") : join(repo(), CONFIG_FILE));
/** What the config's relative paths resolve against: the root, or .govern/. */
const base = (): string => dirname(configFile());
/** The conventional path of `key` inside .govern/, when the workspace follows the convention. */
const dotDefault = (key: keyof typeof DOT_DEFAULTS): string | undefined => (dotted() ? join(base(), DOT_DEFAULTS[key]) : undefined);

/** Make `dir` a workspace by the convention: .govern/ with its folders and a .gitignore for run state (lanes and their
 *  ledgers are the record and stay tracked; locks and job logs are not). Refuses a folder that already is one. */
export function initWorkspace(dir: string, o: { nested?: boolean } = {}): string {
  const root = resolve(dir);
  if (marker(root)) fail(`${root} is already a govern workspace`);
  // A workspace below another shadows it for every command run under it: only on purpose.
  const outer = dirname(root) === root ? undefined : above(dirname(root));
  if (outer && !o.nested) fail(`${root} is inside the govern workspace at ${outer}: commands run under it would stop finding that one (pass --nested if that is the point)`);
  const g = join(root, DOT_DIR);
  for (const f of ["projects", "queue", "processes"]) mkdirSync(join(g, f), { recursive: true });
  writeFileSync(join(g, ".gitignore"), "# run state: locks, instances, reservations, job logs\nstate/\nprojects/**/govern/jobs/\n");
  return g;
}

const cache = new Map<string, WorkspaceConfig>();
/** The workspace's govern.config.json, typed and strictly checked; {} when the workspace has none. */
export function config(): WorkspaceConfig {
  const f = configFile();
  const hit = cache.get(f);
  if (hit) return hit;
  const c: WorkspaceConfig = existsSync(f) ? parseFile(f, readFileSync(f, "utf8"), CONFIG) : {};
  cache.set(f, c);
  return c;
}
const abs = (v: string | undefined): string | undefined => (v === undefined ? undefined : resolve(base(), v));
/** A path the config must give: the error names the file and the key (an env override, when there is one, is tried first). */
function required(key: keyof WorkspaceConfig & string, env?: string): string {
  const e = env ? process.env[env] : undefined;
  if (e) return e;
  const v = config()[key];
  if (typeof v === "string") return resolve(base(), v);
  const d = Object.hasOwn(DOT_DEFAULTS, key) ? dotDefault(key as keyof typeof DOT_DEFAULTS) : undefined;
  if (d) return d;
  const f = configFile();
  return fail(existsSync(f) ? `${f} has no "${key}"${env ? ` (or set ${env})` : ""}` : `no ${CONFIG_FILE} in ${repo()}: it must set "${key}"${env ? ` (or set ${env})` : ""}`);
}
/** An optional folder: the env override, else the config's key; undefined when neither, and with no workspace. */
const optional = (key: "processes" | "workflow" | "prompts" | "capabilities" | "state", env: string): string | undefined =>
  process.env[env] || (findRepo() ? abs(config()[key]) ?? (Object.hasOwn(DOT_DEFAULTS, key) ? dotDefault(key as keyof typeof DOT_DEFAULTS) : undefined) : undefined);

/** The lanes' folder: GOVERN_PROJECTS, else the config's "projects", else .govern/projects; none of them is a GovernError. */
export const projectsDir = (): string => required("projects", "GOVERN_PROJECTS");
/** The queue folder: GOVERN_QUEUE, else the config's "queue", else .govern/queue; none of them is a GovernError. */
export const queueDir = (): string => required("queue", "GOVERN_QUEUE");
/** The tuning log: GOVERN_TUNING_LOG, else the config's "tuningLog", else .govern/tuning.jsonl; none of them is a GovernError. */
export const tuningLogFile = (): string => required("tuningLog", "GOVERN_TUNING_LOG");
/** The packages folder from the config's "packages" (no env override, no .govern default); unset is a GovernError. */
export const packagesDir = (): string => required("packages");
/** The workspace's own processes folder, or undefined (built-in processes only) when there is none or no workspace. */
export const processesDir = (): string | undefined => optional("processes", "GOVERN_PROCESSES");
/** The workspace's workflow document (the video process's exit table), or undefined. */
export const workflowFile = (): string | undefined => optional("workflow", "GOVERN_WORKFLOW");
/** The workspace-wide prompts folder (GOVERN_PROMPTS replaces every prompts folder), or undefined. */
export const promptsDir = (): string | undefined => optional("prompts", "GOVERN_PROMPTS");
/** The config's chat baseline for `govern usage`, or undefined when it gives none. */
export const baseline = (): Baseline | undefined => config().baseline;
/** The config's slack settings, envFile, inbox, heartbeat file and upload roots absolute; undefined when the workspace has none. */
export const slackConfig = (): NonNullable<WorkspaceConfig["slack"]> | undefined => {
  const c = findRepo() ? config().slack : undefined;
  return c && { ...c, ...(c.envFile ? { envFile: resolve(base(), c.envFile) } : {}),
    ...(c.inbox ? { inbox: resolve(base(), c.inbox) } : {}),
    ...(c.heartbeat ? { heartbeat: { ...c.heartbeat, file: resolve(base(), c.heartbeat.file) } } : {}),
    ...(c.upload ? { upload: { ...c.upload, roots: c.upload.roots.map(r => resolve(base(), r)) } } : {}) };
};
/** The config's decide settings, envFile absolute. */
export const decideConfig = (): { shadow: boolean; envFile?: string } => {
  const d = findRepo() ? config().decide : undefined;
  return { shadow: d?.shadow === true, ...(d?.envFile ? { envFile: resolve(base(), d.envFile) } : {}) };
};
/** `text` with {repo}, {dir} and {paths.NAME} expanded: the one expansion every command and runner argv goes through. */
export const expandPlaceholders = (text: string, dir: string): string =>
  text.replaceAll("{repo}", repo()).replaceAll("{dir}", dir).replace(/\{paths\.([^{}]+)\}/g, (_, n: string) => pathNamed(n));
/** A named path from the config's "paths", absolute (relative entries resolve against the config's folder);
 *  undefined when the config has no such key. Own keys only: "constructor" is not a path just because objects have it. */
export function pathEntry(name: string): string | undefined {
  const p = config().paths;
  const v = p && Object.hasOwn(p, name) ? p[name] : undefined;
  return v === undefined ? undefined : resolve(base(), v);
}
/** A named path from the config's "paths", absolute. */
export function pathNamed(name: string): string {
  return pathEntry(name) ?? fail(`${configFile()} has no paths.${name} (a command uses {paths.${name}})`);
}
/** The workspace's capability grants folder: GOVERN_CAPABILITIES, the config's "capabilities", else beside the lanes;
 *  undefined with no workspace (built-in capabilities only). */
export const capabilitiesDir = (): string | undefined =>
  optional("capabilities", "GOVERN_CAPABILITIES") ?? (findRepo() ? join(projectsDir(), "..", "capabilities") : undefined);
/** Where locks live: GOVERN_STATE, the config's "state", else govern-state beside the lanes' folder. */
export const stateDir = (): string => optional("state", "GOVERN_STATE") ?? join(dirname(projectsDir()), "govern-state");
/** A workspace list govern reads elsewhere (lib/resources.ts, lib/allowances.ts check its shape). */
export type DeclaredKey = "resources" | "allowances";
/** The config's value for `key` and the file it came from, or undefined when there is no workspace or no such key. */
export function declaredSetting(key: DeclaredKey): { file: string; value: unknown } | undefined {
  const r = findRepo();
  if (!r) return undefined;
  const v = config()[key];
  return v === undefined ? undefined : { file: configFile(), value: v };
}
