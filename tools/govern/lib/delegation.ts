// Workspace standing authority: immutable grant/revoke events, resolved per process, gate and person.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SOURCE, verifyQuote, type Source } from "./approval.ts";
import { getProcess, type GateDef, type Process } from "./process.ts";
import { configFile, stateDir } from "./workspace.ts";
import { withLaneLock } from "./lane-lock.ts";
import { arr, obj, name, str, literal, parseFile, reject, type Shape } from "./shape.ts";
import { fail, usage, nowIso, writeJson } from "./util.ts";

export interface Delegation {
  process: string; gates: string[]; to: string; quote: string; source: Source;
  at: string; by: "owner"; action: "delegate" | "revoke";
}
const timestamp: Shape<string> = (v, p) => {
  const s = str(v, p);
  if (Number.isNaN(Date.parse(s))) reject(p, "must be a timestamp");
  return s;
};
/** Validate a recorded grant or revocation; a function avoids eager initialization through the process/project cycle. */
export function DELEGATION(v: unknown, p: string): Delegation {
  return obj({
    process: name, gates: arr(name, { nonEmpty: true }), to: name, quote: str, source: SOURCE,
    at: timestamp, by: literal("owner"), action: literal("delegate", "revoke"),
  })(v, p);
}
/** Beside the workspace config: .govern/delegations.json by convention; delegations.json for legacy config workspaces. */
export const delegationFile = () => join(dirname(configFile()), "delegations.json");
/** Read the strictly validated grant/revoke history, or an empty history before the first delegation. */
export function delegationHistory(): Delegation[] {
  const file = delegationFile();
  return existsSync(file) ? parseFile(file, readFileSync(file, "utf8"), arr(DELEGATION)) : [];
}
function covering(history: Delegation[], process: string, gate: string, to: string): Delegation | undefined {
  const latest = history.findLast((d) => d.process === process && d.to === to && d.gates.includes(gate));
  return latest?.action === "delegate" ? latest : undefined;
}
/** Recheck the lane's own process definition, including frozen snapshots: authority never transfers to owner gates. */
export function activeDelegation(pr: Process, g: GateDef, to: string): Delegation | undefined {
  if (to === "owner" || g.owner !== to || g.policy || !Object.hasOwn(pr.people ?? {}, to)) return undefined;
  return covering(delegationHistory(), pr.name, g.name, to);
}
/** Verify the owner's words once, at delegation (and again for revocation); append history under a workspace lock. */
export function recordDelegation(process: string, gate: string, to: string, quote: string, revoke = false): Delegation {
  const pr = getProcess(process);
  if (to === "owner" || !Object.hasOwn(pr.people ?? {}, to)) fail("--to must name a process person other than owner");
  const gates = gate === "*" ? pr.gates.filter((g) => g.owner === to && !g.policy) : pr.gates.filter((g) => g.name === gate);
  if (!gates.length || gates.some((g) => g.owner !== to || g.policy)) fail(`delegation covers only gates owned by ${to} without an approval policy`);
  if (quote.trim().length < 2) usage("--quote is required: the owner's words delegating or revoking gate decisions");
  const source = verifyQuote(quote);
  const event: Delegation = { process: pr.name, gates: gates.map((g) => g.name), to, quote, source, at: nowIso(), by: "owner", action: revoke ? "revoke" : "delegate" };
  return withLaneLock(join(stateDir(), "delegations-lock"), () => {
    writeJson(delegationFile(), [...delegationHistory(), event]);
    return event;
  });
}
/** List every historical event with its provenance and the gates still active under that grant. */
export function listDelegations(): string {
  const history = delegationHistory();
  return history.map((d) => {
    const active = d.gates.filter((gate) => covering(history, d.process, gate, d.to) === d);
    return `${d.action} ${d.process} ${d.gates.join(",")} --to ${d.to} · ${active.length ? `active: ${active.join(",")}` : "inactive"} · by ${d.by} at ${d.at} · ${JSON.stringify(d.source)} · "${d.quote}"`;
  }).join("\n") || "no standing delegations";
}
