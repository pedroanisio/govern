# Build stage: docs

You are building one stage of govern's lane-portability feature.

- The code is the git worktree `./src` (super-tools, branch lane-portability). Change files only under `./src`.
- The design is `./src/tools/govern/plans/lane-portability/PLAN.md`, section all of Design. Read that section and
  `./src/CLAUDE.md` before writing anything; both bind you.
- Do not edit anything under `./src/tools/govern/plans/`. The stage's exit check runs from another checkout and
  ignores changes there; the review stage fails the branch if you touch it.
- This stage writes documentation, not code. The existing drift tests check it against the command table, and
  `make conform` checks the README blocks and every relative Markdown link.
- You cannot run commands. After your reply the orchestrator runs the exit check
  (`acceptance/docs.json`: TypeScript type-check, the tests below, no skipped or todo test; the orchestrator commits your work)
  and sends you its output if it fails.
- No placeholders, no skipped tests, no `TODO`. Match the surrounding code's style: typed shapes from `lib/shape.ts`,
  `GovernError` via `fail()`, terse comments that state why.

The check requires these existing tests to pass, and `make conform`:

- "drift: every command and subcommand is in SKILL.md and HELP; SKILL.md names no command that does not exist"
- "drift: the bin/govern MANPAGE names every command"
- "drift: MANPAGE OPTIONS has one entry per flag the command table declares, naming the commands that take it"
- "drift: MANPAGE SEE ALSO names files and tools that exist and are current, and every manual govern serves"

Reply with HANDOFF: the files you changed, and for each required test the behaviour it proves.

## What to write

- `./src/tools/govern/PORTABILITY.md`: how to freeze, export, import and clone a lane, the bundle format, what a copy
  does not inherit and why. Written for the people who use govern; link it from `tools/govern/README.md`.
- The `bin/govern` MANPAGE: SYNOPSIS lines, an OPTIONS entry for every new flag naming the commands that take it, the
  new file in SEE ALSO.
- `SKILL.md`: the new commands, and the rule that an agent never freezes a lane or accepts imported checks: both are
  the owner's.
- The repository README's generated blocks stay current (`make docs`).
