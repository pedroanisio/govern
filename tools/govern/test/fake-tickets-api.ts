// A fake tickets API on loopback for the reference connector's tests (examples/connector/tickets.ts). It runs in a worker
// thread, so it keeps answering while the test's main thread waits in spawnSync on govern drive. The test steers it and
// reads its state over HTTP: POST /_mode sets how the next ticket creation goes, GET /_state returns the tickets and the
// requests seen.
//
//   GET    /tickets?externalKey=K   the tickets created with that key (the probe)
//   POST   /tickets                 creates one; mode "ok", "lose" (created, then the connection is cut), "503", "422"
//   GET    /tickets/:id             one ticket; mode "tamper" answers it with another key (a confirm mismatch)
//   DELETE /tickets/:id             deletes it; 404 when it is not there
import { createServer } from "node:http";
import { parentPort } from "node:worker_threads";

interface Ticket { id: string; externalKey: string; title: string; body: string; status: "open" | "deleted" }
interface Seen { method: string; path: string; idempotencyKey?: string; auth?: string }

const tickets: Ticket[] = [];
const seen: Seen[] = [];
let mode = "ok";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x"), method = req.method ?? "";
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/_mode") { mode = (JSON.parse(raw) as { mode: string }).mode; return send(200, { mode }); }
    if (url.pathname === "/_state") return send(200, { tickets, seen });
    const key = req.headers["idempotency-key"];
    seen.push({ method, path: url.pathname + url.search, ...(typeof key === "string" ? { idempotencyKey: key } : {}),
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: "unauthorized" });
    const one = /^\/tickets\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && url.pathname === "/tickets")
      return send(200, tickets.filter((t) => t.status === "open" && t.externalKey === url.searchParams.get("externalKey")));
    if (method === "POST" && url.pathname === "/tickets") {
      if (mode === "503") return send(503, { error: "maintenance" });
      if (mode === "422") return send(422, { error: "title is too long" });
      const b = JSON.parse(raw) as { title: string; body: string; externalKey: string };
      const t: Ticket = { id: `T-${tickets.length + 1}`, externalKey: b.externalKey, title: b.title, body: b.body, status: "open" };
      tickets.push(t);
      if (mode === "lose") { mode = "ok"; res.socket?.destroy(); return; }
      return send(201, t);
    }
    if (one && method === "GET") {
      const t = tickets.find((x) => x.id === one[1] && x.status === "open");
      if (!t) return send(404, { error: "not found" });
      return send(200, mode === "tamper" ? { ...t, externalKey: "someone-else" } : t);
    }
    if (one && method === "DELETE") {
      const t = tickets.find((x) => x.id === one[1] && x.status === "open");
      if (!t) return send(404, { error: "not found" });
      t.status = "deleted";
      return send(204, {});
    }
    send(404, { error: "no route" });
  });
});
server.listen(0, "127.0.0.1", () => {
  const a = server.address();
  parentPort?.postMessage(typeof a === "object" && a ? a.port : 0);
});
parentPort?.on("message", (m) => { if (m === "close") { server.closeAllConnections(); server.close(() => process.exit(0)); } });
