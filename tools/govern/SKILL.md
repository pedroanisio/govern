---
name: govern
description: Work on a PALS Notes video (script, sound, preview, fixes, metadata, publishing) with the owner through the govern CLI, at a fraction of the tokens. Use whenever the conversation is about making, changing, checking or publishing a specific video or Short.
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
2. `govern work <slug> <stage>`. For a video, stage is one of plan, script, script-check, sound, preview, produce, final or deliver. For an `ops` lane (engine, lab, docs, channel set-up), it is plan, doing, review or done. This opens a measured work segment and prints the **brief**:
   - stage and exit condition;
   - approvals;
   - named files;
   - commands;
   - last jobs;
   - recent decisions.

   Work from the brief. Do not read WORKFLOW.md, CHECKLIST.md, the style guide or old reports in full. The brief carries the exit condition, and `govern ask` carries the rules each step needs.
3. If the video's build commands or files are not named yet, name them once:
   - `govern cmd <slug> preview -- {python} build_short1.py --preview`. Placeholders: `{python}`, `{repo}`, `{dir}`.
   - `govern file <slug> script short-1.screenplay.json`
   - `govern file <slug> sheet "renders/**/*sheet*.png"`. A glob means its newest match.

## The loop

The owner says what to change. Then:

1. **Read narrowly.** Open only the file the change touches, and only the part you need (grep, offset or limit). Don't re-read what is already in this conversation.
2. **Edit the source.** Scene files are generated, so edit the builder, never the XML.
3. **Build without waiting in the model.** Run `govern run <slug> preview --bg`, then `govern wait <slug>`.
   - In Claude Code, run the wait as one Bash call with `run_in_background: true`. You are notified when it ends, and no tokens are spent while it runs. Never write sleep or poll loops, and never check a job repeatedly.
   - `wait` prints the exit code, the new files and the last 12 log lines. Use `govern log <slug> --grep RE` only if those lines don't explain a failure.
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

## Asking another agent: the task queue

Do not message other sessions, and do not start subagents. Put the request in the queue:

```bash
govern task send --to codex|claude|<session> --project <slug> --task <name> --kind TASK --summary "…" --body "…" --file <repo-relative path>
```

- `govern task dispatch`, or the timer `govern task dispatch --loop`, starts one fresh headless session per message: `codex exec` or `claude -p` (Sonnet). The session gets only the message, its thread and the named files. The reply is verified JSON (ACK, REVIEW, HANDOFF, BLOCKED…) and is filed back to the sender. A reply that fails verification becomes a BLOCKED notice from the dispatcher, never an answer.
- Nothing runs while the queue waits. Read replies with `govern task list --to <you>` and `govern task show <id>`, once, when the owner asks or the work needs them, not in a loop.
- `--to` must be `codex`, `claude`, `auto`, `owner` or the name of a live Claude Code session (`~/.claude/sessions`); an unknown or dead name fails and lists the live ones. **Sessions are not woken by the queue** (the dispatcher runs only codex and claude): after sending to one, also tell it `govern task show <id>` with SendMessage.
- Your own mail: `govern task inbox` (open messages for you; `--all` adds closed). Answer with `govern task reply <id> --kind ACK|REVIEW|HANDOFF|... --summary … --body …` (files the reply to the sender and closes the original), `govern task close <id> --note …` when nothing needs saying, `govern task forward <id> --to <name>` when it went to the wrong name. Your name is `GOVERN_AS`, else found from your process tree; pass `--as NAME` if neither works. `govern task inbox --hook` prints a short block only when mail waits, for a UserPromptSubmit/SessionStart hook.
- The sender is you: `--from` defaults to your session's name (as for `--as`), so replies come back to your inbox. Never send as `owner`. The owner has no inbox; anything that needs him goes to him directly in the conversation, at once.
- Prefer `--to codex` for checks: in the 2026-10-12 pilot, the same fact-check took 56k tokens and 29 s on Codex, against 122k tokens, 67 s and $0.83 on `claude -p`.
- `--write` lets the runner change files in the project folder. Default is read-only.

## The owner's gates

- **Approvals** come only from the owner's own words. Record them verbatim: `govern approve <slug> script|final|publish --quote "<exactly what the owner said>"`. Never infer an approval, and never approve for the owner.
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
- the Codex `ask` steps.

It compares these with the chat baseline (468k context per call). Report it when the owner asks, or when a video is delivered, alongside the farm cost per pass.
