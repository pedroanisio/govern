---
title: Roadmap
description: Documented unreleased work, current iteration support and remaining gaps.
nav: 5
---

This page separates unreleased changes from current capabilities, historical gap assessments and extension work in progress. The source documents define the status; these items carry no delivery promise.

## Unreleased

**Unreleased — `CHANGELOG.md`, `[Unreleased]`.** These changes are on the branch baseline but are not in a release:

- Nonzero Claude exits fail even when a result was printed. Malformed successful replies get one bounded repair, with original and repair evidence retained on failure.
- `govern install-skill` links to the tracked tool folder. The compact core manual, full reference, command rules, topic list and size report separate short instructions from detailed rules. Work segments record both manual hashes, and the desk shows manual size.
- Queue concurrency limits apply across dispatchers. Profiles require current self-tests, including the built-in profiles. Private `CODEX_HOME` isolates login and minimal configuration. Capability displays distinguish missing, stale and failed tests, and the negative probe asks for an actually absent capability.
- Tasks asking for edits are refused by read profiles unless explicitly confirmed read-only. Grok runs show their turn and timeout bounds.
- Named reply checks, commit checks and command verification make verification visible. The desk counts checked, shape-only, unverified and repaired replies.
- `govern task triage` exposes failures. `govern task retry` records an explicit retry, bounded to two per original. Parallel dispatch and per-message timeouts are configurable.
- Stage drift warnings show when recorded work may be ahead of the stage. Finished lanes show as finished.
- Token attribution uses segments, recorded lane, working directory and queue project. Session hooks open and close measured segments. Usage and desk show unattributed sessions and lanes with recorded work but no session.

## Iteration support

**Gap — `ITERATION.md`, limits of current iteration support.** The document describes implemented capabilities and their limits, rather than a future schedule:

- Bounded repeat routes replay one stage or a scoped body. The first execution counts toward the limit. Repeats clear decisions inside the body and increment generations; uncertain checks and unfinished children block repetition.
- Conditional parallel branches select all matches once and persist the selection. The join waits for selected predecessors. Branches currently route directly to their join; multi-step branches can use subprocesses.
- Flat typed collections can create one child case per item. Required item limits and concurrency bounds constrain unfinished cases. Inputs freeze, children share a pinned definition, and outputs preserve input order. Nested arrays and object items are absent.

These definitions use `govern advance`, `govern data`, `govern subprocess` and `govern tick --advance`. They do not imply a background scheduler.

## Integration gaps

**Gap — `OPENCLAW-GAP.md`.** This is an unmaintained research snapshot. Its priorities describe integration work, not verified interoperability:

- A typed tools/API adapter would expose case operations with idempotency and revision checks. Done means repeated requests do not duplicate effects and premature advancement still fails.
- External human identity mapping would bind votes to actor, message and reviewed state. Done means distinct people retain distinct votes, quorum, exclusions and expiry, and generated messages cannot vote.
- A durable event and notification outbox would retain attempts, receipts and replay. Done means outages recover without duplicate decisions; delivery acknowledgment never approves work.
- A stage-to-agent adapter would persist the case generation, attempt and runtime mapping. Done means restarts retain attribution and do not repeat uncertain external actions.
- A combined audit view would connect cases, evidence, decisions, runs and cost. Done means the operator can explain a blocked case and trace its decision and resulting work.

The snapshot also identifies flat data, constrained inclusive branches, bounded loops, absent BPMN/DMN import and visual design, and absent distributed tenant isolation. OpenClaw integration would not itself resolve those limits.

## Native assistant gaps

**Gap — `OPENCLAW-PARITY.md`, “Top five additions”.** This is also an unmaintained snapshot:

- An authenticated Gateway and one messaging channel would separate read, work and decision authority. Done means a person can create and inspect a case in chat, replay is harmless and only an authenticated eligible person can approve.
- Govern-owned conversation sessions were a gap in that snapshot. `CONVERSATIONS.md` now documents durable history, serial turns, progress, cancellation and explicit recovery. This part has shipped; it is not a missing native feature.
- Memory with provenance would add bounded, access-aware retrieval and correction/deletion. Done means recall cites evidence, private memory stays private and old approvals cannot authorize new work.
- A typed tool and extension runtime would give tools common schemas, permissions, bounds and receipts across engines. Done means two adapters run the same declared tool, block unauthorized effects and retain uncertain writes.
- Recurring automations and reliable notifications would persist schedules, overlap limits and outbound delivery. Done means restarts retain schedules, duplicate wakes do not duplicate tasks, and outages leave visible pending delivery.

The snapshots' remote-approval and mobile gaps must also be read against the shipped API and signed device approvals in `REMOTE.md`. Neither snapshot establishes current feature parity or production compatibility.

## Extensions

**In progress — lane task brief, `task.md`.** Peer, mesh, agents, center, remote, decide, conversation and business commands are being moved toward extensions that a workspace enables. That parallel work is not merged into this branch baseline. The current [command reference](/docs/commands/) describes the baseline commands; it does not claim extension enablement is available.
