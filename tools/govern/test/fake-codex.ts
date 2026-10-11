#!/usr/bin/env node
// Fake `codex` for govern's tests. Behaviour is driven by env vars:
//   FAKE_CODEX_ARGV_OUT   append the argv (JSON) to this file
//   FAKE_CODEX_STDIN_OUT  append the stdin text (one JSON string per call) to this file
//   FAKE_CODEX_SCRIPTS    comma-separated JSONL files, one per successive call (counter in FAKE_CODEX_COUNTER)
//   FAKE_CODEX_EXIT       exit code (default 0)
// The text of the last agent_message is also written to the file after -o, like codex exec does.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGV_OUT) appendFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(argv) + "\n");
const chunks: Buffer[] = [];
process.stdin.on("data", (c) => chunks.push(c as Buffer));
process.stdin.on("end", () => {
  if (process.env.FAKE_CODEX_STDIN_OUT) appendFileSync(process.env.FAKE_CODEX_STDIN_OUT, JSON.stringify(Buffer.concat(chunks).toString("utf8")) + "\n");
  const counter = process.env.FAKE_CODEX_COUNTER ?? "";
  const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  if (counter) writeFileSync(counter, String(n + 1));
  const scripts = (process.env.FAKE_CODEX_SCRIPTS ?? "").split(",").filter(Boolean);
  const script = scripts[Math.min(n, scripts.length - 1)];
  let last: string | undefined;
  for (const line of script ? readFileSync(script, "utf8").split("\n").filter(Boolean) : []) {
    const o = JSON.parse(line);
    if (o.type === "item.completed" && o.item?.type === "agent_message") last = o.item.text;
    process.stdout.write(line + "\n");
  }
  const oi = argv.indexOf("-o");
  if (oi >= 0 && last !== undefined) writeFileSync(argv[oi + 1], last);
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
});
