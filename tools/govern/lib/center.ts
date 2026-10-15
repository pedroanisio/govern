// The operator's command center: every federated host's telemetry, agents and messages in one view, with alerts
// derived by code. `govern center` prints it; `govern center serve` shows it in a browser on loopback.
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { clip, kTok } from "./util.ts";
import * as peer from "./peer.ts";
import * as mesh from "./mesh.ts";
import type { Telemetry, Recent } from "./telemetry.ts";

export const WARN_CERT_MS = 7 * 86400_000, STALE_SYNC_MS = 3600_000, CACHE_MS = 10_000, MESSAGES = 60;
export interface HostView { host: string; url?: string; self: boolean; registrar: boolean; ok: boolean; error?: string; telemetry?: Telemetry }
export interface Alert { level: "critical" | "warning"; host: string; message: string }
export interface View {
  at: string; mesh?: { name: string; registrar?: string; revoked: number };
  hosts: HostView[]; peers: { name: string; url: string; revoked: boolean }[];
  alerts: Alert[]; messages: (Recent & { host: string })[];
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
    hosts, peers: peer.peers().map(p => ({ name: p.name, url: p.url, revoked: !!p.revokedAt })), alerts, messages,
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
  L.push("", "AGENTS");
  for (const h of v.hosts) {
    const t = h.telemetry; if (!t) continue;
    L.push(`  ${h.host}: runners ${t.agents.runners.join(", ")}${t.agents.sessions.length ? ` · sessions ${t.agents.sessions.join(", ")}` : ""}`);
    for (const a of t.agents.registered) L.push(`    ${a.name}@${h.host}  ${a.kind}  ${a.projects.join(", ")}  until ${a.expires}${a.aliases.length ? `  aliases ${a.aliases.join(", ")}` : ""}${a.description ? `  ${a.description}` : ""}`);
  }
  L.push("", "SPEND, LAST 24 H");
  for (const h of v.hosts) for (const [agent, r] of Object.entries(h.telemetry?.byAgent ?? {})) L.push(`  ${h.host.padEnd(16)} ${agent.padEnd(16)} ${String(r.count).padStart(4)} runs  ${r.failed} failed  ${usd(r.costUsd)}  ${Math.round(r.seconds)}s`);
  L.push("", `MESSAGES (latest ${v.messages.length})`);
  for (const m of v.messages) L.push(`  ${m.created.slice(5, 16).replace("T", " ")} ${m.host.padEnd(12)} ${m.state.padEnd(7)} ${m.kind.padEnd(8)} ${m.from}→${m.to} [${m.project}/${m.task}] ${clip(m.summary, 70)}${m.lastError ? `  ⚠ ${clip(m.lastError, 60)}` : ""}`);
  return L.join("\n");
}

const PAGE = () => readFileSync(new URL("./center.html", import.meta.url), "utf8");
const digest = (s: string) => createHash("sha256").update(s).digest();
/** A fresh bearer token for one `center serve` process. */
export const newToken = (): string => randomBytes(24).toString("base64url");
/** The dashboard on loopback. The page is public; /api/state needs `Authorization: Bearer TOKEN`, and every request
 *  must name a loopback host, so a page on another site cannot read the view through a rebound DNS name. */
export function centerServer(o: { token: string; view?: () => Promise<View> }): Server {
  const view = o.view ?? (() => gather());
  let cached: { at: number; v: Promise<View> } | undefined;
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
    if (req.method !== "GET" || req.url !== "/api/state") return json(404, { error: "not found" });
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(given), digest(o.token))) return json(401, { error: "missing or wrong token" });
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), v: view() };
    cached.v.then(v => json(200, v), (e: Error) => { cached = undefined; json(500, { error: clip(e.message, 300) }); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
