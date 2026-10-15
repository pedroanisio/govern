#!/usr/bin/env node
// Fake `claude -p --output-format json` for govern's tests.
//   FAKE_CLAUDE_ARGV_OUT  append {argv, cwd, nested, stdin, input} (JSON) to this file; nested = CLAUDECODE was inherited;
//                         stdin = the prompt's length, input = the prompt text
//   FAKE_CLAUDE_RESULT    result text; with --json-schema, JSON parsed into structured_output (result is empty)
//   FAKE_CLAUDE_OMIT_STRUCTURED  simulate a CLI that supplies no structured payload
//   FAKE_CLAUDE_TASK_SHAPE  honor a task demanding verdicts only when no --json-schema is supplied
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
    appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nested: "CLAUDECODE" in process.env, stdin: Buffer.concat(chunks).toString("utf8").length, input: Buffer.concat(chunks).toString("utf8") }) + "\n");
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
  if (process.env.FAKE_CLAUDE_TASK_SHAPE && Buffer.concat(chunks).toString("utf8").includes('Return only {"verdicts": []}') && !process.argv.includes("--json-schema"))
    result = JSON.stringify({ verdicts: [] });
  // As the real CLI: with --json-schema, `result` keeps the text and `structured_output` carries the object however the
  // model fenced it; text that holds no JSON object yields no structured_output at all.
  let structured: unknown;
  try { structured = JSON.parse(result.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { structured = undefined; }
  const object = structured !== null && typeof structured === "object" && !Array.isArray(structured);
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2, result,
    ...(process.argv.includes("--json-schema") && !process.env.FAKE_CLAUDE_OMIT_STRUCTURED && object ? { structured_output: structured } : {}),
    total_cost_usd: 0.0123, usage: { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000, output_tokens: 200 },
  }));
});
