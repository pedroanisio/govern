// Outside services a workspace depends on, as systemd sees them: named units from the `watch` config, their state and how
// long since each last succeeded. Read only, and never fatal: a missing unit, a host without systemd or an unreachable
// bus is a reported state, because this runs on the desk and in the notifier.
import { spawnSync } from "node:child_process";
import { clip } from "./util.ts";
import { config, findRepo, type WorkspaceConfig } from "./workspace.ts";

export type Scope = "user" | "system";
/** ok: nothing to say. problem: raises an alert. pending: mid-transition or unreadable, so the outcome is not known yet and an
 *  open alert neither closes nor repeats. */
export type Health = "ok" | "problem" | "pending";
export interface UnitState { scope: Scope; unit: string; health: Health; state: string; lastSuccess: string }
export interface ScopeGap { scope: Scope; reason: string }
export interface Watched { units: UnitState[]; gaps: ScopeGap[] }
export interface ServiceAlert { key: string; text: string }

/** How long an `active` unit must have stayed up to count as healthy: a crash loop passes through `active` between failures. */
export const STABLE_MS = 60_000;
const QUERY_MS = 3000;
const PROPERTIES = ["LoadState", "ActiveState", "SubState", "Result", "Type", "ExecMainStatus", "ExecMainExitTimestamp", "ActiveEnterTimestamp", "ActiveExitTimestamp"];
/** systemd's catalog ids for "Started/Finished" and "Deactivated successfully": the journal's record of a oneshot that worked. */
const SUCCESS_IDS = ["39f53479d3a045ac8e11786248231fbf", "7ad2d189f7e94e70a38c781354912448"];

const scopeArg = (s: Scope): string[] => (s === "user" ? ["--user"] : []);
const unixMs = (v: string | undefined): number | undefined => { const m = /^@(\d+)$/.exec(v ?? ""); return m ? Number(m[1]) * 1000 : undefined; };

