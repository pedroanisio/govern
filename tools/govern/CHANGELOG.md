---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

### Changed

- `govern install-skill` now links `<skills dir>/govern` to the tracked `tools/govern` folder instead of copying SKILL.md (the owner's rule: skills are tracked beside their tool and `.claude/skills` entries are symlinks); a real directory or file is refused unless `--replace`, and `--check` names what it found. The temp-file copy and its read-back are gone.
- `SKILL.md` is now the core manual (at most 9,000 bytes, about 2,000 tokens); the detailed operating rules moved to the new [REFERENCE.md](REFERENCE.md) and into each command's `govern help <command>` text.
- `govern help <command>` prints the command's rules after its usage lines.
- Work segments record `referenceSha` (sha256 of REFERENCE.md) beside `skillSha` (sha256 of SKILL.md).
- The desk's tuning line shows `manual ≈ N tokens`.

### Added

- `govern help --topics` lists the reference documents with their paths.
- `govern manual --full` prints the core manual followed by REFERENCE.md; `govern manual --size` prints the bytes and approximate tokens (bytes / 3.6) of both.

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
