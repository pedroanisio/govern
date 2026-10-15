// The operator's command center: every federated host's telemetry, agents and messages in one view, with alerts
// derived by code. `govern center` prints it; `govern center serve` shows it in a browser on loopback.
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from "node:fs";
import { clip, kTok, fail } from "./util.ts";
import * as peer from "./peer.ts";
import * as mesh from "./mesh.ts";
import { file as peerFile, locked } from "./peer-id.ts";
import type { Telemetry, Recent } from "./telemetry.ts";
import { lanesAnswer, definitionOf, type ProcessInfo } from "./livestate.ts";
import type { LaneState } from "./lanestate.ts";
import { parseProcess, getProcess, processes, type Process } from "./process.ts";
import { processSvg } from "./processview.ts";

export const WARN_CERT_MS = 7 * 86400_000, STALE_SYNC_MS = 3600_000, CACHE_MS = 10_000, MESSAGES = 60;
export interface HostView { host: string; url?: string; self: boolean; registrar: boolean; ok: boolean; error?: string; telemetry?: Telemetry }
export interface Alert { level: "critical" | "warning"; host: string; message: string }
export interface View {
  at: string; mesh?: { name: string; registrar?: string; revoked: number };
  hosts: HostView[]; peers: { name: string; url: string; revoked: boolean }[];
  alerts: Alert[]; messages: (Recent & { host: string })[]; agents: AgentRow[];
}
/** One line of the agents list. `reach` says who can address it: a registered agent's projects (from other hosts too),
 *  "this host only" for a live session that has not registered, "as granted" for runners. `names` are what a sender on `host` types: the agent's name then its aliases, or each runner. */
export interface AgentRow { host: string; names: string[]; address: string; kind: string; reach: string; until?: string; description?: string }

/** Every agent on every reporting host: its registered agents, then its live sessions that hold no registration under
 *  their own name (each listed once), then its runners. A host without telemetry lists nothing; its alert says why. */
export function agentRows(hosts: HostView[]): AgentRow[] {
  return hosts.flatMap(h => {
    const t = h.telemetry; if (!t) return [];
    const registered = new Set(t.agents.registered.map(a => a.name));
    return [
      ...t.agents.registered.map(a => ({ host: h.host, names: [a.name, ...a.aliases], address: `${a.name}@${h.host}` + (a.aliases.length ? ` (${a.aliases.join(", ")})` : ""), kind: a.kind, reach: a.projects.join(", "), until: a.expires, ...(a.description ? { description: a.description } : {}) })),
      ...t.agents.sessions.filter(n => !registered.has(n)).map(n => ({ host: h.host, names: [n], address: `${n}@${h.host}`, kind: "session", reach: "this host only" })),
      ...(t.agents.runners.length ? [{ host: h.host, names: t.agents.runners, address: `${t.agents.runners.join(", ")} @${h.host}`, kind: "runners", reach: "as granted" }] : []),
    ];
  });
}

/** What needs the operator's attention on host `h`, each stated with its consequence. */
export function alertsFor(h: HostView, now: number): Alert[] {
  const out: Alert[] = [], a = (level: Alert["level"], message: string) => out.push({ level, host: h.host, message });
  if (!h.ok || !h.telemetry) { a("critical", `no telemetry: ${h.error ?? "unknown error"}`); return out; }
  const t = h.telemetry;
  if (!t.dispatcher.running) a("warning", "dispatcher not running: queued runs and relays wait (govern task dispatch --loop)");
  if (t.mesh?.certExpires) {
    const left = Date.parse(t.mesh.certExpires) - now;
    if (left <= 0) a("critical", "mesh certificate expired: other members refuse this host until it syncs");
    else if (left < WARN_CERT_MS) a("warning", `mesh certificate expires in ${Math.ceil(left / 86400_000)} days: run govern mesh sync`);
  }
  if (t.mesh && now - Date.parse(t.mesh.syncedAt) > STALE_SYNC_MS) a("warning", `last mesh sync ${t.mesh.syncedAt}: revocations and new members may be missed`);
  if (t.relay.failed24h) a("warning", `${t.relay.failed24h} outbound deliveries failed in 24 h${t.relay.lastError ? `: ${clip(t.relay.lastError, 160)}` : ""}`);
  if (t.relay.retrying) a("warning", `${t.relay.retrying} outbound deliveries are retrying`);
  if (t.queue.unverified) a("warning", `${t.queue.unverified} replies failed verification and wait for review`);
  if (t.runs24h.failed) a("warning", `${t.runs24h.failed} of ${t.runs24h.count} runs failed in 24 h`);
  return out;
}

