---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# business extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Commands: `govern event`, `event-listen`, `tick`, `alerts`, `subprocess`, `recover`, `human`, `human-inbox`, `data`, `reject`.
Documents: [BUSINESS.md](../../BUSINESS.md) and [LIFECYCLE.md](../../LIFECYCLE.md).

They are the commands for typed business processes and their lifecycle: events, timers, alerts, subprocesses, recovery, case
data, human tasks and policy rejections. Enable them with `govern ext enable business`.

- [index.ts](index.ts): the commands. `tick --advance` and `reject` call back into the core's `advance` and policy decision
  through `lib/cli.ts`, so the extension never imports `govern.ts`.
- [manpage.ts](manpage.ts): the SYNOPSIS, OPTIONS, ENVIRONMENT and DESCRIPTION text `govern help event` (and the others) prints.
- It loads `ext/business/event-server.ts`. The lifecycle runtime (`lib/lifecycle.ts`, `lib/lifecycle-runtime.ts`, `lib/lifecycle-schema.ts`)
  and the graph processes (`lib/business.ts`, `lib/business-schema.ts`) stay in the core: `advance`, `approve`, `work`, the brief
  and the lane state depend on them for graph and lifecycle processes.
