// govern remote: the HTTP API a paired device (the Android app in android/) uses to read the lanes and telemetry and to
// act as the owner. The protocol is specified in REMOTE.md. Reads need the device's bearer token; an action (approving a
// gate, acknowledging an alert) also needs the request body signed by the device's own P-256 key, which never leaves the
// device. Pairing needs a one-time code or a comparison confirmed at the owner's own terminal.
import { createServer as createHttp, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { hostname } from "node:os";
import * as pairing from "./remote-pair.ts";
import { createServer as createHttps } from "node:https";
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify, X509Certificate, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, createReadStream, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { check, obj, str, name, literal, arr, type Shape, reject } from "../../lib/shape.ts";
import { GovernError, fail, nowIso, readJsonl } from "../../lib/util.ts";
import { stateDir, config } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";
import { load, save, appendLedger, ledgerFile, stateFile, checkSlug } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { ownerApproval, requireGateOwner, gateApproved } from "../../lib/business.ts";
import { transaction } from "../../lib/lifecycle.ts";
import * as artifacts from "../../lib/artifacts.ts";
import * as conversations from "../../lib/conversation.ts";
import * as runtime from "../conversation/conversation-runtime.ts";
import * as jobs from "../../lib/jobs.ts";
import { deskView, laneDetail, sessionDetail, jobDetail, engines, sessions, PROTOCOL, type Desk, type LaneDetail, type SessionDetail } from "./remote-view.ts";

// The refusals the server maps to a status (400, 403, 404, 413; any other GovernError is a state conflict, 409) live in
// http-errors.ts, which the lane artifacts the core keeps share.
import { BadRequest, Forbidden, NotFound, TooLarge } from "../../lib/http-errors.ts";
export { BadRequest, Forbidden, NotFound, TooLarge };
const parsed = <T>(what: string, raw: unknown, shape: Shape<T>): T => {
  try { return check(what, raw, shape); } catch (e) { throw e instanceof GovernError ? new BadRequest(e.message) : e; }
};

/** A lane slug from a request: a bad one is a malformed request. */
const slugOf = (s: string | undefined): string => { try { return checkSlug(s); } catch (e) { throw e instanceof GovernError ? new BadRequest(e.message) : e; } };

export interface Device { id: string; name: string; person: string; publicKey: string; tokenSha256: string; pairedAt: string; lanes?: string[]; revokedAt?: string }
interface Pairing { codeSha256: string; person: string; expires: string; attempts: number }

/** Wrong codes a pairing survives: the next wrong one deletes it, so a code cannot be guessed by trying. */
export const PAIR_ATTEMPTS = 5;
/** How far a signed action's `at` may be from the server's clock, and how long its nonce is remembered (longer than that). */
export const SKEW_MS = 5 * 60_000;
const NONCE_TTL_MS = 2 * SKEW_MS;
export const MAX_BODY = 65536;
export const MAX_STREAMS = 8;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

const dir = () => join(stateDir(), "remote");
const file = (n: string) => join(dir(), n);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const audit = (entry: Record<string, unknown>) => { ensureDir(); appendFileSync(file("audit.jsonl"), JSON.stringify({ t: nowIso(), ...entry }) + "\n", { mode: 0o600 }); };

function ensureDir(): void { mkdirSync(dir(), { recursive: true, mode: 0o700 }); }
/** Parse remote state file `n`, or `empty` when it does not exist; fails (exit 1) when it is not valid JSON. */
export function readState<T>(n: string, empty: T): T {
  const f = file(n);
  if (!existsSync(f)) return empty;
  try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch (e) { return fail(`${f} is not valid JSON (${(e as Error).message})`, 1); }
}
/** Replace remote state file `n` with `v` as JSON (mode 600), written to a temporary file and renamed into place. */
export function writeState(n: string, v: unknown): void {
  ensureDir();
  const f = file(n), tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, f);
}
/** One change to the remote state at a time: the server and the CLI both change it. */
export const locked = <T>(f: () => T): T => { ensureDir(); return withLaneLock(join(dir(), "lock"), f); };

/** Every paired device, revoked ones included; [] before the first pairing, and fails when devices.json is not JSON. */
export const devices = (): Device[] => readState<{ devices: Device[] }>("devices.json", { devices: [] }).devices;

