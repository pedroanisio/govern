// Mesh membership: one registrar host holds the mesh key and issues 30-day certificates; every member trusts every other
// certified member, so N hosts need N joins rather than N² pairings. Grants for members stay each host's own policy.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { obj, str, arr, literal, parseFile, check, reject, type Shape } from "./shape.ts";
import {
  name, nonempty, iso, hex64, project, publicKey, url, keys, newKeys, file, locked, readOr, write, identity,
  fingerprint, header, signBytes, verifyBytes, sign, fresh, error, signedJson, postFetch, MAX_BODY, TIMEOUT_MS,
  type Keys, type Headers, type Response, type Post,
} from "./peer-id.ts";
import { fail, clip } from "./util.ts";

export const MESH_PROTOCOL = "govern-mesh/1";
export const CERT_MS = 30 * 86400_000, DEFAULT_INVITE_S = 3600, MAX_INVITE_S = 7 * 86400;
const INVITE_PREFIX = "govern-mesh:";

export interface CertBody { protocol: string; mesh: string; name: string; url: string; publicKey: string; issued: string; expires: string }
export interface Cert { body: string; signature: string }
const CERT_BODY: Shape<CertBody> = obj({ protocol: literal(MESH_PROTOCOL), mesh: hex64, name, url, publicKey, issued: iso, expires: iso });
const CERT: Shape<Cert> = obj({ body: str, signature: str });
export interface Policy { allow: string[]; projects: string[] }
const projects: Shape<string[]> = (v, p) => { const a = arr(project)(v, p); return a.includes("*") && a.length !== 1 ? reject(p, '"*" must be the only project') : a; };
const POLICY: Shape<Policy> = obj({ allow: arr(name), projects });

interface RegMember { name: string; url: string; publicKey: string; joinedAt: string; revokedAt?: string }
interface Invite { id: string; secretSha256: string; expires: string; name?: string; usedAt?: string }
interface Registrar extends Keys { version: 1; name: string; url: string; members: RegMember[]; invites: Invite[] }
const REGISTRAR: Shape<Registrar> = keys(obj({
  version: literal(1), name, publicKey, privateKey: str, url,
  members: arr(obj({ name, url, publicKey, joinedAt: iso }, { revokedAt: iso })),
  invites: arr(obj({ id: nonempty, secretSha256: hex64, expires: iso }, { name, usedAt: iso })),
}));
export interface Member { version: 1; mesh: { name: string; publicKey: string; url: string }; cert: Cert; members: CertBody[]; revoked: string[]; syncedAt: string; policy: Policy }
const MEMBER: Shape<Member> = obj({
  version: literal(1), mesh: obj({ name, publicKey, url }), cert: CERT, members: arr(CERT_BODY), revoked: arr(hex64), syncedAt: iso, policy: POLICY,
});
const REG_FILE = "mesh-registrar.json", MEMBER_FILE = "mesh.json";
const registrarState = (): Registrar | undefined => readOr<Registrar | undefined>(REG_FILE, REGISTRAR, undefined);
/** This host's mesh membership, or undefined before `govern mesh create` or `join`. */
export const state = (): Member | undefined => readOr<Member | undefined>(MEMBER_FILE, MEMBER, undefined);

