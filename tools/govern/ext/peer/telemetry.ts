// One host's telemetry: dispatcher, mesh membership, queue and relay health, the last day's runs and spend, agents and
// recent messages. Read from files only; no model runs. Message bodies never leave the host: summaries and routing do.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { obj, str, bool, arr, literal, record, reject, type Shape } from "../../lib/shape.ts";
import { name, iso, project, hex64, identity, fingerprint } from "../../lib/peer-id.ts";
import { dispatcherInfo } from "../../lib/desk.ts";
import { liveSessions } from "../../lib/sessions.ts";
import { readJsonl, clip } from "../../lib/util.ts";
import * as mesh from "./mesh.ts";
import * as agents from "../../lib/agents.ts";
import * as queue from "../../lib/queue.ts";

export const RECENT = 40, DAY_MS = 86400_000;
const count: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a whole number, 0 or more"));
const num: Shape<number> = (v, p) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : reject(p, "must be a number, 0 or more"));

export interface Runs { count: number; ok: number; failed: number; seconds: number; input: number; output: number; costUsd: number }
export interface Recent {
  id: string; state: string; kind: string; from: string; to: string; project: string; task: string; summary: string; created: string;
  closedBy?: string; note?: string;
  remote?: string; attempts?: number; lastError?: string; ok?: boolean; seconds?: number; costUsd?: number;
}
export interface Telemetry {
  protocol: "govern-telemetry/1"; host: string; fingerprint: string; at: string;
  dispatcher: { running: boolean; since?: string; interval?: number };
  mesh?: { name: string; registrar: boolean; syncedAt: string; certExpires?: string; members: number; observers: string[] };
  peers: number;
  queue: { open: number; claimed: number; done: number; failed: number; unverified: number };
  relay: { outboundOpen: number; retrying: number; failed24h: number; delivered24h: number; inbound24h: number; lastError?: string };
  runs24h: Runs; byAgent: Record<string, Runs>;
  agents: { runners: string[]; sessions: string[]; registered: { name: string; kind: "stable" | "ephemeral"; aliases: string[]; projects: string[]; expires: string; description?: string }[] };
  recent: Recent[];
}
const RUNS: Shape<Runs> = obj({ count, ok: count, failed: count, seconds: num, input: count, output: count, costUsd: num });
const RECENT_SHAPE: Shape<Recent> = obj(
  { id: str, state: literal("open", "claimed", "done", "failed"), kind: str, from: str, to: str, project: str, task: str, summary: str, created: iso },
  { closedBy: str, note: str, remote: name, attempts: count, lastError: str, ok: bool, seconds: num, costUsd: num },
);
/** The closed shape of a telemetry answer: a command center parses a remote host's answer with it before showing it. */
export const TELEMETRY: Shape<Telemetry> = obj({
  protocol: literal("govern-telemetry/1"), host: name, fingerprint: hex64, at: iso,
  dispatcher: obj({ running: bool }, { since: iso, interval: num }),
  peers: count,
  queue: obj({ open: count, claimed: count, done: count, failed: count, unverified: count }),
  relay: obj({ outboundOpen: count, retrying: count, failed24h: count, delivered24h: count, inbound24h: count }, { lastError: str }),
  runs24h: RUNS, byAgent: record(RUNS),
  agents: obj({ runners: arr(str), sessions: arr(str), registered: arr(obj({ name, kind: literal("stable", "ephemeral"), aliases: arr(name), projects: arr(project), expires: iso }, { description: str })) }),
  recent: arr(RECENT_SHAPE),
}, { mesh: obj({ name, registrar: bool, syncedAt: iso, members: count, observers: arr(name) }, { certExpires: iso }) }) as Shape<Telemetry>;

const zero = (): Runs => ({ count: 0, ok: 0, failed: 0, seconds: 0, input: 0, output: 0, costUsd: 0 });
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
/** Add one ledger run to `r`. Ledger lines are this host's own records; a field that is missing or not a number counts 0. */
function add(r: Runs, e: Record<string, unknown>): void {
  const u = (e.usage ?? {}) as Record<string, unknown>;
  r.count++; if (e.ok === true) r.ok++; else r.failed++;
  r.seconds += n(e.seconds); r.input += Math.round(n(u.input)); r.output += Math.round(n(u.output)); r.costUsd += n(u.costUsd);
}

