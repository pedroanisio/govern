#!/bin/sh
# Reply suggestions for the Zendesk watcher (watch.ts, ZENDESK_WATCH_SUGGEST): reads the prompt on stdin and prints
# {"suggestions": [{"text", "confidence"}]} from Claude Code headless, with no tools, no MCP servers, no settings and no
# saved session. The watcher checks this output before posting it; this script only shapes it.
# ZENDESK_WATCH_MODEL picks the model (default sonnet).
set -eu
schema='{"type":"object","additionalProperties":false,"required":["suggestions"],"properties":{"suggestions":{"type":"array","minItems":3,"maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["text","confidence"],"properties":{"text":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":1}}}}}}'
claude -p --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence \
  --model "${ZENDESK_WATCH_MODEL:-sonnet}" --output-format json --json-schema "$schema" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    if(j.is_error||!j.structured_output){console.error("claude: "+(j.subtype||"no structured output"));process.exit(1)}
    process.stdout.write(JSON.stringify(j.structured_output))})'
