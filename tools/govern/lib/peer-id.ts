// Host identity, the closed shapes and the signed-bytes primitives shared by peer delivery, the mesh and agent registration.
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { obj, str, parseFile, check, reject, type Shape } from "./shape.ts";
import { stateDir } from "./workspace.ts";
import { withLaneLock } from "./lane-lock.ts";
import { fail } from "./util.ts";

/** Largest request or response body any peer route reads. */
export const MAX_BODY = 262144;
/** A signed request's `at` must be within this many milliseconds of the receiver's clock. */
export const SKEW_MS = 5 * 60_000;
export const NAME = /^[a-z0-9][a-z0-9.-]*$/;
/** A host, peer or recipient name: lowercase letters, digits, dots and dashes. */
export const name: Shape<string> = (v, p) => { const s = str(v, p); return NAME.test(s) ? s : reject(p, "must be lowercase letters, digits, dots and dashes, starting with a letter or digit"); };
/** Any string with at least one character. */
export const nonempty: Shape<string> = (v, p) => { const s = str(v, p); return s.length ? s : reject(p, "must not be empty"); };
/** An ISO-8601 UTC timestamp, as `Date.toISOString` writes it. */
export const iso: Shape<string> = (v, p) => { const s = str(v, p); return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s)) ? s : reject(p, "must be an ISO timestamp"); };
/** A project slug: lowercase segments separated by `/`, with no empty or `..` segment. */
export const slug: Shape<string> = (v, p) => { const s = str(v, p); return /^[a-z0-9][a-z0-9.\/-]*$/.test(s) && !s.split("/").some(x => x === ".." || x === "") ? s : reject(p, "must be a project slug"); };
/** A project grant: one slug, or "*" for every project. */
export const project: Shape<string> = (v, p) => v === "*" ? "*" : slug(v, p);
/** A lowercase hex SHA-256 key fingerprint. */
export const hex64: Shape<string> = (v, p) => { const s = str(v, p); return /^[0-9a-f]{64}$/.test(s) ? s : reject(p, "must be a lowercase hex SHA-256 fingerprint"); };
/** A base64 DER SPKI Ed25519 public key, in its one canonical encoding. */
export const publicKey: Shape<string> = (v, p) => {
  const s = str(v, p);
  try {
    const bytes = Buffer.from(s, "base64");
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== s || !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error("bad key");
  } catch { reject(p, "must be a base64 DER Ed25519 SPKI public key"); }
  return s;
};
/** An https URL with no credentials, query or fragment; http only on loopback. */
export const url: Shape<string> = (v, p) => {
  const s = str(v, p);
  try {
    const u = new URL(s);
    const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password || u.search || u.hash) throw new Error("bad URL");
  } catch { reject(p, "must be an https URL (http is allowed only on loopback)"); }
  return s;
};
/** Whether a project grant list covers `p`. */
export const covers = (projects: readonly string[], p: string): boolean => projects.includes("*") || projects.includes(p);
/** The projects both grant lists cover: "*" only when both are "*". */
export function intersect(a: readonly string[], b: readonly string[]): string[] {
  if (a.includes("*")) return [...b];
  if (b.includes("*")) return [...a];
  return a.filter(x => b.includes(x));
}

