---
generated_by: "GPT-6 via Codex"
date: "2026-10-15"
---

# Changelog

All notable changes to govern are documented here, following Keep a Changelog.

## [Unreleased]

### Added

- A session's tokens are attributed to its lane by where it works (a segment, `GOVERN_LANE`, the lane's folder, a queue run's project), not by a `govern work` it remembered; `govern usage` shows them as an `unsegmented · by cwd` row in the lane's TOTAL.
- `govern hook session-start` opens a work segment for a session working in a lane's folder or started with `GOVERN_LANE`; `govern hook stop` closes it when it lets the session stop; `govern install-skill` prints the hook line to add.
- The desk's TOKENS TODAY includes chat sessions attributed to lanes, and a new UNATTRIBUTED section lists sessions that map to no lane and lanes with work recorded and no session; `govern usage` with no slug ends with the same section.

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