/** This host's telemetry at `now`. */
export function snapshot(o: { peers: number; now?: number }): Telemetry {
  const now = o.now ?? Date.now(), since = now - DAY_MS, me = identity(), rows = queue.all();
  const d = dispatcherInfo(), m = mesh.state();
  const self = m?.members.find(x => x.publicKey === me.publicKey);
  const recentDay = (iso: string | undefined) => !!iso && Date.parse(iso) >= since;
  const remoteOut = rows.filter(x => x.m.to.includes("@"));
  const runs = zero(), byAgent: Record<string, Runs> = Object.create(null);
  const ledger = join(queue.QUEUE(), "ledger.jsonl");
  for (const e of existsSync(ledger) ? readJsonl(ledger) : []) {
    if (!e || typeof e !== "object" || e.kind === "relay" || !recentDay(typeof e.t === "string" ? e.t : undefined)) continue;
    const agent = typeof e.agent === "string" && e.agent ? e.agent : "unknown";
    add(runs, e); add(byAgent[agent] ??= zero(), e);
  }
  const lastFailure = [...remoteOut].reverse().find(x => x.m.relay?.lastError || (x.state === "failed" && x.m.result?.error))?.m;
  const lastError = lastFailure?.relay?.lastError ?? lastFailure?.result?.error;
  return {
    protocol: "govern-telemetry/1", host: me.name, fingerprint: fingerprint(me.publicKey), at: new Date(now).toISOString(),
    dispatcher: d ? { running: d.running, since: d.started, ...(typeof d.interval === "number" ? { interval: d.interval } : {}) } : { running: false },
    ...(m ? { mesh: { name: m.mesh.name, registrar: mesh.isRegistrar(), syncedAt: m.syncedAt, ...(self ? { certExpires: self.expires } : {}), members: m.members.length, observers: mesh.observers() } } : {}),
    peers: o.peers,
    queue: {
      open: rows.filter(x => x.state === "open").length, claimed: rows.filter(x => x.state === "claimed").length,
      done: rows.filter(x => x.state === "done").length, failed: rows.filter(x => x.state === "failed").length,
      unverified: rows.filter(x => x.m.verification?.state === "unverified" && x.state !== "done").length,
    },
    relay: {
      outboundOpen: remoteOut.filter(x => x.state === "open").length,
      retrying: remoteOut.filter(x => x.state === "open" && x.m.relay).length,
      failed24h: remoteOut.filter(x => x.state === "failed" && recentDay(x.m.created)).length,
      delivered24h: remoteOut.filter(x => x.state === "done" && recentDay(x.m.created)).length,
      inbound24h: rows.filter(x => x.m.remote && recentDay(x.m.created)).length,
      ...(lastError ? { lastError: clip(lastError, 300) } : {}),
    },
    runs24h: runs, byAgent,
    agents: {
      runners: queue.runners(), sessions: [...new Set(liveSessions().map(s => s.name))].sort(),
      registered: agents.live(now).map(a => ({ name: a.name, kind: a.kind, aliases: a.aliases, projects: a.projects, expires: a.expires, ...(a.description ? { description: a.description } : {}) })),
    },
    recent: rows.slice(-RECENT).reverse().map(({ state, m: x }): Recent => ({
      id: x.id, state, kind: x.kind, from: x.from, to: x.to, project: x.project, task: x.task, summary: clip(x.summary, 200), created: x.created,
      ...(x.remote ? { remote: x.remote.peer } : {}),
      ...(x.relay ? { attempts: x.relay.attempts, lastError: clip(x.relay.lastError, 300) } : {}),
      ...(x.result?.closedBy ? { closedBy: x.result.closedBy, ...(x.result.note || x.result.error ? { note: clip(x.result.note ?? x.result.error!, 300) } : {}) } : {}),
      ...(x.result ? { ok: x.result.ok, seconds: x.result.seconds, ...(typeof x.result.usage?.costUsd === "number" ? { costUsd: x.result.usage.costUsd } : {}) } : {}),
    })),
  };
}
