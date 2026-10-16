// Phone-initiated pairing. All request and device changes share remote.ts's lock with the server and CLI.
import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { BadRequest, Forbidden, NotFound, locked, readState, writeState, p256, createDevice, revokeUndelivered } from "./remote.ts";
import { PROTOCOL } from "./remote-view.ts";
import { checkSlug } from "../../lib/project.ts";
import { GovernError } from "../../lib/util.ts";

export class TooMany extends GovernError {}
type Clock = () => number;
type State = "waiting" | "confirmed" | "refused" | "expired" | "cancelled";
interface Sealed { iv: string; tag: string; data: string }
interface PairRequest {
  id: string; name: string; publicKey: string; secretSha256: string; expires: string; pin: string | null;
  address?: string; state: State; lanes?: string[]; person?: string; deviceId?: string; sealed?: Sealed;
}
export interface PairRequestBody { name: string; publicKey: string; lanes?: string[] }
const hash = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(hash(a), hash(b));
const save = (rs: PairRequest[]) => writeState("requests.json", rs);
// One minute past expiry gives phones time to poll a final state without retaining completed requests indefinitely.
const PAIR_REQUEST_RETENTION_MS = 60_000;
const MAX_STORED_PAIR_REQUESTS = 128;

/** The 6-digit code the phone and the owner's terminal both show for request `id`, derived from its id, the phone's
 *  public key and the certificate pin, so a request swapped in transit shows a different code. */
export function comparisonCode(id: string, publicKey: string, pin?: string | null): string {
  return String(hash(`govern-pair/2\n${id}\n${publicKey}\n${pin ?? ""}`).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** Expire an undelivered confirmation too: no recoverable token survives its delivery window, and its device is revoked. */
function current(now: Clock): PairRequest[] {
  const rs = readState<PairRequest[]>("requests.json", []), undelivered: string[] = [], time = now();
  let changed = false;
  for (const r of rs) if ((r.state === "waiting" || r.sealed) && Date.parse(r.expires) <= time) {
    if (r.sealed && r.deviceId) undelivered.push(r.deviceId);
    r.state = "expired"; delete r.sealed; changed = true;
  }
  const kept = rs.filter(r => r.state === "waiting" || r.sealed || time < Date.parse(r.expires) + PAIR_REQUEST_RETENTION_MS);
  if (changed || kept.length !== rs.length) { revokeUndelivered(undelivered, time); save(kept); }
  return kept;
}
const find = (rs: PairRequest[], id: string): PairRequest => {
  const r = rs.find((r) => r.id === id);
  if (!r) throw new NotFound(`no pairing request ${id}`);
  return r;
};
const waiting = (r: PairRequest) => { if (r.state !== "waiting") throw new GovernError(`pairing request is ${r.state}`); };
function authenticate(r: PairRequest, secret: string): void {
  if (!timingSafeEqual(hash(secret), Buffer.from(r.secretSha256, "hex"))) throw new Forbidden("wrong pairing secret");
}
function lanesOf(lanes: string[] | undefined): string[] | undefined {
  if (lanes === undefined) return undefined;
  try { return [...new Set(lanes.map((s) => checkSlug(s)))]; }
  catch (e) { if (e instanceof GovernError) throw new BadRequest(e.message); throw e; }
}
function sealingKey(): Buffer {
  let key = readState<string | null>("pair-key.json", null);
  if (!key) { key = randomBytes(32).toString("base64"); writeState("pair-key.json", key); }
  return Buffer.from(key, "base64");
}
function seal(token: string): Sealed {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sealingKey(), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function unseal(s: Sealed): string {
  const cipher = createDecipheriv("aes-256-gcm", sealingKey(), Buffer.from(s.iv, "base64"));
  cipher.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(s.data, "base64")), cipher.final()]).toString("utf8");
}

/** Open a phone-initiated pairing request for `body`'s device name, public key and optional lanes, valid for 5 minutes;
 *  returns its id and the one-time secret the phone polls with. Fails with BadRequest on bad input and TooMany beyond 32
 *  open requests, 2 from one client address, or 128 stored requests across all states. */
