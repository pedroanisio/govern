# Build stage: export

You are building one stage of govern's lane-portability feature.

- The code is the git worktree `./src` (super-tools, branch lane-portability). Change files only under `./src`.
- The design is `./src/tools/govern/plans/lane-portability/PLAN.md`, section Export, and The bundle: govern-lane-bundle/1. Read that section and
  `./src/CLAUDE.md` before writing anything; both bind you.
- Do not edit anything under `./src/tools/govern/plans/`. The stage's exit check runs from another checkout and
  ignores changes there; the review stage fails the branch if you touch it.
- Write the tests first, in `./src/tools/govern/test/export.test.ts`, using the helpers in `./src/tools/govern/test/helpers.ts` (`makeEnv`,
  `govern`, `asSession`, `typed`, `write`, `jsonl`). Then write the code that makes them pass.
- You cannot run commands. After your reply the orchestrator runs the exit check
  (`acceptance/export.json`: TypeScript type-check, the tests below, no skipped or todo test; the orchestrator commits your work)
  and sends you its output if it fails.
- No placeholders, no skipped tests, no `TODO`. Match the surrounding code's style: typed shapes from `lib/shape.ts`,
  `GovernError` via `fail()`, terse comments that state why.

The check requires tests with exactly these titles, each passing:

- "export writes a bundle whose manifest hashes every file"
- "export reads the lane under its lock and records the ledger offset"
- "export --template carries configuration only"
- "export refuses symlinks and files over the size limit"
- "export never includes job logs, locks or reservations"
- "export carries the public keys of devices that signed approvals"
- "export --freeze freezes the lane before it reads"
- "a frozen lane can be exported"

Reply with HANDOFF: the files you changed, and for each required test the behaviour it proves.

## What to build

- `lib/bundle.ts`: the bundle's typed shape (unknown keys refused), its hash, the file walk with the limits, symlink
  and `.git` refusals and `--exclude` globs. Import will reuse this module.
- `govern export <slug> [--template] [--out FILE] [--exclude GLOB]... [--freeze --quote Q]`.
- The read happens under `lifecycle.transaction`; `--freeze` freezes inside the same transaction, before the read.
- The `export` ledger entry; the bundle written with mode 600.

The test "export reads the lane under its lock" must hold the lane's transaction lock from the test and assert the
export waits for it, and assert `ledgerOffset` equals the ledger's line count at the time of the read.