/** A one-time pairing code for `person`, valid for `minutes`; it replaces any earlier code. The code is shown once and only its hash is stored. */
export function createPairing(person: string, minutes: number): { code: string; expires: string } {
  if (!/^[a-z][a-z0-9_.-]*$/i.test(person)) fail(`bad person name: ${person}`);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) fail("--minutes must be 1..60");
  const raw = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  const code = raw.match(/.{4}/g)!.join("-");
  const expires = new Date(Date.now() + minutes * 60_000).toISOString();
  locked(() => writeState("pairing.json", { codeSha256: sha(raw), person, expires, attempts: 0 } satisfies Pairing));
  audit({ kind: "pair-code", person, expires });
  return { code, expires };
}
const normalizeCode = (c: string) => c.replace(/[\s-]/g, "").toUpperCase();

/** The public key of a pairing request: base64 DER SubjectPublicKeyInfo of a P-256 key, the format Android Keystore exports. */
export function p256(b64: string): KeyObject {
  let key: KeyObject;
  try { key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" }); } catch { throw new BadRequest("publicKey must be a base64 DER SubjectPublicKeyInfo"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new BadRequest("publicKey must be an EC P-256 key");
  return key;
}

/** Pairs the device that presents the current code: its key is stored and a bearer token returned (once; only its hash is kept).
 *  A wrong code counts against the pairing, an expired one is deleted. */
export function pair(code: string, deviceName: string, publicKey: string, now = Date.now()): { device: Device; token: string } {
  p256(publicKey);
  return locked(() => {
    const pg = readState<Pairing | null>("pairing.json", null);
    if (!pg) throw new Forbidden("no pairing code is open: run govern remote pair at the owner's terminal");
    if (Date.parse(pg.expires) <= now) { writeState("pairing.json", null); throw new Forbidden("the pairing code expired: run govern remote pair again"); }
    const ok = timingSafeEqual(Buffer.from(sha(normalizeCode(code)), "hex"), Buffer.from(pg.codeSha256, "hex"));
    if (!ok) {
      const attempts = pg.attempts + 1;
      writeState("pairing.json", attempts >= PAIR_ATTEMPTS ? null : { ...pg!, attempts });
      audit({ kind: "pair-refused", attempts });
      throw new Forbidden(attempts >= PAIR_ATTEMPTS ? "wrong pairing code; the code is now void: run govern remote pair again" : "wrong pairing code");
    }
    const paired = createDevice(deviceName, publicKey, pg.person, undefined, now);
    writeState("pairing.json", null);
    return paired;
  });
}

/** Creates a device under the caller's remote lock; both pairing flows use this path. */
export function createDevice(deviceName: string, publicKey: string, person: string, lanes?: string[], now = Date.now()): { device: Device; token: string } {
  const token = randomBytes(32).toString("base64url");
  const device: Device = { id: `d-${randomBytes(6).toString("hex")}`, name: deviceName, person, publicKey,
    tokenSha256: sha(token), pairedAt: new Date(now).toISOString(), ...(lanes === undefined ? {} : { lanes }) };
  writeState("devices.json", { devices: [...devices(), device] });
  audit({ kind: "paired", device: device.id, name: deviceName, person, ...(lanes === undefined ? {} : { lanes }) });
  return { device, token };
}

/** Revokes devices whose token was never delivered, under the caller's remote lock: no unusable device stays paired. */
export function revokeUndelivered(ids: readonly string[], now: number): void {
  const all = devices(), gone = all.filter((d) => ids.includes(d.id) && !d.revokedAt);
  if (!gone.length) return;
  for (const d of gone) d.revokedAt = new Date(now).toISOString();
  writeState("devices.json", { devices: all });
  for (const d of gone) audit({ kind: "revoked", device: d.id, reason: "pairing token never delivered" });
}

/** Whether `device` may act on lane `slug`: an unscoped device reaches every lane, a scoped one only its lanes (never `null`). */
export const inScope = (device: Device, slug: string | null): boolean => device.lanes === undefined || (slug !== null && device.lanes.includes(slug));

/** Filter only after the shared cache, including optional session summaries supplied by the read views. */
export function scoped<T extends Omit<Desk, "viewer" | "sessions" | "unreadableSessions"> & { sessions?: { lane: string | null }[]; unreadableSessions?: unknown[] }>(desk: T, device: Device): T {
  if (device.lanes === undefined) return desk;
  return { ...desk, lanes: desk.lanes.filter((x) => inScope(device, x.slug)).map(x => ({ ...x, blockedBy: x.blockedBy.filter(slug => inScope(device, slug)) })), unreadable: desk.unreadable.filter((x) => inScope(device, x.slug)),
    // an unreadable conversation's lane is unknown, so no scoped device may see it
    ...(desk.unreadableSessions ? { unreadableSessions: [] } : {}),
    ...(desk.sessions ? { sessions: desk.sessions.filter((x) => inScope(device, x.lane)) } : {}),
    telemetry: { ...desk.telemetry, allowances: desk.telemetry.allowances.filter(line => {
      // shown() formats the consumer in the second column; config errors may expose lane data too.
      if (line.startsWith("allowances: config error")) return false;
      const lane = /^\S+\s+lane:(\S+)\s/.exec(line)?.[1];
      return lane === undefined || inScope(device, lane);
    }), tokens: desk.telemetry.tokens.filter((x) => inScope(device, x.lane)),
      machines: desk.telemetry.machines.filter((x) => inScope(device, x.lane)), inbox: desk.telemetry.inbox.filter((x) => inScope(device, x.project)) } };
}

const scopedLane = (lane: LaneDetail, device: Device): LaneDetail => ({ ...lane, blockedBy: lane.blockedBy.filter(slug => inScope(device, slug)) });

/** Mark device `id` revoked (its token stops working) under the remote state lock, audit it, and return it; fails when
 *  there is no such device or it is already revoked. */
export function revoke(id: string): Device {
  return locked(() => {
    const all = devices(), d = all.find((x) => x.id === id) ?? fail(`no device ${id} (govern remote devices lists them)`);
    if (d.revokedAt) fail(`${id} is already revoked`);
    d.revokedAt = nowIso();
    writeState("devices.json", { devices: all });
    audit({ kind: "revoked", device: id });
    return d;
  });
}

/** The paired, unrevoked device whose token this is. */
export function deviceOfToken(token: string): Device | undefined {
  const h = Buffer.from(sha(token), "hex");
  return devices().find((d) => !d.revokedAt && timingSafeEqual(h, Buffer.from(d.tokenSha256, "hex")));
}

// ---------------------------------------------------------------- signed actions

const iso: Shape<string> = (v, at) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : reject(at, "must be an ISO timestamp"));
const nonce: Shape<string> = (v, at) => (typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : reject(at, "must be 16..128 characters of A-Z a-z 0-9 _ -"));
const quote: Shape<string> = (v, at) => (typeof v === "string" && v.trim().length >= 2 && v.length <= 2000 ? v : reject(at, "must be the person's words, 2..2000 characters"));
const bounded = (max: number): Shape<string> => (v, at) => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : reject(at, `must be 1..${max} characters after trim`);
const artifact = obj({ name: (v, at) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) ? v : reject(at, "must be a plain artifact name"),
  sha256: (v, at) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : reject(at, "must be a lowercase SHA-256 digest") });
