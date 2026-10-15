// Signed queue delivery between hosts. Peers grant local recipient/project access; execution policy stays local.
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { obj, str, bool, arr, literal, parseFile, check, reject, type Shape } from "./shape.ts";
import { stateDir } from "./workspace.ts";
import { withLaneLock } from "./lane-lock.ts";
import { fail, clip } from "./util.ts";
import * as queue from "./queue.ts";

export const PROTOCOL = "govern-peer/1";
export const MAX_BODY = 262144;
const SKEW_MS = 5 * 60_000, RECEIVED_TTL_MS = 7 * 86400_000;
const MAX_ATTEMPTS = 8, TIMEOUT_MS = 15000;
const NAME = /^[a-z0-9][a-z0-9.-]*$/;
const name: Shape<string> = (v, p) => { const s = str(v, p); return NAME.test(s) ? s : reject(p, "must be lowercase letters, digits, dots and dashes, starting with a letter or digit"); };
const nonempty: Shape<string> = (v, p) => { const s = str(v, p); return s.length ? s : reject(p, "must not be empty"); };
const iso: Shape<string> = (v, p) => { const s = str(v, p); return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s)) ? s : reject(p, "must be an ISO timestamp"); };
const slug: Shape<string> = (v, p) => { const s = str(v, p); return /^[a-z0-9][a-z0-9.\/-]*$/.test(s) && !s.split("/").some(x => x === ".." || x === "") ? s : reject(p, "must be a project slug"); };
const publicKey: Shape<string> = (v, p) => {
  const s = str(v, p);
  try {
    const bytes = Buffer.from(s, "base64");
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== s || !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error("bad key");
  } catch { reject(p, "must be a base64 DER Ed25519 SPKI public key"); }
  return s;
};
const url: Shape<string> = (v, p) => {
  const s = str(v, p);
  try {
    const u = new URL(s);
    const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password || u.search || u.hash) throw new Error("bad URL");
  } catch { reject(p, "must be an https URL (http is allowed only on loopback)"); }
  return s;
};

export interface Identity { name: string; publicKey: string; privateKey: string }
export interface Peer { name: string; url: string; publicKey: string; allow: string[]; projects: string[]; addedAt: string; revokedAt?: string }
const HOST: Shape<Identity> = (v, p) => {
  const h = obj({ name, publicKey, privateKey: str })(v, p);
  try {
    const key = createPrivateKey({ key: h.privateKey, format: "pem", type: "pkcs8" });
    if (!h.privateKey.startsWith("-----BEGIN PRIVATE KEY-----") || key.asymmetricKeyType !== "ed25519") throw new Error("bad key");
    if (createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") !== h.publicKey) throw new Error("mismatched key");
  } catch { reject(`${p}.privateKey`, "must be an Ed25519 PKCS#8 PEM private key matching publicKey"); }
  return h;
};
const PEER = obj({ name, url, publicKey, allow: arr(name), projects: arr((v, p) => v === "*" ? "*" : slug(v, p)), addedAt: iso }, { revokedAt: iso });
const PEERS: Shape<{ peers: Peer[] }> = (v, p) => {
  const out = obj({ peers: arr(PEER) })(v, p), live = new Set<string>();
  out.peers.forEach((x, i) => {
    if (!x.revokedAt) { if (live.has(x.name)) reject(`${p}.peers[${i}].name`, `duplicate live name ${x.name}`); live.add(x.name); }
    if (x.projects.includes("*") && x.projects.length !== 1) reject(`${p}.peers[${i}].projects`, '"*" must be the only project');
  });
  return out;
};
const dir = () => join(stateDir(), "peer");
const file = (n: string) => join(dir(), n);
function ensureDir(): void { mkdirSync(dir(), { recursive: true, mode: 0o700 }); }
const locked = <T>(f: () => T): T => { ensureDir(); return withLaneLock(file("lock"), f); };
function read<T>(n: string, shape: Shape<T>): T { return parseFile(file(n), readFileSync(file(n), "utf8"), shape); }
function write(n: string, value: unknown): void {
  const f = file(n), tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, f);
}
/** Create once under the peer lock; an existing identity can never be renamed implicitly. */
export function identity(requestedName?: string): Identity {
  return locked(() => {
    if (existsSync(file("host.json"))) {
      const h = read("host.json", HOST);
      if (requestedName !== undefined && requestedName !== h.name) fail(`host identity already has name ${h.name}`);
      return h;
    }
    const keys = generateKeyPairSync("ed25519");
    const h = check(file("host.json"), { name: requestedName ?? hostname().toLowerCase().replace(/[^a-z0-9.-]/g, "-"), publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }, HOST);
    write("host.json", h); return h;
  });
}
/** The lowercase hex SHA-256 of a base64 DER Ed25519 public key; fails when the key is not one. */
export function fingerprint(key: string): string { return createHash("sha256").update(Buffer.from(check("publicKey", key, publicKey), "base64")).digest("hex"); }
/** Every peer in peers.json, revoked ones included; [] before the first `govern peer add`. Fails naming the file and path when it is malformed. */
export function peers(): Peer[] { return existsSync(file("peers.json")) ? read("peers.json", PEERS).peers : []; }
/** Add a peer under the peer lock: checked against the peer shape, and refused when its name is already live. */
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
/** Syntax only: CLI/relay checks whether the named peer is live. */
export function parseAddress(address: string): { name: string; peer: string } | undefined {
  const parts = address.split("@");
  return parts.length === 2 && parts.every(x => NAME.test(x)) ? { name: parts[0]!, peer: parts[1]! } : undefined;
}

