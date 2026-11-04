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
   Slack app's Interactivity Request URL to its `/slack/actions`. Socket Mode is not supported: its payloads carry no
   per-request signature, so govern could not verify them itself.

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
- each open timer alert, and each stage `govern drive` left to the operator, once, as text.

When the decision is made, or the case changes under a message, the message is updated without its buttons; a changed
case gets a new message. A closed message keeps what it asked and gains one line (block `govern.outcome`) saying who
decided: `Done by @ana`, `Approved by @ana, @gil`, `Sent back by @gil`. `posted.json` keeps each message's blocks for
this; a message posted before blocks were kept closes as one line of text. What was posted is kept under the state folder's `slack/`. A failed Slack call is reported (exit
1) and tried again on the next run. `--dry-run` sends nothing and leaves notification receipts unchanged. Run one notifier per workspace.

Button labels come from `slack.labels` (`complete`, `approve`, `reject`; default Done, Approve, Send back).

## What a request must prove

`POST /slack/actions` handles a request in this order. The first check that fails refuses it, and nothing is recorded.

| Check | Refusal |
|---|---|
| Body at most 64 KiB | 413 |
| `X-Slack-Signature` is `v0=` HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret | 401 |
| `X-Slack-Request-Timestamp` within 300 s of the server's clock | 401 |
| A `block_actions` payload with exactly one `govern.decide` button and a valid value | 400 |
| The signature was never received before (remembered for 600 s, under the state folder's `slack/`) | 401 |
| The payload's team is the config's `slack.team` | 403 |
| The lane exists | 404 |
| The Slack user is a person of the lane's process | 403 |
| The case digest still matches, and govern accepts the decision (eligibility, active stage, gate owner, needed gates) | 409 |

A recorded decision replies 200 `{"ok": true, "text": "…"}`; every refusal replies `{"ok": false, "error": "…"}`.

## What is recorded

The decision goes through the same rules as one made at a terminal ([BUSINESS.md](BUSINESS.md)):

- **Policy gate:** the person's vote. A reject follows the policy's `rejectTo`.
- **Gate without a policy:** an approval, only by the gate's `owner`. Such a gate cannot be rejected.
- **Human task:** completed by the person, who claims it first when nobody holds it.

The ledger entry (and, for an owner approval, `approvals.<gate>.source` in govern.json) carries the source
`{"kind": "slack", "team", "user", "timestamp", "signedBody", "signature"}`. Anyone holding the signing secret can check the
signature against the recorded body and timestamp again.

## What this does not guarantee

- The signing secret is shared between Slack and govern (HMAC), unlike a paired phone's private key. Anyone who can read it
  can forge a request. Keep it readable only by the account that runs `govern slack serve`, and out of reach of agent
  sessions.
- Slack authenticates the user. govern trusts that identity and the `people.<id>.slack` mapping the process owner wrote.
- After recording a decision, `serve` immediately replaces the clicked message through its signed payload’s `response_url`.
  It rebuilds the message from the copy Slack sends with the click: what it asked stays, and one line says where the
  decision stands. A policy gate short of its quorum keeps its buttons, with progress above them (`1/2 approvals: @ana`),
  while the case is still the version the buttons are bound to; otherwise the buttons go. Without that copy the bare
  outcome line replaces the message. Refusals explain why in an ephemeral reply to the clicker. Only HTTPS `hooks.slack.com` URLs without credentials or nondefault ports are accepted; redirects are refused. A failed callback never undoes a decision; `notify` still reconciles on its next run. Payloads without a response URL retain HTTP-only feedback.

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
```

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


## User services

`govern slack install-service` writes `govern-slack-listen.service`, `govern-slack-notify.service`, `govern-slack-digest.service` and `govern-slack-digest.timer` under `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`). It requires the channel and inbox, writes private files, and starts nothing. The listener loops every 60 seconds and the notifier independently every 30 seconds. The persistent daily timer uses local time; the digest's daily key still prevents repeats.

Set `slack.envFile` for the bot token: shell secrets are never copied into units. Workspace and PATH values are quoted for systemd. These units belong to one workspace per OS account; rerunning the installer replaces their definitions. Stop the previous poller or listener so exactly one reader owns the inbox, then run the printed commands:

```sh
systemctl --user daemon-reload
systemctl --user enable --now govern-slack-listen.service govern-slack-notify.service govern-slack-digest.timer
```

Inspect with `systemctl --user status govern-slack-listen govern-slack-notify govern-slack-digest.timer` and `journalctl --user -u govern-slack-listen -u govern-slack-notify`. The installer does not install `serve`, a tunnel, or the queue dispatcher. Run those separately when needed. To stop the channel services, use `systemctl --user disable --now govern-slack-listen.service govern-slack-notify.service govern-slack-digest.timer`.
