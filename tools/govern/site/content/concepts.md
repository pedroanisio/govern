---
title: Concepts
description: The terms used for governed work, execution and human decisions.
nav: 2
---

This page defines the parts of govern, from a lane and its process to queue execution, cost records and human decisions.

## Lane

A lane is one instance of a process at its own stage. Its `govern.json` holds stage, decisions, approvals, commands and files. `govern new SLUG --process dev` creates one. [Lanes and processes](/docs/lanes-and-processes/) explains the state.

## Process

A process names stages, their exit conditions and checks, and gates. `govern process list` lists definitions; `govern process show dev` shows one. `govern advance SLUG` moves on only when its check passes, gates allow it and dependencies are ready. A stage without a check needs evidence with `--note`.

![The dev process: plan, build, test, review, done](/static/brand/process-stages.png)

## Brief

A brief is the compact starting point for work: stage and exit condition, approvals, named files, commands, last jobs and recent decisions. `govern brief SLUG` prints it without opening a segment. A process may name its own manual.

## Work segment

A work segment measures one session's work on one lane and stage. `govern work SLUG STAGE` opens it and prints the brief. `govern done SLUG` closes it. Segments connect use to work and record the manual hashes in the ledger.

## Approval

Only the decision owner's own words approve a gate. `govern approve SLUG GATE --quote "owner's words"` records them. A plain terminal records the OS user. Claude sessions require words found in the person's own typed turn. Codex and Grok sessions are refused because that source cannot be verified. A paired device can provide a signed single-owner approval. Policy votes require mapped human OS accounts. Never infer approval or approve for someone else.

## Queue

The queue holds durable messages and runs one fresh headless session per dispatched task. `govern task send` addresses a runner, profile, session, owner or remote recipient. Runners execute tasks; profiles select an engine, model and capabilities. A capability grants a tool or effect, classified as `read`, `write`, `spend`, `publish` or `push`.

`govern caps` shows grants and sealing limits. `govern caps --check PROFILE` tests them with verified probes. Dispatch requires a passing test of the current profile. Replies must parse and pass their selected content checks. `[checked]` means a check passed; `[unverified]` requires inspection; `[shape only]` proves form alone. Read [the queue guide](/docs/queue/).

## Resources and jobs

Resources declare machines, services and accounts, their prices, sharing and limits. `govern resources` lists them. `govern run SLUG CMD --bg` starts a detached job; `govern wait SLUG` waits in code. Resource locks control concurrent jobs, and allowances reserve covered spending before work starts.

## Ledger and tuning

Append-only JSONL ledgers record work, checks, jobs and decisions. `govern usage` reports calls, tokens and machine cost against the workspace baseline. `govern tune` measures recent use and adjusts Claude Code's compaction window within code-owned bounds. The dispatcher runs tuning hourly; tuning runs no model.

## Peers and mesh

Peers carry signed queue delivery between hosts. A mesh lets hosts trust certified members after one join per host. Receiving hosts keep control of profiles, gates and allowances. `govern peer list`, `govern mesh status` and `govern agents list` show trust and addressable recipients. `govern center` shows the federation. See [peers](/docs/peers/).

## Remote devices

A paired phone reads lanes and telemetry and sends signed decisions and guidance. `govern remote serve` exposes the API; pairing is reserved for the owner's terminal. The phone cannot advance lanes or run arbitrary commands. See [remote devices](/docs/remote/).

## Business processes

A business case is a lane with typed data and graph execution. Graph processes route between active stages, join branches and assign human tasks. `govern data SLUG` reads case fields. `govern human-inbox` lists human work; `govern advance SLUG --stage STAGE` completes a selected active branch. Events, timers and child cases extend the lifecycle. See [business processes](/docs/business-processes/).
