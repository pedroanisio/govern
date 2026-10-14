#!/usr/bin/env node
// Fake `grok --prompt-file F --output-format streaming-messages-json` for govern's tests.
//   FAKE_GROK_ARGV_OUT   append {argv, cwd, env, prompt} (JSON) to this file; env = the seal variables as the child saw them
//                        (HOME, GROK_HOME, GROK_CLAUDE_*_ENABLED, GROK_MEMORY, CLAUDECODE), prompt = the --prompt-file's text
//   FAKE_GROK_RESULT     the `result` field (default: empty)
//   FAKE_GROK_STOP       the `stop_reason` field (default end_turn)
//   FAKE_GROK_RAW        print this instead of the JSON result (to test non-JSON output)
//   FAKE_GROK_EXIT       exit with this status after printing
//   FAKE_GROK_SLEEP     sleep this many seconds before answering (to test the timeout)
//   FAKE_GROK_NOUSAGE   "1": omit usage and total_cost_usd; "incomplete": usage_is_incomplete true, no total_cost_usd
//   FAKE_GROK_ERRJSON   print {type:"error",message:<this>} and exit 1 (grok's own error json)
//   FAKE_GROK_REFRESH   "1": replace GROK_HOME/auth.json by a regular file (what a token refresh by rename does)
//   FAKE_GROK_SCRIPT     a JSON file: [{result, write?: {path, text}}, …], one entry per successive call (the last repeats;
//                        counter file prefix FAKE_GROK_COUNTER), exactly like fake-claude.ts; NONCE becomes ./probe.txt's text.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, readlinkSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
const argv = process.argv.slice(2);
const pf = argv.indexOf("--prompt-file");
const prompt = pf >= 0 && argv[pf + 1] ? readFileSync(argv[pf + 1]!, "utf8") : "";
const SEAL = ["HOME", "GROK_HOME", "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_MEMORY", "CLAUDECODE", "GROK_AGENT", "GROK_SESSION_ID",
  ...["CLAUDE", "CURSOR"].flatMap((v) => ["AGENTS", "HOOKS", "MCPS", "RULES", "SKILLS"].map((k) => `GROK_${v}_${k}_ENABLED`))];
/** The private GROK_HOME as the child sees it: its files, whether auth.json is a link and to what, its mode (never its content). */
const gh = process.env.GROK_HOME ?? "";
const homeInfo = (() => {
  try {
    const a = join(gh, "auth.json"), st = lstatSync(a, { throwIfNoEntry: false });
    return { files: readdirSync(gh).sort(), authIsLink: !!st?.isSymbolicLink(), authTarget: st?.isSymbolicLink() ? readlinkSync(a) : null, authMode: st && !st.isSymbolicLink() ? (st.mode & 0o777).toString(8) : null,
      config: existsSync(join(gh, "config.toml")) ? readFileSync(join(gh, "config.toml"), "utf8") : null };
  } catch { return null; }
})();
if (process.env.FAKE_GROK_ARGV_OUT)
  appendFileSync(process.env.FAKE_GROK_ARGV_OUT, JSON.stringify({ argv, cwd: process.cwd(), env: Object.fromEntries(SEAL.map((k) => [k, process.env[k] ?? null])), prompt, homeExists: existsSync(process.env.HOME ?? "/nonexistent"), homeInfo }) + "\n");
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
if (process.env.FAKE_GROK_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_GROK_SLEEP) * 1000);
if (process.env.FAKE_GROK_REFRESH === "1" && gh) { const t = join(gh, "auth.tmp"); writeFileSync(t, "REFRESHED-DUMMY", { mode: 0o600 }); renameSync(t, join(gh, "auth.json")); }
if (process.env.FAKE_GROK_ERRJSON !== undefined) { process.stdout.write(JSON.stringify({ type: "error", message: process.env.FAKE_GROK_ERRJSON })); process.exit(1); }
const nousage = process.env.FAKE_GROK_NOUSAGE;
if (process.env.FAKE_GROK_RAW !== undefined) process.stdout.write(process.env.FAKE_GROK_RAW);
else {
const stop = process.env.FAKE_GROK_STOP ?? "end_turn";
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
emit({ type: "system", subtype: "init" });
emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
emit({
  type: "result", result: text, stop_reason: stop, subtype: stop === "end_turn" ? "success" : "error_max_turns", is_error: stop !== "end_turn", ...(stop !== "end_turn" ? { errors: [`stopped with ${stop}`] } : {}), sessionId: "01a13a1d-0000-7000-8000-000000000000", requestId: "r", cwd: process.cwd(),
  // the CLI's own json: input_tokens EXCLUDES cache reads (verified: 12776 + 1920 + 49 = 14745 total)
  ...(nousage === "1" ? {} : { usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 200, reasoning_tokens: 50, total_tokens: 10200 } }),
  num_turns: 2, ...(nousage ? (nousage === "incomplete" ? { usage_is_incomplete: true, cost_is_partial: true } : {}) : { total_cost_usd: 0.0123, total_cost_usd_ticks: 123000000 }),
});
}
process.exit(Number(process.env.FAKE_GROK_EXIT ?? 0));
