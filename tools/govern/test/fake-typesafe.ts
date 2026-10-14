#!/usr/bin/env node
// Fake TypeSafe System One server for govern's tests: listens on a free port and prints it as the first line of stdout.
//   FAKE_TYPESAFE_LOG    append {method, url, authorization, body} (JSON) per request to this file
//   FAKE_TYPESAFE_REPLY  a JSON file {status, body, delayMs?}, read on every request (so a test can change it between calls);
//                        without one, a 200 whose answers fit the questions asked: choice → its first key, score → the
//                        second level, noul → 0.7; model "jev-test-1", usage {input_tokens: 100, output_tokens: 10}
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

type Q = { type: string; criteria?: Record<string, string> | string[] };
function answers(questions: Record<string, Q>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria as Record<string, string>);
      out[k] = { type: "choice", choice: keys[0], confidence: 1, probabilities: Object.fromEntries(keys.map((c, i) => [c, i ? 0 : 1])) };
    } else if (q.type === "score") {
      const levels = q.criteria as string[];
      out[k] = { type: "score", score: 1 / (levels.length - 1), confidence: 0.9, legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
        probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 1 ? 1 : 0])) };
    } else out[k] = { type: "noul", noul: 0.7 };
  }
  return out;
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    if (process.env.FAKE_TYPESAFE_LOG)
      appendFileSync(process.env.FAKE_TYPESAFE_LOG, JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization, body }) + "\n");
    const f = process.env.FAKE_TYPESAFE_REPLY;
    const given = f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as { status?: number; body?: unknown; delayMs?: number } : {};
    const reply = { status: given.status ?? 200, delayMs: given.delayMs ?? 0, body: given.body
      ?? { model: "jev-test-1", answers: answers(body?.questions ?? {}), usage: { input_tokens: 100, output_tokens: 10 } } };
    setTimeout(() => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    }, reply.delayMs);
  });
});
server.listen(0, "127.0.0.1", () => {
  const a = server.address();
  process.stdout.write(`${typeof a === "object" && a ? a.port : 0}\n`);
});