/** Gather the view: this host's telemetry, then every mesh member's, asked in parallel. */
export async function gather(o: { post?: peer.Post; now?: () => number } = {}): Promise<View> {
  const now = o.now ?? Date.now, local = peer.localTelemetry(now()), s = mesh.state();
  const remote = s ? await peer.observe({ ...(o.post ? { post: o.post } : {}), now }) : [];
  const registrar = s?.mesh.registrar;
  const hosts: HostView[] = [
    { host: local.host, self: true, registrar: !!local.mesh?.registrar, ok: true, telemetry: local },
    ...remote.map(r => ({ host: r.host, url: r.url, self: false, registrar: r.host === registrar, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.telemetry ? { telemetry: r.telemetry } : {}) })),
  ];
  const messages = hosts.flatMap(h => (h.telemetry?.recent ?? []).map(m => ({ ...m, host: h.host })))
    .sort((a, b) => b.created.localeCompare(a.created) || a.host.localeCompare(b.host)).slice(0, MESSAGES);
  const alerts = hosts.flatMap(h => alertsFor(h, now())).sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));
  return {
    at: new Date(now()).toISOString(),
    ...(s ? { mesh: { name: s.mesh.name, ...(registrar ? { registrar } : {}), revoked: s.revoked.length } } : {}),
    hosts, peers: peer.peers().map(p => ({ name: p.name, url: p.url, revoked: !!p.revokedAt })), alerts, messages, agents: agentRows(hosts),
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
/** The view as text for a terminal. */
export function render(v: View): string {
  const L: string[] = [`COMMAND CENTER  ${v.at}${v.mesh ? `  ·  mesh ${v.mesh.name}${v.mesh.registrar ? ` (registrar ${v.mesh.registrar})` : ""}` : "  ·  not in a mesh"}`];
  L.push("", `HOSTS (${v.hosts.length})`);
  for (const h of v.hosts) {
    const t = h.telemetry, role = [h.self ? "this host" : "", h.registrar ? "registrar" : ""].filter(Boolean).join(", ");
    if (!t) { L.push(`  ✖ ${h.host.padEnd(16)} ${role.padEnd(20)} ${h.error ?? "unreachable"}`); continue; }
    const q = t.queue, r = t.runs24h;
    L.push(`  ● ${h.host.padEnd(16)} ${role.padEnd(20)} dispatcher ${t.dispatcher.running ? "up" : "DOWN"}  queue ${q.open} open/${q.claimed} claimed/${q.failed} failed  24h ${r.count} runs ${usd(r.costUsd)} ${kTok(r.input)} in ${kTok(r.output)} out  relay ${t.relay.delivered24h}↑ ${t.relay.inbound24h}↓ ${t.relay.outboundOpen} pending${t.mesh?.certExpires ? `  cert until ${t.mesh.certExpires.slice(0, 10)}` : ""}`);
  }
  for (const p of v.peers) L.push(`  ○ ${p.name.padEnd(16)} static peer${p.revoked ? " (revoked)" : ""}  ${p.url}  (telemetry is shared with mesh observers only)`);
  L.push("", `ALERTS (${v.alerts.length})`);
  for (const a of v.alerts) L.push(`  ${a.level === "critical" ? "‼" : "!"} ${a.host}: ${a.message}`);
  if (!v.alerts.length) L.push("  none");
  L.push("", `AGENTS (${v.agents.filter(r => r.kind !== "runners").length})`);
  for (const r of v.agents) L.push(`  ${r.address}  ${r.kind}  ${r.reach}${r.until ? `  until ${r.until}` : ""}${r.description ? `  ${r.description}` : ""}`);
  if (!v.agents.length) L.push("  none");
  L.push("", "SPEND, LAST 24 H");
  for (const h of v.hosts) for (const [agent, r] of Object.entries(h.telemetry?.byAgent ?? {})) L.push(`  ${h.host.padEnd(16)} ${agent.padEnd(16)} ${String(r.count).padStart(4)} runs  ${r.failed} failed  ${usd(r.costUsd)}  ${Math.round(r.seconds)}s`);
  L.push("", `MESSAGES (latest ${v.messages.length})`);
  for (const m of v.messages) L.push(`  ${m.created.slice(5, 16).replace("T", " ")} ${m.host.padEnd(12)} ${m.state.padEnd(7)} ${m.kind.padEnd(8)} ${m.from}→${m.to} [${m.project}/${m.task}] ${clip(m.summary, 70)}${m.lastError ? `  ⚠ ${clip(m.lastError, 60)}` : ""}`);
  return L.join("\n");
}

// ---- Live lanes and processes: every host's lane summaries, and the processes they run, in the same read-only view ----

/** One host's part of the lanes view. `unknown` marks a host whose govern predates lane reporting: it is listed, its lanes are not. */
export interface HostLanes { host: string; self: boolean; ok: boolean; unknown?: boolean; error?: string; lanes: number; omitted: number; unreadable: number }
export interface LaneRow { host: string; self: boolean; lane: LaneState }
/** How many lanes of one process a host has, by derived status. */
export interface ProcessHost { host: string; self: boolean; lanes: number; running: number; waiting: number; blocked: number; done: number }
export interface ProcessRow extends ProcessInfo { hosts: ProcessHost[] }
export interface LiveView { at: string; hosts: HostLanes[]; lanes: LaneRow[]; processes: ProcessRow[] }

const tally = (ls: LaneState[]) => ({
  lanes: ls.length, running: ls.filter(l => l.status === "running").length, done: ls.filter(l => l.status === "done").length,
  waiting: ls.filter(l => l.status === "waiting-on-owner" || l.status === "waiting-on-coordinator").length, blocked: ls.filter(l => l.status === "blocked-by-check").length,
});

/** Gather every host's lanes and processes: this host's, then every mesh member's asked in parallel over the signed channel. A host without the route is marked unknown. */
export async function gatherLive(o: { post?: peer.Post; now?: () => number } = {}): Promise<LiveView> {
  const now = o.now ?? Date.now, id = peer.identity(), s = mesh.state();
  const local = lanesAnswer({ host: id.name, fingerprint: peer.fingerprint(id.publicKey), now: now() });
  const remote = s ? await peer.observeLanes({ ...(o.post ? { post: o.post } : {}), now }) : [];
  const hosts: HostLanes[] = [
    { host: local.host, self: true, ok: true, lanes: local.lanes.length, omitted: local.omitted, unreadable: local.unreadable },
    ...remote.map(r => ({ host: r.host, self: false, ok: r.ok, ...(r.unknown ? { unknown: true } : {}), ...(r.error ? { error: r.error } : {}), lanes: r.answer?.lanes.length ?? 0, omitted: r.answer?.omitted ?? 0, unreadable: r.answer?.unreadable ?? 0 })),
  ];
  const lanes: LaneRow[] = [
    ...local.lanes.map(lane => ({ host: local.host, self: true, lane })),
    ...remote.flatMap(r => (r.answer?.lanes ?? []).map(lane => ({ host: r.host, self: false, lane }))),
  ];
  const known = new Map<string, ProcessRow>();
  const add = (host: string, self: boolean, infos: ProcessInfo[]) => {
    for (const i of infos) {
      const key = `${i.name}@${i.hash}`, row = known.get(key) ?? { ...i, hosts: [] };
      known.set(key, row);
      const mine = lanes.filter(l => l.host === host && l.lane.process.name === i.name && l.lane.process.hash === i.hash).map(l => l.lane);
      row.hosts.push({ host, self, ...tally(mine) });
    }
  };
  add(local.host, true, local.processes);
  for (const r of remote) if (r.answer) add(r.host, false, r.answer.processes);
  const processes = [...known.values()].sort((a, b) => a.name.localeCompare(b.name) || b.revision - a.revision);
  return { at: new Date(now()).toISOString(), hosts, lanes, processes };
}

/** The SVG of one process with the live state of the lanes on it, or with one lane's progress. `host` names whose lanes and definitions to use (default: this host).
 *  Returns the problem as a status and message when there is none to draw. */
export async function processDrawing(v: LiveView, q: { name: string; host?: string; hash?: string; lane?: string }, o: { post?: peer.Post; now?: () => number; definitions?: Map<string, Process> } = {}): Promise<{ status: 200; svg: string } | { status: 404 | 502; error: string }> {
  const now = (o.now ?? Date.now)(), self = v.hosts.find(h => h.self)!, host = q.host ?? self.host;
  const h = v.hosts.find(x => x.host === host);
  if (!h) return { status: 404, error: `no host ${host} in the view` };
  let name = q.name, hash = q.hash;
  const selected = q.lane ? v.lanes.find(l => l.host === host && l.lane.slug === q.lane)?.lane : undefined;
  if (q.lane && !selected) return { status: 404, error: `no lane ${q.lane} on ${host}` };
  if (selected) { name = selected.process.name; hash = selected.process.hash; }
  let pr: Process | undefined;
  const key = `${host}@${name}@${hash ?? ""}`, cache = o.definitions;
  if (hash && cache?.has(key)) pr = cache.get(key);
  else if (h.self) {
    try {
      if (hash) { const text = definitionOf(name, hash); pr = text === undefined ? undefined : parseProcess(`${name}.json`, text); }
      else pr = processes().has(name) ? getProcess(name) : undefined;
    } catch (e) { return { status: 502, error: clip((e as Error).message, 300) }; }
  } else {
    if (!hash) return { status: 404, error: "a process of another host is named by its hash (see /api/processes)" };
    if (h.unknown || !h.ok) return { status: 502, error: h.error ?? `${host} did not answer` };
    try {
      const text = await peer.fetchProcess(host, name, hash, { ...(o.post ? { post: o.post } : {}), now: () => now });
      pr = text === undefined ? undefined : parseProcess(`${host}/${name}.json`, text);
    } catch (e) { return { status: 502, error: clip((e as Error).message, 300) }; }
  }
  if (!pr) return { status: 404, error: `${host} has no process ${name}${hash ? ` with hash ${hash.slice(0, 12)}` : ""}` };
  if (hash) cache?.set(key, pr);
  const mine = v.lanes.filter(l => l.host === host && l.lane.process.name === name && (!hash || l.lane.process.hash === hash)).map(l => l.lane);
  return { status: 200, svg: processSvg(pr, selected ? { now, lanes: [selected], selected } : { now, lanes: mine }) };
}

const PAGE = () => readFileSync(new URL("./center.html", import.meta.url), "utf8");
const digest = (s: string) => createHash("sha256").update(s).digest();
/** A fresh bearer token. */
export const newToken = (): string => randomBytes(24).toString("base64url");
/** Where the access token is kept: beside the peer identity, in govern's private state. */
export const tokenFile = (): string => peerFile("center-token");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/;
/** The command center's access token: created once (directory 0700, file 0600) and reused by every `center serve` and `center url`, so the
 *  address survives restarts. A token file readable by group or other is refused, so is one that holds no token; `rotate` replaces it. */
export function persistentToken(o: { rotate?: boolean } = {}): string {
  return locked(() => {
    const f = tokenFile();
    if (!o.rotate && existsSync(f)) {
      const mode = statSync(f).mode & 0o777;
      if (mode & 0o077) fail(`${f} is readable by group or other (mode ${mode.toString(8)}): run chmod 600 on it, or rotate the token with govern center serve --new-token`);
      const t = readFileSync(f, "utf8").trim();
      if (!TOKEN_SHAPE.test(t)) fail(`${f} is not a token: delete it, or rotate with govern center serve --new-token`);
      return t;
    }
    const t = newToken(), tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, t + "\n", { mode: 0o600 }); renameSync(tmp, f);
    return t;
  });
}
/** The address of the page on `host:port`, with the token in the fragment (which the browser never sends). */
export const centerAddress = (host: string, port: number, token: string): string => `http://${host.includes(":") ? `[${host}]` : host}:${port}/#token=${token}`;
/** The dashboard on loopback. The page is public; /api/state needs `Authorization: Bearer TOKEN`, and every request
 *  must name a loopback host, so a page on another site cannot read the view through a rebound DNS name. */