const ACTIONS = {
  approve: obj({ action: literal("approve"), lane: str, gate: name, quote, nonce, at: iso }, { artifact }),
  ack: obj({ action: literal("ack"), lane: str, alert: str, nonce, at: iso }),
  changes: obj({ action: literal("changes"), lane: str, gate: name, quote, nonce, at: iso }, { artifact }),
  reviewed: obj({ action: literal("reviewed"), lane: str, artifact, nonce, at: iso }),
  instruct: obj({ action: literal("instruct"), session: str, text: bounded(8000), mode: literal("queue", "interrupt"), nonce, at: iso }),
  session: obj({ action: literal("session"), lane: str, engine: str, title: bounded(120), text: bounded(8000), nonce, at: iso }),
};
export type Action = ReturnType<(typeof ACTIONS)[keyof typeof ACTIONS]>;
export interface ActionResult { ok: true; lane: LaneDetail | null; session: SessionDetail | null }

/** The action in `body`, which `signature` (base64 DER ECDSA-SHA256) must sign with the device's key; the clock and the nonce
 *  must show it was signed for this request and never used before. Every refusal is a GovernError naming the reason. */
export function verifyAction(device: Device, body: Buffer, signature: string | undefined, now = Date.now()): Action {
  if (!signature) throw new Forbidden("the action is not signed (Govern-Signature header missing)");
  let good = false;
  try { good = verify("sha256", body, p256(device.publicKey), Buffer.from(signature, "base64")); } catch { good = false; }
  if (!good) throw new Forbidden("the signature does not match the device's key");
  let raw: unknown;
  try { raw = JSON.parse(body.toString("utf8")); } catch { throw new BadRequest("the signed body is not JSON"); }
  const kind = typeof raw === "object" && raw !== null ? (raw as { action?: unknown }).action : undefined;
  if (typeof kind !== "string" || !Object.hasOwn(ACTIONS, kind)) throw new BadRequest(`action must be one of ${Object.keys(ACTIONS).join(", ")}`);
  const a = parsed<Action>("action", raw, ACTIONS[kind as keyof typeof ACTIONS]);
  if (Math.abs(Date.parse(a.at) - now) > SKEW_MS) throw new Forbidden(`the action was signed at ${a.at}, more than ${SKEW_MS / 60000} minutes from the server's clock`);
  locked(() => {
    const seen = readState<Record<string, number>>("nonces.json", {});
    for (const [k, exp] of Object.entries(seen)) if (exp < now) delete seen[k];
    if (Object.hasOwn(seen, a.nonce)) throw new Forbidden("this action was already received (nonce reused)");
    seen[a.nonce] = now + NONCE_TTL_MS;
    writeState("nonces.json", seen);
  });
  return a;
}

