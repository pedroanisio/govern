---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-11-18"
---

# govern on Tayet

Part of [super-tools](../../README.md); the tool is [govern](README.md). This is the [slack extension](SLACK.md) pointed at
a Tayet workspace instead of Slack.

[Tayet](https://tayet.app/) is a self-hosted team chat built on Matrix, where agents are members. An agent runs as a
sidecar (`npx tayet-agent`) on its operator's machine. The sidecar serves a local API on loopback that speaks part of
Slack's Web API and Socket Mode, and can post clicks as signed HTTP requests. govern talks to that API the way it talks to
Slack, with the differences below. They were checked against the sidecar's source at release tayet-agent-v0.3.0
(`tayethq/tayet`, `sidecar/src/api/slack/`).

govern expects **tayet-agent 0.3.0 or later and a Tayet server at 0.1.2 or later**. An older sidecar refuses a card with
more than 3 buttons, opens no form and posts no click over HTTP; an older server shows such a card, or a form, as not
displayable.

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
     "server": "tayet", "api": "http://127.0.0.1:7878/slack/api", "transport": "socket", "forms": true
   }
   ```

   `team` is the `team_id` that `auth.test` answers through the sidecar. `channel` is a conversation the agent is in.
   Process people map to Tayet's `U…` ids, as with Slack.
3. Put the contents of `<store>/local.token` in the dotenv file `slack.envFile` names (mode 600): as `SLACK_BOT_TOKEN`,
   used for the Web API, as `SLACK_APP_TOKEN`, used for Socket Mode, and, for clicks over HTTP, as `SLACK_SIGNING_SECRET`.
   The sidecar uses one token for all three.
4. Run `govern slack serve`. With `"transport": "socket"` it connects to the sidecar over Socket Mode, and nothing listens
   on a port. Run `govern slack notify --loop` and `govern slack listen --loop` as usual. `govern doctor` checks the token,
   the team, the channel, and the app token or the signing secret.

### Clicks over HTTP

With `"transport": "http"`, `govern slack serve` listens on `http://127.0.0.1:<port>/slack/actions` (`--port`, default
5003), as for Slack. Start the sidecar with `--slack-actions-url http://127.0.0.1:<port>/slack/actions`: it then posts the
clicks and form submissions there, signed with its local token, instead of sending them over Socket Mode. Events and
slash commands stay on Socket Mode, so `govern slack chat` is unchanged. A Squad Lead ([LEAD.md](LEAD.md)) gets its channel's messages from `govern slack
serve`'s own connection, as on Slack.

A signed click is a stronger record than a Socket Mode one: the ledger keeps the signature, which anyone holding the local
token can check again ([What a click proves](#what-a-click-proves)). The sidecar sends a click again, signed anew, when
govern does not answer within 3 seconds; govern also remembers each click by its message, person, button and time, so the
second delivery decides nothing and does not touch the card.

`govern slack chat` ([SLACK.md](SLACK.md#chat-govern-slack-chat)) works on Tayet unchanged: the sidecar sends every
message of a conversation the agent is in as an event, to every open connection, so `serve` and `chat` run side by side
on the same token. Tayet has no typing indicator; the 👀 reaction says a question is being answered.

## What differs from Slack

| | Slack | Tayet |
|---|---|---|
| Clicks | Signed HTTP requests (`transport: "http"`), or Socket Mode | The same. HTTP needs the sidecar's `--slack-actions-url`; the signing secret is the local token |
| Buttons per message | 25 | 25 on one card. A decision with more choices is sent as several cards |
| A clicked message | Keeps its buttons until govern edits it | Closes on the first click, whoever clicked. An edit cannot add buttons back |
| Message text | A fallback for the blocks | The card's request. govern sends the blocks' text as `text` |
| Forms (`slack.forms`) | Supported | Supported: Send back asks why, and an editable option opens its fields. The form's values are messages of the conversation, readable by its members |
| Ephemeral replies | A refusal is shown to the clicker only | Not available: a refusal replaces the card for everyone |
| Response and upload URLs | `hooks.slack.com`, `files.slack.com` (HTTPS) | On the sidecar's own address (`slack.api`'s origin) |
| Upload body | Raw bytes | One multipart file field |
| Upload authorization | None: the URL is the credential | The bot token, as for the Web API |
| Shared file id | The one `files.getUploadURLExternal` gave | A new one, the completion's only file; govern journals it |
| An image's original | Opened from the preview | Not offered by the web client (preview only): set `slack.chat.originals` |

A card closes on its first click, so `slack serve` marks every clicked card under the state folder (`slack/answered.json`).
`notify` posts a new card for anything the closed one asked that still waits on someone:

- a policy gate short of its quorum (one approval recorded, the next approver needs a card);
- a refused click (a person not in the process, or a case that changed), which would otherwise leave nobody a button;
- a click that opened a form (`slack.forms`). The click closed the card, and only the form's submission decides: if the
  person closes the form without sending it, the new card is where the gate can still be decided. The new card can appear
  while the form is still open.

The old card is edited to say that a newer one follows. A mark that no posted record claims is forgotten after a day.

## The Squad Lead on Tayet

A Squad Lead ([LEAD.md](LEAD.md)) runs on Tayet with these differences from Slack, each for a rule of the sidecar:

| | Slack | Tayet |
|---|---|---|
| A permission card's input | The first 12 lines, and **View full command** opens the rest | All of it in the card, up to 20,000 characters. The sidecar opens a view only as a form with something to send |
| Before a button counts | A dialog says what it allows | Nothing asks again (the sidecar drops a button's `confirm`). The line above the buttons says what each one does |
| The link to the message that started the turn | On the card | Not shown: it is a Slack address |
| Choices in a reply | Buttons up to 5, a menu past that | Buttons up to 25. The sidecar shows no menu, so past 25 the people answer in words |
| A click by someone who may not decide | Refused to that person; the card stays | The card closes for everyone, and the Lead's process posts it again within a second. The same for a choices card |
| The status of a turn | A plan of steps | Text |

Anyone in the Lead channel can therefore close a card for a moment, and cannot decide it: the decision is still only
`slack.lead.users`'. A card that closes only for the people who may answer it needs a change in Tayet, not in govern.

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
- The sidecar's Slack layer was checked at tayet-agent 0.3.0. Run `govern doctor` after upgrading it.
- A form's `trigger_id` is valid for 30 seconds and opens one form. govern opens the form while it answers the click.
