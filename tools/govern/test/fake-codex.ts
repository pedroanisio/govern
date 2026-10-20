#!/usr/bin/env node
// Fake `codex` for govern's tests. Behaviour is driven by env vars:
//   FAKE_CODEX_ARGV_OUT   append the argv (JSON) to this file
//   FAKE_CODEX_STDIN_OUT  append the stdin text (one JSON string per call) to this file
//   FAKE_CODEX_SCRIPTS    comma-separated JSONL files, one per successive call (counter in FAKE_CODEX_COUNTER)
//   FAKE_CODEX_EXIT       exit code (default 0)
//   FAKE_CODEX_HOME_OUT   append {home, files, config, authIsLink} (JSON) describing the CODEX_HOME the child saw
// The text of the last agent_message is also written to the file after -o, like codex exec does.
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, mkdirSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGV_OUT) appendFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(argv) + "\n");
if (process.env.FAKE_CODEX_HOME_OUT) {
  const home = process.env.CODEX_HOME ?? "";
  const auth = existsSync(home) ? lstatSync(`${home}/auth.json`, { throwIfNoEntry: false }) : undefined;
  appendFileSync(process.env.FAKE_CODEX_HOME_OUT, JSON.stringify({ home, files: existsSync(home) ? readdirSync(home).sort() : null, config: existsSync(`${home}/config.toml`) ? readFileSync(`${home}/config.toml`, "utf8") : null, authIsLink: auth?.isSymbolicLink() ?? null }) + "\n");
}
const chunks: Buffer[] = [];
process.stdin.on("data", (c) => chunks.push(c as Buffer));
//   FAKE_CODEX_SLEEP_MS   wait this long before answering; FAKE_CODEX_TIMES_OUT gets a "start"/"end" line (epoch ms) around the wait
//   FAKE_CODEX_BARRIER    DIR:N — after "start", enter DIR and wait until N calls have entered it, at most BARRIER_CAP_MS
//                         (a dispatcher that never runs N at once still ends: by a smaller overlap, or by the caller's timeout)
const BARRIER_CAP_MS = 30000;
function barrier(then: () => void): void {
  const spec = process.env.FAKE_CODEX_BARRIER;
  if (!spec) return then();
  const cut = spec.lastIndexOf(":"), dir = spec.slice(0, cut), n = Number(spec.slice(cut + 1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${process.pid}`, "");
  const until = Date.now() + BARRIER_CAP_MS;
  const poll = () => (readdirSync(dir).length >= n || Date.now() >= until ? then() : setTimeout(poll, 20));
  poll();
}
process.stdin.on("end", () => {
  const stamp = (what: string) => { if (process.env.FAKE_CODEX_TIMES_OUT) appendFileSync(process.env.FAKE_CODEX_TIMES_OUT, `${what} ${Date.now()}\n`); };
  stamp("start");
  barrier(() => setTimeout(() => { stamp("end"); answer(); }, Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0)));
});
function answer(): void {
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
  if (oi >= 0 && last !== undefined) {
    const file = argv[oi + 1];
    if (file === undefined) throw new Error("fake codex: -o needs a file");
    writeFileSync(file, last);
  }
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
}
