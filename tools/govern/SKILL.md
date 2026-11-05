---
name: govern
description: Use the govern CLI for process-based agent work: videos, software, ops, audits or govern itself. Use when making, changing, checking or finishing such work, or moving a lane through its stages.
---

# Working with govern

govern keeps work in files. Each lane follows a **process** with stages, exit checks and owner gates. Read narrowly, wait on jobs outside the model, and keep decisions in files.

This is the core manual. `govern help <command>` prints flags and rules; `govern help --topics` lists references.

## Start

1. `govern desk` is the owner's one screen (lanes, inbox, queue, today's tokens); `govern status` lists the lanes. One session works one lane.
2. No lane yet: `govern new <slug> --process <name> --title "…"` (`govern process list` shows the processes).
3. `govern work <slug> <stage>` opens a measured work segment and prints the **brief**: stage, exit condition, approvals, files, commands, jobs and decisions. `govern brief <slug>` prints it again. Work from the brief, not whole process documents. If it names `manual: govern manual <process>`, read that once. In a lane's folder, or with `GOVERN_LANE=<slug>`, `govern hook session-start` opens the segment.
4. Name commands and files once: `govern cmd <slug> build -- {python} build.py`, `govern file <slug> report summary.json`.

## The loop

The owner says what to change. Then:

1. **Read narrowly.** Open only the part the change touches. Don't re-read this conversation.
2. **Edit the source**, never the generated file.
3. **Build without waiting in the model.** `govern run <slug> <command> --bg`, then `govern wait <slug>` as one Bash call with `run_in_background: true`. You are told when it ends. Never write sleep or poll loops. `wait` stops at 540 s with exit 124: wait again. `govern jobs <slug>` lists jobs; `govern log <slug> --grep RE` only if the last lines don't explain a failure.
4. **Show the result.** Give its path. Read images only to judge them. Say what you measured and could not judge.
5. **Record the decision** at once: `govern note <slug> "chose the second supplier file; first had no totals"`. Notes inform the next session.

Reply briefly: changes, result path, open question. `govern advance <slug>` runs the stage's check and moves on only if it passes; never edit govern.json to skip a stage, and never swap a failing check for one that passes.

## Steps to Codex

A step is a prompt run as one verified Codex call: `govern ask <slug> <step> [--file F]… [--var K=V]…` (`govern prompts` lists the steps). JSON output is checked against a schema and rules, with one repair. **Exit 3 means unverified**: say so, never patch the output by hand and present it as verified. Show a few lines and the JSON path.

## The task queue

The dispatcher starts one fresh headless agent session per message:

```bash
govern task send --to codex --project <slug> --task <name> --kind TASK --summary "…" --body "…" --file <repo-relative path>
```

