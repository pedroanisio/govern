---
title: Architecture
description: How the CLI, file state and execution subsystems fit together.
section: docs
---

This page explains govern's subsystems, CLI layer, file layout and verification gates, following `ARCHITECTURE.md`. State stays in files; code waits and relays; models supply judgment; human words open gates.

## Actors and runtime

The owner, paired phones, working sessions, headless queue runners, external event senders and peer hosts use the same workspace state. Most invocations load files, act, append ledger entries and exit. There is no central daemon holding authoritative memory.

Four HTTP servers provide thin front doors: remote devices, external events, peers and the loopback command center. Dispatch and timer loops, background conversation workers and blocking job waits are other long-lived processes. They reread files rather than keeping separate authoritative counters or business state.

## CLI layer

`bin/govern` launches `govern.ts` under Node type stripping. Its command table declares usage, flags and handlers. Unknown flags, malformed switches and missing values exit 2 with valid flags. A lane-changing command takes the lane lock and appends to its ledger.

The `MANPAGE` block in `bin/govern` defines public command syntax. `govern manual`, `govern manual --full` and `govern help COMMAND` provide the operating rules. `lib/shape.ts` parses every JSON file into a closed typed shape and reports the first bad field by its JSON path.

## Subsystems

| Group | Responsibility |
|---|---|
| Workspace and processes | Find explicit workspace state, load built-ins and overrides, parse typed JSON |
| Lanes | State, briefs, work segments, dependencies, locks and advancement |
| Business graph | Typed cases, routes, joins, human tasks, policies, loops and per-item children |
| Lifecycle | Deadlines, events, retries, compensation, subprocesses and process snapshots |
| Jobs | Detached execution, timeout, wait, logs and stopping process trees |
| Resources and budgets | Resource locks, recipe jobs, tagged machines, reaping and spending reservations |
| Verified model steps | Schema and rule checks, one repair, failure exit and call hashes for `govern ask` |
| Task queue | Durable messages, sealed dispatch, reply checks, peers, discovery and telemetry |
| Capabilities | Grants, profiles, engine mappings, verified probes and private execution homes |
| Conversations | Durable serial turns, streamed progress, cancellation, recovery and context checkpoints |
| Owner gates | Verified human sources for approvals, rejection, allowances and human tasks |
| Owner surfaces and measurement | Desk, remote views, artifacts, usage, tuning and shadow decision reports |

`lib/util.ts` supplies argument parsing, typed errors and JSONL helpers shared across groups.

## File layout

A convention-based workspace uses this layout:

```text
.govern/
  config.json
  processes/*.json
  capabilities/
  projects/<slug>/
    govern.json
    govern/ledger.jsonl
    govern/jobs/<id>/
    govern/ask/
    artifacts/
  queue/
    open/
    claimed/
    done/
    failed/
    ledger.jsonl
  state/
```

Configuration can move folders and environment overrides win. State includes conversations, lane locks, resource locks, remote records and peer records. Append-only JSONL ledgers feed desk, phone and usage reports. Jobs retain command records, logs, exit status and settlement markers.

## Boundaries that protect decisions

Servers authenticate and parse requests before calling existing functions. Phone actions and events use lane transactions; peer delivery uses queue filing under the peer lock. A phone cannot advance a lane or run arbitrary commands. Peer senders cannot choose local execution policy. Remote and peer transport use different trust protocols.

Model output must parse and pass declared checks. `govern ask` has schema and house-rule checks, one repair and exit 3 on unverified output. Queue checks run before delivery; failed verification is visible. Conversation progress remains provisional until terminal validation succeeds. A conversation reply never supplies business approval.

Approval verification checks source words, not just a supplied string. This protects against mistaken agent approvals, but writable state and transcript files are not tamper-proof. Real role separation still depends on local access controls.

## Cost and execution

Briefs replace repeated history reads. Jobs run detached, with `govern wait` blocking in code. Verified one-shot model steps limit review cascades. Queue dispatch replaces model-driven message relaying. `govern usage` measures use per lane and segment. `govern tune` adjusts compaction from measured recent use without calling a model.

Resource locks constrain concurrency. Covered jobs and tasks reserve allowances before execution and settle known use afterward. Unknown spend is charged as reserved. The [queue guide](/docs/queue/) describes timeout, repair and explicit retry bounds.

## Test suite and gates

The repository's verification gate is:

```sh
npm run -s typecheck --prefix tools/govern
npm test --prefix tools/govern
```

The tests cover CLI and validation behavior as well as business routes, lifecycle recovery, events, timers, subprocesses, capabilities and conversation outcomes. The lifecycle documentation calls out authentication, delivery, DST and holidays, deduplication, durable retries, compensation failures, child completion, frozen definitions and refused migrations.

`npm run coverage` from `tools/govern` reports V8 line and branch coverage across child Node processes. It has no coverage threshold of its own and exits nonzero when the suite fails. Runtime stage gates are separate: a passing suite does not approve a human decision or bypass a lane dependency.
