---
name: govern
description: Work on a PALS Notes video (script, sound, preview, fixes, metadata, publishing), or any other lane of agent work (software, ops, govern itself) that follows a process, through the govern CLI at a fraction of the tokens. Use whenever the conversation is about making, changing, checking or publishing a specific video or Short, or about moving a govern lane through its stages.
---

# Working on a video with govern

You and the owner shape a video together: the work is iterative and creative. `govern` keeps that conversation cheap. Measured on 2026-10-10/11 (PALS-Notes/costs/token-analysis/REPORT-2026-10-11.md), the money did not go into the conversation. It went into four things:
- re-reading a 468k-token context on every call;
- polling renders from inside the model, about $800;
- review and fix agent cascades, about $1,400;
- sessions messaging each other, about $455.

The rules below remove those four.

## Start

The owner's one screen is `govern desk`: every lane (videos and `ops/*` work), their inbox, the queue and today's tokens. One session works one lane; the other lanes wait in their files, not in open chat tabs.

1. `govern status` lists the videos. If the video is not there, run `govern new <slug> --kind long|short --title "…" --lang en|pt-BR [--parent <film>]`. The slug is its folder under `PALS-Notes/projects/`, for example `a-millionth-apart/shorts`.
2. `govern work <slug> <stage>`. For a video, stage is one of plan, script, script-check, sound, preview, produce, final or deliver. For an `ops` lane (engine, lab, docs, channel set-up), it is plan, doing, review or done. Other lanes use their process's stages (`govern process show <name>`). This opens a measured work segment and prints the **brief**:
   - stage and exit condition;
   - approvals;
   - named files;
   - commands;
   - last jobs;
   - recent decisions.

   The segment's `work` ledger entry carries `skillSha`, the sha256 of this manual (tools/govern/SKILL.md) when the segment opened, so a segment can be matched to the rules it ran under; `--open` records it too.

   `govern brief <slug>` prints the brief again without opening a segment. Work from the brief. Do not read WORKFLOW.md, CHECKLIST.md, the style guide or old reports in full. The brief carries the exit condition, and `govern ask` carries the rules each step needs.
3. If the video's build commands or files are not named yet, name them once:
   - `govern cmd <slug> preview -- {python} build_short1.py --preview`. Placeholders: `{python}`, `{repo}`, `{dir}`.
   - `govern file <slug> script short-1.screenplay.json`
   - `govern file <slug> sheet "renders/**/*sheet*.png"`. A glob means its newest match.

`govern help` lists every command with its flags; `govern help <command>` (or `govern <command> --help`) shows one. The command comes first, then its subcommand (`govern task send …`), then arguments and flags. A flag the command does not take, a switch given a value other than true or false, and a value flag with no value are refused (exit 2) with the command's valid flags. A value flag takes the next word as its value even when it starts with `--` (`--note "--verbose test passes"`), unless that word is itself a govern flag (`--note --bg` forgot the note); give such a value as `--flag=VALUE`. `govern manual` prints this manual; `govern install-skill [<skills dir>]` installs it as the govern skill (default: the repo's `.claude/skills`): it writes a temp file beside the destination, renames it into place, and reads it back by sha256, failing (exit 1) on a mismatch without replacing a good copy. `govern install-skill [<skills dir>] --check` installs nothing: it exits 0 when the installed copy is byte for byte this file, and 1, naming both paths and both sha256s, when it differs or is missing.

## Any process, any group of agents

govern is not tied to video. A lane follows a **process**: stages, the exit condition of each, the command that checks it, and the owner's gates.

