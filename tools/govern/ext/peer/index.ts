// Other hosts: peers (signed delivery behind a TLS tunnel), the mesh (one invite per host, certified members) and the agent
// directory (NAME@HOST). The queue's NAME@PEER recipients and the dispatcher's relay call this extension; without it a
// NAME@PEER recipient is refused. A workspace turns it on with `govern ext enable peer`.
import * as peer from "../../lib/peer.ts";
import * as mesh from "../../lib/mesh.ts";
import * as agents from "../../lib/agents.ts";
import * as queue from "../../lib/queue.ts";
import { origin } from "../../lib/approval.ts";
import { resolveAs, callingSession, sessions, liveSessions } from "../../lib/sessions.ts";
import { fail, opt, flag, many, secondsOpt, nowIso } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { out, loopback, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

const MESH_SYNC_MS = 10 * 60_000;
/** Peer grants are owner-only; the server always binds IPv4 loopback behind a TLS tunnel. */
async function cmdPeer(a: Args): Promise<void> {
  const sub = a._[1];
  if ((sub === "add" || sub === "revoke") && origin().kind !== "terminal")
    fail("manage peers from the owner's own terminal: a peer's allow list grants runs on this host", 1);
  if (sub === "id") {
    const h = peer.identity(opt(a, "name"));
    return out(`${h.name}\nfingerprint: ${peer.fingerprint(h.publicKey)}\npublic key: ${h.publicKey}`);
  }
  if (sub === "add") {
    const p = peer.addPeer({ name: a._[2] ?? fail("govern peer add <name>"), url: opt(a, "url") ?? fail("--url is required"), publicKey: opt(a, "key") ?? fail("--key is required"), allow: many(a, "allow"), projects: many(a, "project") });
    return out(`added ${p.name} (${peer.fingerprint(p.publicKey)})`);
  }
  if (sub === "revoke") return out(`revoked ${peer.revokePeer(a._[2] ?? fail("govern peer revoke <name>")).name}`);
  if (sub === "list") {
    const rows = queue.all();
    return out(peer.peers().map(p => {
      const outbound = rows.filter(x => x.state === "open" && peer.parseAddress(x.m.to)?.peer === p.name);
      const last = rows.filter(x => peer.parseAddress(x.m.to)?.peer === p.name && (x.m.relay?.lastError || x.m.result?.error)).at(-1)?.m;
      return `${p.name}${p.revokedAt ? " REVOKED" : ""}  ${p.url}\n  allow: ${p.allow.join(", ")}  projects: ${p.projects.join(", ")}\n  fingerprint: ${peer.fingerprint(p.publicKey)}  open: ${outbound.length}\n  last relay error: ${last?.relay?.lastError ?? last?.result?.error ?? "none"}`;
    }).join("\n") || "(no peers: govern peer add)");
  }
  if (sub === "push") {
    for (const line of await peer.push({ max: opt(a, "max") === undefined ? undefined : Number(opt(a, "max")) })) out(line);
    return;
  }
  const host = opt(a, "host") ?? "127.0.0.1", port = Number(opt(a, "port") ?? 5003);
  if (!loopback(host)) fail("peer serve binds loopback only; TLS comes from the tunnel (Cloudflare or Tailscale)");
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be 1..65535");
  peer.identity();
  const server = peer.peerServer();
  server.on("error", e => { process.stderr.write(`peer: ${e.message}\n`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => out(`govern peer on http://127.0.0.1:${port} · TLS comes from the tunnel`));
}

/** Mesh membership and grants change who may cause runs here, so every change but a plain sync is the owner's. */
async function cmdMesh(a: Args): Promise<void> {
  const sub = a._[1] ?? "status";
  if (sub !== "status" && !(sub === "sync" && opt(a, "url") === undefined) && origin().kind !== "terminal")
    fail("manage the mesh from the owner's own terminal: mesh grants authorize runs on this host", 1);
  const policy = () => ({ allow: many(a, "allow"), projects: many(a, "project"), ...(many(a, "observer").length ? { observers: many(a, "observer") } : {}) });
  if (sub === "create") {
    const m = mesh.create({ name: opt(a, "name") ?? fail("--name is required"), url: opt(a, "url") ?? fail("--url is required (this host's public https address)"), policy: policy() });
    return out(`mesh ${m.mesh.name} created; this host (${peer.identity().name}) is its registrar\nmesh key fingerprint: ${peer.fingerprint(m.mesh.publicKey)}\nnext: govern mesh invite, once per host that joins`);
  }
  if (sub === "invite") {
    const i = mesh.invite({ host: opt(a, "host"), ttlSeconds: secondsOpt(a, "ttl") });
    return out(`${i.code}\nsingle use, expires ${i.expires}\non the joining host, from its owner's terminal:\n  govern mesh join CODE --url https://THAT-HOST --project P [--allow NAME]…`);
  }
  if (sub === "join") {
    const m = await mesh.join(a._[2] ?? fail("govern mesh join <code> --url URL --project P"), { url: opt(a, "url") ?? fail("--url is required (this host's public https address)"), policy: policy() });
    return out(`joined mesh ${m.mesh.name} as ${peer.identity().name}: ${m.members.length} members (mesh key ${peer.fingerprint(m.mesh.publicKey)})`);
  }
  if (sub === "policy") {
    const m = mesh.setPolicy(policy());
    return out(`members may address: ${m.policy.allow.join(", ") || "(no runners or profiles; registered agents only)"} in projects ${m.policy.projects.join(", ")}; telemetry observers: ${mesh.observers().join(", ") || "none"}`);
  }
  if (sub === "revoke") { mesh.revoke(a._[2] ?? fail("govern mesh revoke <host>")); return out(`revoked ${a._[2]}: members drop it at their next sync`); }
  if (sub === "sync") {
    const m = await mesh.sync({ url: opt(a, "url") }), hosts = await peer.discover();
    out(`synced mesh ${m.mesh.name}: ${m.members.length} members, certificate renewed`);
    for (const h of hosts) out(`  ${h.host}: ${h.ok ? `${h.agents.length} addressable` : `unreachable: ${h.error}`}`);
    return;
  }
  const s = mesh.state();
  if (!s) return out("(not in a mesh: govern mesh create, or govern mesh join with an invite code)");
  const self = peer.identity(), cert = s.members.find(m => m.publicKey === self.publicKey);
  out(`mesh ${s.mesh.name}${mesh.isRegistrar() ? " (this host is the registrar)" : ` · registrar ${s.mesh.url}`}`);
  out(`this host: ${self.name} ${cert?.url ?? ""} · certificate expires ${cert?.expires ?? "?"} · synced ${s.syncedAt}`);
  out(`members may address: ${s.policy.allow.join(", ") || "(registered agents only)"} · projects: ${s.policy.projects.join(", ")} · telemetry observers: ${mesh.observers().join(", ") || "none"}`);
  for (const m of s.members) out(`  ${m.name}${m.publicKey === self.publicKey ? " (this host)" : ""}  ${m.url}  ${peer.fingerprint(m.publicKey).slice(0, 16)}  until ${m.expires}`);
  if (s.revoked.length) out(`  revoked keys: ${s.revoked.map(f => f.slice(0, 16)).join(", ")}`);
}

/** Agents publish and find each other: a session registers only itself; listing reads local state and signed directories. */
async function cmdAgents(a: Args): Promise<void> {
  const sub = a._[1] ?? "list";
  if (sub === "register" || sub === "unregister") {
    // The holder: this Claude Code session (its id and process) when there is one, else the caller's name or the terminal.
    const self = resolveAs({}), cs = callingSession(), proc = cs ? sessions().find(s => s.pid === cs.pid) : undefined;
    const holder = { owner: cs?.sessionId ?? self ?? "terminal", ...(cs ? { pid: cs.pid } : {}), ...(proc?.procStart ? { procStart: proc.procStart } : {}) };
    const asked = opt(a, "as");
    if (self && asked !== undefined && asked !== self) fail(`an agent registers only itself (this is ${self})`);
    if (sub === "unregister") {
      const n = a._[2] ?? asked ?? self ?? fail("govern agents unregister [NAME]: which registration");
      return out(agents.unregister(n, holder.owner) ? `unregistered ${n}` : `${n} was not registered`);
    }
    const ephemeral = flag(a, "ephemeral");
    const claimed = [...(!ephemeral ? [asked ?? self] : []), ...many(a, "alias")];
    for (const n of claimed) if (liveSessions().some(s => s.name === n && s.pid !== cs?.pid))
      fail(`${n} belongs to another live session: only that session may register its name or alias`);
    const r = agents.register({ ...holder, ...(ephemeral ? { ephemeral } : { name: asked ?? self ?? fail("cannot tell which agent this is: pass --as NAME, set GOVERN_AS, or use --ephemeral") }),
      aliases: many(a, "alias"), projects: many(a, "project"), description: opt(a, "description"), ttlSeconds: secondsOpt(a, "ttl") });
    const host = peer.identity().name;
    out(`registered ${r.name}@${host} (${r.kind}) for ${r.projects.join(", ")} until ${r.expires}${r.aliases.length ? `; also ${r.aliases.map(x => `${x}@${host}`).join(", ")}` : ""}`);
    if (r.name !== self) out(`read its inbox with: govern task inbox --as ${r.name}`);
    return;
  }
  const live = agents.live();
  out(`this host (${peer.identity().name}):`);
  out(`  runners: ${queue.runners().join(", ")}`);
  for (const r of live) out(`  ${r.name}  agent (${r.kind})  ${r.projects.join(", ")}  until ${r.expires}${r.aliases.length ? `  aliases: ${r.aliases.join(", ")}` : ""}${r.description ? `  ${r.description}` : ""}`);
  const dir = flag(a, "refresh") ? { fetchedAt: nowIso(), hosts: await peer.discover() } : peer.cached();
  if (!dir) return out("(no other hosts discovered yet: govern agents list --refresh)");
  out(`other hosts (as of ${dir.fetchedAt}):`);
  for (const h of dir.hosts) {
    if (!h.ok) { out(`  ${h.host}: unreachable: ${h.error}`); continue; }
    for (const x of h.agents) out(`  ${x.name}@${h.host}  ${x.kind}${x.lifetime ? ` (${x.lifetime})` : ""}  ${x.projects.join(", ")}${x.aliases ? `  aliases: ${x.aliases.map(n => `${n}@${h.host}`).join(", ")}` : ""}${x.description ? `  ${x.description}` : ""}`);
    if (!h.agents.length) out(`  ${h.host}: nothing addressable from this host`);
  }
}

export const name = "peer";
export const description = "other hosts: peers, mesh, NAME@PEER addressing and the agent directory";
export const docs: ExtDoc[] = [{ title: "other hosts: peers, mesh, NAME@PEER addressing, the command center", path: "PEERS.md" }];
export const manpage = MANPAGE;

/** Refuse (exit 2) a host that is not a live peer or mesh member: what `task send --to NAME@PEER` checks. */
export function requireHost(host: string): void { peer.remote(host); }

/** The dispatcher loop's federation work, one call per tick: a mesh sync with discovery every ten minutes while in a mesh, then one
 *  relay pass to live peers. Returns the lines to print; a failure is a line, never a throw. */
export function relay(): (max: number | undefined) => Promise<string[]> {
  let lastSync = 0;
  return async (max) => {
    const lines: string[] = [];
    try {
      if (mesh.state() && Date.now() - lastSync >= MESH_SYNC_MS) {
        lastSync = Date.now();
        try { await mesh.sync(); }
        catch (e) { lines.push(`[mesh] sync failed: ${(e as Error).message}`); }
        try { for (const h of await peer.discover()) if (!h.ok) lines.push(`[mesh] ${h.host}: ${h.error}`); }
        catch (e) { lines.push(`[mesh] discovery failed: ${(e as Error).message}`); }
      }
    } catch (e) { lines.push(`[mesh] failed: ${(e as Error).message}`); }
    try {
      if (peer.remotes().length) for (const line of await peer.push({ max })) lines.push(`[peer] ${line}`);
    } catch (e) { lines.push(`[peer] failed: ${(e as Error).message}`); }
    return lines;
  };
}

/** The desk's line for this extension: the peers and the messages waiting for them; none when there are no peers. */
export function deskLines(): string[] {
  const list = peer.peers().filter((p) => !p.revokedAt);
  if (!list.length) return [];
  const open = queue.all().filter((x) => x.state === "open" && peer.parseAddress(x.m.to) !== undefined).length;
  return ["", `PEERS  ${list.length} peer${list.length === 1 ? "" : "s"} (${list.map((p) => p.name).join(", ")}) · ${open} open message${open === 1 ? "" : "s"} to NAME@PEER (govern peer list)`];
}

export const commands: Cmd[] = [
  { name: "peer", section: 6, footer: false, noSub: "govern peer id|add|list|revoke|serve|push (PEERS.md)",
    subs: {
      id: { flags: { value: ["name"] }, lines: [["[--name N]", "create or show the host identity, fingerprint and public key; --name only on creation"]], run: cmdPeer },
      add: { flags: { value: ["url", "key"], multi: ["allow", "project"] }, lines: [["<name> --url URL --key BASE64 [--allow NAME]… [--project SLUG|*]…", "trust a peer for these local recipients and projects; owner's terminal only"]], run: cmdPeer },
      list: { lines: [["", "peers, grants, fingerprints, open outbound counts and last relay errors"]], run: cmdPeer },
      revoke: { lines: [["<name>", "revoke a peer's grants; owner's terminal only"]], run: cmdPeer },
      serve: { flags: { value: ["host", "port"] }, lines: [["[--port 5003] [--host 127.0.0.1]", "bind 127.0.0.1 only; TLS comes from a Cloudflare or Tailscale tunnel"]], run: cmdPeer },
      push: { flags: { value: ["max"] }, lines: [["[--max N]", "run one relay pass, oldest first; print one line per message"]], run: cmdPeer },
    } },
  { name: "mesh", section: 6, footer: false, defaultSub: "status", noSub: "govern mesh create|invite|join|sync|status|policy|revoke (PEERS.md)",
    subs: {
      create: { flags: { value: ["name", "url"], multi: ["allow", "project", "observer"] }, lines: [["--name MESH --url URL --project P… [--allow NAME]… [--observer HOST]…", "make this host the registrar of a new mesh; --project/--allow are the grants every member gets here; owner's terminal only"]], run: cmdMesh },
      invite: { flags: { value: ["host", "ttl"] }, lines: [["[--host NAME] [--ttl 3600]", "registrar: print a single-use invite code for one new host; owner's terminal only"]], run: cmdMesh },
      join: { flags: { value: ["url"], multi: ["allow", "project", "observer"] }, lines: [["<code> --url URL --project P… [--allow NAME]… [--observer HOST]…", "join with an invite code, at this host's public URL, granting members these names and projects;\n--observer names the members that may read this host's telemetry (default: the registrar); owner's terminal only"]], run: cmdMesh },
      sync: { flags: { value: ["url"] }, lines: [["[--url URL]", "renew this host's certificate, refresh members and discover agents; --url moves this host (owner's terminal only)"]], run: cmdMesh },
      status: { lines: [["", "the mesh, this host's certificate, the grants members get here, and every member"]], run: cmdMesh },
      policy: { flags: { multi: ["allow", "project", "observer"] }, lines: [["--project P… [--allow NAME]… [--observer HOST]…", "replace the grants every member gets here, and who reads its telemetry (default: the registrar); owner's terminal only"]], run: cmdMesh },
      revoke: { lines: [["<host>", "registrar: revoke a member; owner's terminal only"]], run: cmdMesh },
    } },
  { name: "agents", section: 6, footer: false, defaultSub: "list", noSub: "govern agents list|register|unregister (PEERS.md)",
    subs: {
      list: { flags: { bool: ["refresh"] }, lines: [["[--refresh]", "agents here, and what this host may address on every other host (cached; --refresh asks each host)"]], run: cmdAgents },
      register: { flags: { value: ["as", "description", "ttl"], multi: ["project", "alias"], bool: ["ephemeral"] }, lines: [["--project P… [--as NAME | --ephemeral] [--alias NAME]… [--description TEXT] [--ttl S]", "publish this agent's inbox to peer hosts as NAME@HOST for these projects, until it expires or its session ends;\nnames and aliases are unique per host and held by their registering session; --ephemeral generates a name (1 h default, at most 24 h)"]], run: cmdAgents },
      unregister: { flags: { value: ["as"] }, lines: [["[NAME] [--as NAME]", "withdraw a registration this session holds"]], run: cmdAgents },
    } },
];
