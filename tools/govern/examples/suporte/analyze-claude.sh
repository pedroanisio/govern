#!/bin/sh
# Ticket analysis for the Slack requests runner (requests.ts, REQUESTS_ANALYZE): reads the prompt on stdin and prints
# {"resumo", "pontos", "proximo_passo"} from Claude Code headless, with no tools, no MCP servers, no settings and no saved
# session. requests.ts checks this output against the ticket's facts before posting it; this script only shapes it.
# REQUESTS_MODEL picks the model (default sonnet).
set -eu
schema='{"type":"object","additionalProperties":false,"required":["resumo","pontos","proximo_passo"],"properties":{"resumo":{"type":"string","minLength":1},"pontos":{"type":"array","maxItems":5,"items":{"type":"string","minLength":1}},"proximo_passo":{"type":"string","minLength":1}}}'
claude -p --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence \
  --model "${REQUESTS_MODEL:-sonnet}" --output-format json --json-schema "$schema" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    if(j.is_error||!j.structured_output){console.error("claude: "+(j.subtype||"no structured output"));process.exit(1)}
    process.stdout.write(JSON.stringify(j.structured_output))})'
