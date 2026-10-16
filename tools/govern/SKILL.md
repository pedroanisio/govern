---
name: govern
description: Work on a lane of agent work (a video, software, ops, an audit, govern itself) that follows a process, through the govern CLI at a fraction of the tokens. Use whenever the conversation is about making, changing, checking or finishing a specific piece of such work, or about moving a govern lane through its stages.
---

# Working with govern

govern keeps the work of you and the owner in files and keeps the conversation about it cheap. A lane of work follows a **process**: its stages, the exit condition and check of each, and the owner's gates. The money in agent work goes into four things, and the rules below remove them:
- re-reading a huge context on every call;
- polling long jobs from inside the model;
- review and fix agent cascades;
- sessions messaging each other.

This is the core manual. Everything else is one command away: `govern help <command>` prints a command's flags and rules, `govern help --topics` lists the reference documents.

## Start

1. `govern desk` is the owner's one screen (lanes, inbox, queue, today's tokens); `govern status` lists the lanes. One session works one lane.
2. No lane yet: `govern new <slug> --process <name> --title "…"` (`govern process list` shows the processes).
3. `govern work <slug> <stage>` opens a measured work segment and prints the **brief**: stage and exit condition, approvals, named files, commands, last jobs, recent decisions. `govern brief <slug>` prints it again. Work from the brief; do not read long process documents in full. If it names `manual: govern manual <process>`, read that once.
4. Name the lane's commands and files once: `govern cmd <slug> build -- {python} build.py`, `govern file <slug> report summary.json`.

## The loop

The owner says what to change. Then:

1. **Read narrowly.** Open only the file and the part the change touches. Don't re-read what is in this conversation.
2. **Edit the source**, never the generated file.
3. **Build without waiting in the model.** `govern run <slug> <command> --bg`, then `govern wait <slug>` as one Bash call with `run_in_background: true`. You are told when it ends. Never write sleep or poll loops. `wait` stops at 540 s with exit 124: wait again. `govern jobs <slug>` lists jobs; `govern log <slug> --grep RE` only if the last lines don't explain a failure.
4. **Show the result.** Give the owner the path to open. Read an image only to judge it. Say what you measured and what you could not judge.
5. **Record the decision** at once: `govern note <slug> "chose the second supplier file; first had no totals"`. The next session starts from the notes.

Keep replies short: what changed, what to look at, the open question. `govern advance <slug>` runs the stage's check and moves on only if it passes; never edit govern.json to skip a stage, and never swap a failing check for one that passes.

## Steps to Codex

A step is a prompt run as one verified Codex call: `govern ask <slug> <step> [--file F]… [--var K=V]…` (`govern prompts` lists the steps). The output is JSON, checked against a schema and rules, with one repair. **Exit 3 means unverified**: say so, never patch the output by hand and present it as verified. Show a few lines and the JSON path.

## The task queue

To ask another agent, send a message; the dispatcher starts one fresh headless session per message:

```bash
govern task send --to codex --project <slug> --task <name> --kind TASK --summary "…" --body "…" --file <repo-relative path>
```

- `--to` is a runner (`codex`, `claude`, `grok`), a profile, `auto`, `owner`, a live session name or `NAME@PEER` on another host. Prefer `codex` for checks. `--write` lets the runner change files in the project folder; the default is read-only. For `NAME@PEER` pass none of `--write`, `--profile`, `--lane`, `--estimate-usd`, `--file`.
- Your mail: `govern task inbox`. Answer with `govern task reply <id> --kind ACK|REVIEW|HANDOFF|BLOCKED|… --summary … --body …`; `govern task close <id> --note …` when nothing needs saying. Read replies once, when the owner asks or the work needs them, never in a loop. Do not send as `owner`; the owner has no inbox.
- Every reply carries one of three marks: `[checked: …]` (a content check passed), `[unverified]` (the check failed or could not run: read the reply yourself before acting on it) and `[shape only]` (no check exists for the kind: it proves the form only).
- **Never message other sessions and never start subagents** (no Agent tool, no Workflow). Sessions are not woken by the queue.

## The owner's gates

- Approvals come only from the owner's own words, verbatim: `govern approve <slug> <gate> --quote "<exactly what the owner said>"`. Never infer an approval, never approve for the owner, never rephrase a quote until it passes: ask the person. The same holds for `govern check <slug> <stage> --accept --quote "…"` and `govern allow`.
- The owner sees complete drafts, not intermediate passes.
- `govern publish <slug>` only after the owner's go in this session; run the commands it prints unchanged.
- Setup that grants access (pairing a phone, `peer`, `mesh`, `remote`) is the owner's alone: never run it, never ask for a code.

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
- `govern usage [<slug>]` shows what the tokens went to; report it when asked or when a lane is delivered.

## Where the rest is

- `govern help <command>`: flags and rules of one command. `govern help --topics`: the documents below with their paths.
- `govern manual --full`: this manual plus [REFERENCE.md](REFERENCE.md), the detailed rules (workspace, checks, resources, allowances, runners, capabilities, environment variables). `govern manual --size` prints the sizes.
- [BUSINESS.md](BUSINESS.md): typed case data, routes, human tasks, quorum. [LIFECYCLE.md](LIFECYCLE.md): timers, events, recovery, subprocesses. [ITERATION.md](ITERATION.md): loops and branching. [CONVERSATIONS.md](CONVERSATIONS.md): persistent conversations. [REMOTE.md](REMOTE.md): phone and devices. [PEERS.md](PEERS.md): other hosts and mesh.
