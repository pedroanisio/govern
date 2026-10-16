---
title: Task queue
description: Send bounded agent tasks and inspect their verified replies.
section: docs
---

The queue carries durable messages between agents and runs fresh headless sessions for dispatched tasks. This guide covers sending, capability checks, reply verification, concurrency and recovery.

## Messages and inboxes

`govern task send` takes recipient, project, task, kind, summary and a body or body file. Named `--file` attachments give a runner the evidence to inspect. Use `--write` or a write profile for edits. A read profile refuses a message asking for file changes; `--read-only` explicitly confirms read-only intent.

`govern task list` lists messages. `govern task inbox` reads your mail and `govern task show ID` shows a full message, reply and verification details. Sessions are not woken by delivery. They read their inbox, answer through `govern task reply`, close messages with `govern task close`, or route them with `govern task forward`.

Messages move through `open`, `claimed`, `done` and `failed`. `govern task dispatch` claims runnable work and starts one fresh session per message. A runner sees the message, thread and named files, with bounded inlined file content. It does not inherit the sender's full chat.

## Runners, profiles and capabilities

Built-in runners use Codex, Claude or Grok. Queue configuration can add runners with `argv` and `format`. A profile combines capabilities, engine and model. `govern caps` lists profiles and grants; `govern caps PROFILE` shows tool mappings, side-effect classes, secret names and sealing limits.

Capabilities are `read`, `write`, `spend`, `publish` or `push`. Tasks using guarded effects must be tied to a lane whose matching gate is approved. Send and dispatch both enforce that rule. A registration or remote message does not grant execution rights.

Claude uses explicit allowed tools and denies other built-ins, without inherited settings or MCP configuration. Codex runs in its sandbox with a private `CODEX_HOME` containing a login link and minimal `config.toml`. Project `AGENTS.md` instructions still load. Grok gets scoped tools, private homes and disabled compatibility layers, but project configuration, built-in agents, bundled skills and web tools remain sealing limits. `govern caps` reports them. A custom runner that shadows a profile runs unsealed and is warned about.

## Self-tests

`govern caps --check PROFILE` runs sealed probes and verifies nonce or file evidence. An unparseable or unverifiable answer fails. Results are bound to the profile's content hash. `govern caps --check --all` checks profiles without a current pass.

Dispatch runs a missing or stale self-test once per profile hash. Failure leaves the task open, names the failed capability and sends one BLOCKED notice. Further messages on the same failed hash do not rerun it automatically. Even built-in profiles need a current passing test. `selfTest: "optional"` only allows capabilities without probes to pass.

## Replies and content checks

Replies have exactly `kind`, `summary` and `body`. Kinds are `ACK`, `PROGRESS`, `BLOCKED`, `HANDOFF`, `REVIEW`, `DECISION` and `NOTICE`. The summary is 3 to 200 characters and the body is nonempty. Queue parsing rejects malformed envelopes.

- `[checked: …]` means the selected content checks passed. It does not prove claims beyond those checks.
- `[unverified]` means a check failed or could not run. Read the reply yourself before acting on it.
- `[shape only]` means the kind has no content check; only form is established.

Checks selected by the task kind and reply kind both apply. Built-in `file-refs` verifies that cited file lines exist. `commit-refs` checks named commits and is applied to HANDOFF replies; a handoff naming no commit remains shape-only. `claims-cited` requires every ID from the attached claims ledger to appear in the reply.

`--check NAME` adds checks and is repeatable. Names resolve from the profile's checks, queue `checks.named`, then built-ins. Unknown names fail with exit 2. `--verify -- ARGV...` runs a command without a shell in the project folder, bounded to 600 seconds. Only exit 0 gives the verification pass. `govern task show ID` exposes the reason and kept check logs when verification fails.

A successful run with malformed reply text gets one repair call, sealed read-only, to wrap the same content. A failed repair retains both texts. Nonzero runs and timeouts are not repaired. `GOVERN_QUEUE_REPAIR=0` disables repair. The desk counts checked, shape-only, unverified and repaired replies.

## Concurrency and timeouts

Queue `config.json` sets `concurrency` per runner or profile across all dispatchers; the default is one per runner. Excess work stays open. `govern task dispatch --parallel N` adds workers in one dispatcher without exceeding those shared limits.

`--timeout S` on send or retry replaces `GOVERN_QUEUE_TIMEOUT_SEC` for that run. Queue `maxTimeoutSec` defaults to 7200. Grok has a turn limit and timeout, with no dollar cap; show and desk print those bounds. A thread reaches the owner when its `maxRuns` limit is reached, default four.

## Failures and explicit recovery

`govern task triage` lists failed messages, cause, usage, cost and retained reply. `--all` includes unverified replies in `done`. `govern task retry ID --note T` files a threaded copy after inspection and repair of the cause. A third retry of one original is refused.

Dispatch fails dead holders and charges unknown spend as reserved. Holderless claims fail after twice the run limit, at least one hour. Effects may already have happened; runs are never retried automatically. After inspecting effects, use `govern task reclaim ID --note T`. Reclaim refuses a live holder.

Local mail to unknown recipients expires after `mailTtlHours`, default 72. Known runners, profiles, live sessions, registrations, aliases and configured mailboxes are retained; `owner` always remains. Remote mail belongs to the relay.

## Dispatcher service

Standard host setup includes `govern task install-service` and the enable command it prints. `govern task dispatch --loop` keeps dispatching, tunes hourly and relays peer traffic. `--reap-every` can list tagged machines for the desk; it never stops them.

`govern task install-service --system` previews a system unit with the current user. `--system --write` writes it only as root. A non-root request prints the refusal and unit without escalating. See [peers](/docs/peers/) for delivery between hosts.
