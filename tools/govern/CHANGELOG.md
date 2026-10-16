---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

### Added

- `govern task triage [--all] [--project P] [--to X] [--json]` lists failed messages with the cause, tokens, cost and the kept reply; the desk's `failed: N` points to it.
- `govern task retry <id> --note "<what was fixed>"` files a new open message from a failed or closed one, threaded and noted on both; a third retry of one original is refused.
- `govern task dispatch --parallel N` (and `install-service --parallel N`) runs up to N messages at once in one dispatcher.
- Queue `config.json` takes `concurrency` (the most runs per runner or profile across all dispatchers, default 1 per runner) and `maxTimeoutSec` (default 7200); the desk shows `running N/limit` per runner.
- `govern task send --timeout S` sets one run's limit instead of `GOVERN_QUEUE_TIMEOUT_SEC`; `task show` prints it and the holderless-claim bound follows it.
- `govern status`, `govern desk` and `govern brief` warn `⚠ stage may be behind` for a lane with 20 or more jobs, notes and asks since its last advance and none in 24 h.

### Changed

- A runner now runs one message at a time across all dispatchers unless the queue's `concurrency` says otherwise.

### Fixed

- A finished lane prints `finished` in `govern status` and `govern desk`, never `finished  active <stage>`.

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
