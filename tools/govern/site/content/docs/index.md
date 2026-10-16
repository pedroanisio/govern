---
title: Docs
description: Guides and command reference for operating govern.
nav: 3
section: docs
---

These guides cover setup, daily lane work, queue execution and the rules for human decisions. Start with a lane, then use the reference for the commands you need.

## Read the manual

`govern manual` prints the core operating manual. `govern help <command>` prints one command's usage, flags and rules. `govern help --topics` lists the reference documents.

`govern manual --full` adds the detailed reference. A process may provide a manual of its own, such as `govern manual video`.

## Guides

- [Getting started](/docs/getting-started/) installs from the repository and walks through a software lane.
- [Lanes and processes](/docs/lanes-and-processes/) explains state, checks, gates, dependencies, artifacts and process definitions.
- [Queue](/docs/queue/) covers messages, dispatch, capability profiles, verification and recovery.
- [Command reference](/docs/commands/) lists every command in manpage order, with synopsis and behavior.
- [Peers](/docs/peers/) covers signed delivery, mesh membership, agent discovery and the command center.
- [Remote devices](/docs/remote/) covers pairing, scope, signed approvals and phone access.
- [Business processes](/docs/business-processes/) covers graph routes, typed cases, human tasks, events, timers and subprocesses.
- [Architecture](/docs/architecture/) explains subsystems, CLI rules, file layout and verification gates.

For definitions, read [concepts](/concepts/). For documented limits and unreleased work, read the [roadmap](/roadmap/).
