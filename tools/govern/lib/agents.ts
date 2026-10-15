// Agent registration: a session publishes its own inbox to peer hosts for named projects. Every name and alias is unique
// on its host and held by one owner, so NAME@HOST names exactly one agent. A stable name is chosen and refreshed; an
// ephemeral one is generated and ends with its session. Registering never grants a run: runners and profiles stay the
// owner's to grant.
import { randomBytes } from "node:crypto";
import { obj, arr, str, literal, posInt, check, reject, type Shape } from "./shape.ts";
import { name, iso, project, locked, readOr, write } from "./peer-id.ts";
import { sessions, isAlive } from "./sessions.ts";
import { runners } from "./queue.ts";
import { LEGACY_PROFILES } from "./caps.ts";
import { fail } from "./util.ts";

export const DEFAULT_TTL_S = 12 * 3600, MAX_TTL_S = 7 * 86400, EPHEMERAL_TTL_S = 3600, MAX_EPHEMERAL_TTL_S = 86400, MAX_DESCRIPTION = 200, MAX_ALIASES = 8;
/** Names no agent may register: the dispatcher runs them or govern itself sends as them. */
export const reserved = (): string[] => [...runners(), ...LEGACY_PROFILES, "auto", "owner", "dispatcher", "relay"];
/** Who holds a registration: a session id, a session name, or "terminal"; `pid`/`procStart` tie it to a running process. */
export interface Holder { owner: string; pid?: number; procStart?: string }
export interface Agent extends Holder {
  name: string; kind: "stable" | "ephemeral"; aliases: string[]; description: string; projects: string[]; registeredAt: string; expires: string;
}
const description: Shape<string> = (v, p) => { const s = str(v, p); return s.length <= MAX_DESCRIPTION && !/[\r\n]/.test(s) ? s : reject(p, `must be one line of at most ${MAX_DESCRIPTION} characters`); };
const AGENT: Shape<Agent> = obj({
  name, kind: literal("stable", "ephemeral"), aliases: arr(name), owner: str, description, projects: arr(project, { nonEmpty: true }), registeredAt: iso, expires: iso,
}, { pid: posInt, procStart: str });
const FILE = obj({ version: literal(2), agents: arr(AGENT) });
const load = (): Agent[] => readOr("agents.json", FILE, { version: 2 as const, agents: [] }).agents;
const save = (agents: Agent[]) => write("agents.json", { version: 2, agents });
/** Every name an agent answers to: its own, then its aliases. */
export const names = (a: Agent): string[] => [a.name, ...a.aliases];

/** Whether a registration still stands at `now`: unexpired; its process alive when one is recorded; and, when Claude
 *  Code's registry knows a session of its name, at least one such session still runs. */
export function alive(a: Agent, now: number, known = sessions()): boolean {
  if (Date.parse(a.expires) <= now) return false;
  if (a.pid !== undefined && !isAlive(a.pid, a.procStart)) return false;
  const same = known.filter(s => s.name === a.name);
  return !same.length || same.some(s => isAlive(s.pid, s.procStart));
}
/** Every standing registration at `now` whose names are still available for mailboxes. */
export const live = (now = Date.now()): Agent[] => { const known = sessions(), blocked = new Set(reserved()); return load().filter(a => !names(a).some(n => blocked.has(n)) && alive(a, now, known)); };
/** The standing agent that answers to `n` (its name or an alias), or undefined. */
export const resolve = (n: string, now = Date.now()): Agent | undefined => live(now).find(a => names(a).includes(n));

/** A fresh ephemeral name: `e-` and eight base32 letters, never a reserved or standing name. */
function ephemeralName(taken: Set<string>): string {
  for (;;) {
    const n = "e-" + [...randomBytes(8)].map(b => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
    if (!taken.has(n)) return n;
  }
}
/** Register, or refresh, an agent held by `holder`. A stable registration needs a name; an ephemeral one gets a
 *  generated name. Every name and alias must be free on this host or already held by the same owner. */
export function register(o: Holder & { name?: string; ephemeral?: boolean; aliases?: string[]; projects: string[]; description?: string; ttlSeconds?: number; now?: number }): Agent {
  const now = o.now ?? Date.now(), kind = o.ephemeral ? "ephemeral" : "stable";
  const ttl = o.ttlSeconds ?? (o.ephemeral ? EPHEMERAL_TTL_S : DEFAULT_TTL_S), max = o.ephemeral ? MAX_EPHEMERAL_TTL_S : MAX_TTL_S;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > max) fail(`--ttl must be a whole number of seconds from 60 to ${max} for a${o.ephemeral ? "n ephemeral" : " stable"} name`);
  if (o.ephemeral && o.name !== undefined) fail("an ephemeral name is generated: pass --ephemeral or --as, not both");
  if (!o.ephemeral && o.name === undefined) fail("a stable registration needs a name: --as NAME, GOVERN_AS, or --ephemeral");
  const aliases = [...new Set(o.aliases ?? [])];
  if (aliases.length > MAX_ALIASES) fail(`at most ${MAX_ALIASES} aliases`);
  if (o.projects.includes("*") && o.projects.length !== 1) fail('"*" must be the only project');
  return locked(() => {
    const standing = live(now), others = standing.filter(a => o.ephemeral || a.name !== o.name);
    const taken = new Set(standing.flatMap(names));
    const n = o.name ?? ephemeralName(taken);
    for (const x of [n, ...aliases]) {
      if (reserved().includes(x)) fail(`${x} is a runner, profile or govern name: only the owner grants it to peers (govern mesh policy, govern peer add)`);
      const holder = others.find(a => names(a).includes(x));
      if (holder) fail(`${x} is held by ${holder.name === x ? "another agent" : `agent ${holder.name}`} on this host until ${holder.expires}: names are unique per host`);
    }
    const mine = standing.find(a => a.name === n);
    if (mine && mine.owner !== o.owner) fail(`${n} is held by another owner on this host until ${mine.expires}: names are unique per host`);
    if (aliases.includes(n)) fail("an alias must differ from the name");
    const a = check("agent", {
      name: n, kind, aliases, owner: o.owner, description: o.description ?? "", projects: [...new Set(o.projects)],
      registeredAt: mine?.registeredAt ?? new Date(now).toISOString(), expires: new Date(now + ttl * 1000).toISOString(),
      ...(o.pid !== undefined ? { pid: o.pid } : {}), ...(o.procStart !== undefined ? { procStart: o.procStart } : {}),
    }, AGENT);
    save([...standing.filter(x => x.name !== n), a]);
    return a;
  });
}
/** Remove `n`'s registration when `owner` holds it; false when it had none. */
export function unregister(n: string, owner: string, now = Date.now()): boolean {
  return locked(() => {
    const a = live(now).find(x => x.name === n);
    if (!a) return false;
    if (a.owner !== owner) fail(`${n} is held by another owner`);
    save(load().filter(x => x.name !== n)); return true;
  });
}
