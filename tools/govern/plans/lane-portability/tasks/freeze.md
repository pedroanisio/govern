# Build stage: freeze

You are building one stage of govern's lane-portability feature.

- The code is the git worktree `./src` (super-tools, branch lane-portability). Change files only under `./src`.
- The design is `./src/tools/govern/plans/lane-portability/PLAN.md`, section Freeze. Read that section and
  `./src/CLAUDE.md` before writing anything; both bind you.
- Do not edit anything under `./src/tools/govern/plans/`. The stage's exit check runs from another checkout and
  ignores changes there; the review stage fails the branch if you touch it.
- Write the tests first, in `./src/tools/govern/test/freeze.test.ts`, using the helpers in `./src/tools/govern/test/helpers.ts` (`makeEnv`,
  `govern`, `asSession`, `typed`, `write`, `jsonl`). Then write the code that makes them pass.
- You cannot run commands. After your reply the orchestrator runs the exit check
  (`acceptance/freeze.json`: TypeScript type-check, the tests below, no skipped or todo test; the orchestrator commits your work)
  and sends you its output if it fails.
- No placeholders, no skipped tests, no `TODO`. Match the surrounding code's style: typed shapes from `lib/shape.ts`,
  `GovernError` via `fail()`, terse comments that state why.

The check requires tests with exactly these titles, each passing:

- "freeze records the owner's words, and unfreeze lifts it"
- "a frozen lane refuses every write command and names the freeze"
- "a frozen lane still answers brief, status and desk"
- "freeze is refused while a job of the lane is running"
- "freeze from an agent session without the owner's typed words is refused"
- "a frozen lane can name where its work continued"

Reply with HANDOFF: the files you changed, and for each required test the behaviour it proves.

## What to build

- `govern freeze <slug> --quote Q [--continued-as TEXT]` and `govern unfreeze <slug> --quote Q`, in the command table
  of `govern.ts`, with help lines.
- `frozen` in the `Project` type and in the `PROJECT` shape (`lib/project.ts`).
- Enforcement in `save()` and `appendLedger()` (the allowed ledger kinds: freeze, unfreeze, export), in `jobs.start`,
  in queue dispatch (task held, not run) and in conversation `send` for a bound conversation.
- The refusal while work is in flight (running job, running conversation turn, claimed queue task), naming each.
- `frozen` shown in `brief`, `status` and `desk`.

The test "a frozen lane refuses every write command" must run each write command of the command table against a
frozen lane (advance, work, run, cmd, file, check --set, approve, reject, data --set, human, dep, event, note, alerts --ack)
and assert each one exits non-zero with the freeze message and leaves govern.json byte-identical.