- `--to` is a runner (`codex`, `claude`, `grok`), a profile, `auto`, `owner`, a live session name or `NAME@PEER` on another host. Prefer `codex` for checks. `--write` lets the runner change files in the project folder; the default is read-only.
- Your mail: `govern task inbox`. Answer with `govern task reply <id> --kind ACK|REVIEW|HANDOFF|BLOCKED|… --summary … --body …`; `govern task close <id> --note …` when nothing needs saying. Read replies once, when the owner asks or the work needs them, never in a loop. Do not send as `owner`; the owner has no inbox.
- Every reply carries one of three marks: `[checked: …]` (a content check passed), `[unverified]` (the check failed or could not run: read the reply yourself before acting on it) and `[shape only]` (no check exists for the kind: it proves the form only).
- Ask for checks: `--check commit-refs|claims-cited|file-refs` and `--verify -- <test command>` make govern verify the reply (every HANDOFF's commits are checked anyway); a reply that does not parse gets one repair call before it fails (`[repaired]`).
- `--timeout S` sets one run's limit; `govern task triage` lists failed tasks with the cause, and `govern task retry <id> --note "<what was fixed>"` resends one (never automatic).
- No profile runs unchecked: the dispatcher self-tests a profile once per definition before its first run (`govern caps --check`). A message that asks for file changes is refused for a read profile: add `--write`, or `--read-only` to confirm it needs no edits.
- The `claude-write` and `grok-write` profiles have no shell: run the suite yourself and check each new test fails without the fix. A thread stops after `maxRuns` (4) runs, `--reply-to` included: send the next review as a new task.
- **Never message other sessions and never start subagents** (no Agent tool, no Workflow). Sessions are not woken by the queue.

## The owner's gates

- Without standing delegation, approvals come only from the owner's own words, verbatim: `govern approve <slug> <gate> --quote "<exactly what the owner said>"`. Never infer an approval, never approve for the owner, never rephrase a quote until it passes: ask the person. The same holds for `govern check <slug> <stage> --accept --quote "…"` and `govern allow`.
- The owner grants standing gate authority with `govern delegate`; see [README.md](README.md#standing-gate-delegation) for grant, list and revocation commands. Codex and Grok cannot grant or revoke; owner gates and policy votes are excluded.
- With active authority, `govern approve <slug> <gate> --by PERSON --note "<decision evidence>"` records the delegate's decision. Never infer it. An explicit `--quote` still requires verification.
- The owner sees complete drafts, not intermediate passes.
- Setup that grants access (pairing a phone, `peer`, `mesh`, `remote`) is the owner's alone: never run it, never ask for a code.
- `govern freeze`, `unfreeze` and accepting an import or its flagged checks are the owner's, like a gate; `govern export` without `--freeze` is read-only.

## Never, in production work

- No subagents, Agent tool or Workflow. One session works one lane. An engine or tool bug goes to its owner as a queue request.
- No messages to other sessions. State lives in `govern.json`; `govern status` answers "where is it".
- No heavy work on the machine the owner works on: builds and renders run where the lane's commands say.
- No long logs or whole files pasted into the chat.
- No overwriting an approved file. Write the new one beside it with a suffix.
- Never `kill` a job's pid by hand: `govern kill <slug>`.

## Keep the context small

- Every command warns past 150k tokens per call; `govern ctx` shows the number. Never ask the owner to `/clear`.
- When it warns: record what is open with `govern note`, offload model work with `govern task send --to codex`, wait on jobs in the background, let auto-compaction do the rest.
- One session covers one lane and one stage. For another lane run `govern done <slug>` and start a fresh session.
- `govern usage [<slug>]` shows what the tokens went to, calls outside a segment included. Report it when asked or when a lane is delivered.

## Where the rest is

- `govern install-skill [<skills dir>]` links `<skills dir>/govern` to this folder (a symlink, never a copy).
- `govern help <command>`: flags and rules of one command. `govern help --topics`: the documents below with their paths.
- `govern manual --full`: this manual plus [REFERENCE.md](REFERENCE.md), the detailed rules (workspace, checks, resources, allowances, runners, capabilities, environment variables). `govern manual --size` prints the sizes.
- Extensions (peer, center, remote, decide, conversation, business, slack) load only where the workspace enables them: `govern ext list` shows each one's state, `govern ext enable <name>` and `govern ext disable <name>` change it; a disabled one's commands are refused (exit 4) and its documents are not in `govern help --topics`.
- [BUSINESS.md](BUSINESS.md): typed case data, routes, human tasks, quorum. [LIFECYCLE.md](LIFECYCLE.md): timers, events, recovery, subprocesses. [ITERATION.md](ITERATION.md): loops and branching. [CONVERSATIONS.md](CONVERSATIONS.md): persistent conversations. [REMOTE.md](REMOTE.md): phone and devices. [SLACK.md](SLACK.md): decisions from Slack buttons. [PEERS.md](PEERS.md): other hosts and mesh. [PORTABILITY.md](PORTABILITY.md): freeze, export, import, clone.

- Slack: `govern slack listen` records posts; `govern slack post` journals sends; `govern slack upload` uploads media; `govern slack resolve` settles an uncertain send; `govern slack digest` sends daily summaries; `govern slack triage` lists posts owed a reply or a manual review; `govern slack dismiss` records why a post needs nothing; `govern slack heartbeat` shows whether the agent session's heartbeat is fresh (exit 1 when stale or missing; `notify` posts `blocked:`/`note:` for it); `govern slack install-service` writes user units.