/** Execute a verified action as the device's person, serializing its commit with device revocation.
 * @param device - The device whose signature was verified.
 * @param a - The verified action.
 * @param body - The signed request bytes to record with an approval.
 * @param signature - The verified signature to record with an approval.
 * @returns The lane (scoped to the device) and session the action changed, after it and its audit entry are persisted.
 * @throws {@link Forbidden} If the device was revoked or removed before the commit, or the lane or session is out of its scope.
 * @throws {@link GovernError} If the lane, session or action is invalid.
 */
export function perform(device: Device, a: Action, body: Buffer, signature: string): ActionResult {
  let slug: string | null, session: string | null = null;
  if (a.action === "instruct") {
    try { conversations.sessionId(a.session); } catch (e) { throw new BadRequest((e as Error).message); }
    if (!existsSync(join(conversations.directory(a.session), "session.json"))) throw new NotFound(`no session ${a.session}`);
    const s = conversations.read(a.session);
    slug = s.lane ?? null;
    if (!inScope(device, slug)) throw new Forbidden(`session ${a.session} is outside this device's scope`);
    if (s.closedAt) fail(`session ${a.session} is closed`);
    session = a.session;
  } else {
    slug = slugOf(a.lane);
    if (!inScope(device, slug)) throw new Forbidden(`lane ${slug} is outside this device's scope`);
  }
  if (slug !== null && !existsSync(stateFile(slug))) throw new NotFound(`no lane ${slug}`);
  const send = (id: string, text: string, mode: "queue" | "interrupt") => {
    conversations.send(id, text, { requestId: "remote-" + a.nonce, mode });
    runtime.background(id);
  };
  const apply = () => {
    if (a.action === "instruct") {
      send(a.session, a.text, a.mode);
      if (slug !== null) appendLedger(slug, { kind: "instruct", session: a.session, by: device.person, device: device.id, mode: a.mode, chars: a.text.length });
      return;
    }
    const p = load(slug!);
    if ("artifact" in a && a.artifact) {
      const fd = artifacts.open(p.slug, a.artifact.name);
      try { if (artifacts.digest(fd) !== a.artifact.sha256) fail("the artifact changed since you reviewed it"); } finally { closeSync(fd); }
    }
    if (a.action === "approve" || a.action === "changes") {
      const gates = processOf(p).gates;
      const g = gates.find((x) => x.name === a.gate) ?? fail(`gate must be one of ${gates.map((x) => x.name).join(", ") || "(none: this process has no gates)"}`);
      if (g.policy) fail(`${g.name} is decided by an approval policy (quorum of named people): decide it with govern approve at a terminal`);
      const evidence = a.artifact ? { artifact: a.artifact } : {};
      if (a.action === "approve") {
        ownerApproval(p, g, device.person, a.quote, () => ({ kind: "device", device: device.id, signedBody: body.toString("utf8"), signature }));
        save(p);
        const { by, source } = p.approvals[g.name]!;
        appendLedger(p.slug, { kind: "approve", gate: g.name, quote: a.quote, by, source, device: device.id, ...evidence });
      } else {
        requireGateOwner(g, device.person);
        if (gateApproved(p, g)) fail(`gate ${g.name} is already approved`);
        const open = sessions().find(s => s.lane === p.slug && s.state !== "closed");
        const text = `changes requested on ${g.name} by ${device.person}: ${a.quote}`;
        appendLedger(p.slug, { kind: "changes-requested", gate: g.name, quote: a.quote, by: device.person, device: device.id, ...evidence });
        p.notes.push({ at: nowIso(), stage: p.stage, text }); save(p);
        if (open) send(open.id, text, "queue");
      }
    } else if (a.action === "reviewed") {
      if (!readJsonl(ledgerFile(p.slug)).some(e => e.kind === "artifact-reviewed" && e.device === device.id && e.name === a.artifact.name && e.sha256 === a.artifact.sha256))
        appendLedger(p.slug, { kind: "artifact-reviewed", ...a.artifact, person: device.person, device: device.id });
    } else if (a.action === "session") {
      if (!engines().includes(a.engine)) throw new BadRequest(`engine must be one of ${engines().join(", ")}`);
      const prefix = p.slug.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/^[^a-z0-9]+/, "") || "lane";
      const id = `${prefix.slice(0, 73)}-${randomBytes(3).toString("hex")}`;
      conversations.create(id, { lane: p.slug, title: a.title, ...(Object.hasOwn(config().conversationAdapters ?? {}, a.engine) ? { adapter: a.engine } : { profile: a.engine }) });
      send(id, a.text, "queue"); session = id;
      appendLedger(p.slug, { kind: "session-opened", session: id, engine: a.engine, by: device.person, device: device.id });
    } else {
      const alert = p.alerts?.find((x) => x.id === a.alert) ?? fail(`no alert ${a.alert} on ${slug}`);
      if (alert.acknowledgedAt) fail(`alert ${a.alert} is already acknowledged`);
      alert.acknowledgedAt = nowIso(); save(p);
      appendLedger(p.slug, { kind: "alert-ack", id: a.alert, by: device.person, device: device.id });
    }
  };
  const commit = () => locked(() => {
    if (!devices().some((d) => d.id === device.id && !d.revokedAt))
      throw new Forbidden("this device is no longer paired (revoked or removed)");
    apply();
  });
  // Acquire the lane first: a request waiting for it must not block revocation.
  if (slug === null) commit(); else transaction(slug, commit);
  audit({ kind: a.action, device: device.id, lane: slug, ...("gate" in a ? { gate: a.gate } : {}), ...("alert" in a ? { alert: a.alert } : {}), ...(session ? { session } : {}) });
  return { ok: true, lane: slug === null ? null : scopedLane(laneDetail(load(slug)), device), session: session === null ? null : sessionDetail(session) };
}


