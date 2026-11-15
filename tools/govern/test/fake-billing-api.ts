// A fake billing API on loopback for the ops-cell example's tests (examples/ops-cell/billing.ts). It runs in a worker
// thread, so it keeps answering while the test's main thread waits in spawnSync on govern drive. The test steers it and
// reads its state over HTTP: POST /_seed adds disputes and invoices, POST /_mode sets how the next credit-note creation
// goes, POST /_resolve records the billing team's decision on a dispute, GET /_state returns everything and the requests
// seen.
//
//   GET  /disputes/:id                 a dispute: {id, invoice, customer, amount, reason, status, decision?, amountGranted?}
//   GET  /invoices/:id                 an invoice: {id, customer, total, lines}
//   GET  /credit-notes?externalKey=K   the credit notes created with that key, void ones included (the probe)
//   POST /credit-notes                 creates one; mode "ok", "lose" (created, then the connection is cut), "503", "422"
//   GET  /credit-notes/:id             one credit note
//   POST /credit-notes/:id/void        voids it; 409 when it is already void
import { createServer } from "node:http";
import { parentPort } from "node:worker_threads";

interface Dispute { id: string; invoice: string; customer: string; amount: number; reason: string; status: "open" | "resolved";
  decision?: string; amountGranted?: number }
interface Invoice { id: string; customer: string; total: number; lines: { item: string; amount: number }[] }
interface CreditNote { id: string; invoice: string; amount: number; reason: string; externalKey: string; status: "issued" | "void" }
interface Seen { method: string; path: string; idempotencyKey?: string }

const disputes: Dispute[] = [];
const invoices: Invoice[] = [];
const creditNotes: CreditNote[] = [];
const seen: Seen[] = [];
let mode = "ok";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x"), method = req.method ?? "";
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/_mode") { mode = (JSON.parse(raw) as { mode: string }).mode; return send(200, { mode }); }
    if (url.pathname === "/_seed") {
      const b = JSON.parse(raw) as { disputes?: Dispute[]; invoices?: Invoice[] };
      disputes.push(...(b.disputes ?? []));
      invoices.push(...(b.invoices ?? []));
      return send(200, {});
    }
    if (url.pathname === "/_resolve") {
      const b = JSON.parse(raw) as { id: string; decision: string; amountGranted: number };
      const d = disputes.find((x) => x.id === b.id);
      if (!d) return send(404, { error: "no dispute" });
      Object.assign(d, { status: "resolved", decision: b.decision, amountGranted: b.amountGranted });
      return send(200, d);
    }
    if (url.pathname === "/_state") return send(200, { disputes, invoices, creditNotes, seen });
    const key = req.headers["idempotency-key"];
    seen.push({ method, path: url.pathname + url.search, ...(typeof key === "string" ? { idempotencyKey: key } : {}) });
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: "unauthorized" });
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/disputes\/([^/]+)$/.exec(url.pathname))) {
      const d = disputes.find((x) => x.id === m![1]);
      return d ? send(200, d) : send(404, { error: "no dispute" });
    }
    if (method === "GET" && (m = /^\/invoices\/([^/]+)$/.exec(url.pathname))) {
      const i = invoices.find((x) => x.id === m![1]);
      return i ? send(200, i) : send(404, { error: "no invoice" });
    }
    if (method === "GET" && url.pathname === "/credit-notes")
      return send(200, creditNotes.filter((c) => c.externalKey === url.searchParams.get("externalKey")));
    if (method === "POST" && url.pathname === "/credit-notes") {
      if (mode === "503") return send(503, { error: "maintenance" });
      if (mode === "422") return send(422, { error: "amount exceeds the invoice total" });
      const b = JSON.parse(raw) as { invoice: string; amount: number; reason: string; externalKey: string };
      if (creditNotes.some((c) => c.externalKey === b.externalKey && c.status === "issued")) return send(409, { error: "duplicate externalKey" });
      const c: CreditNote = { id: `CN-${creditNotes.length + 1}`, invoice: b.invoice, amount: b.amount, reason: b.reason, externalKey: b.externalKey, status: "issued" };
      creditNotes.push(c);
      if (mode === "lose") { mode = "ok"; res.socket?.destroy(); return; }
      return send(201, c);
    }
    if (method === "GET" && (m = /^\/credit-notes\/([^/]+)$/.exec(url.pathname))) {
      const c = creditNotes.find((x) => x.id === m![1]);
      return c ? send(200, c) : send(404, { error: "no credit note" });
    }
    if (method === "POST" && (m = /^\/credit-notes\/([^/]+)\/void$/.exec(url.pathname))) {
      const c = creditNotes.find((x) => x.id === m![1]);
      if (!c) return send(404, { error: "no credit note" });
      if (c.status === "void") return send(409, { error: "already void" });
      c.status = "void";
      return send(200, c);
    }
    send(404, { error: "no route" });
  });
});
server.listen(0, "127.0.0.1", () => {
  const a = server.address();
  parentPort?.postMessage(typeof a === "object" && a ? a.port : 0);
});
parentPort?.on("message", (m) => { if (m === "close") { server.closeAllConnections(); server.close(() => process.exit(0)); } });
