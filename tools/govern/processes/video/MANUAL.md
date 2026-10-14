---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code; revised by Claude Opus 5.5 via Claude Code"
  date: "2026-10-14"
---

# Working on a video with govern

The manual of the `video` process (`govern manual video`). It adds to the general manual (`govern manual`): read that first. A video lane runs plan, script, script-check, sound, preview, produce, final, deliver, with the owner's gates `script`, `final` and `publish`.

You and the owner shape a video together: the work is iterative and creative. `govern` keeps that conversation cheap. Measured on 2026-10-10/11 (PALS-Notes/costs/token-analysis/REPORT-2026-10-11.md), the money did not go into the conversation. It went into four things:
- re-reading a 468k-token context on every call;
- polling renders from inside the model, about $800;
- review and fix agent cascades, about $1,400;
- sessions messaging each other, about $455.

The rules below remove those four.

## Start

1. `govern status` lists the videos. If the video is not there, run `govern new <slug> --kind long|short --title "…" --lang en|pt-BR [--parent <film>]`. The slug is its folder under the workspace's projects folder, for example `a-millionth-apart/shorts`.
2. `govern work <slug> <stage>`, with stage one of plan, script, script-check, sound, preview, produce, final or deliver. Do not read WORKFLOW.md, CHECKLIST.md, the style guide or old reports in full: the brief carries the stage's exit condition (from the workflow document the workspace's govern.config.json names), and `govern ask` carries the rules each step needs.
3. A new video lane starts with its process's setup: the file `approval` (APPROVAL.md) and `sheet` (`**/*sheet*.png`), and, when the lane's folder holds a `film.json`, the command `fb` (`{python} {paths.filmBuild} film.json`, `paths.filmBuild` being the workspace's film_build.py) and the file `timings` (timings.json). Name the rest once:
   - `govern cmd <slug> preview -- {python} build_short1.py --preview`. Placeholders: `{python}`, `{repo}`, `{dir}`, `{paths.NAME}`.
   - `govern file <slug> script short-1.screenplay.json`
   - `govern file <slug> sheet "renders/**/*sheet*.png"`. A glob means its newest match.

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

These steps run as one verified Codex call each, not as chat work in this session. They are the prompts of the video process (`govern prompts video`); their schemas and house rules (hook length and banned openings, written-form captions, metadata limits) are data beside them in `processes/video/prompts/`.

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
- Images can be added with `--image sheet.png`.

Two steps include the channel's writing guides. The prompts name them by key, `{{include:paths.KEY}}`, and the workspace's govern.config.json maps each key under `paths` to its file (relative to the config's folder, or absolute). A missing key or a missing file stops the step before any Codex call.

| Key | File | Used by |
|---|---|---|
| `scriptStyleGuide` | the channel's script style guide | script-review |
| `enUsWritingGuide` | the en-US read-aloud checks | script-review |
| `ptBrWritingGuide` | the pt-BR read-aloud checks | script-review, ptbr |

For example, beside `filmBuild`:

```json
"scriptStyleGuide": "pals-notes-channel/writing/SCRIPT-STYLE-GUIDE.md",
"enUsWritingGuide": "var/media-business/channels/palsnotes/workflow/script/post-validation/en-US-writing.md",
"ptBrWritingGuide": "var/media-business/channels/palsnotes/workflow/script/post-validation/pt-BR-writing.md"
```

A workspace prompt can still include a file inside the workspace by path, `{{include:docs/guide.md}}`.

## The owner's gates

- **The owner sees complete drafts,** not intermediate passes. State the farm pass cost and the film's total when you deliver.
- **Publish.** `govern publish <slug>` checks the approvals (`final`, `publish`) and the filed package (in the workspace's packages folder), then prints the smm commands. Run those printed commands through Bash, unchanged, so the publish guard sees them. Only do this after the owner's go in this session.

## Never, in production work

- No subagents, Agent tool or Workflow. One session does the video. A real engine bug goes to e4 as a request (PALS-Notes/docs/engine/patches/), not to an agent cascade.
- No messages to other sessions. State lives in `govern.json`, and `govern status` answers "where is it".
- No heavy work on WSL. Renders, encodes, TTS and Whisper run on the VMs or farm through the video's commands (`vmrun.sh`, `farm-pool.sh`).
- No long logs or whole files pasted into the chat.
- No overwriting an approved file. Write the new one beside it with a suffix.

## Measure

`govern usage` compares a video's segments with the chat baseline (468k context per call, from the workspace's `baseline` config). Report it when the owner asks, or when a video is delivered, alongside the farm cost per pass.