- `govern process list` shows them; built in are `video`, `ops` and `dev` (plan → build → test → review → done). `govern process show <name>` prints the stages, checks and gates. A workspace adds its own as JSON in its processes folder; a file with a built-in's name overrides it. A process file is parsed strictly: `version` 1, `name`, `stages` (`{name, exit?, check?, requires?: "check"}`), and optionally `description`, `kinds`, `exitFrom: "workflow"` and `gates` (`{name, stage?, needs?, message?, owner?}`; `owner` is who decides the gate, default "owner"). An unknown key, a wrong type, a duplicate stage or gate name, a gate naming a stage or gate that does not exist, or gates that need each other stops every command with exit 2, naming the file and the JSON path (`$.stages[1].chek`). Fix the file; nothing guesses past it. A lane's govern.json is parsed the same way: only the keys govern writes, each of its type (a command is an argv array or `{argv, timeout?}` with a whole-number timeout), `slug` equal to the lane's folder, a process that exists with a kind that fits it, a `stage` and `checks` keys that are the process's stages, and timestamps in ISO form. A bad govern.json stops a command on that lane with exit 2; `govern status` and `govern desk` still list every other lane, show the bad one as a `✖` row with its file, path and message, and then exit 1. Change a lane through govern commands, not by editing the file.
- `govern new <slug> --process dev --title "…"` starts a lane on that process. A folder with a `govern.config.json` (`{"projects", "queue", "processes"}`) is its own workspace, so a different team or project runs govern without PALS Notes.
- **Exit checks.** A stage whose process names a check (dev's test stage checks `test`) is done only when that command passes: `govern cmd <slug> test -- <command>` names it once, and `govern check <slug> --set <cmd> --stage <stage>` points any other stage at a command. `govern check <slug>` runs the check now. Every `--set` goes into the ledger (from: the stage's check before it, the lane's own or the process's; to), and so does every `govern cmd` set or `--rm` (the command before and after, as govern.json stores it, and the stages whose check it is). A **swap** is flagged: a stage's existing check pointed at another command, or a command that is some stage's check redefined or removed. Setup is not: a stage with no check getting one, a command defined for the first time. The brief shows a ⚠ line for every stage with a flagged swap, whatever stage the lane is at, until the lane is finished or the owner accepts it with `govern check <slug> <stage> --accept --quote "<exactly what the owner said>"`, which clears that stage's changes made before it (a later swap is flagged again). Nothing else clears it: not the check passing (a gamed check is what passes), not moving back and forth, not leaving the stage. An acceptance is the owner's, like an approval: never infer it, and never accept for the owner. Setting a check or a command to what it already is changes nothing (no ledger entry, no ⚠); the same argv with another `--timeout` is a change. Never swap a failing check, or the command it names, for one that passes.
- **Timeouts.** A command run in the foreground (a check, `govern run` without `--bg`) gets 30 minutes unless `govern cmd <slug> <name> --timeout <seconds> -- <command>` gives it its own limit. Past it, the job's processes (as **Stopping a job** counts them) get SIGTERM, then whatever is left gets SIGKILL 3 seconds later; the job reads `timeout` and the check fails as "timed out after Ns". A foreground command stays in govern's process group, so Ctrl-C stops it together with govern. The timeout is kept by the govern that waits on the command: if that govern is killed some other way (by its pid, with no signal to its group), the command runs on with no limit and its job reads `running`; `govern kill <slug>` stops it and records its end.
- **Stopping a job.** `govern kill <slug> [<job>]` stops the lane's latest running job (or the one named), and the job reads `killed`. A job's processes are its own process and its descendants, for a `--bg` job every process in its process group, and, where `/proc` shows process environments (Linux), every process whose environment carries the job's `GOVERN_JOB_DIR` (every process the job starts inherits it, so one that double-forks out of the tree or moves to its own group with `setsid` is still found, also after the job's own process has exited). Limit: a process that leaves the job's tree and group and also drops `GOVERN_JOB_DIR` from its environment (or any process that leaves them, where there is no `/proc`) escapes. The job's own pid is signalled only while its start time says it is still that job: a job that ended long ago may have left its pid to an unrelated process. A stop never signals the govern doing it or that govern's parents, so a job that runs `govern kill` on its own lane does not kill the command it ran from. A stopped job reads `running` until its last process is gone; one that then turns out to have exited on its own (an exit code under 128) reads by that code instead. `<job>` is a job id, a unique prefix of one, or a command name (that command's newest job). A job's end goes into the ledger once, by whichever govern sees it end first: the foreground `govern run` (or check) that ran it, or a `govern wait` or `govern kill` on it; a `--bg` job nobody waits on or kills has only its start in the ledger. Never `kill` a job's pid by hand.
- **Advance.** `govern advance <slug>` runs the stage's check and moves on only if it passes, no owner gate holds the stage and no lane it waits on is behind. A stage with no check needs `--note "<evidence>"`; the ledger's advance entry records whether the check or the note passed the stage, and the note's words. A stage marked `"requires": "check"` (dev's test stage) passes only on a check: with none set, advance refuses a note and names the `govern check --set` to run. `govern work <slug> <later stage>` holds every skipped stage to the same rules and refuses otherwise; going back to rework a stage is always allowed. Never edit govern.json to skip a stage.
- **Dependencies.** `govern dep <slug> --after <lane>[:<stage>]`. `govern status` and the desk show each lane as ready or blocked, and on what. A dependency that would close a cycle is refused.
- **Stop hook.** `govern hook stop` runs as a Claude Code Stop hook. While this session's lane has a failing check, it refuses the stop and prints the failure and the next command (at most 3 times per work segment). Fix the cause, don't argue with the hook.
- **Runners.** The queue's `config.json` can add runners beside codex and claude (`"runners": {NAME: {"argv": [...], "format": "text"|"json-result"}}`) and caps a thread at `maxRuns` (default 4), after which it goes to the owner as BLOCKED.
- govern improves itself this way: its own work runs as the `ops/govern` lane on the `dev` process, with the govern test suite as the test check.

