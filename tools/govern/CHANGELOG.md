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

### Added

- `govern help --topics` lists the reference documents with their paths.
- `govern manual --full` prints the core manual followed by REFERENCE.md; `govern manual --size` prints the bytes and approximate tokens (bytes / 3.6) of both.
- A run that exits 0 with a reply that does not parse gets one repair call (same engine and profile, `read` only, cheapest model, 120 s) before it fails; the task, the ledger and `task show` record it, `task list` shows `[repaired]`, and a failed repair keeps `.reply.txt` and `.repair.txt`. `GOVERN_QUEUE_REPAIR=0` turns it off.
- `govern task send --check NAME` (repeatable) adds a content check to the reply, resolved from the profile's capabilities file `checks`, the queue config's `checks.named`, then the built-ins; an unknown NAME is refused.
- Built-in checks `commit-refs` (applied to every HANDOFF), `claims-cited` and `verify-cmd` (`task send --verify -- ARGV…`: govern runs the command and the reply is `[checked]` only on exit 0).
- `govern desk` QUEUE line shows `replies today: N checked · N shape only · N unverified · N repaired`; the checks asked of open tasks are listed.

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
