---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-11-16"
---

# govern on Tayet

Part of [super-tools](../../README.md); the tool is [govern](README.md). This is the [slack extension](SLACK.md) pointed at
a Tayet workspace instead of Slack.

[Tayet](https://tayet.app/) is a self-hosted team chat built on Matrix, where agents are members. An agent runs as a
sidecar (`npx tayet-agent`) on its operator's machine. The sidecar serves a local API on loopback that speaks part of
Slack's Web API and Socket Mode. govern talks to that API the way it talks to Slack, with the differences below. They were
checked against the sidecar's source at release v0.1.0 (`tayethq/tayet`, `sidecar/src/api/slack/`).

## Setup

1. In Tayet, an admin creates the agent under People; Tayet shows its credential once. Start the sidecar on the machine
   that runs govern (`tayet-agent --server https://chat.<domain> --store <dir>`, with the credential in `TAYET_AGENT_TOKEN`).
   The sidecar never prints its local token. It writes it to `<store>/local.token`, and the API's address to
   `<store>/api.json`. Keep the store on persistent storage: it holds the agent's credential once the sidecar has reissued
   it. The credential runs one store at a time, so starting it elsewhere moves the agent.
2. Enable the slack extension and configure the workspace:

   ```json
   "slack": {
     "team": "T…", "channel": "C…", "envFile": "secrets/tayet.env",
     "server": "tayet", "api": "http://127.0.0.1:7878/slack/api", "transport": "socket"
   }
   ```

   `team` is the `team_id` that `auth.test` answers through the sidecar. `channel` is a conversation the agent is in.
   Process people map to Tayet's `U…` ids, as with Slack.
3. Put the contents of `<store>/local.token` in the dotenv file `slack.envFile` names (mode 600) twice: as `SLACK_BOT_TOKEN`,
   used for the Web API, and as `SLACK_APP_TOKEN`, used for Socket Mode. The sidecar uses one token for both.
4. Run `govern slack serve`. It connects to the sidecar over Socket Mode. Nothing listens on a port and no tunnel is needed.
   Run `govern slack notify --loop` and `govern slack listen --loop` as usual. `govern doctor` checks the token, the team,
   the channel and the app token.

`govern slack chat` ([SLACK.md](SLACK.md#chat-govern-slack-chat)) works on Tayet unchanged: the sidecar sends every
message of a conversation the agent is in as an event, to every open connection, so `serve` and `chat` run side by side
on the same token. Tayet has no typing indicator; the 👀 reaction says a question is being answered.

## What differs from Slack

| | Slack | Tayet |
|---|---|---|
| Clicks | Signed HTTP requests (`transport: "http"`), or Socket Mode | Socket Mode only |
| Buttons per message | 25 | 3. A decision with more choices is sent as several cards |
| A clicked message | Keeps its buttons until govern edits it | Closes on the first click, whoever clicked. An edit cannot add buttons back |
| Message text | A fallback for the blocks | The card's request. govern sends the blocks' text as `text` |
| Forms (`slack.forms`) | Supported | Not available (no `views.open`): the config refuses them |
| Ephemeral replies | A refusal is shown to the clicker only | Not available: a refusal replaces the card for everyone |
| Response and upload URLs | `hooks.slack.com`, `files.slack.com` (HTTPS) | On the sidecar's own address (`slack.api`'s origin) |
| Upload body | Raw bytes | One multipart file field |

A card closes on its first click, so `slack serve` marks every clicked card under the state folder (`slack/answered.json`).
`notify` posts a new card for anything the closed one asked that still waits on someone:

- a policy gate short of its quorum (one approval recorded, the next approver needs a card);
- a refused click (a person not in the process, or a case that changed), which would otherwise leave nobody a button.

The old card is edited to say that a newer one follows. A mark that no posted record claims is forgotten after a day.

## What a click proves

There is no signature over a Socket Mode payload. A click counts because it arrived on the connection `govern slack serve`
opened to the configured API with the app-level token. For Tayet, that connection is plain WebSocket on loopback, to the
sidecar's port. The trust differs from signed HTTP:

- A process that takes the sidecar's port before the sidecar does can pose as it. Keep the sidecar running as a service on
  the same account as govern, and the local token readable by that account only.
- The record cannot be checked again later. Its source is `{"kind": "slack-socket", "team", "user", "envelope", "payload"}`:
  the envelope id and the payload as received, not a signature anyone can recompute.
- Tayet records who answered a card, and when, on its own side. Compare its export with the ledger when the two must agree.

The checks after authentication are the same as for a signed request: the team, the person mapping, the case digest, and
govern's rules for the gate or task. A repeat of a click is refused. A click is identified by its message, person, button
and click time, and is remembered for seven days. The sidecar delivers a click at least once, including clicks made while
govern was not connected.

## Limits

- `slack listen` polls `conversations.history` and `conversations.replies`. Tayet's ids and `ts` values have Slack's shape,
  so the inbox works unchanged.
- `conversations.list` and `users.list` only return what the agent can see. govern uses neither.
- The sidecar's Slack layer is version 0.1.0. Run `govern doctor` after upgrading it.