export interface Keys { publicKey: string; privateKey: string }
export interface Identity extends Keys { name: string }
/** A key pair whose PEM private key matches its base64 SPKI public key. */
export const keys = <T extends Keys>(s: Shape<T>): Shape<T> => (v, p) => {
  const k = s(v, p);
  try {
    const key = createPrivateKey({ key: k.privateKey, format: "pem", type: "pkcs8" });
    if (!k.privateKey.startsWith("-----BEGIN PRIVATE KEY-----") || key.asymmetricKeyType !== "ed25519") throw new Error("bad key");
    if (createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") !== k.publicKey) throw new Error("mismatched key");
  } catch { reject(`${p}.privateKey`, "must be an Ed25519 PKCS#8 PEM private key matching publicKey"); }
  return k;
};
const HOST: Shape<Identity> = keys(obj({ name, publicKey, privateKey: str }));
/** A fresh Ed25519 key pair in the encodings govern stores. */
export function newKeys(): Keys {
  const k = generateKeyPairSync("ed25519");
  return { publicKey: k.publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: k.privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

/** `<stateDir>/peer`: identity, grants, mesh membership and agent registrations. */
export const dir = () => join(stateDir(), "peer");
/** The path of file `n` in the peer directory. */
export const file = (n: string) => join(dir(), n);
function ensureDir(): void { mkdirSync(dir(), { recursive: true, mode: 0o700 }); }
// The peer directories this process holds the lock for: a nested call runs inside the outer one.
const held = new Set<string>();
/** Run `f` holding the peer lock, which serializes every read-modify-write of the peer directory across processes.
 *  Re-entrant within one process: identity() and member refreshes run inside a mesh operation's lock. */
export function locked<T>(f: () => T): T {
  ensureDir();
  const d = dir();
  if (held.has(d)) return f();
  return withLaneLock(file("lock"), () => { held.add(d); try { return f(); } finally { held.delete(d); } });
}
/** Parse peer-directory file `n` with `shape`; fails naming the file and JSON path. */
export function read<T>(n: string, shape: Shape<T>): T { return parseFile(file(n), readFileSync(file(n), "utf8"), shape); }
/** `fallback` when the file does not exist yet; a malformed file fails naming its path. */
export const readOr = <T>(n: string, shape: Shape<T>, fallback: T): T => existsSync(file(n)) ? read(n, shape) : fallback;
/** Write `value` to peer-directory file `n` (mode 600) through a temporary file and a rename. */
export function write(n: string, value: unknown): void {
  ensureDir();
  const f = file(n), tmp = `${f}.tmp-${process.pid}-${randomUUID()}`;
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
    const h = check(file("host.json"), { name: requestedName ?? (hostname().toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/^[^a-z0-9]+/, "") || "host"), ...newKeys() }, HOST);
    write("host.json", h); return h;
  });
}
/** The lowercase hex SHA-256 of a base64 DER Ed25519 public key; fails when the key is not one. */
export function fingerprint(key: string): string { return createHash("sha256").update(Buffer.from(check("publicKey", key, publicKey), "base64")).digest("hex"); }

export type Headers = Record<string, string>;
/** A header by case-insensitive name. */
export const header = (h: Headers, n: string): string | undefined => Object.entries(h).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
/** The base64 Ed25519 signature of exactly `bytes`. */
export const signBytes = (bytes: Buffer, privateKey: string): string => edSign(null, bytes, privateKey).toString("base64");
/** Whether `signature` is a valid Ed25519 signature of exactly `bytes` by `key`; false for any malformed input. */
export function verifyBytes(bytes: Buffer, signature: string | undefined, key: string): boolean {
  try { return !!signature && edVerify(null, bytes, createPublicKey({ key: Buffer.from(key, "base64"), type: "spki", format: "der" }), Buffer.from(signature, "base64")); }
  catch { return false; }
}
/** The request headers for `bytes`: the signer's key fingerprint and its signature of exactly those bytes. */
export function sign(bytes: Buffer, host: Keys = identity()): Headers {
  return { "Govern-Peer-Key": fingerprint(host.publicKey), "Govern-Signature": signBytes(bytes, host.privateKey) };
}
/** Whether `at` is within SKEW_MS of `now`. */
export const fresh = (at: string, now: number): boolean => Math.abs(Date.parse(at) - now) <= SKEW_MS;

/** A route's answer: status, JSON body and extra headers (a response signature). */
/** The body fields delivery and errors use are typed; other routes add their own. */
export interface Body { [k: string]: unknown; protocol?: string; id?: string; duplicate?: boolean; error?: string }
export interface Response { status: number; body: Body; headers?: Headers; bytes?: Buffer }
/** A JSON error answer. */
export const error = (status: number, message: string): Response => ({ status, body: { error: message } });
/** A JSON body signed with `privateKey` in Govern-Signature, so the caller can check it came from the key it addressed. */
export function signedJson(status: number, body: Record<string, unknown>, privateKey: string): Response {
  const bytes = Buffer.from(JSON.stringify(body));
  return { status, body, bytes, headers: { "Govern-Signature": signBytes(bytes, privateKey) } };
}

/** Outbound POST timeout for every peer route. */
export const TIMEOUT_MS = 15000;
/** One HTTP POST; injected in tests. `headers` are the response headers, lowercased. */
export type Post = (url: string, bytes: Buffer, headers: Headers, timeoutMs: number) => Promise<{ status: number; text: string; headers?: Headers }>;
/** The real transport: fetch, with redirects refused and the timeout enforced. */
export const postFetch: Post = async (u, bytes, headers, timeoutMs) => {
  const r = await fetch(u, { method: "POST", body: new Uint8Array(bytes), headers: { ...headers, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  const out: Headers = {}; r.headers.forEach((v, k) => { out[k] = v; });
  return { status: r.status, text: await r.text(), headers: out };
};
