#!/usr/bin/env node
// Fake `claude -p --output-format json` for govern's tests.
//   FAKE_CLAUDE_ARGV_OUT  append {argv, cwd, nested} (JSON) to this file; nested = CLAUDECODE was inherited
//   FAKE_CLAUDE_RESULT    the text of the `result` field
import { appendFileSync } from "node:fs";
const chunks: Buffer[] = [];
process.stdin.on("data", (c) => chunks.push(c as Buffer));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_ARGV_OUT)
    appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nested: "CLAUDECODE" in process.env, stdin: Buffer.concat(chunks).toString("utf8").length }) + "\n");
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2, result: process.env.FAKE_CLAUDE_RESULT ?? "",
    total_cost_usd: 0.0123, usage: { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000, output_tokens: 200 },
  }));
});
