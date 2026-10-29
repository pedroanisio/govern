import { createServer, type Server } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { check, obj, name, str, record, posInt, ShapeError } from "../../lib/shape.ts";
import { scalar } from "../../lib/business-schema.ts";
import { load, save, create, checkSlug, stateFile } from "../../lib/project.ts";
import { existsSync } from "node:fs";
import { deliverEvent, transaction } from "../../lib/lifecycle.ts";
import { GovernError, fail } from "../../lib/util.ts";
const DELIVERY = obj({ lane: name, name, id: name, correlation: scalar }, { data: record(scalar), generation: posInt });
const CASE = obj({ process: name, slug: str, title: str }, { data: record(scalar) });
/** A request whose shape is wrong (400), as opposed to a delivery the lanes refuse (409). */
class Malformed extends Error {}

/** Open the case a POST /cases delivery describes, or recognise it as delivered before: the lane exists on the same process
 *  and holds the same values for every field delivered. Anything else about an existing lane is refused. */
function openCase(raw: unknown): { created: boolean; duplicate: boolean; slug: string } {
  let c: ReturnType<typeof CASE>;
  try { c = check("case delivery", raw, CASE); } catch (e) { throw new Malformed((e as Error).message); }
  let slug: string;
  try { slug = checkSlug(c.slug); } catch (e) { throw new Malformed((e as Error).message); }
  if (!existsSync(stateFile(slug))) {
    create(slug, { process: c.process, title: c.title, ...(c.data ? { data: c.data } : {}) });
    return { created: true, duplicate: false, slug };
  }
  const p = load(slug);
  const same = p.process === c.process && Object.entries(c.data ?? {}).every(([k, v]) => p.data?.[k] === v);
  if (!same) fail(`${slug} already exists with other data${p.process === c.process ? "" : ` (process ${p.process})`}: not changed`);
  return { created: false, duplicate: true, slug };
}
/** An HTTP server (not yet listening) that takes POST /events with `Authorization: Bearer <token>`, a JSON delivery of
 *  at most 64 KiB, and delivers it to the lane's waiting stage under the lane lock: 200 {accepted, duplicate}; 400, 401,
 *  404, 409 (a refused delivery) or 413 otherwise. Fails when the token is shorter than 16 characters. */
export function eventServer(token: string): Server {
  if (token.length < 16) fail("GOVERN_WEBHOOK_TOKEN must contain at least 16 characters");
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const expected = digest("Bearer " + token);
  const server = createServer((req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || (req.url !== "/events" && req.url !== "/cases")) {
      reply(404, { error: "POST /events or POST /cases required" });
      return;
    }
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ""))) {
      reply(401, { error: "unauthorized" });
      req.resume();
      return;
    }
    let size = 0,
      chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) {
        if (!res.headersSent) reply(413, { error: "event payload exceeds 64 KiB" });
        return;
      }
      if (!res.headersSent) chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      if (req.url === "/cases") {
        try { reply(200, openCase(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
        catch (e) {
          const status = e instanceof SyntaxError || e instanceof Malformed || e instanceof ShapeError ? 400 : e instanceof GovernError ? 409 : 500;
          reply(status, { error: status === 400 ? (e instanceof SyntaxError ? "invalid JSON" : (e as Error).message) : status === 409 ? (e as Error).message : "case delivery failed" });
        }
        return;
      }
      try {
        const e = check("event delivery", JSON.parse(Buffer.concat(chunks).toString("utf8")), DELIVERY);
        const accepted = transaction(e.lane, () => {
          const p = load(e.lane),
            accepted = deliverEvent(p, e.name, e.id, e.correlation, e.data ?? {}, e.generation);
          save(p);
          return accepted;
        });
        reply(200, { accepted, duplicate: !accepted });
      } catch (e) {
        reply(e instanceof SyntaxError ? 400 : e instanceof GovernError ? 409 : 500, {
          error:
            e instanceof SyntaxError ? "invalid JSON" : e instanceof GovernError ? e.message : "event delivery failed"
        });
      }
    });
    req.on("error", () => {
      if (!res.headersSent) reply(400, { error: "incomplete event request" });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
