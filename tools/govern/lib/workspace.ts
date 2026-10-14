// The workspace govern works in: GOVERN_REPO, else the nearest govern.config.json above the cwd; never guessed. Every path
// a lane, the queue, the processes or the tuning log live at comes from that file (relative to it) or an env override.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fail } from "./util.ts";
import { obj, str, posInt, record, parseFile } from "./shape.ts";

export const CONFIG_FILE = "govern.config.json";

/** The chat baseline `govern usage` compares against, and where it was measured. */
export interface Baseline { mainMedianCtx: number; subagentMedianCtx: number; source: string }
/** What a workspace keeps in its govern.config.json; each path is relative to the file. */
export interface WorkspaceConfig {
  /** The lanes' folder (required unless GOVERN_PROJECTS). */
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
}
const CONFIG = obj({}, {
  projects: str, queue: str, processes: str, workflow: str, tuningLog: str, packages: str, prompts: str, paths: record(str),
  baseline: obj({ mainMedianCtx: posInt, subagentMedianCtx: posInt, source: str }),
  capabilities: str, resources: (v: unknown) => v, allowances: (v: unknown) => v, state: str,
});

/** The nearest folder at or above `dir` that holds a govern.config.json, or undefined. */
function above(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, CONFIG_FILE))) return d;
    if (dirname(d) === d) return undefined;
  }
}
/** The workspace folder, or undefined when there is none (GOVERN_REPO unset and no config above the cwd). */
export const findRepo = (): string | undefined => process.env.GOVERN_REPO || above(process.cwd());
/** The workspace folder; no workspace is a clear error, never a guess. */
export const repo = (): string =>
  findRepo() ?? fail(`no ${CONFIG_FILE} at or above ${process.cwd()}: put one in the workspace root, or set GOVERN_REPO to that folder`);

const cache = new Map<string, WorkspaceConfig>();
/** The workspace's govern.config.json, typed and strictly checked; {} when the workspace has none. */
export function config(): WorkspaceConfig {
  const r = repo(), f = join(r, CONFIG_FILE);
  const hit = cache.get(f);
  if (hit) return hit;
  const c: WorkspaceConfig = existsSync(f) ? parseFile(f, readFileSync(f, "utf8"), CONFIG) : {};
  cache.set(f, c);
  return c;
}
const abs = (v: string | undefined): string | undefined => (v === undefined ? undefined : resolve(repo(), v));
/** A path the config must give: the error names the file and the key (an env override, when there is one, is tried first). */
function required(key: keyof WorkspaceConfig & string, env?: string): string {
  const e = env ? process.env[env] : undefined;
  if (e) return e;
  const v = config()[key];
  if (typeof v === "string") return resolve(repo(), v);
  const f = join(repo(), CONFIG_FILE);
  return fail(existsSync(f) ? `${f} has no "${key}"${env ? ` (or set ${env})` : ""}` : `no ${CONFIG_FILE} in ${repo()}: it must set "${key}"${env ? ` (or set ${env})` : ""}`);
}
const optional = (key: "processes" | "workflow" | "prompts" | "capabilities" | "state", env: string): string | undefined => process.env[env] || abs(config()[key]);

export const projectsDir = (): string => required("projects", "GOVERN_PROJECTS");
export const queueDir = (): string => required("queue", "GOVERN_QUEUE");
export const tuningLogFile = (): string => required("tuningLog", "GOVERN_TUNING_LOG");
export const packagesDir = (): string => required("packages");
/** The workspace's own processes folder, or undefined (built-in processes only) when there is none or no workspace. */
export const processesDir = (): string | undefined => (findRepo() ? optional("processes", "GOVERN_PROCESSES") : process.env.GOVERN_PROCESSES);
/** The workspace's workflow document (the video process's exit table), or undefined. */
export const workflowFile = (): string | undefined => optional("workflow", "GOVERN_WORKFLOW");
/** The workspace-wide prompts folder (GOVERN_PROMPTS replaces every prompts folder), or undefined. */
export const promptsDir = (): string | undefined => optional("prompts", "GOVERN_PROMPTS");
export const baseline = (): Baseline | undefined => config().baseline;
/** A named path from the config's "paths", absolute. */
export function pathNamed(name: string): string {
  const p = config().paths;
  const v = p && Object.hasOwn(p, name) ? p[name] : undefined;
  if (v === undefined) fail(`${join(repo(), CONFIG_FILE)} has no paths.${name} (a command uses {paths.${name}})`);
  return resolve(repo(), v!);
}
/** The workspace's capability grants folder: GOVERN_CAPABILITIES, the config's "capabilities", else beside the lanes. */
export const capabilitiesDir = (): string => optional("capabilities", "GOVERN_CAPABILITIES") ?? join(projectsDir(), "..", "capabilities");
/** Where locks live: GOVERN_STATE, the config's "state", else govern-state beside the lanes' folder. */
export const stateDir = (): string => optional("state", "GOVERN_STATE") ?? join(dirname(projectsDir()), "govern-state");
/** A workspace list govern reads elsewhere (lib/resources.ts, lib/allowances.ts check its shape). */
export type DeclaredKey = "resources" | "allowances";
/** The config's value for `key` and the file it came from, or undefined when there is no workspace or no such key. */
export function declaredSetting(key: DeclaredKey): { file: string; value: unknown } | undefined {
  const r = findRepo();
  if (!r) return undefined;
  const v = config()[key];
  return v === undefined ? undefined : { file: join(r, CONFIG_FILE), value: v };
}