export function requestPairing(body: PairRequestBody, o: { pin?: string | null; now?: Clock; address?: string } = {}) {
  if (!body.name.trim() || body.name.length > 80) throw new BadRequest("name must be 1..80 characters");
  p256(body.publicKey);
  const lanes = lanesOf(body.lanes), now = o.now ?? Date.now;
  return locked(() => {
    const rs = current(now);
    if (rs.length >= MAX_STORED_PAIR_REQUESTS) throw new TooMany(`at most ${MAX_STORED_PAIR_REQUESTS} stored pairing requests`);
    const open = rs.filter(r => r.state === "waiting" || r.sealed), address = o.address ?? "unknown";
    if (open.length >= 32) throw new TooMany("at most 32 open pairing requests");
    if (open.filter(r => (r.address ?? "unknown") === address).length >= 2) throw new TooMany("at most 2 open pairing requests per client address");
    const secret = randomBytes(32).toString("base64url");
    const r: PairRequest = { id: `r-${randomBytes(12).toString("hex")}`, name: body.name.trim(), publicKey: body.publicKey,
      secretSha256: hash(secret).toString("hex"), expires: new Date(now() + 300_000).toISOString(), pin: o.pin ?? null, state: "waiting", address,
      ...(lanes === undefined ? {} : { lanes }) };
    rs.push(r); save(rs);
    return { protocol: PROTOCOL, id: r.id, secret, expires: r.expires, host: hostname() };
  });
}

/** The waiting pairing requests with their comparison codes, for the owner's terminal; expired ones are dropped first. */
export function requests(now: Clock = Date.now) {
  return locked(() => current(now).filter((r) => r.state === "waiting").map((r) => ({ id: r.id, name: r.name, lanes: r.lanes ?? null,
    expires: r.expires, code: comparisonCode(r.id, r.publicKey, r.pin) })));
}

/** Pair waiting request `id` when `code` matches its comparison code: create the device for `o.person` (default owner)
 *  on the requested lanes, `o.lanes` or all lanes with `o.all`, and seal its token for the phone's next poll. A wrong code
 *  refuses the request for good (Forbidden); fails with BadRequest when the lanes are not chosen or conflict. */
export function confirmPairing(id: string, code: string, o: { person?: string; lanes?: string[]; all?: boolean; now?: Clock } = {}) {
  const now = o.now ?? Date.now;
  return locked(() => {
    const rs = current(now), r = find(rs, id); waiting(r);
    if (!same(code, comparisonCode(r.id, r.publicKey, r.pin))) {
      r.state = "refused"; save(rs); throw new Forbidden("wrong comparison code; request refused");
    }
    const person = o.person ?? "owner";
    if (!/^[a-z][a-z0-9_.-]*$/i.test(person)) throw new BadRequest(`bad person name: ${person}`);
    if (o.all && o.lanes !== undefined) throw new BadRequest("--all and --lane cannot be combined");
    if (!o.all && o.lanes === undefined && !r.lanes?.length) throw new BadRequest("choose the lanes: --lane SLUG (repeatable) or --all");
    const lanes = o.all ? undefined : lanesOf(o.lanes ?? r.lanes);
    const { device, token } = createDevice(r.name, r.publicKey, person, lanes, now());
    r.state = "confirmed"; r.person = person; r.deviceId = device.id;
    if (lanes === undefined) delete r.lanes; else r.lanes = lanes;
    r.sealed = seal(token); save(rs);
    return device;
  });
}

/** The state of request `id` for the phone holding `secret`; after confirmation it returns the device token once and
 *  forgets it. Fails with NotFound on an unknown request and Forbidden on a wrong secret. */
export function pollPairing(id: string, secret: string, now: Clock = Date.now) {
  return locked(() => {
    const rs = current(now), r = find(rs, id); authenticate(r, secret);
    const token = r.sealed ? unseal(r.sealed) : null;
    if (r.sealed) { delete r.sealed; save(rs); }
    return { protocol: PROTOCOL, state: r.state, expires: r.expires, person: r.person ?? null, deviceId: r.deviceId ?? null,
      token, lanes: r.lanes ?? null, host: hostname() };
  });
}

/** Cancel and remove waiting request `id` for the phone holding `secret`. Fails with NotFound on an unknown or
 *  cancelled request, Forbidden on a wrong secret, and GovernError when confirmed, refused or expired. */
export function cancelPairing(id: string, secret: string, now: Clock = Date.now) {
  return locked(() => {
    const rs = current(now), r = find(rs, id); authenticate(r, secret);
    waiting(r); save(rs.filter(request => request.id !== id));
    return { protocol: PROTOCOL, state: "cancelled" as const };
  });
}

/** Refuse waiting request `id` from the owner's terminal; fails when there is no such request or it is not waiting. */
export function refusePairing(id: string, now: Clock = Date.now): void {
  locked(() => { const rs = current(now), r = find(rs, id); waiting(r); r.state = "refused"; save(rs); });
}
