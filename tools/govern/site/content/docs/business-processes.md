---
title: Business processes
description: Use typed cases, graph routes, human tasks and durable lifecycle controls.
section: docs
---

This guide explains the business-workflow and lifecycle features described in `BUSINESS.md`, `LIFECYCLE.md` and `ITERATION.md`. A case is a lane whose process can route graph work, hold typed data and require human decisions.

## Graph routes and joins

A graph definition declares `next` on every stage; `next: []` is terminal. A route's `to` names destinations. One destination continues work; several start parallel branches. Conditional routes use parsed field comparisons, never JavaScript or shell expressions. A single optional fallback applies when no conditional route matches. Ambiguous matches or no eligible route refuse advancement without changing state.

Joins list direct predecessors. `all` waits for all; `any` releases after one and cancels remaining paths leading to it. Cancellation does not kill jobs or undo effects. Unsatisfiable joins are refused. Ordinary forward routes must be acyclic and reachable from the first stage. Explicit bounded loops are separate validated routes. BPMN import is absent.

`govern work SLUG STAGE` selects an active branch. `govern advance SLUG --stage STAGE` completes that branch under its checks, required data, tasks, gates and dependencies. Graph work cannot skip or rewind stages. A case finishes only when no active stages or pending joins remain.

## Typed case data

`fields` declare strings, numbers, integers, booleans and flat scalar arrays, with validated bounds, enums and defaults. Nested records, object items, nested arrays, unknown fields and ordinary null values are refused. `govern data SLUG` prints data; `--set JSON` atomically merges declared fields.

Global required fields block any advance or human completion. Stage `requiredFields` add local requirements. Changed data invalidates policy votes and active human-task completion, but does not rewind completed branches or recalculate routes already taken. Identity fields used by `excludeFields` become immutable after their first value. Record the person ID, not a display name. Finished cases are read-only through data updates.

## Human tasks and identity

A human stage specifies an assignee or role. Fixed assignments start with that person; role tasks may be claimed by eligible people. `govern human-inbox` lists work. `govern human SLUG` lists tasks or claims, delegates and completes them.

The process maps each person to one OS username and roles. Each OS account maps to exactly one person. `--as` cannot impersonate another account. Only the current assignee can delegate or complete, and fixed-person tasks cannot delegate to another person. Unfinished human tasks block advancement.

Every mutation requires the person's quoted instruction and verified source. Terminal actions record the OS user; Claude sessions require a human turn. Agents cannot manufacture decisions. Local account mapping is not SSO or tamper-proof auditing. Separate accounts and filesystem permissions are needed for role separation.

## Approval policies

Policy gates name people or a role and a quorum. Distinct eligible people vote through `govern approve`; repeating a vote does not increase quorum. Prerequisite gates must be approved. `excludeFields` prevents named people, such as the requester, from voting. Votes expire and changed case data invalidates them. Cached approval alone cannot satisfy a policy gate.

`govern reject` records a veto. An unexpired rejection blocks the gate until superseded or invalidated. With `rejectTo`, rejection resets graph execution to the target, clears other policy decisions and human tasks, and retains the rejecting gate's veto. It does not undo commands. Phone approvals cannot vote on policy gates.

## Timers and alerts

Stage timers persist entry time, generation, deadlines and fired markers. Due, reminder and escalation offsets count from stage entry. A working calendar can restrict counted time by timezone, weekday, same-day interval and holidays. Overnight and multiple daily intervals are absent.

`govern tick SLUG` processes deadlines; `govern tick --loop` runs a local scheduler. Restart it after a machine restart. Advancement and fresh events also apply due escalations. `govern alerts SLUG` lists local alerts; `--ack` acknowledges one without approving a decision. Alerts do not themselves send email, chat or push messages.

## Correlated events

`govern event` delivers a stable ID, event name, JSON correlation value and optional data and generation. Exactly one active stage must match. When `requireGeneration` is declared, old or missing generations are refused. The event's typed output map cannot overwrite its correlation field.

Identical delivery IDs are no-ops even after advancement or rework. Reusing an ID with different content fails. Receipt makes work ready; checks, gates and human tasks still apply. `govern tick --advance` can progress ready event stages and completed calls through the same rules.

`govern event-listen` accepts loopback HTTP delivery with `GOVERN_WEBHOOK_TOKEN`. Put a TLS proxy and provider-signature adapter in front for remote use. This bearer endpoint does not verify native provider signatures or isolate tenants. Keep tokens out of process files, command arguments, tracked files and chat.

## Retries and compensation

A stage's `onError` may declare bounded retries, a compensation command and an error route. Attempt counts include the first check. Backoff is a durable scheduled time, not a sleeping retry loop. These policies apply to exit checks run by `advance`, including scheduler advancement, not diagnostic `govern check` or arbitrary jobs.

Only a successful compensation command records compensation. Interrupted checks and uncertain compensation block blind repeats. Inspect jobs and external effects, then use `govern recover` with verified human words. Recovery does not execute a refund or infer rollback. Error and timer reroutes reset execution and decisions but do not kill jobs or undo effects. Unfinished children block reroutes.

## Subprocesses and pinned definitions

A stage's `call` maps child inputs from parent fields and returns child outputs to parent fields. `govern subprocess SLUG STAGE` starts or synchronizes the child. Child identity is deterministic so interrupted launches resume without duplicating a case. Parent inputs freeze while the child is active. Actual child completion and valid outputs are required; a terminal stage name or PID is insufficient.

Self-calls, ancestor cycles and nesting beyond 16 cases are refused. Retain parent and child records. Creating children starts no agent session.

A positive process `revision` freezes its definition into new cases. `govern process pin SLUG` freezes an unversioned definition before it changes. Snapshots cover process JSON, not binaries, manuals, resources or secrets. `govern process migrate` requires a higher revision and verified human instruction. It validates candidate state before saving, clears decisions and task completion, renews active deadlines and retains event deduplication. Active children, interrupted checks and unresolved compensation block migration. Finished cases cannot migrate.

## Bounded iteration and item work

A repeat route declares its body and maximum total iterations. The first execution counts as one. Repeats clear scoped completion and decisions and increment generations. At the limit, a selected repeat refuses advancement and preserves the case. Unfinished children and uncertain outcomes block repetition.

Conditional branch dispatch persists all matching destinations and joins only selected predecessors. Branches currently route directly to their explicit join. Use a subprocess for multi-step branches.

A `foreach` stage creates a child per flat collection item, with required `maxItems` and bounded concurrency. Inputs freeze, every child uses one pinned definition, and outputs preserve original item order. Concurrency limits unfinished cases, not worker processes. Empty collections finish with empty outputs. `govern subprocess`, `advance` and `tick --advance` synchronize progress; a failed child is not silently abandoned.

## Examples from the repository

- `examples/purchase.json` routes larger purchases into parallel legal and finance human reviews, joins them for a two-person budget decision, excludes the requester and supports rejection to submission. Copy it into the workspace processes folder, repair or remove the relative manual path, and map example people to real accounts.
- `examples/fulfillment.json` uses a supplier child case, generation-bound payment event, working calendar, escalation and bounded check recovery. It requires Node and a local check, without API credentials for the CLI example.
- `examples/supplier-review.json` is the reusable child definition with typed supplier input, approval output and a decision gate. Copy it alongside fulfillment.

Adding a definition runs no commands and starts no listener. Read [lanes and processes](/docs/lanes-and-processes/) for validation and [the command reference](/docs/commands/) for syntax.
