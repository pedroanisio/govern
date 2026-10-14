#!/usr/bin/env node
// Fake `grok --prompt-file F --output-format json` for govern's tests.
//   FAKE_GROK_ARGV_OUT   append {argv, cwd, env, prompt} (JSON) to this file; env = the seal variables as the child saw them
//                        (HOME, GROK_HOME, GROK_CLAUDE_*_ENABLED, GROK_MEMORY, CLAUDECODE), prompt = the --prompt-file's text
//   FAKE_GROK_RESULT     the `text` field (default: empty)
//   FAKE_GROK_STOP       the `stopReason` field (default end_turn)
//   FAKE_GROK_RAW        print this instead of the JSON result (to test non-JSON output)
//   FAKE_GROK_EXIT       exit with this status after printing
//   FAKE_GROK_SCRIPT     a JSON file: [{result, write?: {path, text}}, …], one entry per successive call (the last repeats;
//                        counter file prefix FAKE_GROK_COUNTER), exactly like fake-claude.ts; NONCE becomes ./probe.txt's text.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
const argv = process.argv.slice(2);
const pf = argv.indexOf("--prompt-file");
const prompt = pf >= 0 && argv[pf + 1] ? readFileSync(argv[pf + 1]!, "utf8") : "";
const SEAL = ["HOME", "GROK_HOME", "GROK_CLAUDE_MCPS_ENABLED", "GROK_CLAUDE_SKILLS_ENABLED", "GROK_CLAUDE_HOOKS_ENABLED", "GROK_MEMORY", "CLAUDECODE"];
if (process.env.FAKE_GROK_ARGV_OUT)
  appendFileSync(process.env.FAKE_GROK_ARGV_OUT, JSON.stringify({ argv, cwd: process.cwd(), env: Object.fromEntries(SEAL.map((k) => [k, process.env[k] ?? null])), prompt, homeExists: existsSync(process.env.HOME ?? "/nonexistent") }) + "\n");
let text = process.env.FAKE_GROK_RESULT ?? "";
const script = process.env.FAKE_GROK_SCRIPT;
if (script) {
  const counter = process.env.FAKE_GROK_COUNTER ? `${process.env.FAKE_GROK_COUNTER}.${createHash("sha256").update(readFileSync(script)).digest("hex").slice(0, 12)}` : "";
  const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  if (counter) writeFileSync(counter, String(n + 1));
  const steps: { result: unknown; write?: { path: string; text: string } }[] = JSON.parse(readFileSync(script, "utf8"));
  const step = steps[Math.min(n, steps.length - 1)]!;
  const probe = existsSync("probe.txt") ? readFileSync("probe.txt", "utf8").trim() : "NO-PROBE-FILE";
  const fill = (s: string) => s.replaceAll("NONCE", probe);
  text = fill(typeof step.result === "string" ? step.result : JSON.stringify(step.result));
  if (step.write) { const f = join(process.cwd(), step.write.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, fill(step.write.text)); }
}
if (process.env.FAKE_GROK_RAW !== undefined) process.stdout.write(process.env.FAKE_GROK_RAW);
else process.stdout.write(JSON.stringify({
  text, stopReason: process.env.FAKE_GROK_STOP ?? "end_turn", sessionId: "01a13a1d-0000-7000-8000-000000000000", requestId: "r", cwd: process.cwd(),
  // the CLI's own json: input_tokens EXCLUDES cache reads (verified: 12776 + 1920 + 49 = 14745 total)
  usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 200, reasoning_tokens: 50, total_tokens: 10200 },
  num_turns: 2, total_cost_usd: 0.0123, total_cost_usd_ticks: 123000000,
}));
process.exit(Number(process.env.FAKE_GROK_EXIT ?? 0));