// ---------------------------------------------------------------- the server

export interface ServeOptions { now?: () => number; tls?: { cert: string; key: string }; streamIntervalMs?: number; streamMaxMs?: number; pingMs?: number }

/** The SHA-256 fingerprint of a PEM certificate, as the app pins it (hex, colon-free, lower case). */
export const certPin = (pem: string): string => new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();

const PAIR_REQ = obj({ code: str, name: (v, at) => (typeof v === "string" && v.trim().length >= 1 && v.length <= 80 ? v.trim() : reject(at, "must be 1..80 characters")), publicKey: str });

/** The remote API server (HTTPS with `tls`, else HTTP; not yet listening): health and pairing without a token, then for
 *  a paired device's bearer token the desk, a lane's detail, signed actions, and a server-sent desk stream (pushed on
 *  change, with pings, bounded in count and length). Errors map to 400/401/403/404/409/413/429/500 JSON replies. */
export function remoteServer(o: ServeOptions = {}): Server {
  const now = o.now ?? Date.now, pin = o.tls ? certPin(o.tls.cert) : null;
  const interval = o.streamIntervalMs ?? 3000, maxMs = o.streamMaxMs ?? 3_600_000, pingMs = o.pingMs ?? 15_000;
  let streams = 0;
  const deviceStreams = new Map<string, number>();
  let cache: { at: number; desk: Omit<Desk, "viewer"> } | undefined;
  /** One desk computation per interval, however many streams read it. */
  const desk = (): Omit<Desk, "viewer"> => {
    if (!cache || now() - cache.at >= interval) cache = { at: now(), desk: deskView() };
    return cache.desk;
  };
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const reply = (status: number, value: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://govern.invalid"); }
    catch {
      req.resume();
      return reply(400, { error: "invalid request URL" });
    }
    const route = `${req.method} ${url.pathname}`;
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const device = bearer ? deviceOfToken(bearer) : undefined;
    const fault = (e: unknown) => {
      const status = e instanceof pairing.TooMany ? 429 : e instanceof BadRequest ? 400 : e instanceof Forbidden ? 403 : e instanceof NotFound ? 404 : e instanceof TooLarge ? 413 : e instanceof GovernError ? 409 : 500;
      return reply(status, { error: status === 500 ? "internal error" : (e as Error).message });
    };
    const body = (then: (b: Buffer) => void) => {
      let size = 0; const chunks: Buffer[] = [];
      // Past the limit the rest is read and dropped, so the 413 reaches the client instead of a reset connection.
      req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) reply(413, { error: `body exceeds ${MAX_BODY} bytes` }); else chunks.push(c); });
      req.on("end", () => { if (!res.headersSent) { try { then(Buffer.concat(chunks)); } catch (e) { fault(e); } } });
      req.on("error", () => reply(400, { error: "incomplete request" }));
    };
    if (route === "GET /v1/health") return reply(200, { protocol: PROTOCOL, at: nowIso() });
    if (route === "POST /v1/pair") return body((b) => {
      let raw: unknown;
      try { raw = JSON.parse(b.toString("utf8")); } catch { return reply(400, { error: "invalid JSON" }); }
      const r = parsed("pairing request", raw, PAIR_REQ);
      const { device: d, token } = pair(r.code, r.name, r.publicKey, now());
      reply(200, { protocol: PROTOCOL, deviceId: d.id, person: d.person, token, host: hostname() });
    });
    if (route === "POST /v1/pair/request" || route === "POST /v1/pair/cancel") return body((b) => {
      let raw: unknown;
      try { raw = JSON.parse(b.toString("utf8")); } catch { return reply(400, { error: "invalid JSON" }); }
      if (route === "POST /v1/pair/request") {
        const r = parsed("pairing request", raw, obj({ name: str, publicKey: str }, { lanes: arr(str) }));
        return reply(201, pairing.requestPairing(r, { now, pin, address: req.socket.remoteAddress }));
      }
      const r = parsed("pairing cancellation", raw, obj({ id: str, secret: str }));
      reply(200, pairing.cancelPairing(r.id, r.secret, now));
    });
    if (route === "GET /v1/pair/request") {
      try {
        const secret = req.headers["govern-pair-secret"];
        return reply(200, pairing.pollPairing(url.searchParams.get("id") ?? "", typeof secret === "string" ? secret : "", now));
      } catch (e) { return fault(e); }
    }
    if (!device) { req.resume(); return reply(401, { error: "unauthorized: pair this device with govern remote pair" }); }
    try {
      const personalDesk = (): Desk => ({ ...scoped(desk(), device), viewer: { person: device.person, device: device.id, lanes: device.lanes ?? null } });
      const count = (key: string, fallback: number, max: number): number => {
        const raw = url.searchParams.get(key);
        if (raw === null) return fallback;
        if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new BadRequest(`${key} must be 1..${max}`);
        return Number(raw);
      };
      const lane = () => {
        const slug = slugOf(url.searchParams.get("lane") ?? undefined);
        if (!inScope(device, slug)) throw new Forbidden(`lane ${slug} is outside this device's scope`);
        if (!existsSync(stateFile(slug))) throw new NotFound(`no lane ${slug}`);
        return slug;
      };
      if (route === "GET /v1/desk") return reply(200, personalDesk());
      if (route === "GET /v1/session") {
        const id = url.searchParams.get("id") ?? "", messages = count("messages", 20, 100);
        try { conversations.sessionId(id); } catch (e) { throw new BadRequest((e as Error).message); }
        if (!existsSync(join(conversations.directory(id), "session.json"))) throw new NotFound(`no session ${id}`);
        if (!inScope(device, conversations.inspect(id).lane ?? null)) throw new Forbidden(`session ${id} is outside this device's scope`);
        return reply(200, sessionDetail(id, messages));
      }
      if (route === "GET /v1/job") {
        const slug = lane(), id = url.searchParams.get("id") ?? "", lines = count("lines", 100, 1000);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new BadRequest("job id must be a plain name");
        if (!jobs.list(slug).includes(id)) throw new NotFound(`no job ${id}`);
        return reply(200, jobDetail(slug, id, lines));
      }
      if (route === "GET /v1/artifact") {
        const slug = lane(), name = url.searchParams.get("name") ?? "", fd = artifacts.open(slug, name, artifacts.MAX_BYTES);
        try {
          const bytes = fstatSync(fd).size, sha256 = artifacts.digest(fd);
          res.writeHead(200, { "Content-Type": artifacts.mediaType(name), "Content-Length": bytes, "Govern-Artifact-Sha256": sha256,
            "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
          const stream = createReadStream("", { fd, autoClose: true, start: 0 });
          stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res);
        } catch (e) { closeSync(fd); throw e; }
        return;
      }
      if (route === "GET /v1/lane") {
        const slug = slugOf(url.searchParams.get("slug") ?? undefined);
        if (!inScope(device, slug)) throw new Forbidden(`lane ${slug} is outside this device's scope`);
        if (!existsSync(stateFile(slug))) return reply(404, { error: `no lane ${slug}` });
        return reply(200, scopedLane(laneDetail(load(slug)), device));
      }
      if (route === "POST /v1/actions") return body((b) => {
        const sig = req.headers["govern-signature"];
        const a = verifyAction(device, b, typeof sig === "string" ? sig : undefined, now());
        const result = perform(device, a, b, sig as string);
        cache = undefined;
        reply(200, result);
      });
      if (route === "GET /v1/stream") {
        if (streams >= MAX_STREAMS) return reply(429, { error: `at most ${MAX_STREAMS} streams` });
        if ((deviceStreams.get(device.id) ?? 0) >= 2) return reply(429, { error: "at most 2 streams per device" });
        streams++;
        deviceStreams.set(device.id, (deviceStreams.get(device.id) ?? 0) + 1);
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
        let last = "";
        const push = () => {
          if (!deviceOfToken(bearer!)) { res.end(); return; } // revoked while streaming
          try {
            const d = personalDesk();
            // `at` is stamped on every computation; a desk is new only when something besides it changed.
            const { at: _, ...content } = d;
            const key = JSON.stringify(content);
            if (key !== last) { last = key; res.write(`event: desk\ndata: ${JSON.stringify(d)}\n\n`); }
          } catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ error: e instanceof GovernError ? e.message : "desk unreadable" })}\n\n`); }
        };
        push();
        const tick = setInterval(push, interval), ping = setInterval(() => res.write(": ping\n\n"), pingMs);
        const end = setTimeout(() => res.end(), maxMs);
        res.on("close", () => { clearInterval(tick); clearInterval(ping); clearTimeout(end); streams--;
          const remaining = (deviceStreams.get(device.id) ?? 1) - 1;
          if (remaining) deviceStreams.set(device.id, remaining); else deviceStreams.delete(device.id);
        });
        return;
      }
      req.resume();
      reply(404, { error: `no route ${route}` });
    } catch (e) { fault(e); }
  };
  const server = o.tls ? createHttps({ cert: o.tls.cert, key: o.tls.key }, handler) : createHttp(handler);
  // Both bound receiving the request only; a stream's response may run for its full hour.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

// Whether a host only accepts connections from this machine: lib/cli.ts (the peer and center commands ask it too).
export { loopback } from "../../lib/cli.ts";