export function centerServer(o: { token: string; view?: () => Promise<View>; live?: () => Promise<LiveView>; post?: peer.Post }): Server {
  const view = o.view ?? (() => gather());
  const liveView = o.live ?? (() => gatherLive(o.post ? { post: o.post } : {}));
  let cached: { at: number; v: Promise<View> } | undefined, cachedLive: { at: number; v: Promise<LiveView> } | undefined;
  const definitions = new Map<string, Process>();
  const server = createServer((req, res) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, "application/json; charset=utf-8", JSON.stringify(v));
    req.resume();
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostName)) return json(403, { error: "loopback host names only" });
    if (req.method === "GET" && req.url === "/") return send(200, "text/html; charset=utf-8", PAGE());
    const url = new URL(req.url ?? "/", "http://loopback"), svgName = /^\/api\/process\/([^/]+)\.svg$/.exec(url.pathname)?.[1];
    if (req.method !== "GET" || !(url.pathname === "/api/state" || url.pathname === "/api/lanes" || url.pathname === "/api/processes" || svgName)) return json(404, { error: "not found" });
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(given), digest(o.token))) return json(401, { error: "missing or wrong token" });
    if (url.pathname === "/api/state") {
      if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), v: view() };
      return void cached.v.then(v => json(200, v), (e: Error) => { cached = undefined; json(500, { error: clip(e.message, 300) }); });
    }
    if (!cachedLive || Date.now() - cachedLive.at > CACHE_MS) cachedLive = { at: Date.now(), v: liveView() };
    cachedLive.v.then(async v => {
      if (url.pathname === "/api/lanes") return json(200, { at: v.at, hosts: v.hosts, lanes: v.lanes });
      if (url.pathname === "/api/processes") return json(200, { at: v.at, hosts: v.hosts, processes: v.processes });
      let name: string;
      try { name = decodeURIComponent(svgName!); } catch { return json(404, { error: "not found" }); }
      const q = url.searchParams, hash = q.get("hash") ?? undefined, host = q.get("host") ?? undefined, lane = q.get("lane") ?? undefined;
      if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) return json(404, { error: "hash must be a 64 digit lowercase hex SHA-256" });
      const r = await processDrawing(v, { name, ...(host ? { host } : {}), ...(hash ? { hash } : {}), ...(lane ? { lane } : {}) }, { ...(o.post ? { post: o.post } : {}), definitions });
      if (r.status === 200) send(200, "image/svg+xml; charset=utf-8", r.svg); else json(r.status, { error: r.error });
    }).catch((e: Error) => { cachedLive = undefined; json(500, { error: clip(e.message, 300) }); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
