#!/bin/sh
# Insights for the Grafana watcher (grafana-watch.ts, GRAFANA_WATCH_INSIGHT): reads the prompt on stdin and prints
# {"insights": [{"text", "evidence": [...]}]} from Claude Code headless, with no tools, no MCP servers, no settings and no
# saved session. The watcher checks this output before posting it. GRAFANA_WATCH_MODEL picks the model (default sonnet).
set -eu
schema='{"type":"object","additionalProperties":false,"required":["insights"],"properties":{"insights":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["text","evidence"],"properties":{"text":{"type":"string","minLength":1,"maxLength":500},"evidence":{"type":"array","minItems":1,"items":{"type":"string"}}}}}}}'
claude -p --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence \
  --model "${GRAFANA_WATCH_MODEL:-sonnet}" --output-format json --json-schema "$schema" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    if(j.is_error||!j.structured_output){console.error("claude: "+(j.subtype||"no structured output"));process.exit(1)}
    process.stdout.write(JSON.stringify(j.structured_output))})'
