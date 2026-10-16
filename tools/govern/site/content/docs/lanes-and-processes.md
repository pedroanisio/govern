---
title: Lanes and processes
description: Define checked work and preserve its state, evidence and decisions.
section: docs
---

This guide explains how a lane follows a process and how govern records its state, checks, gates and evidence. A lane is called a project in the implementation and lives under the workspace's projects folder.

## State and brief

`govern.json` records stage, decisions, approvals, commands and files. Change it through govern commands. `govern work SLUG STAGE` opens a measured segment; `govern brief SLUG` prints the compact brief again. The brief includes the exit condition, approvals, named files, commands, recent jobs and decisions. `govern note SLUG TEXT` records a decision for the next session.

The workspace is found through `GOVERN_REPO` or the nearest `.govern/` or `govern.config.json`. A folder containing both workspace forms is refused. Environment path overrides win over configuration.

## Stages and checks

Each stage has a name and may have an exit condition and named check. `govern cmd SLUG test -- ARGV...` registers the command. `govern check SLUG` runs the current check. `govern advance SLUG` runs it again before moving on. A stage without a check needs `--note` evidence.

![The dev process: plan, build, test, review, done](/static/brand/process-stages.png)

`govern check SLUG --set CMD --stage STAGE` assigns a check. Replacing an existing check, redefining its command or removing that command is a flagged swap. Passing the replacement does not clear the flag. Only verified owner acceptance through `govern check SLUG STAGE --accept --quote Q` clears prior swaps for that stage. Never swap a failing check for one that passes.

Moving forward with `govern work` applies the same checks, gates and dependencies to skipped linear stages. Going back is allowed in a linear process. Graph work can select an active branch, but cannot skip or rewind execution.

## Gates and approvals

A gate may hold a stage and require other gates through `needs`. `govern approve SLUG GATE --quote Q` requires the decision owner's own words. A named owner other than `owner` requires `--by`. A plain terminal records the OS user. A Claude session verifies a human turn; a Codex or Grok session cannot supply that approval source. A signed paired-device approval is another source for single-owner gates.

Never infer approval, relay an approval as your own or rephrase a quote until it passes. Policy gates add eligible people, quorum, expiry and exclusions. Read [business processes](/docs/business-processes/) for those rules.

## Dependencies

`govern dep SLUG --after LANE` waits for another lane to finish. `govern dep SLUG --after LANE:STAGE` waits for it to pass the named stage. Dependency cycles are refused. For a graph lane, the referenced stage must have completed; cancellation and declaration order do not count.

## Ledger and artifacts

The append-only `govern/ledger.jsonl` records work segments, checks, advances, jobs, asks and decisions. `govern usage` and `govern desk` derive reports from recorded work.

`govern file SLUG NAME PATH-OR-GLOB` names an input or result; a glob resolves to its newest match. `govern artifact add SLUG FILE` copies evidence into `artifacts/`, records its SHA-256 and version, and makes it available for review. `govern artifact list SLUG` prints metadata. Replacing bytes invalidates reviews of older bytes. Phone approvals can bind to the reviewed digest.

## Built-in processes

| Process | Stages | Checks and gates |
|---|---|---|
| `dev` | `plan`, `build`, `test`, `review`, `done` | `test` requires the named suite; no built-in owner gates |
| `ops` | `plan`, `doing`, `review`, `done` | Operations work with no built-in owner gates; review is by someone other than the author |
| `video` | `plan`, `script`, `script-check`, `sound`, `preview`, `produce`, `final`, `deliver` | Gates `script`, `final`, `publish`, with prerequisite approvals; exit conditions come from the workspace workflow |

`govern manual video` describes the video process, including its verified prompt steps. `govern prompts video` lists those steps. The process supports `long` and `short` kinds and setup for named files and commands.

## Workspace definitions and strict parsing

Workspace files in `.govern/processes/` add processes or override a built-in name. `govern process list` lists them and `govern process show NAME` prints a definition.

A definition contains `version: 1`, `name` and `stages`, and may name gates, kinds, a description, exit-condition source, manual, prompts, recipes and setup. A stage names its exit condition, check and whether it requires a check. A gate names its stage, prerequisite gates, owner and message. Paths are relative to the process file. Graph, case and lifecycle fields extend this structure as described in [business processes](/docs/business-processes/).

Unknown keys, wrong types, duplicate stage or gate names, invalid stage/gate references and cyclic gate prerequisites fail with exit 2 and the file's JSON path. Lane state is also parsed strictly: its slug must match its folder, process and kind must fit, stages and checks must exist, and timestamps must be ISO values. Status and desk still show other lanes when one is invalid, but exit 1. Nothing guesses past invalid state.

A positive process `revision` pins a definition snapshot for new cases. `govern new SLUG --process NAME --pin` or `govern process pin SLUG` also freezes an unversioned definition. Explicit migration requires a higher revision and human instruction; it never silently upgrades existing cases.

## Draw the process

`govern bpmn dev` draws the definition and live lane state as SVG on stdout. `govern bpmn SLUG --svg FILE` writes one lane's frozen process and progress. A process name wins over a lane slug with the same name. `--static` omits live state; `--scene` writes a scene, and `--png` needs `SCENE_RENDER` or `scene-render` on the path. Drawing is read-only and does not import BPMN.
