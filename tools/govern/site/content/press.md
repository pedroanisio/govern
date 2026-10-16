---
title: Press
description: The govern press release, PDF download, and brand images.
nav: 6
---

The press release is available as a [PDF](/press/govern-press-release.pdf). Brand images include the [logo](/static/brand/logo.png), [wordmark](/static/brand/wordmark.png), [social card](/static/brand/social-card.png), and [hero](/static/brand/hero.png).

| File | Size in pixels |
| --- | --- |
| logo.png | 1024×1024 |
| wordmark.png | 2400×800 |
| social-card.png | 1200×630 |
| hero.png | 2400×1200 |

## govern brings checked stages and owner decisions to agent work

## Subheadline

The super-tools tool keeps lane state, approvals, agent tasks, and usage in files so people can see and steer the work

São Paulo, 2026-10-16 — govern is available now on the repository's main branch. It ships inside the super-tools repository as `tools/govern`. The tool organizes agent work into lanes that follow defined processes, with checks at each stage and gates for decisions reserved for the owner. It gives people running work through agents a way to see progress, pending decisions, and cost while agents handle coordination.

govern addresses a problem described in its purpose: agent work can become long conversations whose state is buried in chat. Agents spend effort reading history, waiting on jobs, and relaying messages, while approvals can be assumed or passed along without a clear record. The owner may see the bill before understanding where the effort went. govern puts state in files so a person or agent can pick up the work from a written record. Its aim is to keep decisions with the owner and agent effort on the work.

Each lane follows a process that names stages, exit conditions, checks, and owner gates. Built-in processes cover video, software development, and operations; a workspace can add its own processes or override the built-ins. A lane advances only when its stage check passes, no gate holds it, and its dependencies are ready. The lane's state file records its stage, decisions, approvals, commands, and files. A compact brief brings the next session back to the current stage, its exit condition, recent decisions, and relevant files without requiring a reading of the conversation history.

Checks and gates serve different roles. A check tests whether a stage's exit condition holds. An owner gate records the person's own words approving the decision; agents must not infer approval or rephrase it to obtain a pass. govern also supports verified model steps with schemas and checks, and reports a failed verification rather than treating it as success. Judgments remain with people and agents. The program handles waiting, relaying, and bookkeeping, with detached jobs for long-running work so a model need not remain in the loop while a build or check runs.

The task queue carries work between agents, and its dispatcher starts a fresh headless session for each message. Replies undergo parsing, with content checks available to verify claims or run a specified command. Capability profiles constrain the tools and permissions available to agent runs. The dispatcher self-tests a profile's current definition before it runs work without a current passing check. Usage reports and a ledger make tokens and cost visible per lane, including sessions attributed by where they work. The command center brings lanes, queues, runs, spend, and alerts into an owner's view.

govern is for people running work through agents, the agents doing that work, and anyone defining a new kind of process. The owner sees what is happening and decides at gates without having to relay tasks or chase agents for updates. Agents use the operating manual to understand the next step, their available resources, and when to ask. Adding a kind of work means describing a process rather than changing govern's code. The TypeScript command-line tool runs through Node's type stripping, and the repository includes its documentation and tests alongside the implementation.

## Key facts

- Lane state lives in files and includes stages, decisions, approvals, commands, and files.
- Built-in processes cover video, software development, and operations.
- Stage advancement requires passing checks, clear gates, and ready dependencies.
- Owner approvals are recorded from the owner's own words.
- The task dispatcher starts a fresh headless session per message.
- Capability profiles constrain agent tools and permissions.
- A ledger and usage reports track work per lane.

## About govern

govern is the super-tools tool for organizing agent work through checked processes. Its purpose is to give the owner visibility into progress, decisions, and cost while agents coordinate the work. It supports workspace-defined processes and runs on existing machines and services. It does not replace a model, a cluster scheduler, or continuous integration; people and agents retain responsibility for judging the work.

## Contact

Through the super-tools repository's issue tracker.
