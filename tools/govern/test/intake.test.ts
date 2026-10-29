// POST /cases on govern event-listen (ext/business/event-server.ts, LIFECYCLE.md "Correlated events and webhooks"): an
// external system (a Zendesk trigger, say) opens a case with its process, slug, title and data; the same delivery again
// changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { makeEnv, write, type Env } from "./helpers.ts";
import { eventServer } from "../ext/business/event-server.ts";

const TOKEN = "intake-token-0123456789";
const PROCESS = {
  version: 1, name: "suporte",
  fields: { ticketId: { type: "string", required: true }, canal: { type: "string", enum: ["email", "zendesk"] }, cliente: { type: "string" } },
  stages: [{ name: "triagem", next: [{ to: ["fim"] }] }, { name: "fim", next: [] }],
};

async function serving(f: (url: string, e: Env) => Promise<void>): Promise<void> {
  const e = makeEnv("intake");
  write(join(e.root, "PALS-Notes/processes/suporte.json"), JSON.stringify(PROCESS));
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const server: Server = eventServer(TOKEN);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}/cases`, e); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old;
  }
}
const post = (url: string, body: unknown, token = TOKEN) =>
  fetch(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
const ticket = { process: "suporte", slug: "sup-1001", title: "Printer offline", data: { ticketId: "1001", canal: "zendesk", cliente: "ACME" } };

test("a delivery opens the case with its data; the same delivery again is a duplicate", async () => {
  await serving(async (url, e) => {
    const r = await post(url, ticket);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { created: true, duplicate: false, slug: "sup-1001" });
    const p = JSON.parse(readFileSync(join(e.projects, "sup-1001", "govern.json"), "utf8"));
    assert.equal(p.process, "suporte");
    assert.equal(p.title, "Printer offline");
    assert.deepEqual(p.data, ticket.data);
    const again = await post(url, ticket);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { created: false, duplicate: true, slug: "sup-1001" });
  });
});

test("a delivery for an existing case on another process, or with different data, is a conflict and changes nothing", async () => {
  await serving(async (url, e) => {
    assert.equal((await post(url, ticket)).status, 200);
    const before = readFileSync(join(e.projects, "sup-1001", "govern.json"), "utf8");
    const other = await post(url, { ...ticket, data: { ...ticket.data, cliente: "Other" } });
    assert.equal(other.status, 409);
    assert.match(((await other.json()) as { error: string }).error, /sup-1001 already exists with other data/);
    assert.equal(readFileSync(join(e.projects, "sup-1001", "govern.json"), "utf8"), before);
  });
});

test("a delivery is refused whole: bad token, bad shape, unknown process, invalid data", async () => {
  await serving(async (url, e) => {
    assert.equal((await post(url, ticket, "wrong-token-0123456789")).status, 401);
    assert.equal((await post(url, "{not json")).status, 400);
    assert.equal((await post(url, { ...ticket, extra: 1 })).status, 400);
    assert.equal((await post(url, { ...ticket, slug: "../escape" })).status, 400);
    const unknown = await post(url, { ...ticket, process: "nope" });
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /nope/);
    const bad = await post(url, { ...ticket, data: { ...ticket.data, canal: "fax" } });
    assert.equal(bad.status, 409);
    assert.match(((await bad.json()) as { error: string }).error, /canal/);
    assert.equal(existsSync(join(e.projects, "sup-1001")), false, "a refused delivery leaves no lane behind");
  });
});