/** A certificate for `m`, signed by the mesh key, valid for CERT_MS from `now`. */
export function issue(mesh: Keys, m: { name: string; url: string; publicKey: string }, now: number): Cert {
  const body = JSON.stringify(check("certificate", { protocol: MESH_PROTOCOL, mesh: fingerprint(mesh.publicKey), name: m.name, url: m.url, publicKey: m.publicKey, issued: new Date(now).toISOString(), expires: new Date(now + CERT_MS).toISOString() }, CERT_BODY));
  return { body, signature: signBytes(Buffer.from(body), mesh.privateKey) };
}
/** The body of `cert` when the mesh key signed it and it is current at `now`; a GovernError otherwise. */
export function verifyCert(cert: Cert, meshKey: string, now: number): CertBody {
  if (!verifyBytes(Buffer.from(cert.body), cert.signature, meshKey)) fail("certificate: bad signature");
  const b = parseFile("certificate", cert.body, CERT_BODY);
  if (b.mesh !== fingerprint(meshKey)) fail("certificate: issued by another mesh");
  if (Date.parse(b.expires) <= now) fail("certificate: expired");
  if (Date.parse(b.issued) > now + 5 * 60_000) fail("certificate: issued in the future");
  return b;
}
const certHeader = (c: Cert): string => Buffer.from(JSON.stringify(c)).toString("base64");
/** Headers that let a receiver that has not synced since this host joined still verify it: its own certificate. */
export function presentHeaders(): Headers { const s = state(); return s ? { "Govern-Peer-Cert": certHeader(s.cert) } : {}; }

/** A live member other than this host with `n` as its name. */
export function memberByName(n: string, now = Date.now()): CertBody | undefined {
  const s = state(); if (!s) return undefined;
  const self = identity().publicKey;
  return s.members.find(m => m.name === n && m.publicKey !== self && Date.parse(m.expires) > now && !s.revoked.includes(fingerprint(m.publicKey)));
}
/** Every live member other than this host. */
export function others(now = Date.now()): CertBody[] {
  const s = state(); if (!s) return [];
  return s.members.filter(m => m.publicKey !== identity().publicKey && Date.parse(m.expires) > now && !s.revoked.includes(fingerprint(m.publicKey)));
}
/** The member whose key has fingerprint `fp`: from the synced list, else from a certificate it presented. Revoked or
 *  expired members are not members. */
export function memberByKey(fp: string, presented: string | undefined, now = Date.now()): CertBody | undefined {
  const s = state(); if (!s || s.revoked.includes(fp)) return undefined;
  const known = s.members.find(m => fingerprint(m.publicKey) === fp && Date.parse(m.expires) > now);
  if (known) return known;
  if (!presented) return undefined;
  try {
    const b = verifyCert(check("Govern-Peer-Cert", JSON.parse(Buffer.from(presented, "base64").toString("utf8")), CERT), s.mesh.publicKey, now);
    if (fingerprint(b.publicKey) !== fp) return undefined;
    // A synced member with the same name and another key wins: a name stays bound to the key the registrar listed.
    if (s.members.some(m => m.name === b.name && m.publicKey !== b.publicKey && Date.parse(m.expires) > now)) return undefined;
    return b;
  } catch { return undefined; }
}

const SNAPSHOT = obj({ protocol: literal(MESH_PROTOCOL), mesh: name, cert: CERT, members: arr(CERT), revoked: arr(hex64) });
type Snapshot = ReturnType<typeof SNAPSHOT>;
function snapshot(r: Registrar, forKey: string, now: number): Snapshot {
  const live = r.members.filter(m => !m.revokedAt), self = live.find(m => m.publicKey === forKey) ?? fail("not a live member");
  const revoked = [...new Set(r.members.filter(m => m.revokedAt && !live.some(l => l.publicKey === m.publicKey)).map(m => fingerprint(m.publicKey)))];
  return { protocol: MESH_PROTOCOL, mesh: r.name, cert: issue(r, self, now), members: live.map(m => issue(r, m, now)), revoked };
}
/** Write this host's member state from a snapshot the mesh key signed; every certificate is verified first. */
function apply(meshName: string, mesh: { publicKey: string; url: string }, snap: Snapshot, policy: Policy, now: number): Member {
  const me = identity(), self = verifyCert(snap.cert, mesh.publicKey, now);
  if (self.publicKey !== me.publicKey || self.name !== me.name) fail("mesh: the registrar certified another host");
  const members = snap.members.map(c => verifyCert(c, mesh.publicKey, now)).filter(m => !snap.revoked.includes(fingerprint(m.publicKey)));
  const s: Member = { version: 1, mesh: { name: meshName, ...mesh }, cert: snap.cert, members, revoked: snap.revoked, syncedAt: new Date(now).toISOString(), policy };
  write(MEMBER_FILE, check(file(MEMBER_FILE), s, MEMBER)); return s;
}
/** The registrar refreshes its own member state from its table: it never calls itself over HTTP. */
const refreshLocal = (r: Registrar, now: number): Member => {
  const policy = state()?.policy ?? fail("mesh: the registrar has no member state");
  return apply(r.name, { publicKey: r.publicKey, url: r.url }, snapshot(r, identity().publicKey, now), policy, now);
};