const MESSAGE = obj({ project: slug, task: name, kind: literal(...queue.KINDS), from: name, to: name, summary: (v, p) => { const s = str(v, p); return s.trim() && s.length <= 200 ? s : reject(p, "must be non-empty after trimming and at most 200 characters"); }, body: str }, { replyTo: nonempty });
const ENVELOPE = obj({ protocol: literal(PROTOCOL), id: nonempty, at: iso, message: MESSAGE });
export type Envelope = ReturnType<typeof ENVELOPE>;
/** Translate reply threading only when the parent came from the destination host. */
export function envelope(m: queue.Message, now = Date.now()): Envelope {
  const address = parseAddress(m.to) ?? fail(`not a remote address: ${m.to}`);
  const parent = m.replyTo ? queue.find(m.replyTo)?.m : undefined;
  return check("envelope", { protocol: PROTOCOL, id: m.id, at: new Date(now).toISOString(), message: {
    project: m.project, task: m.task, kind: m.kind, from: m.from, to: address.name, summary: m.summary, body: m.body,
    ...(parent?.remote?.peer === address.peer ? { replyTo: parent.remote.id } : {}),
  } }, ENVELOPE);
}
export type Headers = Record<string, string>;
/** The delivery headers for `bytes`: this host's key fingerprint and the Ed25519 signature of exactly those bytes. */
export function sign(bytes: Buffer, host = identity()): Headers {
  return { "Govern-Peer-Key": fingerprint(host.publicKey), "Govern-Signature": edSign(null, bytes, host.privateKey).toString("base64") };
}
interface Received { peer: string; id: string; localId: string; at: string }
const RECEIVED = obj({ received: arr(obj({ peer: name, id: nonempty, localId: nonempty, at: iso })) });
export interface Response { status: number; body: { protocol?: string; id?: string; duplicate?: boolean; error?: string } }
const error = (status: number, message: string): Response => ({ status, body: { error: message } });
/** Authenticate exact bytes before parsing. Deduplication and filing are serialized across receiver processes. */
export function receive(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  if (bytes.length > MAX_BODY) return error(413, "body exceeds size limit");
  const header = (n: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === n)?.[1];
  const sender = peers().find(p => !p.revokedAt && fingerprint(p.publicKey) === header("govern-peer-key"));
  if (!sender) return error(403, "unknown peer");
  try {
    const sig = header("govern-signature") ?? "";
    if (!edVerify(null, bytes, createPublicKey({ key: Buffer.from(sender.publicKey, "base64"), type: "spki", format: "der" }), Buffer.from(sig, "base64"))) return error(403, "bad signature");
  } catch { return error(403, "bad signature"); }
  let env: Envelope;
  try { env = parseFile("delivery $", bytes.toString("utf8"), ENVELOPE); }
  catch (e) { return error(400, (e as Error).message); }
  if (Math.abs(Date.parse(env.at) - now) > SKEW_MS) return error(403, "timestamp outside five minute window");
  const m = env.message;
  if (!sender.allow.includes(m.to)) return error(403, "recipient not allowed");
  if (!(sender.projects.length === 1 && sender.projects[0] === "*") && !sender.projects.includes(m.project)) return error(403, "project not allowed");
  if (m.replyTo) {
    const parent = queue.all().find(x => x.m.id === m.replyTo)?.m;
    if (!parent || !(parseAddress(parent.to)?.peer === sender.name || parent.remote?.peer === sender.name)) return error(400, "$.message.replyTo: must name a message exchanged with this peer");
  }
  return locked(() => {
    const received: Received[] = (existsSync(file("received.json")) ? read("received.json", RECEIVED).received : []).filter(x => now - Date.parse(x.at) <= RECEIVED_TTL_MS);
    const old = received.find(x => x.peer === sender.name && x.id === env.id);
    if (old) { write("received.json", { received }); return { status: 200, body: { protocol: PROTOCOL, id: old.localId, duplicate: true } }; }
    let local: queue.Message;
    try {
      const target = queue.resolveTarget(m.to, { write: false });
      local = queue.send({ ...m, from: `${m.from}@${sender.name}`, access: "read-only", ...(target.profile ? { profile: target.profile } : {}), files: [], remote: { peer: sender.name, id: env.id } });
    } catch (e) { return error(400, `$.message: ${(e as Error).message}`); }
    received.push({ peer: sender.name, id: env.id, localId: local.id, at: new Date(now).toISOString() }); write("received.json", { received });
    return { status: 200, body: { protocol: PROTOCOL, id: local.id } };
  });
}

