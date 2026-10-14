---
name: govern
description: Work on a lane of agent work (a video, software, ops, an audit, govern itself) that follows a process, through the govern CLI at a fraction of the tokens. Use whenever the conversation is about making, changing, checking or finishing a specific piece of such work, or about moving a govern lane through its stages.
---

# Working with govern

You and the owner do the work together; `govern` keeps that conversation cheap and keeps the work in files. A lane of work follows a **process** (its stages, exit conditions, checks and the owner's gates), and nothing in govern knows one kind of work: a new kind is a new process description. The money in agent work goes into four things, and the rules below remove them:
- re-reading a huge context on every call;
- polling long jobs from inside the model;
- review and fix agent cascades;
- sessions messaging each other.

A process may own a manual with the rules of its kind of work (for example how a build runs or what its steps must say). The brief names it when it does (`manual: govern manual <process>`); read it once, then work from the brief. `govern manual <process>` prints it.

## Start

The owner's one screen is `govern desk`: every lane, their inbox, the queue and today's tokens. One session works one lane; the other lanes wait in their files, not in open chat tabs.

1. `govern status` lists the lanes. If the lane is not there, run `govern new <slug> --process <name> --title "…"` (`govern process list` shows the processes; a process with kinds also takes `--kind` and `--lang`; `--parent <lane>` links a lane to another). The slug is its folder under the workspace's projects folder.
2. `govern work <slug> <stage>`. The stages are the process's own (`govern process show <name>`). This opens a measured work segment and prints the **brief**:
   - stage and exit condition;
   - approvals;
   - named files;
   - commands;
   - last jobs;
   - recent decisions.

   The segment's `work` ledger entry carries `skillSha`, the sha256 of this manual (tools/govern/SKILL.md) when the segment opened, so a segment can be matched to the rules it ran under; `--open` records it too.

   `govern brief <slug>` prints the brief again without opening a segment. Work from the brief; do not read the workspace's long process documents in full. The brief carries the exit condition, and `govern ask` carries the rules each step needs.
3. If the lane's commands or files are not named yet, name them once (a process can do this at `govern new`, from its `setup`):
   - `govern cmd <slug> build -- {python} build.py --preview`. Placeholders: `{python}`, `{repo}`, `{dir}`, and `{paths.NAME}` for a path the workspace's config names under `paths`.
   - `govern file <slug> report summary.json`
   - `govern file <slug> sheet "out/**/*sheet*.png"`. A glob means its newest match.

`govern help` lists every command with its flags; `govern help <command>` (or `govern <command> --help`) shows one. The command comes first, then its subcommand (`govern task send …`), then arguments and flags. A flag the command does not take, a switch given a value other than true or false, and a value flag with no value are refused (exit 2) with the command's valid flags. A value flag takes the next word as its value even when it starts with `--` (`--note "--verbose test passes"`), unless that word is itself a govern flag (`--note --bg` forgot the note); give such a value as `--flag=VALUE`. `govern manual` prints this manual and lists the processes that have their own; `govern manual <process>` prints that one; `govern install-skill [<skills dir>]` installs it as the govern skill (default: the repo's `.claude/skills`): it writes a temp file beside the destination, renames it into place, and reads it back by sha256, failing (exit 1) on a mismatch without replacing a good copy. `govern install-skill [<skills dir>] --check` installs nothing: it exits 0 when the installed copy is byte for byte this file, and 1, naming both paths and both sha256s, when it differs or is missing.

## Any process, any group of agents

govern is not tied to video. A lane follows a **process**: stages, the exit condition of each, the command that checks it, and the owner's gates.