function checkPolicy(p: Policy): Policy {
  const out = check("policy", p, POLICY);
  if (!out.projects.length) fail("--project is required: name the projects mesh members may address here (or '*')");
  return out;
}
/** Make this host the registrar of a new mesh and its first member. */
export function create(o: { name: string; url: string; policy: Policy; now?: number }): Member {
  const now = o.now ?? Date.now(), policy = checkPolicy(o.policy), me = identity();
  return locked(() => {
    if (existsSync(file(MEMBER_FILE)) || existsSync(file(REG_FILE))) fail(`already in mesh ${state()?.mesh.name ?? "(registrar)"}`);
    const r = check(file(REG_FILE), { version: 1, name: o.name, url: o.url, ...newKeys(), members: [{ name: me.name, url: o.url, publicKey: me.publicKey, joinedAt: new Date(now).toISOString() }], invites: [] }, REGISTRAR);
    write(REG_FILE, r);
    return apply(r.name, { publicKey: r.publicKey, url: r.url }, snapshot(r, me.publicKey, now), policy, now);
  });
}

const INVITE = obj({ v: literal(1), url, mesh: publicKey, id: nonempty, secret: nonempty });
const sha = (s: string) => createHash("sha256").update(s).digest();
/** A single-use invite code for one new host, valid `ttlSeconds`; `host` pins the name the joining host must have. */
export function invite(o: { host?: string; ttlSeconds?: number; now?: number } = {}): { code: string; expires: string } {
  const now = o.now ?? Date.now(), ttl = o.ttlSeconds ?? DEFAULT_INVITE_S;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_INVITE_S) fail(`--ttl must be a whole number of seconds from 60 to ${MAX_INVITE_S}`);
  if (o.host !== undefined) check("--host", o.host, name);
  return locked(() => {
    const r = registrarState() ?? fail("only the registrar invites: run govern mesh invite on the host that ran govern mesh create");
    const id = randomUUID(), secret = randomBytes(32).toString("base64url"), expires = new Date(now + ttl * 1000).toISOString();
    r.invites = [...r.invites.filter(i => Date.parse(i.expires) > now), { id, secretSha256: sha(secret).toString("hex"), expires, ...(o.host ? { name: o.host } : {}) }];
    write(REG_FILE, r);
    return { code: INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 1, url: r.url, mesh: r.publicKey, id, secret })).toString("base64url"), expires };
  });
}
/** The registrar URL, mesh key, invite id and secret in an invite code. */
export function parseInvite(code: string): ReturnType<typeof INVITE> {
  if (!code.startsWith(INVITE_PREFIX)) fail(`not a mesh invite code (it starts with ${INVITE_PREFIX})`);
  return parseFile("invite code", Buffer.from(code.slice(INVITE_PREFIX.length), "base64url").toString("utf8"), INVITE);
}


const JOIN = obj({ protocol: literal(MESH_PROTOCOL), kind: literal("join"), at: iso, toKey: hex64, invite: nonempty, member: obj({ name, url, publicKey }) });
const SYNC = obj({ protocol: literal(MESH_PROTOCOL), kind: literal("sync"), at: iso, toKey: hex64, id: nonempty }, { url });
/** The invite proof: an HMAC of the exact request bytes keyed by the SHA-256 of the invite secret, which is all the
 *  registrar stores. Reading the registrar's state already yields the mesh key, so the stored hash grants nothing more. */