## The loop

The owner says what to change. Then:

1. **Read narrowly.** Open only the file the change touches, and only the part you need (grep, offset or limit). Don't re-read what is already in this conversation.
2. **Edit the source.** Scene files are generated, so edit the builder, never the XML.
3. **Build without waiting in the model.** Run `govern run <slug> preview --bg`, then `govern wait <slug>`.
   - In Claude Code, run the wait as one Bash call with `run_in_background: true`. You are notified when it ends, and no tokens are spent while it runs. Never write sleep or poll loops, and never check a job repeatedly.
   - `wait` prints the exit code, the new files and the last 12 log lines. Use `govern log <slug> --grep RE` only if those lines don't explain a failure.
   - `govern jobs <slug>` lists the lane's latest jobs (status, exit code, seconds), for when you need a job id or an older result.
4. **Show the result.**
   - Give the owner the sheet's or preview's path to open.
   - Read an image yourself only when you must judge it. An image stays in the context for the rest of the session, so read one sheet once, not every frame.
   - State what you measured and what you could not judge. You cannot watch motion or hear audio.
5. **Record the decision** as soon as it is made, in one line: `govern note <slug> "scene 3: slower zoom, hold 2 s on the label"`. The next session starts from these notes, not from this chat.

Keep replies short: what changed, what to look at, and the open question. No long reports or tables unless asked.

## Steps that go to Codex

These steps run as one verified Codex call each, not as chat work in this session:

| Step | Command |
|---|---|
| Hook options for a Short | `govern ask <slug> hooks --file <script> [--var direction="…"]` |
| Title, description, chapters, pinned comment | `govern ask <slug> metadata --file <script> --file <timings or publication notes>` |
| Fact-check against saved evidence | `govern ask <slug> factcheck --file <script> --file CLAIMS-LEDGER.md` |
| Script review (style guide, read-aloud checks, story questions) | `govern ask <slug> script-review --file <script>` |
| English → spoken pt-BR | `govern ask <slug> ptbr --file <script>` |