/** `n` ago, in the desk's units. */
const since = (ms: number, now: number): string => {
  const m = Math.max(Math.round((now - ms) / 60000), 0);
  return `${m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`} ago`;
};

/** The newest success the journal records for a oneshot, or undefined when it holds none or cannot be read. */
function journalSuccess(scope: Scope, unit: string): number | undefined {
  const r = spawnSync("journalctl", [...scopeArg(scope), "-u", unit, ...SUCCESS_IDS.map((id) => `MESSAGE_ID=${id}`), "-n", "1", "-o", "short-unix", "--no-pager"], { encoding: "utf8", timeout: QUERY_MS });
  const line = r.status === 0 ? r.stdout.split("\n").findLast((l) => /^\d+(\.\d+)?\s/.test(l)) : undefined;
  return line ? Number(line.split(/\s/)[0]) * 1000 : undefined;
}

/** When the unit last worked, in words. An `active` unit works now. A oneshot worked when it exited 0 or when the journal says
 *  so. A long-running unit that is down has no success event: a start proves nothing, so its last time up is what is known. */
function lastSuccess(scope: Scope, unit: string, p: Record<string, string>, now: number): string {
  if (p.ActiveState === "active") return "now";
  const oneshot = p.Type === "oneshot";
  const exited = oneshot && p.ExecMainStatus === "0" ? unixMs(p.ExecMainExitTimestamp) : undefined;
  if (exited !== undefined) return `last success ${since(exited, now)}`;
  if (oneshot) { const j = journalSuccess(scope, unit); return j === undefined ? "no success recorded" : `last success ${since(j, now)}`; }
  const up = unixMs(p.ActiveExitTimestamp);
  return up === undefined ? "no success recorded" : `last active ${since(up, now)}`;
}

/** What systemd's properties mean for the watch. */
export function classify(p: Record<string, string>, now: number): { health: Health; state: string } {
  if (p.LoadState !== "loaded") return { health: "problem", state: p.LoadState === "not-found" ? "not found" : p.LoadState || "unknown" };
  const sub = p.SubState ?? "";
  switch (p.ActiveState) {
    case "failed": return { health: "problem", state: `failed (${p.Result || "unknown"}${p.ExecMainStatus && p.ExecMainStatus !== "0" ? `, exit ${p.ExecMainStatus}` : ""})` };
    case "activating": return sub.startsWith("auto-restart") ? { health: "problem", state: "restarting after a failure" } : { health: "pending", state: "activating" };
    case "active": {
      const up = unixMs(p.ActiveEnterTimestamp);
      return up !== undefined && now - up < STABLE_MS ? { health: "pending", state: "just started" } : { health: "ok", state: "active" };
    }
    case "inactive": return { health: "ok", state: "inactive" };
    default: return { health: "pending", state: p.ActiveState || "unknown" };
  }
}

/** `systemctl show` of one unit: its properties, or why this scope cannot be asked. A missing unit is not an error here:
 *  systemctl answers LoadState=not-found with status 0. */
function show(scope: Scope, unit: string): Record<string, string> | { gap: string } {
  const r = spawnSync("systemctl", [...scopeArg(scope), "show", "--timestamp=unix", `--property=${PROPERTIES.join(",")}`, "--", unit], { encoding: "utf8", timeout: QUERY_MS });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { gap: "no systemctl on this host" };
  if (code === "ETIMEDOUT") return { gap: `systemctl did not answer in ${QUERY_MS / 1000} s` };
  if (r.error) return { gap: `systemctl could not run (${code ?? r.error.name})` };
  if (r.status !== 0) return { gap: clip((r.stderr.split("\n").find(Boolean) ?? `systemctl exited ${r.status}`).trim(), 120) };
  return Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

/** Every configured unit's state at `now`. A scope that cannot be asked gives one gap and its units as pending. */
export function watched(now = Date.now(), watch: WorkspaceConfig["watch"] = findRepo() ? config().watch : undefined): Watched {
  const units: UnitState[] = [], gaps: ScopeGap[] = [];
  for (const scope of ["user", "system"] as const) {
    let gap: string | undefined;
    for (const unit of watch?.[scope] ?? []) {
      const p: ReturnType<typeof show> = gap === undefined ? show(scope, unit) : { gap };
      if ("gap" in p) { gap ??= p.gap as string; units.push({ scope, unit, health: "pending", state: "not known", lastSuccess: "not known" }); continue; }
      const { health, state } = classify(p, now);
      units.push({ scope, unit, health, state, lastSuccess: health === "problem" && state === "not found" ? "not known" : lastSuccess(scope, unit, p, now) });
    }
    if (gap !== undefined) gaps.push({ scope, reason: gap });
  }
  return { units, gaps };
}

/** The desk's section; none when nothing is watched. */
export function serviceLines(w: Watched = watched()): string[] {
  if (!w.units.length) return [];
  const width = Math.max(...w.units.map((u) => u.unit.length));
  return ["", `SERVICES (${w.units.length})`,
    ...w.units.map((u) => `  ${u.unit.padEnd(width)} ${u.scope === "system" ? "system " : ""}${u.health === "problem" ? "✖ " : ""}${u.state} · ${u.lastSuccess}`),
    ...w.gaps.map((g) => `  ${g.scope} services not readable: ${g.reason}`)];
}

/** The alert key of a unit: per scope and unit, so one failure episode of one unit is one alert. */
export const unitKey = (u: Pick<UnitState, "scope" | "unit">): string => `channel:service:${u.scope}:${u.unit}`;
const gapKey = (scope: Scope): string => `channel:service:${scope}`;
const describe = (u: UnitState): string => `Service ${u.unit} (${u.scope}): ${u.state}; ${u.lastSuccess}`;

/** What should be open right now: one alert per failing unit and per unreadable scope. `held` are the keys of units whose
 *  outcome is not known yet: a run in progress neither closes an open alert nor opens one, so one failure episode is one post. */
export function serviceAlerts(w: Watched): { alerts: ServiceAlert[]; held: Map<string, string> } {
  return {
    alerts: [...w.units.filter((u) => u.health === "problem").map((u) => ({ key: unitKey(u), text: describe(u) })),
      ...w.gaps.map((g) => ({ key: gapKey(g.scope), text: `Services (${g.scope}) not readable: ${g.reason}` }))],
    held: new Map(w.units.filter((u) => u.health === "pending").map((u) => [unitKey(u), describe(u)])),
  };
}
