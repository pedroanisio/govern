// Signed queue delivery and agent discovery between hosts. A sender is a static peer or a certified mesh member; every
// signed request names the key it is addressed to, so a delivery to one host cannot be replayed to another. Grants
// decide which local recipients a sender may address; execution policy stays local.
import { createServer, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { obj, str, bool, arr, literal, parseFile, check, reject, type Shape } from "../../lib/shape.ts";
import {
  NAME, name, nonempty, iso, slug, hex64, project, publicKey, url, file, locked, read, readOr, write, identity, fingerprint, parseAddress,
  header, sign, verifyBytes, fresh, covers, intersect, error, signedJson, postFetch, MAX_BODY, TIMEOUT_MS,
  type Headers, type Response, type Post,
} from "../../lib/peer-id.ts";
import * as mesh from "./mesh.ts";
import * as agents from "../../lib/agents.ts";
import * as telemetry from "./telemetry.ts";
import * as live from "../../lib/livestate.ts";
import { fail, usage, clip } from "../../lib/util.ts";
import * as queue from "../../lib/queue.ts";

export { identity, fingerprint, sign, parseAddress, MAX_BODY, type Identity, type Headers, type Response, type Post } from "../../lib/peer-id.ts";
export const PROTOCOL = "govern-peer/2";
const RECEIVED_TTL_MS = 7 * 86400_000, MAX_ATTEMPTS = 8;

export interface Peer { name: string; url: string; publicKey: string; allow: string[]; projects: string[]; addedAt: string; revokedAt?: string }
const PEER: Shape<Peer> = obj({ name, url, publicKey, allow: arr(name), projects: arr(project), addedAt: iso }, { revokedAt: iso });
const PEERS: Shape<{ peers: Peer[] }> = (v, p) => {
  const out = obj({ peers: arr(PEER) })(v, p), live = new Set<string>(), keys = new Set<string>();
  out.peers.forEach((x, i) => {
    if (!x.revokedAt) {
      if (live.has(x.name)) reject(`${p}.peers[${i}].name`, `duplicate live name ${x.name}`);
      if (keys.has(x.publicKey)) reject(`${p}.peers[${i}].publicKey`, "another live peer has this key");
      live.add(x.name); keys.add(x.publicKey);
    }
    if (x.projects.includes("*") && x.projects.length !== 1) reject(`${p}.peers[${i}].projects`, '"*" must be the only project');
  });
  return out;
};
/** Every peer in peers.json, revoked ones included; [] before the first `govern peer add`. Fails naming the file and path when it is malformed. */
export function peers(): Peer[] { return existsSync(file("peers.json")) ? read("peers.json", PEERS).peers : []; }
/** Add a peer under the peer lock: checked against the peer shape, and refused when its name or key is already live. */
export function addPeer(input: Omit<Peer, "addedAt" | "revokedAt">): Peer {
  return locked(() => {
    const p = check(file("peers.json"), { ...input, addedAt: new Date().toISOString() }, PEER);
    const out = check(file("peers.json"), { peers: [...peers(), p] }, PEERS); write("peers.json", out); return p;
  });
}
/** Revoke the live peer `n`: its deliveries are refused from then on, and messages to it fail in the relay. */
export function revokePeer(n: string): Peer {
  return locked(() => {
    const list = peers(), p = list.find(x => x.name === n && !x.revokedAt) ?? fail(`no live peer ${n}`);
    p.revokedAt = new Date().toISOString(); write("peers.json", { peers: list }); return p;
  });
}
// Syntax only (parseAddress, kept in peer-id.ts with the core): `remote()` checks whether the named host is live.

/** A host this one can send to: a live static peer or a live mesh member, under the name this host uses for it. */
export interface Remote { name: string; url: string; publicKey: string; via: "peer" | "mesh" }
/** The host named `n`. A static peer and a mesh member that share a name but not a key make the name ambiguous, and
 *  it is refused rather than guessed: replies would otherwise reach the wrong host. */
export function remote(n: string, now = Date.now()): Remote {
  const p = peers().find(x => x.name === n && !x.revokedAt), m = mesh.memberByName(n, now);
  if (p && m && p.publicKey !== m.publicKey) fail(`host name ${n} is ambiguous: a peer and a mesh member use it with different keys (revoke the peer)`);
  if (p) return { name: p.name, url: p.url, publicKey: p.publicKey, via: "peer" };
  if (m) return { name: m.name, url: m.url, publicKey: m.publicKey, via: "mesh" };
  return fail(`no live peer or mesh member ${n}`);
}
/** Every host this one can send to; ambiguous names are left out. */
export function remotes(now = Date.now()): Remote[] {
  const names = new Set([...peers().filter(p => !p.revokedAt).map(p => p.name), ...mesh.others(now).map(m => m.name)]);
  return [...names].sort().flatMap(n => { try { return [remote(n, now)]; } catch { return []; } });
}

interface Sender { name: string; publicKey: string; allow: string[]; projects: string[]; via: "peer" | "mesh" }
/** The signer of a request: a live static peer by key fingerprint, else a mesh member (listed, or by the certificate it
 *  presents). A mesh member whose name a static peer holds with another key is not a sender. */
function senderOf(headers: Headers, now: number): Sender | undefined {
  const fp = header(headers, "govern-peer-key");
  if (!fp) return undefined;
  const live = peers().filter(p => !p.revokedAt), p = live.find(x => fingerprint(x.publicKey) === fp);
  if (p) return { ...p, via: "peer" };
  const m = mesh.memberByKey(fp, header(headers, "govern-peer-cert"), now), policy = mesh.state()?.policy;
  if (!m || !policy || live.some(x => x.name === m.name)) return undefined;
  return { name: m.name, publicKey: m.publicKey, allow: policy.allow, projects: policy.projects, via: "mesh" };
}
/** Authenticate exact bytes before parsing anything a sender wrote. */
function authenticate(bytes: Buffer, headers: Headers, now: number): Sender | Response {
  if (bytes.length > MAX_BODY) return error(413, "body exceeds size limit");
  const s = senderOf(headers, now);
  if (!s) return error(403, "unknown peer");
  if (!verifyBytes(bytes, header(headers, "govern-signature"), s.publicKey)) return error(403, "bad signature");
  return s;
}
const isResponse = (x: Sender | Response): x is Response => "status" in x;

const MESSAGE = obj({ project: slug, task: name, kind: literal(...queue.KINDS), from: name, to: name, summary: (v, p) => { const s = str(v, p); return s.trim() && s.length <= 200 ? s : reject(p, "must be non-empty after trimming and at most 200 characters"); }, body: str }, { replyTo: nonempty });
const ENVELOPE = obj({ protocol: literal(PROTOCOL), id: nonempty, at: iso, toKey: hex64, message: MESSAGE });
export type Envelope = ReturnType<typeof ENVELOPE>;
/** The delivery of `m` to the host whose key has fingerprint `toKey`. Reply threading is translated only when the
 *  parent came from the destination host. */
export function envelope(m: queue.Message, toKey: string, now = Date.now()): Envelope {
  const address = parseAddress(m.to) ?? fail(`not a remote address: ${m.to}`);
  const parent = m.replyTo ? queue.find(m.replyTo)?.m : undefined;
  return check("envelope", { protocol: PROTOCOL, id: m.id, at: new Date(now).toISOString(), toKey, message: {
    project: m.project, task: m.task, kind: m.kind, from: m.from, to: address.name, summary: m.summary, body: m.body,
    ...(parent?.remote?.peer === address.peer ? { replyTo: parent.remote.id } : {}),
  } }, ENVELOPE);
}
interface Received { peer: string; id: string; localId: string; at: string }
const RECEIVED = obj({ received: arr(obj({ peer: name, id: nonempty, localId: nonempty, at: iso })) });
/** Whether this host's own key is the one a signed request is addressed to. */
const forMe = (toKey: string) => toKey === fingerprint(identity().publicKey);

/** Authenticate, check the destination, clock and grants, then deduplicate and file under the peer lock. */
export function receive(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  const sender = authenticate(bytes, headers, now);
  if (isResponse(sender)) return sender;
  let env: Envelope;
  try { env = parseFile("delivery $", bytes.toString("utf8"), ENVELOPE); }
  catch (e) { return error(400, (e as Error).message); }
  if (!forMe(env.toKey)) return error(403, "addressed to another host");
  if (!fresh(env.at, now)) return error(403, "timestamp outside five minute window");
  const m = env.message, parent = m.replyTo ? queue.all().find(x => x.m.id === m.replyTo)?.m : undefined;
  if (m.replyTo && (!parent || !(parseAddress(parent.to)?.peer === sender.name || parent.remote?.peer === sender.name))) return error(400, "$.message.replyTo: must name a message exchanged with this peer");
  // An answer to a message this host sent the sender reaches that message's local author without a grant, so a
  // conversation either side starts runs both ways. It never starts a run: a runner or profile author needs a grant.
  const runnable = queue.runners().includes(m.to) || !!queue.resolveTarget(m.to, { write: false }).profile;
  const answering = !!parent && parseAddress(parent.to)?.peer === sender.name && parent.from === m.to && parent.project === m.project && !runnable;
  const agent = !runnable && !agents.reserved().includes(m.to) ? agents.resolve(m.to, now) : undefined;
  if (!answering) {
    if (!covers(sender.projects, m.project)) return error(403, "project not allowed");
    if (!sender.allow.includes(m.to) && !(agent && covers(agent.projects, m.project))) return error(403, "recipient not allowed");
  }
  // An alias is filed under the agent's own name, so its inbox holds every message to any of its names.
  const to = agent && !sender.allow.includes(m.to) ? agent.name : m.to;
  return locked(() => {
    const received: Received[] = readOr("received.json", RECEIVED, { received: [] }).received.filter(x => now - Date.parse(x.at) <= RECEIVED_TTL_MS);
    const old = received.find(x => x.peer === sender.name && x.id === env.id);
    if (old) { write("received.json", { received }); return { status: 200, body: { protocol: PROTOCOL, id: old.localId, duplicate: true } }; }
    let local: queue.Message;
    try {
      const target = queue.resolveTarget(to, { write: false });
      local = queue.send({ ...m, to, from: `${m.from}@${sender.name}`, access: "read-only", ...(target.profile ? { profile: target.profile } : {}), files: [], remote: { peer: sender.name, id: env.id } });
    } catch (e) { return error(400, `$.message: ${(e as Error).message}`); }
    received.push({ peer: sender.name, id: env.id, localId: local.id, at: new Date(now).toISOString() }); write("received.json", { received });
    return { status: 200, body: { protocol: PROTOCOL, id: local.id } };
  });
}

/** One addressable recipient in a directory: a runner or profile the owner granted, another granted name, or an agent
 *  that registered itself. */
export interface Listed { name: string; kind: "runner" | "profile" | "recipient" | "agent"; projects: string[]; lifetime?: "stable" | "ephemeral"; aliases?: string[]; description?: string }
const LISTED: Shape<Listed> = obj({ name, kind: literal("runner", "profile", "recipient", "agent"), projects: arr(project) }, { lifetime: literal("stable", "ephemeral"), aliases: arr(name), description: str });
const DIRECTORY = obj({ protocol: literal(PROTOCOL), kind: literal("directory"), at: iso, toKey: hex64, id: nonempty });
const LISTING = obj({ protocol: literal(PROTOCOL), agents: arr(LISTED) });
/** What `s` may address on this host, and in which projects. */
function listFor(s: Sender, now: number): Listed[] {
  const plain = queue.plainRunners(), all = queue.runners();
  const granted: Listed[] = s.allow.map(n => ({ name: n, kind: plain.includes(n) ? "runner" : all.includes(n) ? "profile" : "recipient", projects: [...s.projects] }));
  const registered = agents.live(now).filter(a => !s.allow.includes(a.name)).flatMap(a => {
    const projects = intersect(a.projects, s.projects);
    return projects.length ? [{ name: a.name, kind: "agent" as const, projects, lifetime: a.kind, ...(a.aliases.length ? { aliases: a.aliases } : {}), ...(a.description ? { description: a.description } : {}) }] : [];
  });
  return [...granted, ...registered];
}
/** POST /v1/peer/directory: the recipients the signer may address here, signed with this host's key. */
export function serveDirectory(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  const sender = authenticate(bytes, headers, now);
  if (isResponse(sender)) return sender;
  let q: ReturnType<typeof DIRECTORY>;
  try { q = parseFile("directory $", bytes.toString("utf8"), DIRECTORY); } catch (e) { return error(400, (e as Error).message); }
  if (!forMe(q.toKey)) return error(403, "addressed to another host");
  if (!fresh(q.at, now)) return error(403, "timestamp outside five minute window");
  return signedJson(200, { protocol: PROTOCOL, agents: listFor(sender, now) }, identity().privateKey);
}

/** One host's answer in a discovery pass. */
export interface HostListing { host: string; via: "peer" | "mesh"; ok: boolean; error?: string; agents: Listed[] }
const HOST_LISTING: Shape<HostListing> = obj({ host: name, via: literal("peer", "mesh"), ok: bool, agents: arr(LISTED) }, { error: str });
const CACHE = obj({ fetchedAt: iso, hosts: arr(HOST_LISTING) });
/** Ask every live host what this host may address there; each answer must carry that host's signature. The result is
 *  cached in directory.json; one host's failure is recorded and does not stop the others. */
export async function discover(o: { post?: Post; now?: () => number } = {}): Promise<HostListing[]> {
  const post = o.post ?? postFetch, now = o.now ?? Date.now;
  const hosts = await Promise.all(remotes(now()).map(async (r): Promise<HostListing> => {
    try {
      const bytes = Buffer.from(JSON.stringify({ protocol: PROTOCOL, kind: "directory", at: new Date(now()).toISOString(), toKey: fingerprint(r.publicKey), id: randomUUID() }));
      const res = await post(`${r.url.replace(/\/$/, "")}/v1/peer/directory`, bytes, { ...sign(bytes), ...mesh.presentHeaders() }, TIMEOUT_MS);
      if (res.status !== 200) fail(`refused (${res.status}): ${clip(res.text, 300)}`);
      if (!verifyBytes(Buffer.from(res.text), header(res.headers ?? {}, "govern-signature"), r.publicKey)) fail("answer not signed by the host's key");
      return { host: r.name, via: r.via, ok: true, agents: parseFile(`${r.name} directory`, res.text, LISTING).agents };
    } catch (e) { return { host: r.name, via: r.via, ok: false, error: clip((e as Error).message, 300), agents: [] }; }
  }));
  locked(() => write("directory.json", { fetchedAt: new Date(now()).toISOString(), hosts }));
  return hosts;
}
/** The last discovery pass, or undefined before the first. */
export const cached = (): { fetchedAt: string; hosts: HostListing[] } | undefined => readOr<ReturnType<typeof CACHE> | undefined>("directory.json", CACHE, undefined);

const TELEMETRY_REQUEST = obj({ protocol: literal(PROTOCOL), kind: literal("telemetry"), at: iso, toKey: hex64, id: nonempty });
/** POST /v1/peer/telemetry: this host's telemetry, signed with its key, for a mesh member this host names as an observer. */
export function serveTelemetry(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  const sender = authenticate(bytes, headers, now);
  if (isResponse(sender)) return sender;
  let q: ReturnType<typeof TELEMETRY_REQUEST>;
  try { q = parseFile("telemetry $", bytes.toString("utf8"), TELEMETRY_REQUEST); } catch (e) { return error(400, (e as Error).message); }
  if (!forMe(q.toKey)) return error(403, "addressed to another host");
  if (!fresh(q.at, now)) return error(403, "timestamp outside five minute window");
  if (sender.via !== "mesh" || !mesh.observers().includes(sender.name)) return error(403, "not an observer of this host");
  return signedJson(200, telemetry.snapshot({ peers: liveStatic(), now }) as unknown as Record<string, unknown>, identity().privateKey);
}
const liveStatic = () => peers().filter(p => !p.revokedAt).length;
/** This host's own telemetry. */
export const localTelemetry = (now = Date.now()): telemetry.Telemetry => telemetry.snapshot({ peers: liveStatic(), now });
/** One host's telemetry answer in a command-center pass. */
export interface Observed { host: string; url: string; ok: boolean; error?: string; telemetry?: telemetry.Telemetry }
/** Ask every live mesh member for its telemetry; an answer must carry that host's signature and parse as a closed
 *  telemetry shape naming that host's key. One host's failure is recorded and does not stop the others. */
export async function observe(o: { post?: Post; now?: () => number } = {}): Promise<Observed[]> {
  const post = o.post ?? postFetch, now = o.now ?? Date.now;
  return Promise.all(mesh.others(now()).map(async (m): Promise<Observed> => {
    try {
      const bytes = Buffer.from(JSON.stringify({ protocol: PROTOCOL, kind: "telemetry", at: new Date(now()).toISOString(), toKey: fingerprint(m.publicKey), id: randomUUID() }));
      const res = await post(`${m.url.replace(/\/$/, "")}/v1/peer/telemetry`, bytes, { ...sign(bytes), ...mesh.presentHeaders() }, TIMEOUT_MS);
      if (res.status !== 200) fail(`refused (${res.status}): ${clip(res.text, 300)}`);
      if (!verifyBytes(Buffer.from(res.text), header(res.headers ?? {}, "govern-signature"), m.publicKey)) fail("answer not signed by the host's key");
      const t = parseFile(`${m.name} telemetry`, res.text, telemetry.TELEMETRY);
      if (t.fingerprint !== fingerprint(m.publicKey)) fail("answer names another host's key");
      return { host: m.name, url: m.url, ok: true, telemetry: t };
    } catch (e) { return { host: m.name, url: m.url, ok: false, error: clip((e as Error).message, 300) }; }
  }));
}

const LANES_REQUEST = obj({ protocol: literal(PROTOCOL), kind: literal("lanes"), at: iso, toKey: hex64, id: nonempty });
const PROCESS_REQUEST = obj({ protocol: literal(PROTOCOL), kind: literal("process"), at: iso, toKey: hex64, id: nonempty, name: nonempty, hash: hex64 });
/** The sender of a read-only observer request, or the refusal: signed, addressed to this host, fresh, and a mesh member this host names as an observer. */
function observerOnly<T extends { toKey: string; at: string }>(bytes: Buffer, headers: Headers, now: number, shape: Shape<T>, what: string): { q: T } | Response {
  const sender = authenticate(bytes, headers, now);
  if (isResponse(sender)) return sender;
  let q: T;
  try { q = parseFile(`${what} $`, bytes.toString("utf8"), shape); } catch (e) { return error(400, (e as Error).message); }
  if (!forMe(q.toKey)) return error(403, "addressed to another host");
  if (!fresh(q.at, now)) return error(403, "timestamp outside five minute window");
  if (sender.via !== "mesh" || !mesh.observers().includes(sender.name)) return error(403, "not an observer of this host");
  return { q };
}
/** POST /v1/peer/lanes: this host's lane summaries and the processes it uses, signed, for an observer. */
export function serveLanes(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  const r = observerOnly(bytes, headers, now, LANES_REQUEST, "lanes");
  if ("status" in r) return r;
  const id = identity();
  return signedJson(200, live.lanesAnswer({ host: id.name, fingerprint: fingerprint(id.publicKey), now }) as unknown as Record<string, unknown>, id.privateKey);
}
/** POST /v1/peer/process: one process definition of this host by name and hash, signed, for an observer; 404 when this host has no such definition. */
export function serveProcess(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  const r = observerOnly(bytes, headers, now, PROCESS_REQUEST, "process");
  if ("status" in r) return r;
  const definition = live.definitionOf(r.q.name, r.q.hash);
  if (definition === undefined) return error(404, "no such process definition here");
  const id = identity();
  return signedJson(200, { protocol: live.PROCESS_PROTOCOL, host: id.name, fingerprint: fingerprint(id.publicKey), at: new Date(now).toISOString(), name: r.q.name, hash: r.q.hash, definition }, id.privateKey);
}
/** One host's lanes answer in a command-center pass. `unknown` marks a host that does not serve lanes (an older govern): its lanes cannot be shown. */
export interface ObservedLanes { host: string; url: string; ok: boolean; unknown?: boolean; error?: string; answer?: live.LanesAnswer }
async function askMember<T>(m: ReturnType<typeof mesh.others>[number], kind: "lanes" | "process", extra: Record<string, string>, shape: Shape<T>, o: { post: Post; now: () => number }): Promise<{ status: number; value?: T; error?: string }> {
  const bytes = Buffer.from(JSON.stringify({ protocol: PROTOCOL, kind, at: new Date(o.now()).toISOString(), toKey: fingerprint(m.publicKey), id: randomUUID(), ...extra }));
  const res = await o.post(`${m.url.replace(/\/$/, "")}/v1/peer/${kind}`, bytes, { ...sign(bytes), ...mesh.presentHeaders() }, TIMEOUT_MS);
  if (res.status !== 200) return { status: res.status, error: `refused (${res.status}): ${clip(res.text, 300)}` };
  if (!verifyBytes(Buffer.from(res.text), header(res.headers ?? {}, "govern-signature"), m.publicKey)) return { status: 200, error: "answer not signed by the host's key" };
  return { status: 200, value: parseFile(`${m.name} ${kind}`, res.text, shape) };
}
/** Ask every live mesh member for its lanes. An answer must carry that host's signature, parse as the closed shape and name that host's key;
 *  a host that answers 404 does not know the route and is marked `unknown`. One host's failure does not stop the others. */
export async function observeLanes(o: { post?: Post; now?: () => number } = {}): Promise<ObservedLanes[]> {
  const post = o.post ?? postFetch, now = o.now ?? Date.now;
  return Promise.all(mesh.others(now()).map(async (m): Promise<ObservedLanes> => {
    try {
      const r = await askMember(m, "lanes", {}, live.LANES_ANSWER, { post, now });
      if (r.status === 404) return { host: m.name, url: m.url, ok: false, unknown: true, error: "this host's govern does not report lanes yet" };
      if (!r.value) return { host: m.name, url: m.url, ok: false, error: r.error ?? "no answer" };
      if (r.value.fingerprint !== fingerprint(m.publicKey)) return { host: m.name, url: m.url, ok: false, error: "answer names another host's key" };
      return { host: m.name, url: m.url, ok: true, answer: r.value };
    } catch (e) { return { host: m.name, url: m.url, ok: false, error: clip((e as Error).message, 300) }; }
  }));
}
/** One process definition (its JSON text) from mesh member `host`, checked against the hash asked for; undefined when the host does not have it. */
export async function fetchProcess(host: string, name: string, hash: string, o: { post?: Post; now?: () => number } = {}): Promise<string | undefined> {
  const post = o.post ?? postFetch, now = o.now ?? Date.now, m = mesh.others(now()).find((x) => x.name === host);
  if (!m) fail(`${host} is not a live mesh member`);
  const r = await askMember(m, "process", { name, hash }, live.PROCESS_ANSWER, { post, now });
  if (r.status === 404) return undefined;
  if (!r.value) return fail(r.error ?? "no answer");
  if (r.value.fingerprint !== fingerprint(m.publicKey) || r.value.name !== name || r.value.hash !== hash) return fail("answer is for another host or process");
  if (createHash("sha256").update(r.value.definition).digest("hex") !== hash) return fail("definition does not match its hash");
  return r.value.definition;
}

const RECEIPT = obj({ protocol: literal(PROTOCOL), id: nonempty }, { duplicate: bool });
/** One relay pass; a retry is bounded by eight attempts and an exponential backoff capped at one hour. */
export async function push(o: { max?: number; now?: number | (() => number); post?: Post } = {}): Promise<string[]> {
  if (o.max !== undefined && (!Number.isInteger(o.max) || o.max < 1)) usage("max must be a positive integer");
  const clock = () => typeof o.now === "function" ? o.now() : o.now ?? Date.now(), post = o.post ?? postFetch, lines = queue.reclaimDead();
  const todo = queue.all().filter(x => x.state === "open" && parseAddress(x.m.to) && (!x.m.relay || Date.parse(x.m.relay.nextAt) <= clock())).slice(0, o.max ?? Infinity);
  for (const { m } of todo) {
    if (!queue.claim(m, "relay")) continue;
    const start = Date.now(), now = clock(), address = parseAddress(m.to)!;
    const failMessage = (why: string) => {
      const notice = queue.send({ project: m.project, task: m.task, kind: "BLOCKED", from: "relay", to: ["dispatcher", "relay"].includes(m.from) ? "owner" : queue.LEGACY_OWNER(m), summary: clip(`relay refused: ${why}`, 200), body: `${m.id} to ${m.to} refused: ${why}`, files: [], replyTo: m.id, access: "read-only" });
      m.result = { agent: "relay", ok: false, seconds: Math.round((Date.now() - start) / 1000), error: why, reply: notice.id };
      queue.save(m, "claimed"); queue.move(m, "claimed", "failed"); lines.push(`${m.id} → ${m.to}: failed: ${why}`);
    };
    let target: Remote, bytes: Buffer, headers: Headers;
    try {
      target = remote(address.peer, now);
      if (m.verification?.state === "unverified") fail("unverified message");
      if (m.files.length) fail("files are decided by the receiving host");
      for (const k of ["profile", "lane", "estimateUsd"] as const) if (m[k] !== undefined) fail(`${k} is decided by the receiving host`);
      if (m.access === "write") fail("write access is decided by the receiving host");
      bytes = Buffer.from(JSON.stringify(envelope(m, fingerprint(target.publicKey), now)));
      if (bytes.length > MAX_BODY) fail("envelope exceeds size limit");
      headers = { ...sign(bytes), ...mesh.presentHeaders() };
    } catch (e) { failMessage((e as Error).message); continue; }
    let lastError: string;
    try {
      const r = await post(`${target.url.replace(/\/$/, "")}/v1/peer/deliver`, bytes, headers, TIMEOUT_MS);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) { failMessage(`peer ${address.peer} refused (${r.status}): ${clip(r.text, 300)}`); continue; }
      if (r.status < 200 || r.status >= 300) throw new Error(`peer ${address.peer} returned ${r.status}: ${clip(r.text, 300)}`);
      const receipt = parseFile("receipt", r.text, RECEIPT);
      const seconds = Math.round((Date.now() - start) / 1000);
      m.result = { agent: "relay", ok: true, seconds, note: `delivered to ${address.peer} as ${receipt.id}` };
      queue.save(m, "claimed"); queue.move(m, "claimed", "done");
      appendFileSync(join(queue.QUEUE(), "ledger.jsonl"), JSON.stringify({ t: new Date(now).toISOString(), kind: "relay", id: m.id, project: m.project, task: m.task, agent: "relay", ok: true, seconds }) + "\n");
      lines.push(`${m.id} → ${m.to}: ${m.result.note}`); continue;
    } catch (e) { lastError = clip((e as Error).message, 300); }
    const attempts = (m.relay?.attempts ?? 0) + 1;
    m.relay = { attempts, lastError, nextAt: new Date(clock() + Math.min(30_000 * 2 ** (attempts - 1), 3600_000)).toISOString() };
    if (attempts >= MAX_ATTEMPTS) { failMessage(`after ${attempts} attempts: ${lastError}`); continue; }
    delete m.claim;
    queue.save(m, "claimed"); queue.move(m, "claimed", "open"); lines.push(`${m.id} → ${m.to}: retry ${attempts} at ${m.relay.nextAt}: ${lastError}`);
  }
  return lines;
}

