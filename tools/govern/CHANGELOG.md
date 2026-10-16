---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

### Changed

- No profile runs unchecked: the six built-in profiles lose their exemption, and the dispatcher runs `caps --check` itself, once per profile hash, for a message whose profile has no passing check of its current definition. A failed check holds the message and sends the sender one BLOCKED notice. `selfTest: "optional"` is kept, with one meaning: a capability with no probe does not fail the check.
- Codex runs with a private `CODEX_HOME` (`GOVERN_CODEX_HOME`, default `<state>/codex-home`) holding a link to the login and a minimal `config.toml`, instead of inheriting `~/.codex`.
- `govern caps` shows `not run`, `stale (profile changed)` and `failed` as distinct check states; `govern caps --check --all` checks every profile without a current passing check.
- `task send` refuses a message that asks for file changes when its profile cannot write (exit 2); `--read-only` overrides it and records `readOnlyConfirmed`.
- `task show` and `desk` print `bound: N turns · T s` for a running or recorded Grok run.

### Fixed

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
