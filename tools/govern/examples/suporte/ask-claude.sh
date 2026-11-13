#!/bin/sh
# Draft answer for a Slack request no ticket routine maps (requests.ts, REQUESTS_ASK): reads the prompt on stdin and
# prints {"resposta","apuracao","proximo_passo"} from Claude Code headless.
#
# NOT sealed, on purpose. The sealed version answered "não tenho acesso ao JIRA nem a outras informações além do texto
# do pedido" to a request about a Jira card — worse than no answer, because it looks like an answer. An agent asked to
# investigate and given nothing to investigate with can only paraphrase the question. So it runs inside the workspace,
# with its settings, its CLAUDE.md, its MCP servers and its tooling.
#
# --permission-mode auto, not bypassPermissions: the same mode the operator's own session runs in. Headless has no one
# to ask, so something has to decide, and "the team's own accesses" means the team's own guardrail too — not none.
#
# What holds it is therefore not the absence of tools. It is the classifier, the prompt (apure, nunca aja, nunca
# aprove um gate) and checkAnswer() in requests.ts, which refuses any draft claiming a change was made.
#
# REQUESTS_ASK_DIR is the workspace it works in (default the suporte repo); REQUESTS_MODEL picks the model.
set -eu
dir=${REQUESTS_ASK_DIR:-/home/dev/govern/suporte}
cd "$dir"

schema='{"type":"object","additionalProperties":false,"required":["resposta","apuracao","proximo_passo"],"properties":{"resposta":{"type":"string","minLength":1,"maxLength":1500},"apuracao":{"type":"array","maxItems":5,"items":{"type":"string","minLength":1,"maxLength":300}},"proximo_passo":{"type":"string","minLength":1,"maxLength":300}}}'

tools="Você está no workspace do suporte da Ginga Pay, em $dir, com os acessos do time.
As ferramentas ficam em bin/: jira.mjs fala com o Jira e loki.mjs lê o log no Grafana. Leia o cabeçalho do arquivo
antes de usar — é lá que estão os subcomandos. As credenciais são carregadas pelas próprias ferramentas a partir de
~/.config/govern/suporte.env: nunca imprima, cite ou repasse valor de segredo.
Linha de log pode conter segredo (corpo de requisição, header, chave em query string): nunca copie linha de log crua
para a resposta — resuma, e redija o que não for necessário.
Use também o resto do ambiente quando ajudar: o código em ~/src, as lanes da squad em ~/govern/squad, as units do
systemd. Prefira ler a adivinhar."

claude -p --permission-mode auto --no-session-persistence \
  --model "${REQUESTS_MODEL:-sonnet}" --output-format json --json-schema "$schema" \
  --append-system-prompt "$tools" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    if(j.is_error||!j.structured_output){console.error("claude: "+(j.subtype||"no structured output"));process.exit(1)}
    process.stdout.write(JSON.stringify(j.structured_output))})'
