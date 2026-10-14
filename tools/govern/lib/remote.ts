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
import { check, obj, str, name, literal, arr, type Shape, reject } from "./shape.ts";
import { GovernError, fail, nowIso } from "./util.ts";
import { stateDir } from "./workspace.ts";
import { withLaneLock } from "./lane-lock.ts";
import { load, save, appendLedger, stateFile, checkSlug } from "./project.ts";
import { processOf } from "./process.ts";
import { ownerApproval } from "./business.ts";
import { transaction } from "./lifecycle.ts";
import * as artifacts from "./artifacts.ts";
import * as conversations from "./conversation.ts";
import * as jobs from "./jobs.ts";
import { deskView, laneDetail, sessionDetail, jobDetail, PROTOCOL, type Desk } from "./remote-view.ts";

/** Refusals the server maps to a status: a malformed request (400), a signature, clock, nonce or code that does not
 *  prove the request (403), a lane that does not exist (404). Any other GovernError is a state conflict (409). */
export class BadRequest extends GovernError {}
export class Forbidden extends GovernError {}
export class NotFound extends GovernError {}
export class TooLarge extends GovernError {}
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
export function readState<T>(n: string, empty: T): T {
  const f = file(n);
  if (!existsSync(f)) return empty;
  try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch (e) { return fail(`${f} is not valid JSON (${(e as Error).message})`, 1); }
}
export function writeState(n: string, v: unknown): void {
  ensureDir();
  const f = file(n), tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, f);
}
/** One change to the remote state at a time: the server and the CLI both change it. */
export const locked = <T>(f: () => T): T => { ensureDir(); return withLaneLock(join(dir(), "lock"), f); };

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
export function pair(code: string, deviceName: string, publicKey: string): { device: Device; token: string } {
  p256(publicKey);
  return locked(() => {
    const pg = readState<Pairing | null>("pairing.json", null);
    if (!pg) throw new Forbidden("no pairing code is open: run govern remote pair at the owner's terminal");
    if (Date.parse(pg.expires) < Date.now()) { writeState("pairing.json", null); throw new Forbidden("the pairing code expired: run govern remote pair again"); }
    const ok = timingSafeEqual(Buffer.from(sha(normalizeCode(code)), "hex"), Buffer.from(pg.codeSha256, "hex"));
    if (!ok) {
      const attempts = pg.attempts + 1;
      writeState("pairing.json", attempts >= PAIR_ATTEMPTS ? null : { ...pg!, attempts });
      audit({ kind: "pair-refused", attempts });
      throw new Forbidden(attempts >= PAIR_ATTEMPTS ? "wrong pairing code; the code is now void: run govern remote pair again" : "wrong pairing code");
    }
    const paired = createDevice(deviceName, publicKey, pg.person);
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

export const inScope = (device: Device, slug: string | null): boolean => device.lanes === undefined || (slug !== null && device.lanes.includes(slug));

/** Filter only after the shared cache, including optional session summaries supplied by the read views. */
export function scoped<T extends Omit<Desk, "viewer" | "sessions"> & { sessions?: { lane: string | null }[] }>(desk: T, device: Device): T {
  if (device.lanes === undefined) return desk;
  return { ...desk, lanes: desk.lanes.filter((x) => inScope(device, x.slug)), unreadable: desk.unreadable.filter((x) => inScope(device, x.slug)),
    ...(desk.sessions ? { sessions: desk.sessions.filter((x) => inScope(device, x.lane)) } : {}),
    telemetry: { ...desk.telemetry, tokens: desk.telemetry.tokens.filter((x) => inScope(device, x.lane)),
      machines: desk.telemetry.machines.filter((x) => inScope(device, x.lane)), inbox: desk.telemetry.inbox.filter((x) => inScope(device, x.project)) } };
}

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
const APPROVE = obj({ action: literal("approve"), lane: str, gate: name, quote, nonce, at: iso });
const ACK = obj({ action: literal("ack"), lane: str, alert: str, nonce, at: iso });
export type Action = ReturnType<typeof APPROVE> | ReturnType<typeof ACK>;

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
  const a: Action = kind === "ack" ? parsed("action", raw, ACK) : parsed("action", raw, APPROVE);
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

/** Carries out a verified action as the device's person, under the lane's transaction. */
export function perform(device: Device, a: Action, body: Buffer, signature: string): void {
  const slug = slugOf(a.lane);
  if (!inScope(device, slug)) throw new Forbidden(`lane ${slug} is outside this device's scope`);
  if (!existsSync(stateFile(slug))) throw new NotFound(`no lane ${slug}`);
  transaction(slug, () => {
    const p = load(slug);
    if (a.action === "approve") {
      const gates = processOf(p).gates;
      const g = gates.find((x) => x.name === a.gate) ?? fail(`gate must be one of ${gates.map((x) => x.name).join(", ") || "(none: this process has no gates)"}`);
      if (g.policy) fail(`${g.name} is decided by an approval policy (quorum of named people): decide it with govern approve at a terminal`);
      ownerApproval(p, g, device.person, a.quote, () => ({ kind: "device", device: device.id, signedBody: body.toString("utf8"), signature }));
      save(p);
      const { by, source } = p.approvals[g.name]!;
      appendLedger(p.slug, { kind: "approve", gate: g.name, quote: a.quote, by, source });
    } else {
      const alert = p.alerts?.find((x) => x.id === a.alert) ?? fail(`no alert ${a.alert} on ${slug}`);
      if (alert.acknowledgedAt) fail(`alert ${a.alert} is already acknowledged`);
      alert.acknowledgedAt = nowIso();
      save(p);
      appendLedger(p.slug, { kind: "alert-ack", id: a.alert, by: device.person, device: device.id });
    }
  });
  audit({ kind: a.action, device: device.id, lane: slug, ...(a.action === "approve" ? { gate: a.gate } : { alert: a.alert }) });
}


// ---------------------------------------------------------------- the server

export interface ServeOptions { now?: () => number; tls?: { cert: string; key: string }; streamIntervalMs?: number; streamMaxMs?: number; pingMs?: number }

/** The SHA-256 fingerprint of a PEM certificate, as the app pins it (hex, colon-free, lower case). */
export const certPin = (pem: string): string => new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();

const PAIR_REQ = obj({ code: str, name: (v, at) => (typeof v === "string" && v.trim().length >= 1 && v.length <= 80 ? v.trim() : reject(at, "must be 1..80 characters")), publicKey: str });

export function remoteServer(o: ServeOptions = {}): Server {
  const now = o.now ?? Date.now, pin = o.tls ? certPin(o.tls.cert) : null;
  const interval = o.streamIntervalMs ?? 3000, maxMs = o.streamMaxMs ?? 3_600_000, pingMs = o.pingMs ?? 15_000;
  let streams = 0;
  let cache: { at: number; desk: Omit<Desk, "viewer"> } | undefined;
  /** One desk computation per interval, however many streams read it. */
  const desk = (): Omit<Desk, "viewer"> => {
    if (!cache || Date.now() - cache.at >= interval) cache = { at: Date.now(), desk: deskView() };
    return cache.desk;
  };
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const reply = (status: number, value: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url ?? "/", "http://govern.invalid");
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
      const { device: d, token } = pair(r.code, r.name, r.publicKey);
      reply(200, { protocol: PROTOCOL, deviceId: d.id, person: d.person, token, host: hostname() });
    });
    if (route === "POST /v1/pair/request" || route === "POST /v1/pair/cancel") return body((b) => {
      let raw: unknown;
      try { raw = JSON.parse(b.toString("utf8")); } catch { return reply(400, { error: "invalid JSON" }); }
      if (route === "POST /v1/pair/request") {
        const r = parsed("pairing request", raw, obj({ name: str, publicKey: str }, { lanes: arr(str) }));
        return reply(201, pairing.requestPairing(r, { now, pin }));
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
        return reply(200, laneDetail(load(slug)));
      }
      if (route === "POST /v1/actions") return body((b) => {
        const sig = req.headers["govern-signature"];
        const a = verifyAction(device, b, typeof sig === "string" ? sig : undefined, now());
        perform(device, a, b, sig as string);
        cache = undefined;
        reply(200, { ok: true, lane: laneDetail(load(checkSlug(a.lane))) });
      });
      if (route === "GET /v1/stream") {
        if (streams >= MAX_STREAMS) return reply(429, { error: `at most ${MAX_STREAMS} streams` });
        streams++;
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
        let last = "";
        const push = () => {
          if (!deviceOfToken(bearer!)) { res.end(); return; } // revoked while streaming
          try {
            const text = JSON.stringify(personalDesk());
            if (text !== last) { last = text; res.write(`event: desk\ndata: ${text}\n\n`); }
          } catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ error: e instanceof GovernError ? e.message : "desk unreadable" })}\n\n`); }
        };
        push();
        const tick = setInterval(push, interval), ping = setInterval(() => res.write(": ping\n\n"), pingMs);
        const end = setTimeout(() => res.end(), maxMs);
        res.on("close", () => { clearInterval(tick); clearInterval(ping); clearTimeout(end); streams--; });
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

/** Whether `host` only accepts connections from this machine. */
export const loopback = (host: string): boolean => host === "localhost" || host === "::1" || /^127\./.test(host);
