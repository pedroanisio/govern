import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_CONVERSATION_LOG)
  appendFileSync(process.env.FAKE_CONVERSATION_LOG, JSON.stringify({ args: process.argv.slice(2), input }) + "\n");
const out = (x: unknown) => process.stdout.write(JSON.stringify(x) + "\n");
out({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "native reply" } }
});
if (process.env.FAKE_CONVERSATION_CLAUDE_PARTIAL !== "1")
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "native reply",
    usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 3 },
    total_cost_usd: 0.02
  });
