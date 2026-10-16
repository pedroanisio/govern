---
title: govern
description: Run lanes of agent work through checked stages while keeping decisions and costs visible.
---

govern exists so that whoever owns the work keeps the decisions and knows where everything stands and what it cost, while the agents spend their effort on the work. Agents organize and distribute work among themselves. The operator sees where everything stands, who is doing what, what it cost and which decisions are waiting.

## Work in lanes

A lane is one instance of a process. Its state lives in files, with stages, checks and gates. Agents coordinate the work. The owner watches it through `govern desk`, which shows lanes, inbox, queue and today's tokens. Read [the concepts](/concepts/) and [why govern exists](/purpose/).

## See where the cost goes

The manual names four spends: re-reading a huge context on every call, polling long jobs inside the model, review and fix agent cascades, and sessions messaging each other. Briefs, detached jobs, verified one-shot steps and dispatch in code address these costs. `govern usage` reports measured use per lane and work segment. There is no fixed model price stated here; execution uses configured engines, models and resources. Read about [measurement and architecture](/docs/architecture/).

## Start a lane

`govern init` creates a workspace. `govern new` creates a lane on a process. `govern work` opens a measured work segment and prints its brief. `govern advance` runs the exit check and moves on when checks, gates and dependencies permit it. Follow [getting started](/docs/getting-started/).

Read the [documentation](/docs/), [comparison](/comparison/) and [press page](/press/).