export type Post = (url: string, bytes: Buffer, headers: Headers, timeoutMs: number) => Promise<{ status: number; text: string }>;
const postFetch: Post = async (url, bytes, headers, timeoutMs) => {
  const r = await fetch(url, { method: "POST", body: new Uint8Array(bytes), headers: { ...headers, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  return { status: r.status, text: await r.text() };
};
const RECEIPT = obj({ protocol: literal(PROTOCOL), id: nonempty }, { duplicate: bool });
/** One relay pass; a retry is bounded by eight attempts and an exponential backoff capped at one hour. */
export async function push(o: { max?: number; now?: number | (() => number); post?: Post } = {}): Promise<string[]> {
  const clock = () => typeof o.now === "function" ? o.now() : o.now ?? Date.now(), post = o.post ?? postFetch, lines: string[] = [];
  if (o.max !== undefined && (!Number.isInteger(o.max) || o.max < 1)) fail("max must be a positive integer");
  const todo = queue.all().filter(x => x.state === "open" && parseAddress(x.m.to) && (!x.m.relay || Date.parse(x.m.relay.nextAt) <= clock())).slice(0, o.max ?? Infinity);
  for (const { m } of todo) {
    if (!queue.move(m, "open", "claimed")) continue;
    const start = Date.now(), now = clock(), address = parseAddress(m.to)!;
    const failMessage = (why: string) => {
      const notice = queue.send({ project: m.project, task: m.task, kind: "BLOCKED", from: "relay", to: ["dispatcher", "relay"].includes(m.from) ? "owner" : queue.LEGACY_OWNER(m), summary: clip(`relay refused: ${why}`, 200), body: `${m.id} to ${m.to} refused: ${why}`, files: [], replyTo: m.id, access: "read-only" });
      m.result = { agent: "relay", ok: false, seconds: Math.round((Date.now() - start) / 1000), error: why, reply: notice.id };
      queue.save(m, "claimed"); queue.move(m, "claimed", "failed"); lines.push(`${m.id} → ${m.to}: failed: ${why}`);
    };
    let target: Peer | undefined, bytes: Buffer, headers: Headers;
    try {
      target = peers().find(p => p.name === address.peer && !p.revokedAt);
      if (!target) fail(`unknown or revoked peer ${address.peer}`);
      if (m.verification?.state === "unverified") fail("unverified message");
      if (m.files.length) fail("files are decided by the receiving host");
      for (const k of ["profile", "lane", "estimateUsd"] as const) if (m[k] !== undefined) fail(`${k} is decided by the receiving host`);
      if (m.access === "write") fail("write access is decided by the receiving host");
      bytes = Buffer.from(JSON.stringify(envelope(m, now)));
      if (bytes.length > MAX_BODY) fail("envelope exceeds size limit");
      headers = sign(bytes);
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
    queue.save(m, "claimed"); queue.move(m, "claimed", "open"); lines.push(`${m.id} → ${m.to}: retry ${attempts} at ${m.relay.nextAt}: ${lastError}`);
  }
  return lines;
}