- `govern process list` shows them; built in are `video`, `ops` and `dev` (plan → build → test → review → done); the video process carries its own manual, prompts and setup under `processes/video/`. `govern process show <name>` prints the stages, checks and gates. A workspace adds its own as JSON in its processes folder; a file with a built-in's name overrides it. A process file is parsed strictly: `version` 1, `name`, `stages` (`{name, exit?, check?, requires?: "check"}`), and optionally `description`, `kinds`, `exitFrom: "workflow"`, `gates` (`{name, stage?, needs?, message?, owner?}`; `owner` is who decides the gate, default "owner"), `manual` (the process's manual file), `prompts` (its prompts folder) and `setup` (groups of `commands` and `files` a new lane starts with, a group with `ifFile` only when that file is in the lane's folder). The paths in a process file are relative to it. An unknown key, a wrong type, a duplicate stage or gate name, a gate naming a stage or gate that does not exist, or gates that need each other stops every command with exit 2, naming the file and the JSON path (`$.stages[1].chek`). Fix the file; nothing guesses past it. A lane's govern.json is parsed the same way: only the keys govern writes, each of its type (a command is an argv array or `{argv, timeout?}` with a whole-number timeout), `slug` equal to the lane's folder, a process that exists with a kind that fits it, a `stage` and `checks` keys that are the process's stages, and timestamps in ISO form. A bad govern.json stops a command on that lane with exit 2; `govern status` and `govern desk` still list every other lane, show the bad one as a `✖` row with its file, path and message, and then exit 1. Change a lane through govern commands, not by editing the file.
- `govern new <slug> --process dev --title "…"` starts a lane on that process.
- **The workspace.** govern works in the folder named by `GOVERN_REPO`, else the nearest folder at or above the current directory that holds a `govern.config.json`; with neither it stops and says so, and guesses no default. The file (`projects` required, and `queue`, `processes`, `workflow`, `tuningLog`, `packages`, `prompts`, `paths`, `baseline`, `capabilities`, `resources`, `state`; paths relative to the file, strict like a process file) says where a lane, the queue, the processes and the tuning log live. A command that needs a key the file lacks names the file and the key. The env overrides (`GOVERN_PROJECTS`, `GOVERN_QUEUE`, `GOVERN_PROCESSES`, `GOVERN_WORKFLOW`, `GOVERN_PROMPTS`, `GOVERN_TUNING_LOG`, `GOVERN_CAPABILITIES`, `GOVERN_RESOURCES`, `GOVERN_STATE`) win over the file. A different team or project runs govern with a config and its own processes folder, with no change to govern.
- **Exit checks.** A stage whose process names a check (dev's test stage checks `test`) is done only when that command passes: `govern cmd <slug> test -- <command>` names it once, and `govern check <slug> --set <cmd> --stage <stage>` points any other stage at a command. `govern check <slug>` runs the check now. Every `--set` goes into the ledger (from: the stage's check before it, the lane's own or the process's; to), and so does every `govern cmd` set or `--rm` (the command before and after, as govern.json stores it, and the stages whose check it is). A **swap** is flagged: a stage's existing check pointed at another command, or a command that is some stage's check redefined or removed. Setup is not: a stage with no check getting one, a command defined for the first time. The brief shows a ⚠ line for every stage with a flagged swap, whatever stage the lane is at, until the lane is finished or the owner accepts it with `govern check <slug> <stage> --accept --quote "<exactly what the owner said>"`, which clears that stage's changes made before it (a later swap is flagged again). Nothing else clears it: not the check passing (a gamed check is what passes), not moving back and forth, not leaving the stage. An acceptance is the owner's, like an approval: never infer it, and never accept for the owner. Setting a check or a command to what it already is changes nothing (no ledger entry, no ⚠); the same argv with another `--timeout` is a change. Never swap a failing check, or the command it names, for one that passes.
- **Timeouts.** A command run in the foreground (a check, `govern run` without `--bg`) gets 30 minutes unless `govern cmd <slug> <name> --timeout <seconds> -- <command>` gives it its own limit. Past it, the job's processes (as **Stopping a job** counts them) get SIGTERM, then whatever is left gets SIGKILL 3 seconds later; the job reads `timeout` and the check fails as "timed out after Ns". A foreground command stays in govern's process group, so Ctrl-C stops it together with govern. The timeout is kept by the govern that waits on the command: if that govern is killed some other way (by its pid, with no signal to its group), the command runs on with no limit and its job reads `running`; `govern kill <slug>` stops it and records its end.
- **Resources.** `govern.config.json` declares the machines, services and accounts a job may run on (`"resources": [...]` or a path to a file of them; `GOVERN_RESOURCES` names another file): `name`, `kind` (free text), `sharing` (`shared`, or `dedicated` with `to`: a lane slug or a folder like `bench/`), `price` (`free`, or `per-second`/`per-hour` with `currency` and `amount`, or `per-month` with `amount`), `allowance` (`text`, optional `maxJobs`, `maxMachines`) and optional `start`, `stop`, `list` argv lists. `govern resources` lists them; `govern resources <name>` shows one with its lock holders and the queue behind it. `govern run <slug> <cmd> --on <resource>` runs the job there, and `govern cmd <slug> <name> --resource <resource> -- ...` makes `--on` implied for that command. A shared resource takes a crash-safe lock (one job at a time unless `maxJobs` says more; a holder that died is reclaimed by its pid and start time), and a job over the limit waits first in, first out: foreground `run` waits in place, a `--bg` job reads `queued on <resource>` in `govern jobs`, and `govern wait` covers the wait with no model involved. A dedicated resource refuses lanes it is not dedicated to. **Benchmark jobs name a dedicated resource** (`--on <bench machine>`), so their timings are never taken beside other work. Every job records its resource (`local` when none) and its wall seconds in the ledger; a `per-second` or `per-hour` resource also gives money in its currency (price as it was when the job started), and `per-month` gives seconds only. `govern usage` and `govern desk` show machine seconds and money beside tokens, per lane. Limits: `maxMachines` is information for the owner, not enforced; the lock is a directory lock under `govern-state/locks` (set `GOVERN_STATE` to move it), not an OS flock.
- **Stopping a job.** `govern kill <slug> [<job>]` stops the lane's latest running job (or the one named), and the job reads `killed`. A job's processes are its own process and its descendants, for a `--bg` job every process in its process group, and, where `/proc` shows process environments (Linux), every process whose environment carries the job's `GOVERN_JOB_DIR` (every process the job starts inherits it, so one that double-forks out of the tree or moves to its own group with `setsid` is still found, also after the job's own process has exited). Limit: a process that leaves the job's tree and group and also drops `GOVERN_JOB_DIR` from its environment (or any process that leaves them, where there is no `/proc`) escapes. The job's own pid is signalled only while its start time says it is still that job: a job that ended long ago may have left its pid to an unrelated process. A stop never signals the govern doing it or that govern's parents, so a job that runs `govern kill` on its own lane does not kill the command it ran from. A stopped job reads `running` until its last process is gone; one that then turns out to have exited on its own (an exit code under 128) reads by that code instead. `<job>` is a job id, a unique prefix of one, or a command name (that command's newest job). A job's end goes into the ledger once, by whichever govern sees it end first: the foreground `govern run` (or check) that ran it, or a `govern wait` or `govern kill` on it; a `--bg` job nobody waits on or kills has only its start in the ledger. Never `kill` a job's pid by hand.
- **Advance.** `govern advance <slug>` runs the stage's check and moves on only if it passes, no owner gate holds the stage and no lane it waits on is behind. A stage with no check needs `--note "<evidence>"`; the ledger's advance entry records whether the check or the note passed the stage, and the note's words. A stage marked `"requires": "check"` (dev's test stage) passes only on a check: with none set, advance refuses a note and names the `govern check --set` to run. `govern work <slug> <later stage>` holds every skipped stage to the same rules and refuses otherwise; going back to rework a stage is always allowed. Never edit govern.json to skip a stage.
- **Dependencies.** `govern dep <slug> --after <lane>[:<stage>]`. `govern status` and the desk show each lane as ready or blocked, and on what. A dependency that would close a cycle is refused.
- **Stop hook.** `govern hook stop` runs as a Claude Code Stop hook. While this session's lane has a failing check, it refuses the stop and prints the failure and the next command (at most 3 times per work segment). Fix the cause, don't argue with the hook.
- **Runners.** The queue's `config.json` can add runners beside codex and claude (`"runners": {NAME: {"argv": [...], "format": "text"|"json-result"}}`) and caps a thread at `maxRuns` (default 4), after which it goes to the owner as BLOCKED.
- **Capabilities and profiles.** A capability is one grant (name, how it is called, Claude permission patterns, the Codex equivalent or "not available on codex", a side-effect class `read|write|spend|publish|push`, an optional resource and cost basis, secret NAMES only, never values). A profile is capabilities plus an engine and model. `govern caps` lists both, `govern caps <profile>` shows one's patterns, Codex mapping, classes and secret names. Built-ins ship with govern (`tools/govern/capabilities/*.json`: read, edit, web, gh-read; profiles claude-read, claude-write, codex-read, codex-write, researcher); a workspace adds or overrides its own in a `capabilities/` folder (`GOVERN_CAPABILITIES`, else `govern.config.json` `"capabilities"`, else beside `projects`). `--to claude|codex` is the profile `claude-read`/`claude-write`/`codex-read`/`codex-write` and `--write` picks the write one. A queued run is sealed to its profile: `--allowedTools` from its patterns, `--setting-sources ""` and `--strict-mcp-config` (only the profile's own `--mcp-config`) for Claude; the sandbox and `-c` settings for Codex. The task records its profile (`task show`, `desk`). A profile holding a spend, publish or push capability runs only for a task tied to a lane (`--lane`, else the project) whose gate of that name is approved; send and dispatch both refuse otherwise and name the gate. A queue config runner with the same name as a profile shadows it and runs unsealed (`govern caps` warns).
- **Grant self-test.** `govern caps --check <profile>` runs one probe per capability in a sealed session (model haiku, `GOVERN_CAPS_CHECK_MODEL` to change), each answered as strict JSON `{capability, status: ok|refused|error, evidence}`; govern verifies the answer (a random nonce, a file it reads itself) and an unparseable or unverified reply is a failed check. The result is recorded in `<queue>/checks/<profile>.json` with the profile's content hash. The dispatcher refuses a profile whose last check failed or predates its current definition, and a profile that requires a check (the default, except the four legacy ones) and has none.
- govern improves itself this way: its own work runs as the `ops/govern` lane on the `dev` process, with the govern test suite as the test check.