const proof = (key: Buffer, bytes: Buffer) => createHmac("sha256", key).update(bytes).digest("base64");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const asBody = (s: Snapshot) => s as unknown as Record<string, unknown>;

/** Registrar side of POST /v1/mesh/join: one use of an unexpired invite, proven by Govern-Invite-Proof, and a signature
 *  by the joining key. Answers with a mesh-signed snapshot that includes the new member's certificate. */
export function serveJoin(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  if (bytes.length > MAX_BODY) return error(413, "body exceeds size limit");
  const r0 = registrarState(); if (!r0) return error(404, "not found");
  let j: ReturnType<typeof JOIN>;
  try { j = parseFile("join $", bytes.toString("utf8"), JOIN); } catch (e) { return error(400, (e as Error).message); }
  if (j.toKey !== fingerprint(r0.publicKey)) return error(403, "addressed to another mesh");
  if (!fresh(j.at, now)) return error(403, "timestamp outside five minute window");
  return locked(() => {
    const r = registrarState()!, inv = r.invites.find(i => i.id === j.invite);
    if (!inv || inv.usedAt || Date.parse(inv.expires) <= now || !same(proof(Buffer.from(inv.secretSha256, "hex"), bytes), header(headers, "govern-invite-proof") ?? "")) return error(403, "invalid or used invite");
    if (!verifyBytes(bytes, header(headers, "govern-signature"), j.member.publicKey)) return error(403, "bad signature");
    if (inv.name && inv.name !== j.member.name) return error(403, `this invite is for host ${inv.name}`);
    const live = r.members.filter(m => !m.revokedAt);
    if (live.some(m => m.name === j.member.name && m.publicKey !== j.member.publicKey)) return error(409, `name ${j.member.name} is taken in this mesh`);
    const known = live.find(m => m.publicKey === j.member.publicKey);
    if (known && known.name !== j.member.name) return error(409, `this key is already a member as ${known.name}`);
    inv.usedAt = new Date(now).toISOString();
    if (known) known.url = j.member.url; else r.members.push({ ...j.member, joinedAt: new Date(now).toISOString() });
    write(REG_FILE, r); refreshLocal(r, now);
    return signedJson(200, asBody(snapshot(r, j.member.publicKey, now)), r.privateKey);
  });
}
/** Registrar side of POST /v1/mesh/sync: a live member, signed, gets a renewed certificate, the live member list and
 *  the revoked keys; an optional `url` moves the member to a new address. */
export function serveSync(bytes: Buffer, headers: Headers, now = Date.now()): Response {
  if (bytes.length > MAX_BODY) return error(413, "body exceeds size limit");
  const r0 = registrarState(); if (!r0) return error(404, "not found");
  const fp = header(headers, "govern-peer-key"), m0 = r0.members.find(m => !m.revokedAt && fingerprint(m.publicKey) === fp);
  if (!m0) return error(403, "not a member");
  if (!verifyBytes(bytes, header(headers, "govern-signature"), m0.publicKey)) return error(403, "bad signature");
  let q: ReturnType<typeof SYNC>;
  try { q = parseFile("sync $", bytes.toString("utf8"), SYNC); } catch (e) { return error(400, (e as Error).message); }
  if (q.toKey !== fingerprint(r0.publicKey)) return error(403, "addressed to another mesh");
  if (!fresh(q.at, now)) return error(403, "timestamp outside five minute window");
  return locked(() => {
    const r = registrarState()!, m = r.members.find(x => !x.revokedAt && x.publicKey === m0.publicKey);
    if (!m) return error(403, "not a member");
    if (q.url && q.url !== m.url) { m.url = q.url; write(REG_FILE, r); refreshLocal(r, now); }
    return signedJson(200, asBody(snapshot(r, m.publicKey, now)), r.privateKey);
  });
}

