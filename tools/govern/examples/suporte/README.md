---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-29"
---

# Support example: an autonomous support process

Part of [super-tools](../../../../README.md); an example of [govern](../../README.md).

A Zendesk ticket runs on its own from intake to closed. Agents analyse and write, commands do the Slack, Jira and Zendesk
work, and people are asked in Slack only for decisions: the manager's validation, the operator's choice of response,
development and QA on each card.

| BPMN | Stage | Done by |
|---|---|---|
| SUP-01 | case opened by `POST /cases` | Zendesk trigger |
| SUP-02, SUP-03 | `anunciar`, `criar-card` | commands (`act.ts`); the card is checked in Jira |
| SUP-04 | `redigir-primeira`, then `enviar-primeira-auto`, or `aprovar-primeira` and `enviar-primeira` | agent; the operator approves it when `primeiraRespostaAuto` is false |
| SUP-05, SUP-06 | `analisar`, `redigir` | agents (the draft carries a confidence) |
| GES-02, GES-04 | `validar` (gate `validacao`) | manager, in Slack: always while `validacaoSempre` is true, else only when the confidence is below 0.8 |
| SUP-07, SUP-08 | `triagem-cards`, `criar-cards` | route, command |
| DEV-01…03, QA-01/02 | `desenvolver`: one `suporte-card` case per card | developers and QA, in Slack |
| SUP-09a | `sugerir` | agent: three responses |
| SUP-09b | `responder` (gate `envio`, one option per suggestion), `enviar-resposta` | operator chooses in Slack; then a command sends it |
| SUP-13, SUP-14 | `retorno` (event `cliente.retorno`), `avaliar-retorno` | Zendesk trigger, agent; unresolved loops back to `analisar` (5 passes at most) |
| SUP-10, SUP-11 | `encerrar`, `redigir-kb`, `publicar-kb` | command (checked in Zendesk), agent, command |
| SUP-12 | timers on `aprovar-primeira`, `validar`, `responder` | reminders and overdue alerts posted to Slack |

Nothing reaches the client before a person: the automatic first response is an acknowledgement drafted to promise
nothing, and every later response goes out only after the operator picks it.

## Install

1. In a govern workspace (`govern init`), enable the extensions and copy the files:

   <!-- readme-example: skip: needs a govern workspace and $GOVERN set to the govern tool folder -->
   ```sh
   govern ext enable business && govern ext enable slack
   mkdir -p .govern/processes/suporte
   cp "$GOVERN"/examples/suporte/{suporte.json,suporte-card.json} .govern/processes/
   cp "$GOVERN"/examples/suporte/{act.ts,checks.ts} .govern/processes/suporte/
   ```

2. In `.govern/config.json`: `paths.suporte` (the folder of `act.ts`, absolute), the Slack settings
   ([SLACK.md](../../SLACK.md)) and a mailbox for the driver:

   ```json
   { "extensions": ["business", "slack"], "mailboxes": ["govern-drive"],
     "paths": { "suporte": "/srv/support/.govern/processes/suporte" },
     "slack": { "team": "T…", "channel": "C…", "envFile": "/etc/govern/slack.env",
       "labels": { "complete": "Concluído", "approve": "Aprovar", "reject": "Devolver" } } }
   ```

3. Replace the people in both process files with your own: each `user` an OS account on the govern host, each `slack`
   a member id. Edit roles and timers to fit.
4. Set the environment of the services below (an env file read by systemd, never a tracked file):
   `SLACK_BOT_TOKEN` (scopes `chat:write`, `channels:history`), `SLACK_SUPPORT_CHANNEL`; `JIRA_BASE_URL`, `JIRA_EMAIL`,
   `JIRA_API_TOKEN`, `JIRA_PROJECT`, `JIRA_DONE_TRANSITION` (the transition id to Done); `ZENDESK_BASE_URL`,
   `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`, `ZENDESK_KB_SECTION`, `ZENDESK_KB_PERMISSION_GROUP`;
   `GOVERN_WEBHOOK_TOKEN` (16 characters or more).

## Run

Six long-running commands, each as a service:

<!-- readme-example: skip: long-running services that need a configured workspace, Slack, Jira and Zendesk -->
```sh
govern task dispatch --loop          # runs the agents' tasks (govern task install-service writes its unit)
govern drive --loop --interval 30    # agent and command stages, decisions, sub-cases
govern tick --advance --loop         # timers, and the client's returns
govern slack serve --port 5003       # Slack's button clicks (behind HTTPS)
govern slack notify --loop           # what people must decide, alerts, and stages left to them
govern event-listen --port 5001      # Zendesk's webhooks (behind HTTPS)
```

## Zendesk

Two triggers, each notifying a webhook to `https://…/cases` or `https://…/events` with bearer authentication
(`GOVERN_WEBHOOK_TOKEN`):

- **Ticket created** → `POST /cases`:

  ```json
  { "process": "suporte", "slug": "sup-{{ticket.id}}", "title": "{{ticket.title}}",
    "data": { "ticketId": "{{ticket.id}}", "canal": "zendesk", "cliente": "{{ticket.requester.name}}",
      "assunto": "{{ticket.title}}", "descricao": "{{ticket.description}}" } }
  ```

- **Ticket updated by the requester** (a public comment from the end user) → `POST /events`:

  ```json
  { "lane": "sup-{{ticket.id}}", "name": "cliente.retorno", "id": "zd-{{ticket.id}}-{{ticket.updated_at_with_timestamp}}",
    "correlation": "{{ticket.id}}", "data": { "comentario": "{{ticket.latest_public_comment}}" } }
  ```

A return that arrives while the case is not waiting for one is refused (409) and changes nothing.

## Files

- [suporte.json](suporte.json), [suporte-card.json](suporte-card.json): the processes.
- [act.ts](act.ts): the commands that act on Slack, Jira and Zendesk; each writes its outputs to `$GOVERN_OUTPUTS`.
- [checks.ts](checks.ts): the stage checks that ask Jira and Zendesk whether the work is really done.

Tests: `test/suporte-flow.test.ts` (a ticket end to end), `test/suporte-act.test.ts`, `test/suporte-checks.test.ts`.
