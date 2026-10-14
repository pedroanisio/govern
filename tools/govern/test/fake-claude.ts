#!/usr/bin/env node
// Fake `claude -p --output-format json` for govern's tests.
//   FAKE_CLAUDE_ARGV_OUT  append {argv, cwd, nested} (JSON) to this file; nested = CLAUDECODE was inherited
//   FAKE_CLAUDE_RESULT    the text of the `result` field
//   FAKE_CLAUDE_SCRIPT    a JSON file: [{result, write?: {path, text}}, …], one entry per successive call (the last repeats;
//                         counter file prefix FAKE_CLAUDE_COUNTER). The token NONCE in result or text becomes the contents of
//                         ./probe.txt (the self-test's nonce); `write` creates that file in the cwd, as a tool call would.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
const chunks: Buffer[] = [];
process.stdin.on("data", (c) => chunks.push(c as Buffer));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_ARGV_OUT)
    appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nested: "CLAUDECODE" in process.env, stdin: Buffer.concat(chunks).toString("utf8").length }) + "\n");
  let result = process.env.FAKE_CLAUDE_RESULT ?? "";
  const script = process.env.FAKE_CLAUDE_SCRIPT;
  if (script) {
    // one counter per script content, so two scripts run in one test each start at their first step
    const counter = process.env.FAKE_CLAUDE_COUNTER ? `${process.env.FAKE_CLAUDE_COUNTER}.${createHash("sha256").update(readFileSync(script)).digest("hex").slice(0, 12)}` : "";
    const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    if (counter) writeFileSync(counter, String(n + 1));
    const steps: { result: unknown; write?: { path: string; text: string } }[] = JSON.parse(readFileSync(script, "utf8"));
    const step = steps[Math.min(n, steps.length - 1)]!;
    const probe = existsSync("probe.txt") ? readFileSync("probe.txt", "utf8").trim() : "NO-PROBE-FILE";
    const fill = (s: string) => s.replaceAll("NONCE", probe);
    result = fill(typeof step.result === "string" ? step.result : JSON.stringify(step.result));
    if (step.write) { const f = join(process.cwd(), step.write.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, fill(step.write.text)); }
  }
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2, result,
    total_cost_usd: 0.0123, usage: { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000, output_tokens: 200 },
  }));
});