type Route = (bytes: Buffer, headers: Headers, now: number) => Response;
const ROUTES: Record<string, Route> = {
  "POST /v1/peer/deliver": receive,
  "POST /v1/peer/directory": serveDirectory,
  "POST /v1/peer/telemetry": serveTelemetry,
  "POST /v1/peer/lanes": serveLanes,
  "POST /v1/peer/process": serveProcess,
  "POST /v1/mesh/join": mesh.serveJoin,
  "POST /v1/mesh/sync": mesh.serveSync,
};
/** Loopback HTTP transport; a tunnel supplies TLS. Authentication and closed-shape parsing live in each route. */
export function peerServer(o: { now?: () => number } = {}): Server {
  const now = o.now ?? Date.now;
  const server = createServer((req, res) => {
    const reply = (r: Response): void => {
      if (res.headersSent) return;
      res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(r.headers ?? {}) });
      res.end(r.bytes ?? JSON.stringify(r.body));
    };
    const fault = () => reply(error(500, "internal error"));
    const key = `${req.method} ${req.url}`;
    if (key === "GET /v1/health") {
      req.resume();
      try { reply({ status: 200, body: { protocol: PROTOCOL, name: identity().name } }); } catch { fault(); }
      return;
    }
    const route = ROUTES[key];
    if (!route) { req.resume(); reply(error(404, "not found")); return; }
    let size = 0; const chunks: Buffer[] = [];
    // Drain excess bytes so the client receives the 413 instead of a reset connection.
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { chunks.length = 0; reply(error(413, "body exceeds size limit")); }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      try {
        const headers: Headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        reply(route(Buffer.concat(chunks), headers, now()));
      } catch { fault(); }
    });
    req.on("error", () => reply(error(400, "incomplete request")));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