/** POST `body` signed by this host to the registrar and return its snapshot, which must carry the mesh key's signature. */
async function call(base: string, path: string, body: Record<string, unknown>, meshKey: string, post: Post, extra: (bytes: Buffer) => Headers = () => ({})): Promise<Snapshot> {
  const bytes = Buffer.from(JSON.stringify(body));
  const r = await post(`${base.replace(/\/$/, "")}${path}`, bytes, { ...sign(bytes), ...extra(bytes) }, TIMEOUT_MS);
  if (r.status !== 200) fail(`registrar refused (${r.status}): ${clip(r.text, 300)}`);
  if (!verifyBytes(Buffer.from(r.text), header(r.headers ?? {}, "govern-signature"), meshKey)) fail("registrar response is not signed by the mesh key");
  return parseFile("registrar response", r.text, SNAPSHOT);
}
/** Join the mesh an invite code names, at this host's public `url`, with `policy` as the grants for every member. */
export async function join(code: string, o: { url: string; policy: Policy; post?: Post; now?: () => number }): Promise<Member> {
  const inv = parseInvite(code), policy = checkPolicy(o.policy), me = identity(), now = o.now ?? Date.now, u = check("--url", o.url, url);
  if (state() || registrarState()) fail(`already in mesh ${state()?.mesh.name ?? "(registrar)"}`);
  const body = { protocol: MESH_PROTOCOL, kind: "join", at: new Date(now()).toISOString(), toKey: fingerprint(inv.mesh), invite: inv.id, member: { name: me.name, url: u, publicKey: me.publicKey } };
  const snap = await call(inv.url, "/v1/mesh/join", body, inv.mesh, o.post ?? postFetch, bytes => ({ "Govern-Invite-Proof": proof(sha(inv.secret), bytes) }));
  return locked(() => {
    if (existsSync(file(MEMBER_FILE))) fail("already in a mesh");
    return apply(snap.mesh, { publicKey: inv.mesh, url: inv.url }, snap, policy, now());
  });
}
/** Renew this host's certificate and refresh the member list; `url` moves this host to a new public address. */
export async function sync(o: { url?: string; post?: Post; now?: () => number } = {}): Promise<Member> {
  const s = state() ?? fail("not in a mesh: govern mesh create or govern mesh join"), now = o.now ?? Date.now;
  if (o.url !== undefined) check("--url", o.url, url);
  const r = registrarState();
  if (r && r.publicKey === s.mesh.publicKey) return locked(() => {
    const cur = registrarState()!, self = cur.members.find(m => !m.revokedAt && m.publicKey === identity().publicKey)!;
    if (o.url) { self.url = o.url; cur.url = o.url; write(REG_FILE, cur); }
    return refreshLocal(cur, now());
  });
  const body = { protocol: MESH_PROTOCOL, kind: "sync", at: new Date(now()).toISOString(), toKey: fingerprint(s.mesh.publicKey), id: randomUUID(), ...(o.url ? { url: o.url } : {}) };
  const snap = await call(s.mesh.url, "/v1/mesh/sync", body, s.mesh.publicKey, o.post ?? postFetch);
  return locked(() => apply(s.mesh.name, s.mesh, snap, state()?.policy ?? s.policy, now()));
}
/** Registrar only: revoke member `n`. Other members drop it at their next sync, and its certificate lapses within 30 days. */
export function revoke(n: string, now = Date.now()): void {
  locked(() => {
    const r = registrarState() ?? fail("only the registrar revokes members");
    const m = r.members.find(x => !x.revokedAt && x.name === n) ?? fail(`no live member ${n}`);
    if (m.publicKey === identity().publicKey) fail("the registrar cannot revoke itself");
    m.revokedAt = new Date(now).toISOString(); write(REG_FILE, r); refreshLocal(r, now);
  });
}
/** Replace the grants this host gives every mesh member. */
export function setPolicy(p: Policy): Member {
  const policy = checkPolicy(p);
  return locked(() => { const s = state() ?? fail("not in a mesh"); s.policy = policy; write(MEMBER_FILE, s); return s; });
}
/** Whether this host is the mesh's registrar. */
export const isRegistrar = (): boolean => { const r = registrarState(), s = state(); return !!r && !!s && r.publicKey === s.mesh.publicKey; };
