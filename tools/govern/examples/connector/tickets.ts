// A sample connector (CONNECTORS.md) on a plain REST tickets API: opens one ticket per idempotency key, from the lane's
// title and its `descricao` field, and outputs {ticketId}. Its compensation deletes that ticket.
//
//   tickets.ts open [DIR]                -> {ticketId}   TICKETS_API (base URL), TICKETS_TOKEN (bearer token)
//   tickets.ts compensate [DIR] --key K  undoes the ticket opened with key K
//
// The API: GET /tickets?externalKey=K, POST /tickets {title, body, externalKey} (Idempotency-Key header), GET and
// DELETE /tickets/:id. A real system without a key field needs another way to find its effect, e.g. the key in a tag.
import { main, http, env, Permanent, type Connector } from "./connector.ts";

interface Ticket { id: string; externalKey: string; title: string; status?: string }
const isTicket = (v: unknown): v is Ticket =>
  typeof v === "object" && v !== null && typeof (v as Ticket).id === "string" && typeof (v as Ticket).externalKey === "string";
const auth = () => ({ Authorization: `Bearer ${env("TICKETS_TOKEN")}` });
const url = (path: string) => env("TICKETS_API").replace(/\/+$/, "") + path;
const request = (ctx: { key: string; title: string; data: Record<string, unknown> }) =>
  ({ title: ctx.title, body: typeof ctx.data.descricao === "string" ? ctx.data.descricao : "", externalKey: ctx.key });

const tickets: Connector<Ticket> = {
  name: "tickets",
  async probe(ctx) {
    const r = await http("Tickets", "GET", url(`/tickets?externalKey=${encodeURIComponent(ctx.key)}`), { headers: auth() });
    if (!Array.isArray(r.body)) throw new Permanent("Tickets' search answer is not a list");
    const mine = r.body.filter(isTicket).filter((t) => t.externalKey === ctx.key);
    if (mine.length > 1) throw new Permanent(`Tickets holds ${mine.length} tickets for ${ctx.key}: resolve the duplicates by hand`);
    return mine[0];
  },
  async execute(ctx) {
    const r = await http("Tickets", "POST", url("/tickets"), { headers: { ...auth(), "Idempotency-Key": ctx.key }, body: request(ctx), pass: [409] });
    if (r.status === 409) {
      // Made meanwhile by another attempt with the same key: that one is ours.
      const t = await this.probe(ctx);
      if (!t) throw new Permanent(`Tickets says a ticket for ${ctx.key} exists but none is found`);
      return t;
    }
    if (!isTicket(r.body)) throw new Permanent("Tickets' answer has no ticket id");
    return r.body;
  },
  async confirm(ctx, t) {
    const r = await http("Tickets", "GET", url(`/tickets/${encodeURIComponent(t.id)}`), { headers: auth() });
    if (!isTicket(r.body) || r.body.id !== t.id || r.body.externalKey !== ctx.key)
      throw new Permanent(`confirm: ticket ${t.id} does not carry the key ${ctx.key}`);
    return { ticketId: t.id };
  },
  plan(ctx) {
    return { method: "POST", path: "/tickets", body: request(ctx) };
  },
  async compensate(_ctx, t) {
    await http("Tickets", "DELETE", url(`/tickets/${encodeURIComponent(t.id)}`), { headers: auth(), pass: [404] });
  },
};

process.exitCode = await main(tickets, "open", process.argv.slice(2));
