// Protocol fixture: all data arrives on stdin; tests never call a paid model.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const mode = process.argv[2] ?? "echo";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);
if (process.env.FAKE_CONVERSATION_LOG) appendFileSync(process.env.FAKE_CONVERSATION_LOG, JSON.stringify(req) + "\n");
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
const last = req.messages.at(-1)?.content ?? "";
if (mode === "malformed") {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (mode === "approval") {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [process.argv[3]!, "approve", "p", "final", "--quote", "I approve"], {
    encoding: "utf8"
  });
  emit({ type: "done", text: r.stderr || r.stdout });
  process.exit(0);
}
if (mode === "tool") {
  emit({ type: "tool.started", id: "t1", name: "read" });
  emit({ type: "tool.finished", id: "t1", name: "read", ok: true });
}
emit({ type: "assistant.delta", text: "part:" });
if (mode === "hang") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
// "slow" holds its reply until the test releases this message (a file named after it in FAKE_CONVERSATION_RELEASE), so a cancel,
// interrupt or kill never races a clock. The 60 s bound only ends a fixture a failed test left waiting.
if (mode === "slow") {
  const release = join(process.env.FAKE_CONVERSATION_RELEASE!, encodeURIComponent(last));
  const end = Date.now() + 60_000;
  while (!existsSync(release)) {
    if (Date.now() > end) process.exit(9);
    await new Promise((r) => setTimeout(r, 20));
  }
}
if (mode === "partial") process.exit(0);
if (mode === "fail") {
  emit({ type: "done", text: "misleading" });
  process.exit(7);
}
if (mode === "oversize") {
  await new Promise<void>((resolve) => process.stdout.write("x".repeat(5 * 1024 * 1024), () => resolve()));
  process.exit(0);
}
const previous = req.messages.filter((m: any) => m.role === "assistant").length;
const text = `reply:${last}:previous=${previous}`;
emit({ type: "done", text, usage: { input: 10, output: 5, cached: 0, costUsd: 0.01 } });
