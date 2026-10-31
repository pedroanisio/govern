---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

### Added

- `govern slack install-service` writes user units for independent listen and notify loops plus a persistent daily digest timer, without starting them or copying credentials.

- Slack clicks report recorded decisions immediately through a validated response URL; refusals explain why to the clicker, and callback failures leave decisions intact for notify reconciliation.

- `govern slack upload` constrains resolved media paths to configured roots and a byte limit, uploads through the external upload API, resolves thread parents and journals file receipts with durable send keys.

- Configured Slack requester requests, briefs and non-command mentions route once per timestamp through sealed read-only queue profiles, with quoted untrusted input, mandatory file-reference checks and owner-only replies with explicit verification status. Hourly overflow remains in the durable inbox, alerts independently and drains on later runs. Automatic `seen:` receipts name the queued task.
- `govern slack notify` independently detects stale listener heartbeat, unanswered requester requests and route limits, posts each condition once, and clears it when resolved. `govern slack digest` sends waiting people, failed tasks and open alerts once per local day, with no post for an empty summary.

- `govern slack listen` records channel posts and edits in a private poller-compatible inbox, follows at most twenty changed threads per run, and writes a successful-run heartbeat. Configured requesters can ask fixed `status`, `pending`, `lane <slug>` and `help` commands in Slack.
- `govern slack post` sends kind-prefixed text or a file's text, resolves parent threads, journals sends and refuses already-sent keys. Slack API errors redact credentials and HTTP 429 retries are bounded. `slack.botTokenVar` overrides the token variable for both posting and notification; typed channel, identity, requester, tag, inbox, route, alert and upload settings reject unknown fields.

### Fixed

- First activation of Slack routing or alerts captures a durable start line before polling. Migrated inbox posts no longer trigger routed tasks, `seen:` replies or unanswered alerts; the boundary survives restarts and never advances automatically.

### Changed

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
