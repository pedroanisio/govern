---
title: Getting started
description: Install govern from the repository and move a software lane through its checks.
section: docs
---

This guide uses the repository checkout to create a workspace and a first lane on the built-in `dev` process. Commands run from the repository root unless a step says otherwise.

## Install from the repository

Use Node 24 or newer. Install the package's development dependencies and put the repository's `bin` directory on your shell's path:

```sh
npm ci --prefix tools/govern
export PATH="$PWD/bin:$PATH"
govern version
govern install-skill
```

The launcher is `bin/govern`. TypeScript runs directly through Node type stripping. `govern install-skill` creates a symbolic link from the default skills directory to the tracked `tools/govern` folder. It prints the session hook lines to add. An existing real file or directory is refused unless replacement is explicitly requested.

## Create the workspace and lane

Run `govern init` in the folder you want as the workspace root. It creates `.govern/`. It refuses an existing workspace and, unless `--nested` is explicit, a folder inside another workspace. Skip initialization when the folder is already a workspace.

```sh
govern init
govern new ops/govern --process dev
govern work ops/govern plan
```

The brief gives the stage's exit condition, approvals, commands, files, last jobs and recent decisions. Record the change, its tests and risks before leaving `plan`.

## Name the test command

In this repository, the overview's example names the govern suite:

```sh
govern cmd ops/govern test -- node --test 'tools/govern/test/*.test.ts'
```

For another repository, name its actual suite instead. `dev` uses the named `test` command as the check for its `test` stage. Do not replace a failing check with an easier command.

## Work and advance

After documenting the plan, move into implementation. Write failing tests before the code that makes them pass.

```sh
govern advance ops/govern --note 'The change, tests and risks are written down'
govern work ops/govern build
```

After implementation satisfies the build stage's exit condition, advance to `test` and run its check:

```sh
govern advance ops/govern --note 'Failing tests were written first and the implementation makes them pass'
govern work ops/govern test
govern check ops/govern
govern advance ops/govern
```

The evidence notes above describe conditions you must actually meet before running those commands. `govern advance` reruns the stage check. Failure holds the lane. Checks, pending gates and dependencies can also refuse a move to a later stage through `govern work`.

The next stage is `review`: a second agent or the owner reads the diff, and findings are fixed or answered. The final `done` stage requires a commit; pushing still requires the owner's go. See [lanes and processes](/docs/lanes-and-processes/) for the full rules.

## Watch the work

```sh
govern desk
govern brief ops/govern
govern usage ops/govern
```

The desk is the owner's overview of lanes, inbox, queue and today's tokens. The brief resumes one lane. Usage connects recorded work to its cost. Read [the queue guide](/docs/queue/) before handing work to a runner.