- Output is JSON, checked against a schema and the house rules, with one automatic repair.
- Exit 3 means it failed verification. Say so; don't patch the output by hand and present it as verified.
- Present the result in a few lines, and give the owner the JSON path for the full text.
- Images can be added with `--image sheet.png`. `govern prompts` lists the steps.
- The ledger's `ask` entry records what was sent: `promptSha` (sha256 of the rendered prompt, the first call's stdin byte for byte), `callShas` (every call's stdin, a repair included) and `schemaSha` (sha256 of the schema file codex was given; absent for a step with no schema).

## Asking another agent: the task queue

Do not message other sessions, and do not start subagents. Put the request in the queue:

```bash
govern task send --to codex|claude|<session> --project <slug> --task <name> --kind TASK --summary "…" --body "…" --file <repo-relative path>
```

- `govern task dispatch`, or the timer `govern task dispatch --loop`, starts one fresh headless session per message: `codex exec` or `claude -p` (Sonnet). The session gets only the message, its thread and the named files. The reply is verified JSON (ACK, REVIEW, HANDOFF, BLOCKED…) and is filed back to the sender. A reply that fails verification becomes a BLOCKED notice from the dispatcher, never an answer; the whole reply is kept in the file the notice names (`whole reply: …`), so read it there instead of re-running the task. `govern task install-service [--interval 30]` writes a user systemd service that runs the loop across sessions and reboots, and prints the `systemctl --user` line that enables it.
- Nothing runs while the queue waits. Read replies with `govern task list --to <you>` and `govern task show <id>`, once, when the owner asks or the work needs them, not in a loop.
- `--to` must be `codex`, `claude`, `auto`, `owner` or the name of a live Claude Code session (`~/.claude/sessions`); an unknown or dead name fails and lists the live ones. **Sessions are not woken by the queue** (the dispatcher runs only codex and claude): after sending to one, also tell it `govern task show <id>` with SendMessage.
- Your own mail: `govern task inbox` (open messages for you; `--all` adds closed). Answer with `govern task reply <id> --kind ACK|REVIEW|HANDOFF|... --summary … --body …` (files the reply to the sender and closes the original), `govern task close <id> --note …` when nothing needs saying, `govern task forward <id> --to <name>` when it went to the wrong name. Your name is `GOVERN_AS`, else found from your process tree; pass `--as NAME` if neither works. `govern task inbox --hook` prints a short block only when mail waits, for a UserPromptSubmit/SessionStart hook.
- The sender is you: `--from` defaults to your session's name (as for `--as`), so replies come back to your inbox. Never send as `owner`. The owner has no inbox; anything that needs him goes to him directly in the conversation, at once.
- Prefer `--to codex` for checks: in the 2026-10-12 pilot, the same fact-check took 56k tokens and 29 s on Codex, against 122k tokens, 67 s and $0.83 on `claude -p`.
- `--write` lets the runner change files in the project folder. Default is read-only.

## The owner's gates

- **Approvals** come only from the owner's own words. Record them verbatim: `govern approve <slug> <gate> --quote "<exactly what the owner said>"`. Never infer an approval, and never approve for the owner. **What govern checks.** Inside a Claude Code session the quote must appear (case, spacing and typographic quotes ignored; a part of a message is enough) in a message the person typed in this session's transcript, not in tool output, a file, pasted content, a reminder, or another session's or a task's message. If it is not found, `approve` fails (exit 1) and says where it looked; do not rephrase until it passes: ask the person. The approval records the session and message (`source`) in govern.json and the ledger. From a plain terminal, nothing is in a transcript to check, so the approval is recorded as typed by the OS user. A Codex session is refused (govern cannot verify it): the person approves from their own terminal or a Claude session. A gate whose process names an `owner` other than "owner" (say `editor`) needs `--by editor`, and the approval records whose words they were. **What this does not guarantee:** it raises the bar from "any string" to "words in the person's own turn". It is not tamper-proof: an agent that can edit transcript files or the session registry can forge a typed message, and an old message that happens to contain the quote still matches. The check is a guard against your own mistakes, not a licence to approve for the person. The same holds for accepting a change to a check (`govern check <slug> <stage> --accept --quote "…"`).
- **The owner sees complete drafts,** not intermediate passes. State the farm pass cost and the film's total when you deliver.
- **Publish.** `govern publish <slug>` checks the approvals and the filed package, then prints the smm commands. Run those printed commands through Bash, unchanged, so the publish guard sees them. Only do this after the owner's go in this session.

## Never, in production work

- No subagents, Agent tool or Workflow. One session does the video. A real engine bug goes to e4 as a request (PALS-Notes/docs/engine/patches/), not to an agent cascade.
- No messages to other sessions. State lives in `govern.json`, and `govern status` answers "where is it".
- No heavy work on WSL. Renders, encodes, TTS and Whisper run on the VMs or farm through the video's commands (`vmrun.sh`, `farm-pool.sh`).
- No long logs or whole files pasted into the chat.
- No overwriting an approved file. Write the new one beside it with a suffix.

## Keep the context small

- Every govern command warns when this session reads more than 150k tokens per call. `govern ctx` shows the number.
- Context is the session's own job; never ask the owner to `/clear` or restart. When it warns:
  1. Record what is open with `govern note` (or memory), so nothing depends on the chat.
  2. Offload model work to Codex with `govern task send --to codex`, and wait on jobs in the background.
  3. Let auto-compaction shrink the rest. The dispatcher runs `govern tune` hourly, and it sets the compaction window.
- One session covers one video and one stage at a time. For another video, run `govern done <slug>` and start a fresh session.
- `govern work <slug> <stage> --open [--engine codex|claude]`, from a terminal, starts a fresh interactive session for one video.

## Measure

`govern usage [<slug>] [--since YYYY-MM-DD]` shows, per work segment:
- calls;
- input-side tokens;
- output tokens;
- average and maximum context per call;
- cache share;
- the owner's turns, and tokens per owner message;
- `~usd` (where priced);
- the Codex `ask` steps;
- Claude Code tool calls, shown when non-zero: `tools`, `repeats` (same tool and input as an earlier call in the segment), `polls` (Bash commands that invoke `sleep` with an operand, by any path, as a command of their own: at the start, after `;`, `&&`, `||`, `|`, `&`, `(`, `{`, a newline or `then`/`do`/`else`, inside `$( … )` or backquotes, after `env`, `nice`, `timeout`, `time`, `command`, `exec` or `nohup`, or in a `bash -c`/`sh -c` script; `sleep` as an argument or inside quotes, such as `grep sleep` or `echo "sleep 5"`, is not a poll, and neither is `govern wait`), `agents` (Agent or Task spawns) and `big reads` (a Read with no offset or limit that returned over 40,000 characters).

It compares these with the chat baseline (468k context per call). Report it when the owner asks, or when a video is delivered, alongside the farm cost per pass.
