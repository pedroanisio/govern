---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

## [0.3.18] - 2026-11-25

### Fixed

- The Squad Lead's alternatives became buttons only when the reply carried a ```` ```choices ```` block, and the first real reply listed its options as "**Opções:** 1. … 2. …" without one, so no card came. A reply that ends with a numbered list under an options heading ("Opções:", "Options:", "Alternativas:"…, at most a short recommendation after it) now gets the card too, each item offered by its bold lead or first sentence.

## [0.3.17] - 2026-11-25

### Added

- The Squad Lead's alternatives are buttons (LEAD.md, "Choices as buttons"). A reply that ends with a ```` ```choices ```` block (one short label a line; the brief asks for it whenever the people must pick, yes/no too) gets a card in the same place: buttons, or a select menu past five. A click is the clicker's next message to the Lead, checked like a permission click (signed, the team, a Lead user, the first choice stands) and audited. `govern slack chat` gains the same hook (`choices`). Serve hands the Lead router to clicks on Socket Mode too, as it did over HTTP.

## [0.3.16] - 2026-11-25

### Fixed

- A message with a file (a screenshot, Slack's `file_share`) to the Squad Lead or `govern slack chat` was dropped without a word: the chat took only messages with no subtype. It is now a question; the Lead fetches each file into `slack/lead/files/<ts>/` (`files:read`) and the turn names its path, so Claude reads it, images too. A plain chat is told the files were not passed on. A thread reply also sent to the channel (`thread_broadcast`) is a question too.
- A message from one of the chat's people that it still cannot take is answered "Not taken" with why, instead of nothing. Edits, deletions, joins and the like stay unanswered.

## [0.3.15] - 2026-11-25

### Changed

- The Squad Lead's turn is told in Slack as it runs, so its people are never left without news (LEAD.md, "The turn, told as it runs"). What Claude says between tool uses is posted in the thread as it says it. A status message, kept last in the thread, shows the elapsed time, the last steps, the one running now and for how long, and the plan's progress; a step reads as its own description (a Bash call's `description`), not a cut command. It appears after 10 s (was 20 s), is updated every 10 s (`GOVERN_LEAD_PROGRESS_EVERY_MS`), and ends saying how the turn ended instead of being deleted. The brief now tells the Lead to answer what was asked before resuming other work, and to say what it starts before long work.
- A message sent to the Lead while a turn runs is answered at once, without the model, with what that turn is doing and that `stop` ends it (`slack/lead/activity.json`); the message itself is answered when the turn ends. `govern slack chat` gains the same hook (`busy`).

## [0.3.14] - 2026-11-25

### Added

- The Squad Lead, `govern slack lead` (LEAD.md). Each workspace can have a Lead: a Claude Code session its people drive from a Slack channel of its own (`slack.lead`), with no IDE. One Slack app and one `govern slack serve` serve every Lead. `govern slack lead enable --channel C --user U [--session ID]` writes the config and the `lead` mailbox, and a running serve picks it up on the next event.
  - Serve's `POST /slack/events` (and its Socket Mode connection) hands each Lead channel's messages, deduplicated by `event_id` and checked against `slack.team`, to that workspace's `govern slack lead run` child. Every other event goes on to `slack.cards` as before.
  - Each turn resumes the Lead's Claude session (`claude -p --resume`) in its folder, with the operator's settings, the current permission mode and govern's brief. Turns queue as one govern conversation. A turn is refused while the session is open in another live process (a VS Code tab).
  - A tool use the mode does not allow becomes a card in the Lead channel: allow once, allow for the session, or deny. Serve records the click of one of `slack.lead.users`. No answer within `permissionTimeoutSeconds` is a deny.
  - `mode default|edit|auto|plan` in the channel, or `govern slack lead mode`, sets the next turns' mode; `pare` or `stop` stops the current turn. Everything is audited in `slack/lead/audit.jsonl`.
  - `govern slack notify` points the Lead channel at each alert it posts and at each decision waiting longer than `slack.lead.waitHours` (default 8).

### Fixed

- A serve with `slack.serveRepos` now reads and writes a click's lane in the lane's own workspace. Before, it used its own workspace for these: the card update after a decision, the form a button opens, the form's submission and the answered mark.
- SLACK.md said Slack sends every event to every Socket Mode connection. Only a Tayet sidecar does that; Slack sends each event to one of the app's connections.

## [0.3.13] - 2026-11-25

### Changed

- `slack.cards`: every open case now has its card, posted on the first notify run that sees it, and not only a case that waits on someone or has an alert. A card system needs every open card in view. A finished case that never had a card gets none. With `threads` alone, nothing changes.

## [0.3.12] - 2026-11-25

### Added

- `slack.cards`: the case's card becomes the lane's place in Slack. The card shows who holds the case and its last note; each new lane note is posted in the card's thread; and a reply in the thread from a person of the lane's process becomes a lane note, with its author (`by`) and `via: "slack"`, recorded in the ledger with its Slack source. `govern slack serve` receives the replies at `POST /slack/events` (signed, same secret) or over Socket Mode. A reply from anyone else adds nothing and its author is told privately. Notes gain the optional `by` and `via` fields. The app manifest subscribes to `message.channels` and `message.groups`. This is the first part of cards that can replace an external tracker on a standalone install; creating, assigning and moving cards from Slack come next.

## [0.3.11] - 2026-11-25

There is no 0.3.10 in this repository: 0.3.10 and 0.3.11 were tagged by mistake in pedroanisio/super-tools on
2026-11-24 (0.3.11 there is this release's transport fix on 0.3.9). This release brings that change here.

### Changed

- A Claude Code (or Grok) result, message or stream event with a key govern does not know no longer fails the run. The key is dropped, and its path is reported once on stderr (`govern: ignored an unknown provider field $.x`), never its value. Every key govern reads is still checked as before: a wrong type, a missing required key or a value that is not an object still fails. Claude Code adds run metadata in most releases, and each addition used to stop every Claude turn on every workspace until govern named the key (2.1.x, 2.1.318, 2.1.322 and 2.1.325). On 2026-11-23 a 429 from the API reached the operator as `unknown key "api_error_origin"` instead of the usage limit. Codex events and govern's own conversation events stay closed.
- A usage counter govern does not know is dropped the same way: the counters it knows are still a measurement, so the run's spend is no longer unknown because of an extra counter.
- The Slack app manifest is a file, `slack-app-manifest.yml`, each scope commented, with the scopes squad setup needs (channels:manage, channels:read, pins:write, users:read, files:read). SLACK-TUTORIAL.md links to it.

## [0.3.9] - 2026-11-18

### Added

- Tayet (tayet-agent 0.3.0, Tayet server 0.1.2): `slack.forms` works on Tayet (Send back asks why; an editable option opens its fields), and `slack.transport` `"http"` takes the clicks the sidecar posts with `--slack-actions-url`, signed with its local token (`SLACK_SIGNING_SECRET`). A card carries up to 25 buttons, so a decision with up to 25 choices goes out on one card. The config no longer refuses either setting. `govern doctor` checks, for Tayet over HTTP, that the signing secret is the sidecar's local token.

### Fixed

- A click delivered twice no longer replaces its card with "Refused: already received". The Tayet sidecar redelivers a click whose ack was late; the repeat still decides nothing, and now leaves the card the first delivery decided as it is.
- A signed click sent again with a new signature (a retry after a late ack) is refused as a repeat: govern also remembers a click by its message, person, button and time, as it did for Socket Mode.
- On Tayet, a click that opens a form marks its card as answered: the card closed on that click, so notify posts a new one if the form is never sent.

## [0.3.8] - 2026-11-16

### Added

- `slack.chat.originals`: the chat attaches each image a reply shows a second time, as `<name>.original`, which a server shows as a download of the full file. Tayet's web client shows images only as a preview, with no way to save the original.

### Fixed

- An upload to a Tayet sidecar is no longer reported as failed after it was shared: the sidecar shares the file under a new id, which govern now accepts when it is the completion's only file, and journals. Slack must still name the id it gave the upload. The chat said `⚠️ … not attached: invalid upload completion` under an image it had attached.

## [0.3.7] - 2026-11-16

### Fixed

- `govern slack upload` and the chat's attachments work with a Tayet sidecar: its upload URL asks for the bot token, which is now sent to it (and still never to Slack's `files.slack.com`). The sidecar answered 401 before.
- `govern slack chat` no longer retries a reply the server refuses, at every start and never visibly: a refused part (a Tayet leak filter took `user@host:path` for a Matrix id) is replaced by a notice saying why and naming the conversation, and the question gets ❌. A server that takes nothing (down) still leaves the delivery for the next start.

## [0.3.6] - 2026-11-16

### Added

- `govern slack chat` attaches the local files a reply shows as Markdown images (`![title](path)`, relative to the conversation's folder; not URLs or code): each is uploaded into the reply's thread through `slack.upload` and `slack.inbox`, with `govern slack upload`'s checks, once, and the image becomes a `📎 title` line. A file that cannot be attached is named in the channel with why. At most 10 a reply.

## [0.3.5] - 2026-11-16

### Added

- `slack.chat.brief`: a file whose text opens each new chat conversation, before its first question, so the agent knows where it runs (what it may run, that a message in the channel cannot widen that). Claude runs without settings files or CLAUDE.md, so it otherwise knows none of this. A brief that cannot be read stops the question with ❌.

### Changed

- `govern slack chat` posts the model's Markdown as Slack mrkdwn, which Slack and Tayet render: `**bold**` is `*bold*`, `*italic*` is `_italic_`, `~~struck~~` is `~struck~`, `[text](url)` is `<url|text>`, a heading is a bold line, a list item starts with `•`, a table is a code block, and a code block loses its language tag. Code spans and blocks are left as they are.

## [0.3.4] - 2026-11-16

### Fixed

- A Claude API failure in a conversation turn (an expired login, a refused request) fails the turn with what Claude said, e.g. `Claude API error (authentication_failed): …`, instead of `unknown key "error"`. Claude Code 2.1.325 reports it as an assistant event with `error` and `is_api_error_message`. A result marked as an error carries its text too.
- Claude Code 2.1.325's occasional `wire_ingest_context` on assistant and user events is accepted and not read.
- SKILL.md names `govern slack chat`, and `chatBot` has its doc comment.

## [0.3.3] - 2026-11-16

### Fixed

- Conversation turns on Claude Code 2.1.325 no longer fail with `unknown key "ttft_ms"`: its partial-message events (`stream_event`) add `api_message_id`, `thinking_display` and `ttft_ms`, now accepted and not read. A captured 2.1.325 stream with partial messages joins the transport fixtures.

## [0.3.2] - 2026-11-16

### Added

- `govern slack chat` and `slack.chat` ([SLACK.md](SLACK.md#chat-govern-slack-chat)): the people `slack.chat.users` names talk to an agent in `slack.channel`. Each message of theirs is a turn of a govern conversation run with `slack.chat.profile` or `.adapter`, and the reply is posted where it was asked, without a Publish click. The channel's top-level messages are one conversation and each thread is its own; a full channel conversation moves on to a new one. 👀 while a turn runs, then ✅, or ❌ with the reason. A journal asks each message once and posts replies left unposted after a restart.
- `runSocket` passes `events_api` payloads to an `onEvent` handler, acked at once; its click handler is optional.
- The Web API layer sends `reactions.add` and `reactions.remove`.

## [0.3.1] - 2026-11-16

### Added

- Socket Mode for `govern slack serve` (`slack.transport: "socket"`, `SLACK_APP_TOKEN`). serve opens the connection itself, so a Slack app needs no public interactivity URL and no tunnel. A click carries no signature there: it is recorded with the source `{"kind": "slack-socket", "team", "user", "envelope", "payload"}`, and a repeat of the same click is refused for seven days.
- Tayet support ([TAYET.md](TAYET.md)): `slack.server: "tayet"` and `slack.api` point the slack extension at a Tayet agent's sidecar. Each card has at most three buttons, and a decision with more choices is split across cards. A card closes on its first click, so `notify` posts a new one while the decision still waits on someone, for example a quorum short of a vote or a refused click. The card's text carries the whole message. The config refuses forms and HTTP clicks with Tayet. Response and upload URLs on the sidecar's own address are accepted, and uploads to it are sent as one multipart file field.
- `slack.api` sets the Web API base in the workspace config. `GOVERN_SLACK_API` still overrides it. `govern doctor` probes that address, and checks `SLACK_APP_TOKEN` when Socket Mode is on.

### Changed

- `govern onboard` is a next-next-finish wizard. Entering a step runs its automatic pass (`POST /api/auto`): the server checks the group, applies every action its own probes attached that needs nothing from a person (at most 3 rounds, each action once), and checks again. Only what needs a person is left on the page (a login, an invite, the Slack token field), with Continue, Skip for now, and a Finish summary.

### Fixed

- `govern doctor`'s `govern:version` checks the govern the box runs (`$GOVERN_BIN`, else `govern` on PATH) against `govern.version`, not the copy running the checks; a checkout with a newer version no longer fails a box that runs the right release.
- Findings carry the exact shell command in a separate `command` field; `fix` is the sentence for a person. The setup page's copy button copies only a command, never prose.

## [0.3.0] - 2026-11-15

### Added

- Box checks ([BOX.md](BOX.md)). `govern doctor [--manifest FILE] [--only GROUP,...] [--json]` says whether a host or container can run its lanes, from a box manifest (`~/.config/govern/box.json`, schema 1.x): govern's version and Node, each engine installed and logged in, each workspace's config, processes and profile self-tests, its systemd user units and linger, its Slack token, team, channel membership and listener, and the images and check commands the manifest declares. Every failure names its fix, who applies it (agent or operator) and, where the box can apply it itself, an action. Exit 1 when a probe fails.
- Guided setup page. `govern onboard [--manifest FILE] [--port 5020] [--host H]` serves the doctor's groups as steps on loopback host names, behind a fresh token in the printed address. "Fix it" runs only the action the server's own fresh doctor run attached to a failing finding (start a unit, make a secret file private, enable slack, run the self-tests, save a pasted Slack bot token mode 600); the operator's part is shown with a copy button.

## [0.2.0] - 2026-11-14

### Added

- Standing gate delegation: `delegate`, `delegate --list` and verified revocation retain workspace history. A named gate owner with active authority can `approve --by --note` without repeating the owner's quote; lane state, ledger, status and brief retain the delegation and evidence.
- Replaying past cases ([BUSINESS.md](BUSINESS.md#replaying-past-cases)). `govern replay start <process> [--file F] [--cases 20] [--since ISO] [--lane L]...` runs the most recently finished cases again on a candidate revision, as `replay/<run>/<case>` lanes made from the data each original was opened with. `govern drive` moves them on: agents work, a service's command is never run (its outputs are the original case's; a stage the original never completed is a divergence), and a replay stops at a human task, a pending gate, an event, a sub-case or a writing agent. `govern replay report <run>` compares them with the originals (agreement on the fields the candidate's agents write, divergences, escalations more and less) and exits 0, 65 or 75. Replay lanes are left out of status, inbox, tick, Slack and metrics; only `govern replay` may make a lane under `replay/`.
- Canary revisions ([BUSINESS.md](BUSINESS.md#canary-revisions)). `govern canary start <process> --file F` gives a higher revision a share of the new cases (`--fraction`, by a hash of the lane's name); each case keeps its arm's frozen definition. `govern canary check` reverts at once on a candidate case that harmed its customer or an exception left with no destination, waits (exit 75) for `--min` finished and judged candidate cases, then reverts (65) when the correct rate falls, or exceptions rise, beyond `--tolerance` against the base arm, and otherwise promotes (0): the candidate becomes the process file, the old one is kept. `status` and `stop --quote` too. A change to what agents are told and how stages retry needs no person; a policy change, or wider limits, need `--quote`. Process files named `*.candidate.json` are not read as processes.
- A service may declare `poll: S`: its exit 75 means "not yet", asked again after S seconds without using an attempt or counting toward the breaker. A lane command may use `{data.FIELD}`, the case's field as text (refused when unset or starting with `-`).
- Business outcomes ([BUSINESS.md](BUSINESS.md#business-outcomes)). A process may name two boolean fields in `outcomes: {correct, customerImpact}`; `govern outcome <slug> [--correct yes|no] [--customer-impact yes|no] [--note T]` records a later verdict, which wins. `govern metrics <process> [--since ISO] [--by revision|arm] [--json]` sums a process's cases per revision or canary arm: correct share, customer harm, exceptions and those left with no destination, cases a person touched, p50/p90 time to finish, agent tasks and money moved. A lane keeps the data it was opened with (`intake`). A `drive-failed` entry now names the stage the case was routed to (`routed`); one without it is an exception left with no destination.
- A service stage may declare `money: {field, currency}`: `govern drive` reserves the amount in the case's number field against the lane's money allowance before each attempt, charges it on exit 0, releases it on exit 65 or 75, and charges it as reserved, once, when the outcome is uncertain. A case with no money allowance in its currency covering the lane, or over the ceiling, is not run: it takes `onExhausted` (or waits for the operator) with the allowance's decision owner named. A process may declare `breaker: {failures, window, cooldown?}`: once that many of its service stages' last outcomes failed, its service stages are held (`govern drive` exits 1) until a trial after the cooldown succeeds or a person runs `govern drive --close-breaker <process> --quote Q`; openings and closings are logged to `drive/breakers.jsonl` ([CONNECTORS.md](CONNECTORS.md#money)).
- A service stage may declare `probe` (a lane command, usually the connector itself) and `recoveries` (default 1). When the last attempt ends with its outcome uncertain (interrupted, a transient failure that persisted, another non-zero exit, missing or invalid outputs), `govern drive` runs the probe as a dry run with `GOVERN_PROBE`, a file it writes `{"done": true|false}` to. Either answer gives the stage its attempts again with the same idempotency key, so the connector makes or confirms the effect with no person; a probe that cannot tell leaves the case to `onExhausted` or the operator, as before. Each answer is a `drive-probe` ledger entry. The reference connector writes its dry-run answer to `$GOVERN_PROBE` ([CONNECTORS.md](CONNECTORS.md#recovery)).
- A lane's ledger is a hash chain: every entry carries `h`, the SHA-256 of the previous entry's `h` and its own body, written under a lock. `govern ledger verify [<slug>...] [--against DIR]` finds an entry changed, removed or inserted, naming its line; `govern ledger export --to DIR` appends new entries to `DIR/<lane>.jsonl` on append-only storage and refuses a ledger that no longer begins with what it copied, which catches a cut tail. Ledgers from an older govern keep their plain lines, covered by the first seal.
- `govern drive` can run service stages unattended ([CONNECTORS.md](CONNECTORS.md)). A service command gets `GOVERN_IDEMPOTENCY_KEY` (`<lane>:<stage>:<round>`, the same on every attempt of one entry into the stage), `GOVERN_STAGE`, `GOVERN_ROUND`, `GOVERN_ATTEMPT` and, after an interrupted attempt, `GOVERN_INTERRUPTED=1`. Drive records the run as running before the command starts, so a driver that dies mid-command is seen on the next pass. That attempt is then run again with the same key, unless it was the last one. Exit 75 is transient and retried after `backoffSeconds` (default 30), doubled per transient failure. Exit 65 is permanent and never retried. An agent or service stage may declare `onExhausted: {to, field?}`: when it gives up, the case takes that exception route, with the reason in `field`, instead of waiting for the operator. A task drive sends is recorded at once.
- The connector contract ([CONNECTORS.md](CONNECTORS.md)): probe, execute, confirm and compensate, keyed by the idempotency key, plus a dry run (`GOVERN_DRY_RUN=1`) and the exit codes 0/65/75. Its reference implementation and a sample tickets connector are in [examples/connector](examples/connector), tested against a fake API and end to end under `govern drive`.
- A shadow-mode example for an operations cell ([examples/ops-cell](examples/ops-cell), [CONNECTORS.md](CONNECTORS.md#shadow-mode)): billing commands for a billing-dispute cell (`coletar` and `decisao-humana` read; `ajustar` is a keyed credit-note connector with a void compensation) and `shadow.ts`, which compares the agent's decision with the human team's (`comparar`) and sums the agreement over a process's lanes against a criterion, optionally only on the cases within an approval limit (`relatorio`, exit 0 when met). Tested against a fake billing API and end to end under `govern drive`.

- A capability's `claude` map takes `addDirs` (absolute paths, refused otherwise): a Claude profile holding it runs `claude -p --add-dir …`, and the task prompt names those folders beside the project folder, as Codex `addDirs` already did. A queued Claude session can then work in a repository's branches outside the lane folder.
- `slack.heartbeat` watches an agent session's heartbeat file by mtime: `govern slack notify` posts one keyed `blocked:` when it is older than `staleSeconds` (default 1800) and one `note:` when it moves again, keeping the open alert in `session-heartbeat.json` and rebuilding a damaged one from `sent.jsonl`; a never-written file alerts nothing. `govern slack heartbeat` prints the beat's state and exits 1 unless it is fresh.
- `slack.route.publishers` and `slack.route.review` offer each routed reply whose content check passed to the publishers in a review channel, in full, with Publish to thread. A publisher's signed click records an approval bound to the text's digest. `govern slack listen` then checks the reply again and posts it once, keyed, in the request's thread, escaped so it cannot mention or link. Unverified, unchecked and BLOCKED replies are never offered.
- `slack.forms` turns two Slack buttons into forms. Send back asks for a reason, which becomes the rejection's quote. A gate option naming `edit` fields gets an Edit button that opens those fields prefilled; submitting approves the edited draft, and the ledger lists the `edited` fields. The click is checked and records nothing, and the signed form submission is what decides. `serve` then needs the bot token to open forms.
- Slack alerts carry buttons. A timer alert has Acknowledge, Snooze 1h and, while its stage's task is unclaimed, Take it; a stage `govern drive` gave up on has Retry stage, which clears the failed run so the next drive sends it again. Each click is checked like a decision and recorded as the person's (`alert-ack`, `alert-snooze`, `human-claim`, `drive-retry`) with the signed request. The message closes with who did what, also when the alert is acknowledged at the terminal or the failure clears; a snoozed alert is posted once more when the hour ends.
- `slack.threads` gives each case one card in the Slack channel, updated in place with its stage and what it waits on from whom. The case's decision messages and alerts are posted in the card's thread instead of the channel itself.
- The `watch` config names systemd units: `govern desk` shows their state and time since last success, `govern slack digest` lists failing ones, and `govern slack notify` alerts once per failure episode. A missing unit or a host without systemd is reported plainly.
- `govern slack install-service` writes user units for independent listen and notify loops plus a persistent daily digest timer, without starting them or copying credentials.

- Slack clicks report recorded decisions immediately through a validated response URL; refusals explain why to the clicker, and callback failures leave decisions intact for notify reconciliation.

- `govern slack upload` constrains resolved media paths to configured roots and a byte limit, uploads through the external upload API, resolves thread parents and journals file receipts with durable send keys.

- Configured Slack requester requests, briefs and non-command mentions route once per timestamp through sealed read-only queue profiles, with quoted untrusted input, mandatory file-reference checks and owner-only replies with explicit verification status. Hourly overflow remains in the durable inbox, alerts independently and drains on later runs. Automatic `seen:` receipts name the queued task.
- `govern slack notify` independently detects stale listener heartbeat, unanswered requester requests and route limits, posts each condition once, and clears it when resolved. `govern slack digest` sends waiting people, failed tasks and open alerts once per local day, with no post for an empty summary.

- `govern slack listen` records channel posts and edits in a private poller-compatible inbox, follows at most twenty changed threads per run, and writes a successful-run heartbeat. Configured requesters can ask fixed `status`, `pending`, `lane <slug>` and `help` commands in Slack.
- `govern slack post` sends kind-prefixed text or a file's text, resolves parent threads, journals sends and refuses already-sent keys. Slack API errors redact credentials and HTTP 429 retries are bounded. `slack.botTokenVar` overrides the token variable for both posting and notification; typed channel, identity, requester, tag, inbox, route, alert and upload settings reject unknown fields.

### Fixed

- A unit written by `govern task install-service` or `govern slack install` runs `$GOVERN_BIN` when that is an absolute path. Before, it always ran the writing copy's own `bin/govern`, which for an installed release is a versioned folder (`/opt/govern/releases/govern-X`) that is removed when the release is pruned.
- An item case of a `foreach` stage gets the task of its agent stage. Its lane is `<parent>/__items/…`, and the queue refused that project slug because of the `_`. So `govern drive` stopped with a usage error at the first agent stage of any item case. A replayed nested lane (`replay/<run>/a__b`) had the same problem. The queue now accepts `_` in a project slug.
- A policy gate that needs more than one approval keeps its buttons in Slack after the first vote. The clicked message shows progress (`1/2 approvals: @ana`) above the buttons, and the buttons go only once the gate is decided or the case changes. Before, the first click removed them for every other approver and `notify` never posted them again, because a vote does not change the case digest.
- A decided Slack message keeps what it asked. The click and `notify` both remove only the buttons and add one line saying who decided (`Done by @ana`, `Approved by @ana, @gil`, `Sent back by @gil`). Before, both replaced the whole message with one line of text. Messages posted before this change still close as text, since their blocks were not recorded.

- The live-session marker on `govern desk`, the lane state and the remote view no longer stays on a lane its session has left. A segment ends when its session opens one in another lane, and a lane reaching `done` or finishing closes its open segments. This is derived from the ledgers, so `govern usage` attribution does not change.
- A message follows a session through a rename. `send` stamps the Claude Code session ids behind `from` and `to` (`fromSession`, `toSession`), a reply inherits its parent's sender, and the inbox, its hook and the desk's YOUR INBOX match on the id; a new session that takes an old name does not get its mail. `--to` accepts a live session's former name, expiry spares it, and the desk counts open messages no inbox will show as UNDELIVERED. YOUR INBOX also lists the calling session's own mail.
- `govern slack upload` POSTs raw bytes as Slack documents; it used PUT. A redirect is reported by its status instead of aborting as a network failure, the transfer limit grows with the file, and network failures name their cause (`network failure (ECONNRESET)`) without any URL. A failed transfer frees its key, since nothing is shared before `files.completeUploadExternal`; `govern slack resolve` settles a send whose completion outcome is unknown, without posting.
- Lane discovery no longer takes a ledger or `govern.json` inside `_tmp`, `node_modules` or a checkout at any depth. `laneSlugs` missed a nested `.git`, and the session-lane index, `govern usage` and the hooks' open-segment search walked the lanes folder with no exclusion at all, so a fixture left by a test run in a clone kept under a lane reached `<state>/session-lanes.json`. A recorded session lane whose folder is gone is ignored and dropped on the next write.
- Every test file runs in a sandbox: importing `test/helpers.ts` drops inherited `GOVERN_*`, gives the process a temp workspace, HOME and working directory, and sets `GOVERN_CEILING` so a search for a workspace cannot leave the temp folder.
- First activation of Slack routing or alerts captures a durable start line before polling. Migrated inbox posts no longer trigger routed tasks, `seen:` replies or unanswered alerts; the boundary survives restarts and never advances automatically.

### Changed

- `govern drive` runs a service stage's command as a background job (`govern run --bg`): a long command (tests, builds) no longer holds the other lanes' stages. A pass waits up to `GOVERN_DRIVE_SERVICE_WAIT` seconds (default 5), so a quick command still finishes its stage in the same pass; a later pass consumes the outputs, records the job's end and seconds in the ledger, and stops a job past its command's timeout, retrying the stage.
- `govern drive` counts an exception route out of a stage (an `onError.to`, a timer escalation or an `onExhausted` route) as leaving it, as it already counted an advance. A stage the case comes back to gets a fresh task and key, and drive no longer waits on the reply to a task sent before the reroute.

- An imported lane's quarantine listing (`govern brief`, `govern import`) shows each `{paths.NAME}` its commands use as this workspace resolves it, or `(not in govern.config.json)`, so the owner reviews the paths an accepted import would run, not only the argv.
- Exit 2 now means a usage error only: an unknown command, subcommand or flag, a missing argument, a malformed or contradictory flag value. A refusal by the workspace's state (no such lane, a gate, check or dependency holding, a bad govern.json, process file or config, a disabled extension, a limit) exits 4, the lowest code govern did not already use (1 a failed check, 3 a failed Codex reply). A script that branched on 2 for state refusals must test 4.
- `govern hook stop` refuses a stop with Claude Code's JSON form, `{"decision":"block","reason":…}` on stdout and exit 0, instead of exit 2 with the reason on stderr; the refusal, its ledger entry and its limit of 3 per segment are unchanged.
- Peer, mesh, agents, center, remote, decide, conversation and the business event and lifecycle commands (`event`, `event-listen`, `tick`, `alerts`, `subprocess`, `recover`, `human`, `human-inbox`, `data`, `reject`) are extensions: they load only where the workspace enables them, and a command of a disabled one is refused (exit 4) with `govern ext enable <name>`. `govern help` lists the core commands and one `extensions:` line; `govern help <command>` of an enabled extension adds the extension's own manpage text; `govern help --topics` lists an extension's documents only while it is enabled; `govern manual --size` prints a third line for them. A workspace enables none by default, so a workspace that used any of them must enable them (`govern ext enable <name>`, or `GOVERN_EXTENSIONS`).
- `govern desk` and `govern status` never load a disabled extension. `task send`, `task forward` and `task retry` refuse a `NAME@PEER` recipient while peer is off, `task dispatch --loop` relays to peers and renews the mesh only while it is on, and the shadow ask of `decide.shadow` needs the decide extension.
- `task send`, `task forward` and `task retry` are asynchronous (they load the peer extension for a `NAME@PEER` recipient): their failures reach the caller as rejections, not synchronous throws.

- A Claude run that exits nonzero is a failed run even when it printed a result.
- `govern install-skill` now links `<skills dir>/govern` to the tracked `tools/govern` folder instead of copying SKILL.md (the owner's rule: skills are tracked beside their tool and `.claude/skills` entries are symlinks); a real directory or file is refused unless `--replace`, and `--check` names what it found. The temp-file copy and its read-back are gone.
- `SKILL.md` is now the core manual (at most 9,000 bytes, about 2,000 tokens); the detailed operating rules moved to the new [REFERENCE.md](REFERENCE.md) and into each command's `govern help <command>` text.
- `govern help <command>` prints the command's rules after its usage lines.
- Work segments record `referenceSha` (sha256 of REFERENCE.md) beside `skillSha` (sha256 of SKILL.md).
- The desk's tuning line shows `manual ≈ N tokens`.
- A runner now runs one message at a time across all dispatchers unless the queue's `concurrency` says otherwise.
- No profile runs unchecked: the six built-in profiles lose their exemption, and the dispatcher runs `caps --check` itself, once per profile hash, for a message whose profile has no passing check of its current definition. A failed check holds the message and sends the sender one BLOCKED notice. `selfTest: "optional"` is kept, with one meaning: a capability with no probe does not fail the check.
- Codex runs with a private `CODEX_HOME` (`GOVERN_CODEX_HOME`, default `<state>/codex-home`) holding a link to the login and a minimal `config.toml`, instead of inheriting `~/.codex`.
- `govern caps` shows `not run`, `stale (profile changed)` and `failed` as distinct check states; `govern caps --check --all` checks every profile without a current passing check.
- `task send` refuses a message that asks for file changes when its profile cannot write (exit 4); `--read-only` overrides it and records `readOnlyConfirmed`.
- `task show` and `desk` print `bound: N turns · T s` for a running or recorded Grok run.

### Added

- `govern drive` (business extension, [BUSINESS.md](BUSINESS.md#agent-and-service-stages)): stages declare an `agent` (a queued task whose reply body is the JSON of the stage's typed `outputs`) or a `service` (a lane command writing its outputs to `$GOVERN_OUTPUTS`); drive sends, waits, applies the outputs, runs the stage's check and advances, retrying up to `attempts` and then leaving the stage to the operator. Stages with nothing to do but their gates and routes are advanced once the gates are approved. A stage held by a gate waits for it and cannot declare outputs.
- `govern event-listen` takes `POST /cases`: a webhook opens a case with its process, slug, title and data; the same delivery again is a duplicate.
- `govern slack notify` posts to `slack.channel` the human tasks, decidable gates, open alerts and stages drive left to the operator, once each, and updates messages after the decision or a change of the case. Gate `options` are approvals that also set case fields (one button each); `govern.decide.<suffix>` action ids are accepted.
- The `slack` extension (`govern ext enable slack`, [SLACK.md](SLACK.md)): `govern slack serve` takes Slack's interactivity requests on loopback, checks the request signature, clock, replays, team and the person mapped by the new `people.<id>.slack`, and records a button's decision (a policy vote, an owner's approval, a human task completed) as that person's, with the new decision source `{"kind": "slack", …}`. A button carries a digest of the case data and loop counters, so a decision on a changed case is refused. The workspace config gains `slack: {team, envFile?}`.
- Brand images in `brand/`: seven scene-render scenes (logo, favicon, wordmark, hero, social card, press banner, process-stages figure), `brand/render.sh` that validates and renders them to `site/static/brand/`, and `brand/BRAND.md`.
- A validated press-release PDF renderer with optional banner and logo images, page numbers, and parser and output tests.
- The govern announcement and press page with PDF and brand-asset links.
- Website: comparison page with alternatives, researched 2026-10-16.
- `site/`: a static site generator for the govern website (`node --disable-warning=ExperimentalWarning tools/govern/site/build.ts`), with a theme, a three-stage Dockerfile, a compose file and an nginx config. It checks frontmatter, a Markdown subset and every internal link before it writes `dist/`.
- Website content covering govern's purpose, concepts, roadmap, setup, lanes, queue, full command reference, peers, remote devices, business processes and architecture.
- `govern ext list|enable|disable`, `extensions` in `.govern/config.json` and `govern.config.json` (an unknown name or a duplicate is refused, naming the file and the JSON path) and `GOVERN_EXTENSIONS` (comma-separated, replaces the file's list). `ext enable` and `ext disable` write `.govern/config.json` and are refused in a `govern.config.json` workspace, which is the owner's file.
- The desk shows a `PEERS` line (peer extension, when there are peers) and a `REMOTE` line (remote extension, when devices are paired).
- [ext/](ext/README.md): one folder per extension with its `index.ts`, its manpage text and a README; `lib/ext-registry.ts`, `lib/ext.ts` and `lib/cli.ts` are the core's side of it.
- `govern help --topics` lists the reference documents with their paths.
- `govern manual --full` prints the core manual followed by REFERENCE.md; `govern manual --size` prints the bytes and approximate tokens (bytes / 3.6) of both.
- A run that exits 0 with a reply that does not parse gets one repair call (same engine and profile, `read` only, cheapest model, 120 s) before it fails; the task, the ledger and `task show` record it, `task list` shows `[repaired]`, and a failed repair keeps `.reply.txt` and `.repair.txt`. `GOVERN_QUEUE_REPAIR=0` turns it off.
- `govern task send --check NAME` (repeatable) adds a content check to the reply, resolved from the profile's capabilities file `checks`, the queue config's `checks.named`, then the built-ins; an unknown NAME is refused.
- Built-in checks `commit-refs` (applied to every HANDOFF), `claims-cited` and `verify-cmd` (`task send --verify -- ARGV…`: govern runs the command and the reply is `[checked]` only on exit 0).
- `govern desk` QUEUE line shows `replies today: N checked · N shape only · N unverified · N repaired`; the checks asked of open tasks are listed.
- `govern task triage [--all] [--project P] [--to X] [--json]` lists failed messages with the cause, tokens, cost and the kept reply; the desk's `failed: N` points to it.
- `govern task retry <id> --note "<what was fixed>"` files a new open message from a failed or closed one, threaded and noted on both; a third retry of one original is refused.
- `govern task dispatch --parallel N` (and `install-service --parallel N`) runs up to N messages at once in one dispatcher.
- Queue `config.json` takes `concurrency` (the most runs per runner or profile across all dispatchers, default 1 per runner) and `maxTimeoutSec` (default 7200); the desk shows `running N/limit` per runner.
- `govern task send --timeout S` sets one run's limit instead of `GOVERN_QUEUE_TIMEOUT_SEC`; `task show` prints it and the holderless-claim bound follows it.
- `govern status`, `govern desk` and `govern brief` warn `⚠ stage may be behind` for a lane with 20 or more jobs, notes and asks since its last advance and none in 24 h.
- A session's tokens are attributed to its lane by where it works (a segment, `GOVERN_LANE`, the lane's folder, a queue run's project), not by a `govern work` it remembered; `govern usage` shows them as an `unsegmented · by cwd` row in the lane's TOTAL.
- `govern hook session-start` opens a work segment for a session working in a lane's folder or started with `GOVERN_LANE`; `govern hook session-end` (the SessionEnd hook) closes it when the session ends, and `hook stop` closes nothing, since Stop fires after every response; `govern install-skill` prints the three hook lines to add.
- The desk's TOKENS TODAY includes chat sessions attributed to lanes, and a new UNATTRIBUTED section lists sessions that map to no lane and lanes with work recorded and no session; `govern usage` with no slug ends with the same section.

### Fixed

- `task send` writes a new message through a temporary file renamed into place, so a parallel dispatcher never reads a half-written message (it crashed on `JSON.parse` of an empty file).
- A finished lane prints `finished` in `govern status` and `govern desk`, never `finished  active <stage>`.
- The negative probe of a self-test asks for a capability the profile really lacks: a profile holding `wt-edit` no longer fails with `not-edit leaked`; with none to ask for the record says `negative: none applicable`.
- Claude runs and chats accept the output of Claude Code 2.1.219 and 2.1.312: the transport decoder names their new run, usage, message and tool-call metadata as opaque fields instead of failing every turn with `unknown key "terminal_reason"` (or `"timestamp"`).

## [0.1.2] - 2026-10-31

### Fixed

- Slack service units write an unquoted absolute `WorkingDirectory` with literal `%` escaped as `%%`. Slack and task units share path validation that refuses line breaks, NUL and relative paths with a typed error; command and environment values remain quoted.

## [0.1.1] - 2026-10-31

### Fixed

- Slack API calls use an explicit method encoding table: scalar reads and upload URL requests are form encoded, structured messages and upload completion remain JSON, and unknown methods fail before sending.

## [0.1.0] - 2026-10-15

### Added

- First tagged release: lanes follow process stages with exit checks and human approval gates.
- Durable conversations with serialized turns, streamed progress, cancellation and explicit restart recovery.
- A task queue and dispatcher that run fresh headless sessions and verify replies before delivery.
- Capability profiles that constrain the tools and permissions available to agent runs.
- Signed govern-peer/2 delivery, mesh federation, agent registration and discovery across hosts.
- A command center showing federated hosts, queues, dispatchers, agents, runs, spend and alerts.
- `govern bpmn` renders a process or lane as SVG, scene or PNG; the command center shows live Projects and Processes views.
- `govern version` and a reproducible release package built and published by GitHub CI.
