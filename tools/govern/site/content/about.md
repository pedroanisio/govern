---
title: About
description: Why govern exists and how owners and agents share the work.
nav: 1
---

govern helps people and small teams see and steer agent work while keeping decisions and cost visible. This page explains where it came from, what it covers and who does the work.

## Where it comes from

The case described in `PURPOSE.md` began with agent work turning into long conversations. State was buried in chat. Agents spent effort re-reading history, waiting and messaging each other. Approvals were relayed or assumed. Most of the spend went to those activities before anyone could see where it went.

The response is to put state in files and use code for waiting, relaying and bookkeeping. Models do judgment. Read [the purpose](/purpose/) for the principles and scope.

## What it is for

govern runs lanes through the stages, checks and gates of a process. It provides briefs, jobs, a task queue, durable conversations and usage reports. A new kind of work is a process description. Video, software and operations processes are built in.

It does not implement messaging channels or its own model. Configured agent harnesses run conversation turns. It does not schedule clusters, replace CI or judge the work. PALS Notes is its first user, not its scope.

## Who runs it

The **owner** watches status and cost and makes the decisions reserved for them, including gates, grants and spend. The owner should not have to relay messages, assign tasks or chase agents.

The **coordinator** plans, splits, assigns, hands off and follows up on work through govern. The **worker** works a lane from its brief, runs checks and returns a checked result. Queue runners start fresh headless sessions under capability profiles. One session works one lane.

Any session can work a lane. Approval belongs to the person who owns the decision. A model cannot infer or manufacture that approval. The [concepts](/concepts/) and [architecture](/docs/architecture/) explain these boundaries.

## Implementation

The CLI is TypeScript and runs directly under Node through type stripping. See [installation](/docs/getting-started/) and the [command reference](/docs/commands/).