## The loop

The owner says what to change. Then:

1. **Read narrowly.** Open only the file the change touches, and only the part you need (grep, offset or limit). Don't re-read what is already in this conversation.
2. **Edit the source.** Edit what generates a file, never the generated file.
3. **Build without waiting in the model.** Run `govern run <slug> <command> --bg`, then `govern wait <slug>`.
   - In Claude Code, run the wait as one Bash call with `run_in_background: true`. You are notified when it ends, and no tokens are spent while it runs. Never write sleep or poll loops, and never check a job repeatedly.
   - `wait` prints the exit code, the new files and the last 12 log lines. Use `govern log <slug> --grep RE` only if those lines don't explain a failure.
   - `govern jobs <slug>` lists the lane's latest jobs (status, exit code, seconds), for when you need a job id or an older result.
4. **Show the result.** Give the owner the path to open. Read an image yourself only when you must judge it: it stays in the context for the rest of the session. State what you measured and what you could not judge.
5. **Record the decision** as soon as it is made, in one line: `govern note <slug> "chose the second supplier file; first had no totals"`. The next session starts from these notes, not from this chat.

Keep replies short: what changed, what to look at, and the open question. No long reports or tables unless asked.

## Steps that go to Codex

A step is a prompt: a markdown file with a front matter (`effort`, `model`, `repairs`, `schema`, `rules`) that a process names in its `prompts` folder (or the workspace's config names in `prompts`). It runs as one verified Codex call, not as chat work in this session: `govern ask <slug> <step> [--file F]… [--var K=V]…`. `govern prompts [<process>]` lists the steps. `schema:` is a JSON schema and `rules:` a JSON array of house rules, both relative to the prompt file; a rule is `{at, message, <one test>}`, `at` a path (`items[].text`, `[]` walks an array, `at` may be a list), the tests `forbid` and `require` (a regular expression, with `flags`), `maxWords`, `maxItems`, `minItems`, `equals`, `indexOf` (the value must index the array at that path), an optional `when: {kind}`, and a message that may use `{at}`, `{n}` and `{match}`. The step's `govern manual <process>` says which steps its work has.

- Output is JSON, checked against a schema and the house rules, with one automatic repair.
- Exit 3 means it failed verification. Say so; don't patch the output by hand and present it as verified.
- Present the result in a few lines, and give the owner the JSON path for the full text.
- Images can be added with `--image sheet.png`.
- The ledger's `ask` entry records what was sent: `promptSha` (sha256 of the rendered prompt, the first call's stdin byte for byte), `callShas` (every call's stdin, a repair included) and `schemaSha` (sha256 of the schema file codex was given; absent for a step with no schema).

## Asking another agent: the task queue

Do not message other sessions, and do not start subagents. Put the request in the queue:

```bash
govern task send --to codex|claude|<profile>|<session> --project <slug> --task <name> --kind TASK --summary "…" --body "…" --file <repo-relative path> [--profile <name>] [--lane <slug>]
```

- `govern task dispatch`, or the timer `govern task dispatch --loop`, starts one fresh headless session per message: `codex exec` or `claude -p` (Sonnet). The session gets only the message, its thread and the named files. The reply is verified JSON (ACK, REVIEW, HANDOFF, BLOCKED…) and is filed back to the sender. A reply that fails verification becomes a BLOCKED notice from the dispatcher, never an answer; the whole reply is kept in the file the notice names (`whole reply: …`), so read it there instead of re-running the task. `govern task install-service [--interval 30]` writes a user systemd service that runs the loop across sessions and reboots, and prints the `systemctl --user` line that enables it.
- Nothing runs while the queue waits. Read replies with `govern task list --to <you>` and `govern task show <id>`, once, when the owner asks or the work needs them, not in a loop.
- `--to` must be `codex`, `claude`, `auto`, `owner` or the name of a live Claude Code session (`~/.claude/sessions`); an unknown or dead name fails and lists the live ones. **Sessions are not woken by the queue** (the dispatcher runs only codex and claude): after sending to one, also tell it `govern task show <id>` with SendMessage.
- Your own mail: `govern task inbox` (open messages for you; `--all` adds closed). Answer with `govern task reply <id> --kind ACK|REVIEW|HANDOFF|... --summary … --body …` (files the reply to the sender and closes the original), `govern task close <id> --note …` when nothing needs saying, `govern task forward <id> --to <name>` when it went to the wrong name. Your name is `GOVERN_AS`, else found from your process tree; pass `--as NAME` if neither works. `govern task inbox --hook` prints a short block only when mail waits, for a UserPromptSubmit/SessionStart hook.
- The sender is you: `--from` defaults to your session's name (as for `--as`), so replies come back to your inbox. Never send as `owner`. The owner has no inbox; anything that needs him goes to him directly in the conversation, at once.
- Prefer `--to codex` for checks: in a pilot, the same fact-check took 56k tokens and 29 s on Codex, against 122k tokens, 67 s and $0.83 on `claude -p`.
- `--write` lets the runner change files in the project folder. Default is read-only. `--profile <name>` picks another profile of the engine instead (not with `--write`: the profile decides what may change); `--to <profile>` addresses a profile directly (for example `researcher`).

## The owner's gates

- **Approvals** come only from the owner's own words. Record them verbatim: `govern approve <slug> <gate> --quote "<exactly what the owner said>"`. Never infer an approval, and never approve for the owner. **What govern checks.** Inside a Claude Code session the quote must appear (case, spacing and typographic quotes ignored; a part of a message is enough) in a message the person typed in this session's transcript, not in tool output, a file, pasted content, a reminder, or another session's or a task's message. If it is not found, `approve` fails (exit 1) and says where it looked; do not rephrase until it passes: ask the person. The approval records the session and message (`source`) in govern.json and the ledger. From a plain terminal, nothing is in a transcript to check, so the approval is recorded as typed by the OS user. A Codex session is refused (govern cannot verify it): the person approves from their own terminal or a Claude session. A gate whose process names an `owner` other than "owner" (say `editor`) needs `--by editor`, and the approval records whose words they were. **What this does not guarantee:** it raises the bar from "any string" to "words in the person's own turn". It is not tamper-proof: an agent that can edit transcript files or the session registry can forge a typed message, and an old message that happens to contain the quote still matches. The check is a guard against your own mistakes, not a licence to approve for the person. Accepting a change to a check (`govern check <slug> <stage> --accept --quote "…"`) is checked the same way and records its `source` in the ledger.
- **The owner sees complete drafts,** not intermediate passes.
- **Publish.** `govern publish <slug>` is for a lane of a process with the gates `final` and `publish`: it checks both approvals and the filed package (the config's `packages` folder), then prints the publishing commands. Run those printed commands through Bash, unchanged, so a publish guard sees them. Only do this after the owner's go in this session.

## Never, in production work

- No subagents, Agent tool or Workflow. One session works one lane. An engine or tool bug goes to its owner as a queue request, not to an agent cascade.
- No messages to other sessions. State lives in `govern.json`, and `govern status` answers "where is it".
- No heavy work on the machine the owner works on: builds and renders run where the lane's commands say.
- No long logs or whole files pasted into the chat.
- No overwriting an approved file. Write the new one beside it with a suffix.

## Keep the context small

- Every govern command warns when this session reads more than 150k tokens per call. `govern ctx` shows the number.
- Context is the session's own job; never ask the owner to `/clear` or restart. When it warns:
  1. Record what is open with `govern note` (or memory), so nothing depends on the chat.
  2. Offload model work to Codex with `govern task send --to codex`, and wait on jobs in the background.
  3. Let auto-compaction shrink the rest. The dispatcher runs `govern tune` hourly, and it sets the compaction window.
- One session covers one lane and one stage at a time. For another lane, run `govern done <slug>` and start a fresh session.
- `govern work <slug> <stage> --open [--engine codex|claude]`, from a terminal, starts a fresh interactive session for one lane.

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

It compares these with the chat baseline the workspace's config gives under `baseline` (omitted when there is none). Report it when the owner asks, or when a lane is delivered.
