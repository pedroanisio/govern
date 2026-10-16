---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

### Changed

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
- `task send` refuses a message that asks for file changes when its profile cannot write (exit 2); `--read-only` overrides it and records `readOnlyConfirmed`.
- `task show` and `desk` print `bound: N turns · T s` for a running or recorded Grok run.

### Added

- Brand images in `brand/`: seven scene-render scenes (logo, favicon, wordmark, hero, social card, press banner, process-stages figure), `brand/render.sh` that validates and renders them to `site/static/brand/`, and `brand/BRAND.md`.
- A validated press-release PDF renderer with optional banner and logo images, page numbers, and parser and output tests.
- The govern announcement and press page with PDF and brand-asset links.

- Website: comparison page with alternatives, researched 2026-10-16.
- `site/`: a static site generator for the govern website (`node --disable-warning=ExperimentalWarning tools/govern/site/build.ts`), with a theme, a three-stage Dockerfile, a compose file and an nginx config. It checks frontmatter, a Markdown subset and every internal link before it writes `dist/`.
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

- A finished lane prints `finished` in `govern status` and `govern desk`, never `finished  active <stage>`.
- The negative probe of a self-test asks for a capability the profile really lacks: a profile holding `wt-edit` no longer fails with `not-edit leaked`; with none to ask for the record says `negative: none applicable`.

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
