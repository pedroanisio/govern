// A fake `claude -p --output-format stream-json` for the Squad Lead's adapter (ext/slack/lead-adapter.ts): it logs its
// argv, prompt and GOVERN_AS to FAKE_LEAD_LOG, then streams a session, one tool use and its result, the reply text and a
// result whose total_cost_usd is FAKE_LEAD_COST (the session's running total). FAKE_LEAD_SESSION overrides the session id
// it reports; FAKE_LEAD_FAIL makes it end with that message on stderr and no result. FAKE_LEAD_NARRATE makes it first say
// that text, then write a plan (TodoWrite) and describe its Bash call; FAKE_LEAD_SLOW_MS is how long the Bash call takes.
// FAKE_LEAD_DENY makes auto mode's classifier block a Bash call of that command (tool use FAKE_LEAD_DENY_ID, default
// tu2), reported in the result's permission_denials.
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
if (process.env.FAKE_LEAD_LOG) appendFileSync(process.env.FAKE_LEAD_LOG, JSON.stringify({ argv, prompt, as: process.env.GOVERN_AS, cwd: process.cwd() }) + "\n");
if (process.env.FAKE_LEAD_FAIL) { process.stderr.write(process.env.FAKE_LEAD_FAIL + "\n"); process.exit(1); }
const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const session = process.env.FAKE_LEAD_SESSION ?? at("--resume") ?? at("--session-id") ?? "";
const out = (x: unknown) => process.stdout.write(JSON.stringify(x) + "\n");
out({ type: "system", subtype: "init", session_id: session });
const narrate = process.env.FAKE_LEAD_NARRATE;
if (narrate) {
  out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: narrate }] } });
  out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "tu0", name: "TodoWrite", input: { todos: [
    { content: "Read the desk", activeForm: "Reading the desk", status: "in_progress" }, { content: "Answer", activeForm: "Answering", status: "pending" }] } }] } });
  out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu0", content: "ok" }] } });
}
out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "tu1", name: "Bash",
  input: { command: "govern desk", ...(narrate ? { description: "Read the squad's desk" } : {}) } }] } });
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LEAD_SLOW_MS ?? 0)));
out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
const deny = process.env.FAKE_LEAD_DENY, denyId = process.env.FAKE_LEAD_DENY_ID ?? "tu2";
if (deny) {
  out({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: denyId, name: "Bash", input: { command: deny, description: "Push the branch" } }] } });
  out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: denyId, is_error: true,
    content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Undermining Oversight] The command reads a credential into the shell." }] } });
}
out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: `lead reply to: ${prompt}` }] } });
out({ type: "result", subtype: "success", is_error: false, session_id: session, result: `lead reply to: ${prompt}`,
  permission_denials: deny ? [{ tool_name: "Bash", tool_use_id: denyId, tool_input: { command: deny, description: "Push the branch" } }] : [],
  usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 7 }, total_cost_usd: Number(process.env.FAKE_LEAD_COST ?? 0.5) });
