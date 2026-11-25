---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-29"
---

# govern slack

Part of [super-tools](../../README.md); the tool is [govern](README.md). The command belongs to the `slack` extension: a
workspace enables it with `govern ext enable slack` (see [REFERENCE.md](REFERENCE.md#extensions)).

To set up a real Slack app step by step, follow [SLACK-TUTORIAL.md](SLACK-TUTORIAL.md).

People decide from Slack: a button approves or rejects a gate, or completes a human task. govern records the decision as the
person's own only when Slack's signature proves the request, the Slack user is mapped to a process person, and the case has
not changed since the button was made.

## Setup

1. Map each person to their Slack user id in the process's `people`. A Slack user maps to exactly one person:

   ```json
   "people": {
     "ana": { "user": "ana", "roles": ["suporte"], "slack": "U04ANA123" },
     "gil": { "user": "gil", "roles": ["gestor"], "slack": "U04GIL456" }
   }
   ```

2. Name the Slack team whose requests count, in the workspace config. The signing secret is `SLACK_SIGNING_SECRET`, or that
   variable from the dotenv file `slack.envFile` names. It needs at least 16 characters. Keep it out of process files,
   command lines, tracked files and chat.

   ```json
   "slack": { "team": "T04TEAM789", "envFile": "secrets/slack.env" }
   ```

3. Run `govern slack serve [--port 5003]`. It listens on loopback only. Put an HTTPS proxy or tunnel in front, and set the
   Slack app's Interactivity Request URL to its `/slack/actions`.

   Or use Socket Mode, which needs no public URL. Set `"transport": "socket"`, turn Socket Mode on in the Slack app, and give
   serve an app-level token (`xapp-…`, scope `connections:write`) as `SLACK_APP_TOKEN`. serve then opens the connection
   itself. Socket Mode payloads carry no signature, so a click there is proven by the connection, not by the request; see
   [Socket Mode](#socket-mode).

   A [Tayet](TAYET.md) workspace works the same way: `"server": "tayet"` and its sidecar's `"api"`, over Socket Mode or,
   with the sidecar's `--slack-actions-url`, over signed HTTP.

4. A Slack app has one Interactivity Request URL. When lanes of other workspaces post buttons through the same app (each
   runs its own `govern slack notify`), list those workspaces in the serving workspace's `slack.serveRepos`, relative to
   the config's folder or absolute:

   ```json
   "slack": { "team": "T04TEAM789", "envFile": "secrets/slack.env", "serveRepos": ["../squad"] }
   ```

   A click is decided in the one workspace that holds the button's lane: its own `slack.team` must be the request's team,
   and its own process's `people` decide. A lane in no served workspace is 404; a lane name in more than one is refused
   (409). The serve reads its config once, so restart it after a change. With `serveRepos`, a folder override in the
   environment (`GOVERN_PROJECTS`, `GOVERN_STATE` and the like) would point every workspace at one folder, so every click
   is refused (403) while one is set.

## The button

A decision is a Slack button with `action_id` `govern.decide`, or `govern.decide.` and a suffix (Slack wants ids unique within a block). Its `value` is the JSON govern makes with `decisionValue()` in
[ext/slack/slack.ts](ext/slack/slack.ts):

```json
{"v": 1, "lane": "sup-123", "gate": "validacao", "decision": "approve", "digest": "<64 hex>"}
{"v": 1, "lane": "sup-123", "task": "responder", "decision": "complete", "digest": "<64 hex>"}
```

- A gate takes `approve` or `reject`; a task takes `complete`. Unknown fields, a second target, or another version are refused.
- An approval may carry `set` (case fields). It is accepted only when it equals one of the gate's `options` filled from the
  case as it stands; the fields are set, then the vote is recorded.
- The button's label is the person's words: it is recorded as the decision's quote, so write it as the decision ("Approve the
  reply", "Send back for changes"). It must have 2 to 2000 characters.
- `digest` is the SHA-256 of the case data and the loop counters when the button was made. A button made before the data
  changed, or before a loop repeated, is refused. Evidence that lives outside the case data (a draft in Jira, say) is bound
  the same way: record its hash in a case field, so a new draft invalidates the buttons made for the old one.

## Posting decisions: `govern slack notify`

Set `slack.channel` (the channel id) in the config and put `SLACK_BOT_TOKEN` (scope `chat:write`, the bot invited to the
channel) in the environment or the `slack.envFile`. `govern slack notify` (or `--loop --interval 30`) posts:

- each active human task and each gate that can be decided now, once, mentioning the people who may decide it, with one
  button per decision (a gate's options are one approve button each, the values they set shown above them);
- each open timer alert, once, with buttons **Acknowledge**, **Snooze 1h** and, while the alert's stage has a human task
  nobody holds, **Take it**;
- each stage `govern drive` left to the operator, once, with its reason and a **Retry stage** button.

When the decision is made, or the case changes under a message, the message is updated without its buttons; a changed
case gets a new message. A closed message keeps what it asked and gains one line (block `govern.outcome`) saying who
decided: `Done by @ana`, `Approved by @ana, @gil`, `Sent back by @gil`. `posted.json` keeps each message's blocks for
this; a message posted before blocks were kept closes as one line of text. What was posted is kept under the state folder's `slack/`. A failed Slack call is reported (exit
1) and tried again on the next run. `--dry-run` sends nothing and leaves notification receipts unchanged. Run one notifier per workspace.

With `"threads": true` in `slack`, each case gets one card in the channel: its title, its stage (or that it finished)
and each thing it waits on with who may decide it. The card is posted when the case first needs someone or has an alert,
and is updated in place as the case moves on. Decision messages and the case's alerts are posted as replies in the
card's thread; people mentioned there are still notified. A card that cannot be posted holds the case's messages back
until a later run, so they never land outside the thread. Without `threads`, every message is posted to the channel
itself.

### Cards: the case's place in Slack

With `"cards": true` in `slack` (it implies `threads`), the card is where people follow and discuss the case:

- Every open case has a card, posted on the first run that sees it, also one that waits on nobody. A finished case that
  never had a card gets none.
- The card also shows who holds the case's human tasks and the case's last note, and says that a reply in its thread is
  a note.
- Each new lane note (`govern note`, an agent's note, a decision's note) is posted in the card's thread, in order, once.
  Notes from before the card was posted are not posted. A failed post is tried again on the next run.
- A reply in the card's thread becomes a note of the lane, written by the process person mapped to the Slack user
  (`people.<id>.slack`), with `by` and `via: "slack"`. The ledger records it as a `note` with its source (team, user,
  channel, message ts). A note that came from the thread is not posted back. A reply longer than 4000 characters is cut.
- A reply from someone who is no person of the lane's process, or from another team, adds nothing; the author is told so
  privately (`chat.postEphemeral`). Edits, deletions, bot posts and top-level messages are ignored. Each message counts
  once: Slack's retries of the same message are ignored for seven days.

`govern slack serve` receives the replies as Slack events. Over HTTP they come signed to `POST /slack/events` on the same
server as `/slack/actions` (same signing secret, same clock check; Slack's URL check is answered). Every delivery that
passes the signature is answered 200, refused or not, so Slack does not retry a refusal. Over Socket Mode they come as
`events_api` envelopes. The Slack app subscribes to the bot events `message.channels` (and `message.groups` for a private
channel): see [slack-app-manifest.yml](slack-app-manifest.yml). Cards stay on the moving parts govern already has: the
gate buttons in the thread still decide, and only the people who may.

### Alert buttons

An alert button (`action_id` `govern.alert.ack`, `govern.alert.snooze`, `govern.alert.take`, `govern.drive.retry`) passes
the same checks as a decision (below: signature, clock, replay, team, a person of the lane's process) and is recorded as
that person's, with the signed request as `source`. None of them approves a gate or completes a task.

| Button | What it does | Ledger |
|---|---|---|
| Acknowledge | sets the alert's `acknowledgedAt`, as `govern alerts --ack` does | `alert-ack` |
| Snooze 1h | sets `snoozedUntil` an hour ahead; the notifier skips the alert until then, then posts it once more ("still open after a snooze") | `alert-snooze` |
| Take it | claims the stage's human task for the person, who must be eligible for it | `human-claim` |
| Retry stage | clears the failed run in `govern drive`'s state, so the next drive run sends the stage again (attempt counting starts over) | `drive-retry` |

The value names the lane and the alert (`{"v":1,"lane","alert","action"}`) or the lane, stage and round
(`{"v":1,"lane","stage","round","action":"retry"}`); unknown fields are refused. An alert already acknowledged, and a stage
no longer failed at that round, are refused (409). The clicked message loses its buttons and gains one line saying what
was done. When an alert is acknowledged at the terminal, or a failure goes away by itself, the notifier closes its
message the same way; a later failure of the same stage is a new message.

### Forms: a reason, an edited draft

With `"forms": true` in `slack`, two buttons open a Slack form (a modal) instead of deciding at once:

- **Send back** asks *Why is it sent back?* (2 to 2000 characters). The reason, not the button label, is the rejection's
  quote.
- A gate option with `edit` fields ([BUSINESS.md](BUSINESS.md)) gets a second button, **Edit: <label>**, opening those
  fields prefilled with the option's values as the case stands. Submitting approves the option with the edited text; the
  ledger's `approve` entry lists the changed fields as `edited`. A value longer than a Slack text input holds (3000
  characters) is not offered for editing: the click is refused, so a draft is never cut short.

The click is checked first (signature, clock, replay, team, the person, the case digest, and that the person may decide
the gate now) and records nothing; `serve` then opens the form with `views.open`, so it needs the bot token
(`SLACK_BOT_TOKEN` or `slack.botTokenVar`, no extra scope) and refuses to start without it. The decision is recorded only
when the signed `view_submission` arrives. It is checked the same way, and is refused when someone else submits the form
or the case changed after it was opened. A refusal is shown in the form itself. Once recorded, the clicked message is
updated through the click's response URL, using the blocks `notify` kept for it.

Button labels come from `slack.labels` (`complete`, `approve`, `reject`; default Done, Approve, Send back).

## What a request must prove

`POST /slack/actions` handles a request in this order. The first check that fails refuses it, and nothing is recorded.

| Check | Refusal |
|---|---|
| Body at most 64 KiB | 413 |
| `X-Slack-Signature` is `v0=` HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret | 401 |
| `X-Slack-Request-Timestamp` within 300 s of the server's clock | 401 |
| A `block_actions` payload with exactly one `govern.decide` (or alert) button and a valid value, or a `view_submission` of a govern form | 400 |
| The signature was never received before (remembered for 600 s, under the state folder's `slack/`) | 401 |
| The payload's team is the config's `slack.team` | 403 |
| The lane exists | 404 |
| The Slack user is a person of the lane's process | 403 |
| The case digest still matches, and govern accepts the decision (eligibility, active stage, gate owner, needed gates) | 409 |

A recorded decision replies 200 `{"ok": true, "text": "…"}`; every refusal replies `{"ok": false, "error": "…"}`.

### Socket Mode

With `slack.transport` `"socket"`, `govern slack serve` calls `apps.connections.open` with `SLACK_APP_TOKEN` and keeps the
WebSocket open. It reconnects when the server asks to, when the connection drops, and every 30 minutes. It stops when the
token is refused (`invalid_auth`, `token_revoked` and the like). The connection URL must be Slack's (`wss://…slack.com`) or
on the configured API's own address. Each `interactive` envelope goes through the checks above, except the three about the
signature and size. Instead, a repeat of the same click is refused: the same message, person, button and click time, remembered for
seven days under the state folder's `slack/`. Every envelope is acked within 2.5 s. Events are acked at once; `govern
slack chat` reads them ([Chat](#chat-govern-slack-chat)). `serve` hands a Lead channel's messages to that workspace's Lead
([LEAD.md](LEAD.md)), and with `slack.cards` takes a reply in a card's thread as a lane note
([Cards](#cards-the-cases-place-in-slack)); it ignores every other event. Slash commands are acked and ignored: `govern
slack listen` reads the channel itself.

Slack delivers each event to only one of an app's open Socket Mode connections; a Tayet sidecar sends every event to
every connection. So on Slack, a `govern slack chat` alongside `serve` on the same app sees only some of the channel's
messages. Give it an app of its own, or use a Lead, which `serve` itself feeds.

### Events over HTTP

`POST /slack/events` on the same server takes Slack's Events API, signed with the same secret and checked as clicks are
(signature, a timestamp within 300 s, at most 1 MiB). A `url_verification` gets its `challenge`. One subscription serves
both readers: a message in a Lead channel goes to that workspace's Lead ([LEAD.md](LEAD.md)), and an event whose
`event_id` was seen in the last hour is dropped there, which is how Slack's retries end; any other message goes on to
cards ([Cards](#cards-the-cases-place-in-slack)). Turn on Event Subscriptions with that URL and the bot events
`message.channels` and `message.groups` ([slack-app-manifest.yml](slack-app-manifest.yml)).

## What is recorded

The decision goes through the same rules as one made at a terminal ([BUSINESS.md](BUSINESS.md)):

- **Policy gate:** the person's vote. A reject follows the policy's `rejectTo`.
- **Gate without a policy:** an approval, only by the gate's `owner`. Such a gate cannot be rejected.
- **Human task:** completed by the person, who claims it first when nobody holds it.

The ledger entry (and, for an owner approval, `approvals.<gate>.source` in govern.json) carries the source
`{"kind": "slack", "team", "user", "timestamp", "signedBody", "signature"}`. Anyone holding the signing secret can check the
signature against the recorded body and timestamp again. A click over Socket Mode carries
`{"kind": "slack-socket", "team", "user", "envelope", "payload"}` instead: the envelope id and the payload as received.
Nothing in it can be checked again, because Socket Mode signs nothing.

## What this does not guarantee

- The signing secret is shared between Slack and govern (HMAC), unlike a paired phone's private key. Anyone who can read it
  can forge a request. Keep it readable only by the account that runs `govern slack serve`, and out of reach of agent
  sessions.
- Slack authenticates the user. govern trusts that identity and the `people.<id>.slack` mapping the process owner wrote.
- After recording a decision, `serve` immediately replaces the clicked message through its signed payload’s `response_url`.
  It rebuilds the message from the copy Slack sends with the click: what it asked stays, and one line says where the
  decision stands. A policy gate short of its quorum keeps its buttons, with progress above them (`1/2 approvals: @ana`),
  while the case is still the version the buttons are bound to; otherwise the buttons go. Without that copy the bare
  outcome line replaces the message. Refusals explain why in an ephemeral reply to the clicker. Only HTTPS `hooks.slack.com` URLs without credentials or nondefault ports are accepted, or, when `slack.api` names a server other than Slack (a Tayet sidecar), URLs on that API's own origin. Redirects are refused. A failed callback never undoes a decision; `notify` still reconciles on its next run. Payloads without a response URL retain HTTP-only feedback.

## Reading a channel and sending messages

Enable the extension, then configure the channel and a private inbox relative to the workspace config file:

```json
"slack": {
  "team": "TTEAM", "channel": "CCHANNEL", "envFile": ".env", "botTokenVar": "BOT_TOKEN",
  "bot": ["UBOT", "BBOT"],
  "requesters": { "UOPERATOR": "operator", "UPARTNER": "partner" },
  "tags": ["brief", "request", "stats", "alert", "setup", "question"],
  "inbox": "generated/slack"
}
```

`botTokenVar` defaults to `SLACK_BOT_TOKEN`. Its value comes from the environment first, then `envFile`; govern never
records the token. Both `notify` and the channel commands use this setting. Config rejects unknown fields, including
nested ones. `listen` and `post` refuse missing channel, inbox or credentials. No channel reader runs automatically.
The bot needs the channel's history scope and `chat:write`, and must belong to the channel.

- `govern slack listen --once` runs once (also the default). `--loop --interval 60` repeats, reporting failures and retrying
  on the next run. A failed single run exits 1. The interval is a positive whole number of seconds.
- One history page is read per run (100 posts); only changed threads are read (200 messages per thread), at most twenty
  threads per run. Remaining changed threads wait for the next run. Nothing is lost while fewer posts than one page
  arrive between runs and thread replies stay within their page. A history `has_more` response is reported on stderr
  and recorded as `hasMore` in the heartbeat. It warns that older posts beyond the page may be missed.
- The first run marks existing history seen. Later runs append other people's posts to `inbox.jsonl`, including author,
  timestamps, text, file IDs, recognized leading `[tag]`, requester eligibility and an `edited` flag. An unreadable post
  produces an `unreadable` row. Requester eligibility says who posted, regardless of tag; it never grants approval.
- `state.json` retains the poller's exact `top`, `threads`, `edits` structure. Inbox writes precede state writes: after a
  crash a consumer may see a repeated row, and should deduplicate by timestamp and edit. `heartbeat.json` holds
  `lastSuccess`, an ISO timestamp updated only after a successful run. The folder is mode 700 and files are mode 600.

Run only one reader per inbox. To migrate, stop the previous reader and its timer, preserve its `state.json` and
`inbox.jsonl`, point `slack.inbox` there, and run `govern slack listen --once` before starting the loop. No Python poller
or reference file is needed at runtime. Preserve `commands.json`, `sent.jsonl` and `send-intents.json` across restarts too.

```sh
govern slack post --kind ack --text 'Received' --thread 1793000000.000001 --key work-received
govern slack post --kind delivered --file generated/result.txt --key work-delivered
govern slack post --kind blocked --text 'Request escalated' --alerts
```

`--alerts` posts a top-level message to `slack.alertsChannel` instead of `slack.channel` and refuses `--thread`; it fails
when `slack.alertsChannel` is unset. `govern slack notify` sends its channel alerts (stale heartbeat, unanswered
requests, route limits) there too, while lane and gate posts stay in `slack.channel`.

Kinds are `ack`, `blocked`, `delivered`, `question`, `note`. The text starts with `<kind>: ` and must be nonempty and at
most 40000 Unicode characters including the prefix. Exactly one of `--text` and `--file` is required. A thread timestamp
is resolved through `conversations.replies` to its parent. Successful sends append `ts`, resolved `thread`, `kind`, and
`key` (null when omitted) to `sent.jsonl`; a previously sent key is refused. Use one writer per inbox. A keyed send also
uses a stable `client_msg_id`. A private `send-intents.json` is written before a keyed send: a crash or an ambiguous
network result leaves the key reserved and prevents an automatic duplicate, including command replies. A proven Slack
refusal releases that reservation for retry. An uncertain send is settled with `govern slack resolve`, below; do not edit
either file by hand.
An unkeyed send has no such protection. Message sends retry HTTP 429 at most twice, honoring numeric `Retry-After` up to 300 seconds;
a longer or malformed delay fails for a later invocation to retry. A network failure names its cause as a system code,
`timed out`, `aborted` or an error class; native messages, which hold URLs, and response bodies are never included in
API errors.

`govern slack resolve --key K [--delivered [--ts TS] | --not-delivered]` settles a reserved key. It may read Slack and
it posts nothing.

| Mark in `send-intents.json` | Meaning | What resolve does |
|---|---|---|
| `staging` | Upload stopped before completion: nothing was shared | Releases the key; a later upload also proceeds by itself |
| `completing FILE THREAD TIME` | Completion was issued, outcome unknown | Reads the thread: the file there is journaled as delivered. Absent, the key stays unless `--not-delivered` is given; that needs a whole thread read and five minutes since `TIME`, because sharing is not immediate. `--delivered` journals without reading |
| `sending`, `uploading`, or any other text | No file to look up (`uploading` is the mark of earlier versions, which set it before the transfer and never cleared it on failure) | Refuses until you have looked at the channel, then `--delivered --ts TS` journals it and `--not-delivered` releases it |

A failed read of the thread refuses and keeps the key: absence is only ever concluded from a whole read.

A requester may write exactly `<@UBOT> status`, `<@UBOT> pending`, `<@UBOT> lane <slug>` or `<@UBOT> help`. The bot mention
must match `slack.bot`. The code parses this fixed grammar, reads the shared status/brief and pending-decision views,
and answers in that post's thread, capped to Slack's limit. It records answered timestamps separately from the poller's
state and uses a send key per command. Everyone else's posts and anything outside the grammar enter the inbox. Posts never become shell commands. Configured routing below handles eligible non-command posts as untrusted data.

## Triggers: `run <name>`

`slack.triggers` maps a lowercase name to a systemd user unit. A configured requester who posts exactly
`<@bot> run <name>` starts that unit with `systemctl --user start --no-block`, at most once per `minIntervalSec`
(default 900); a unit already active is not started again. The reply says started, already running, or when the next
request counts. The post only selects a configured name: it never becomes argv, a path or a unit name, and an
unconfigured `run x` is an ordinary post. `help` lists the configured names. The last start per name is kept in
`slack.inbox/triggers.json`.

```json
"triggers": { "report": { "unit": "govern-grafana-report.service", "minIntervalSec": 900 } }
```

## Routing requests, independent alerts and a daily digest

Outside services are watched from the workspace config, not from `slack`, because the desk reports them too. See
**Watched services** in REFERENCE.md. A failing unit raises one alert per failure episode: a rerun in progress neither
closes it nor posts again, a success closes it, and a later failure is a new post. The digest lists it under open alerts.

All settings are optional. Nothing routes until `slack.route` is configured:

```json
"route": { "to": "codex", "profile": "codex-read", "maxPerHour": 6 },
"alerts": { "listenStaleSec": 300, "unansweredSec": 600 }
```

After a successful poll, `listen` replays the durable inbox. Posts from current requesters with a recognized `[request]`
or `[brief]` tag, or a direct bot mention outside the command grammar, enter the same queue as `govern task send`.
Other authors stay in the inbox. Revoking a requester prevents routing their waiting posts. When routing or alerts is first enabled, a private `start-line.json` captures the newest timestamp already in the
inbox before polling. Only later posts are eligible, including arrivals during that run. Preserve this fixed activation
boundary across restarts; it never advances as the backlog drains. First activation initializes it even during a `notify --dry-run`; notification receipts remain unchanged. The first listener run still only seeds history. Edits do not route a timestamp
again. A route accepts a sealed profile with only read capabilities, without secrets or MCP; it refuses write profiles,
missing profiles, a mismatched engine and a custom queue runner that bypasses the seal.

The post is JSON-quoted inside a fence longer than any backtick sequence in it. An instruction declares it untrusted
data that may not direct the run. A routed task belongs to the `slack` queue project and is sent from `owner` so its reply
returns to the owner's queue inbox. `routes.json` stores the task receipt and routing time. A deterministic task name
also recovers a queue write that succeeded before its receipt was saved. Keep this journal and the queue across restarts.

The rolling hourly quota counts queued tasks, regardless of their later result. Posts over the limit remain recorded in
`inbox.jsonl`; the listener reports the backlog, and `notify` alerts once. Later listener runs drain it as quota becomes
available. A queued task gets one keyed `seen: queued task <id>` receipt in its parent thread. A refused receipt retries
without queuing another task. An ambiguous receipt retains its send intent and needs the same operator reconciliation
as an explicit keyed post. No model reply is ever posted to Slack automatically.

### Publishing a checked reply

A reply can reach the request's thread only through a person. Name who may publish, and a review channel the
requesters are not in:

```json
"route": { "to": "codex", "profile": "codex-read", "maxPerHour": 6, "publishers": ["U0…"], "review": "C0…" }
```

`govern slack notify` offers each reply to a routed request whose content check passed (`checked`) once in the review
channel: what it answers, its whole text (plain text, so nothing in it mentions or links), and **Publish to thread**.
Replies that are unverified, carry no check (`shape only` or none), are BLOCKED, or are too long to show in full (34800
characters) are never offered. Read those with `govern task inbox --as owner`.

A click by a publisher passes the decision server's checks (signature, clock, replay, team) and is refused unless the
reply is still offered as the same text (its SHA-256 is in the button). It records the approval, with the signed click
as its source, in the inbox's `publish.json`, and posts nothing itself. `govern slack listen`, the inbox's one writer,
then checks the reply again and posts it once as `delivered: <text>` in the request's thread. The text has Slack's
`<`, `>` and `&` escaped, and the send key is `publish:<reply id>`. An uncertain send is settled with
`govern slack resolve`. The offer closes with *Published to the thread* once the send is journaled. The content check
proves the cited `file:line` references exist, not that the analysis is right: the publisher's approval is the review.

The queue dispatcher validates output with `parseReply` against `queue-reply.json`, rejects unknown fields and malformed,
incomplete or adversarial envelopes, and sends a BLOCKED queue reply on failure. Every routed task also requests the
`file-refs` content check: the model must cite workspace `file:line` evidence. Missing or invalid references mark the
reply unverified for the owner; this check proves references exist, not the truth of the analysis. Queue run limits,
timeouts and the single envelope-repair attempt remain code-owned bounds. Read the reply with `govern task inbox --as owner`.

Run `govern slack notify --loop` independently from `listen`. With `alerts` configured it checks the heartbeat even when
the listener has died. Missing or old heartbeats alert after `listenStaleSec`; old requester requests alert after
`unansweredSec` when their thread has neither a journaled send nor an observed bot post. The listener records observed
bot posts in `bot-replies.json`, without adding them to the inbox. Commands do not count as unanswered requests. A send
in the same thread, including `seen:`, answers the request. The route-limit alert needs `route`, independently of
`alerts`. Each condition posts once, updates to cleared when it clears, and may alert again if it recurs. API failures
retry next notify run; `--dry-run` sends nothing and leaves notification receipts unchanged. These checks use the local inbox and heartbeat; retain them
and keep the listener within the history and thread windows described above.

`govern slack digest` explicitly sends one summary of what waits on each person, failed queue/drive tasks and open lane
and channel alerts. With nothing to report it sends nothing. A `digest:YYYY-MM-DD` send key uses the host's local calendar
and prevents repeats that day. It uses the configured channel credentials and private send journal. An oversized digest
is refused instead of silently omitting work. An ambiguous send requires the keyed-send reconciliation above. Use `install-service` below to write a daily timer explicitly.

## Session heartbeat

An agent session that answers the channel can say it is alive by touching a file: a Claude Code hook, the channel watcher
or anything else updates its mtime. With `slack.heartbeat` configured, every `notify` run reads that mtime and tells the
channel when the session goes quiet and when it is back:

```json
"slack": { "...": "...", "inbox": "generated/slack",
  "heartbeat": { "file": "generated/session.beat", "staleSeconds": 1800, "name": "creation-bot" } }
```

`file` is required and resolves against the config file, like the other slack paths. `staleSeconds` is a whole number of
seconds, 1 or more (default 1800). `name` is who the messages call the session's owner (default `the agent`). An empty
path or name, a zero, negative or fractional `staleSeconds`, and an unknown key are refused at config load. Without
`heartbeat` nothing changes. The alert needs `slack.inbox` and `slack.channel`; when either is missing, `notify` reports
`failed heartbeat: …` and does the rest of its run.

- When the beat is older than `staleSeconds` and no alert is open, `notify` posts once
  `blocked: <name>'s session has sent no heartbeat since HH:MM (UTC-3); requests wait until it returns or the headless shift answers`.
- While it stays stale, nothing more is posted.
- When the mtime moves past the beat the alert named, `notify` posts once
  `note: <name>'s session is back (silent HH:MM–HH:MM UTC-3)`. If the new beat is already stale, the same run opens a new alert.
- A heartbeat file that was never written alerts nothing, so installing the alert before the writers exist is silent.
  A file removed while an alert is open neither closes it nor opens another.

Times are the host's local clock and offset; a time on another day carries its date. Both sends are keyed
(`heartbeat:blocked:<last beat>`, `heartbeat:note:<last beat>`) and journaled in `sent.jsonl`, so `triage` and the
uncertain-send reconciliation treat them like any keyed post. A refused send is reported as `failed` and retried on the
next run; a key the journal already holds is recorded without sending it again.

The open alert is kept in `session-heartbeat.json` in `slack.inbox` (mode 600): `{}` or
`{"alert": {"since": "<ISO last beat>", "ts": "<blocked: ts>"}}`. A restart reads it, so it neither repeats a `blocked:`
nor loses the `note:` it owes. A file that is not that shape (not JSON, an unknown key, a time that is not ISO, a ts that
is not Slack's) is a `HeartbeatStateError`. `notify` then rebuilds the state from `sent.jsonl` (the latest `blocked:`
key without its `note:`), writes it back and prints `heartbeat <file>: …; rebuilt from sent.jsonl: …`. `--dry-run` reports
what it would post and the repair it would make, and sends and writes nothing.

`govern slack heartbeat [--json]` prints the beat's age, `fresh`, `stale` or `missing`, and the open alert, from local
files only. It exits 0 only when the beat is fresh, so a headless shift can run it to decide whether the session is
answering. A damaged state file is shown, not repaired.

Decision and rejected alternatives:

- **The mtime of a file another program touches is the heartbeat; govern only reads it.** Rejected: a heartbeat govern
  writes, such as a `govern slack beat` command. That would add a writer to the inbox and a token-free command that
  every hook must find on PATH; `touch` works from any hook with no govern dependency.
- **The alert is a `blocked:` and a later `note:`, two keyed sends.** Rejected: one of `notify`'s channel alerts (a
  `channel:` key updated to "condition cleared"). An edited message notifies nobody; the return is news people need to
  see. The two posts also use the `blocked:`/`note:` vocabulary the channel already reads.
- **A missing file is not stale.** Rejected: alerting on a missing file. The first install, before the hook has run once,
  would post `blocked:` at once.
- **Its own state file, with the send journal as the source to rebuild from.** Rejected: keeping the alert in
  `notify`'s `posted.json`, whose readers expect one shape per key and fail on anything else; and deriving the state
  only from `sent.jsonl`, which a dry run could not stage and which would grow every check with the journal. Rejected
  for a damaged state file: stopping every check until the operator removes it (the alert would go silent exactly
  when it matters) or treating it as "no alert" (it would repeat a `blocked:` already posted).

## Triage: every post gets a disposition

`govern slack triage` reads only the local journals and gives every inbox post after the start line exactly one state:

| state | meaning |
|---|---|
| `answered` | a send in `sent.jsonl` or a bot reply in `bot-replies.json`, in the post's thread, **later than the post**. The send that opened a thread, or a reply before the post, does not count. |
| `dismissed` | `govern slack dismiss --ts TS --reason R` recorded, in `triage.jsonl`, that the post needs nothing further and why. |
| `mapped` | a `slack.triage.rules` pattern matches its text, its thread parent is mapped, or it is an empty post in a thread (a file attached to that conversation). |
| `request` | it mentions the bot, or is a requester's `[request]`/`[brief]`: owed a reply. |
| `review` | none of the above: owed a manual review. |

A post that mentions the bot is never mapped by a rule. `--check` exits 1 while any `request` or `review` is open, so a
hook or a timer can stop on it; `--all` lists every state; `--json` prints the items. Rules are named regular
expressions, refused at config load when invalid:

```json
"triage": {"rules": [{"name": "stats", "pattern": "^\\[stats\\]"}, {"name": "addressed-elsewhere", "pattern": "^\\s*<@(?!UBOT\\b)U[A-Z0-9]+>"}]}
```

With `slack.triage` and `slack.alerts` configured, `notify` raises `channel:review:TS` for a `review` item older than
`alerts.unansweredSec`, as it raises `channel:unanswered:TS` for a request. Keep `triage.jsonl` with the other journals.

## Uploading media

Configure `upload: {"roots": ["generated"], "maxBytes": 100000000}` inside `slack`. Roots resolve relative to the workspace config base, as does `inbox`. Numeric limits must be positive integers and roots a nonempty list.

```sh
govern slack upload --thread 1793000000.000100 --file generated/clip.mp4 --title "Clip" --text "Ready for review" --key clip-1
```

Upload requires `slack.channel`, `slack.inbox`, a bot token with `files:write`, and `slack.upload`. The file must resolve, including symlinks, inside an allowed root and be a nonempty regular file no larger than `maxBytes`. Allowed extensions are PNG, JPG/JPEG, GIF, WebP, MP4/M4V, MOV, WebM and PDF (reports). These are extension restrictions, not content inspection. `--thread` is required and resolves a reply timestamp to its parent, just like `post`. Optional text must be nonempty and at most 40000 characters; titles are 1..255 characters.

The command calls `files.getUploadURLExternal`, POSTs the raw bytes without the bot token to an HTTPS `files.slack.com` upload URL, then calls `files.completeUploadExternal` to share the file in the thread. A redirect is never followed and fails as `file upload: HTTP 3xx`. The transfer's limit is 30 seconds plus one per 256 KB. The private `sent.jsonl` receipt has `kind: "upload"`, the resolved thread and key; its `ts` is the Slack file id rather than an assumed chat message timestamp. Keyed uploads use the same send-intent reservation as posts. A failure before completion frees the key, because only completion shares a file and each attempt gets a new file id; the unshared file is never posted. After completion is issued an uncertain result never retries automatically and `govern slack resolve` settles it. No upload URL, token or file bytes are journaled.


## Chat: `govern slack chat`

`slack.chat` makes `slack.channel` a place to talk to an agent:

```json
"slack": { "team": "T…", "channel": "C…", "transport": "socket",
           "chat": { "users": ["U…"], "profile": "ops-chat" } }
```

`govern slack chat` opens its own Socket Mode connection (`SLACK_APP_TOKEN`, as `serve` does, and alongside it). A Tayet
sidecar sends every event to every open connection, but Slack sends each event to only one of an app's connections: on
Slack, run chat on an app of its own, or use a Squad Lead ([LEAD.md](LEAD.md)), which `serve` feeds through the one app. Each message a person in `chat.users` posts in the channel is a
turn of a govern conversation ([CONVERSATIONS.md](CONVERSATIONS.md)) run with `chat.profile` (default `codex-read`) or a
configured `chat.adapter`, with `timeoutSeconds` and `maxContextChars` (default 400,000) as the conversation takes them.
The reply is posted where the question was asked, in parts of at most 3,500 characters, its Markdown turned into Slack's mrkdwn
(`**bold**` is `*bold*`, `[text](url)` is `<url|text>`, a heading is a bold line, a list item starts with `•`, a table
is a code block; code stays as it is).

- The channel's top-level messages are one conversation (`chat-<channel>-<n>`); each thread is its own
  (`chat-<channel>-t-<thread ts>`) and is answered in the thread. When the channel's conversation goes past its context
  budget, the question that found it full moves to the next one, with a line saying the new one does not see the old.
- The question gets 👀 while it runs, then ✅, or ❌ with a message saying why the turn failed. Nothing the model
  half-said is posted.
- `chat.brief` names a file (relative to the config's folder) whose text opens each new conversation, before its
  first question: what the agent should know about where it runs, such as what it may run and that a message cannot widen
  that. Claude runs without settings files or CLAUDE.md, so this is where such notes go. It is read when a conversation
  starts; a brief that cannot be read stops the question with ❌.
- A reply's Markdown images of local files (`![title](path)`, the path relative to the conversation's folder; not URLs,
  not inside code) are attached: each file is uploaded into the reply's thread (the question's thread, for a question in
  one) and the image becomes a `📎 title` line. This needs `slack.upload` (roots, maxBytes) and `slack.inbox`, as
  `govern slack upload` does, with the same checks; each file is sent once, and one that cannot be is named in the channel
  with why. At most 10 files a reply.
- `chat.originals: true` attaches each such image (png, jpg, gif, webp) a second time, as `<name>.original` titled
  `<title> (full size)`: a name no server shows as an image, so it arrives as a download of the full file. Tayet's web
  client shows an image only as a preview, with no way to open or save the original; this hands it over. Slack needs
  none of it. Renaming the download back to `<name>` gives the image.
- A reply part the server refuses (a Tayet sidecar's leak filter, say) is reported in its place: `❌ The reply could not
  be posted: <why>`, naming the conversation that holds it, and the question gets ❌. Only when the server takes nothing
  (down) is the delivery left for the next start.
- A mention of the agent is dropped from the question. Edits, deletions, bots, the agent itself, other people and other
  channels are not questions.
- `<state folder>/slack/chat.json` records each question by its channel and ts. A question the server sends again is not
  asked again; a reply left unposted (chat stopped, the server was down) is posted when chat starts again. Delivered
  questions are forgotten after seven days.

**This is the one place govern posts a model's reply without a person clicking Publish.** A workspace opts in by naming
the people. Everything they write is a prompt with the profile's tools, so the profile is the limit: a profile with a
shell can do what its account can, on that person's word alone. The usual conversation guards still apply (self-test
record, allowances, the profile's own output check). Run `govern caps --check <profile>` once before the first question.

## User services

`govern slack install-service` writes `govern-slack-listen.service`, `govern-slack-notify.service`, `govern-slack-digest.service` and `govern-slack-digest.timer` under `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`). It requires the channel and inbox, writes private files, and starts nothing. The listener loops every 60 seconds and the notifier independently every 30 seconds. The persistent daily timer uses local time; the digest's daily key still prevents repeats.

Set `slack.envFile` for the bot token: shell secrets are never copied into units. Workspace and PATH values are quoted for systemd. These units belong to one workspace per OS account; rerunning the installer replaces their definitions. Stop the previous poller or listener so exactly one reader owns the inbox, then run the printed commands:

```sh
systemctl --user daemon-reload
systemctl --user enable --now govern-slack-listen.service govern-slack-notify.service govern-slack-digest.timer
```

Inspect with `systemctl --user status govern-slack-listen govern-slack-notify govern-slack-digest.timer` and `journalctl --user -u govern-slack-listen -u govern-slack-notify`. The installer does not install `serve`, a tunnel, or the queue dispatcher. Run those separately when needed. To stop the channel services, use `systemctl --user disable --now govern-slack-listen.service govern-slack-notify.service govern-slack-digest.timer`.
