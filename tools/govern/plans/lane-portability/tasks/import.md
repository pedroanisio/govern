# Build stage: import

You are building one stage of govern's lane-portability feature.

- The code is the git worktree `./src` (super-tools, branch lane-portability). Change files only under `./src`.
- The design is `./src/tools/govern/plans/lane-portability/PLAN.md`, section Import. Read that section and
  `./src/CLAUDE.md` before writing anything; both bind you.
- Do not edit anything under `./src/tools/govern/plans/`. The stage's exit check runs from another checkout and
  ignores changes there; the review stage fails the branch if you touch it.
- Write the tests first, in `./src/tools/govern/test/import.test.ts`, using the helpers in `./src/tools/govern/test/helpers.ts` (`makeEnv`,
  `govern`, `asSession`, `typed`, `write`, `jsonl`). Then write the code that makes them pass.
- You cannot run commands. After your reply the orchestrator runs the exit check
  (`acceptance/import.json`: TypeScript type-check, the tests below, no skipped or todo test; the orchestrator commits your work)
  and sends you its output if it fails.
- No placeholders, no skipped tests, no `TODO`. Match the surrounding code's style: typed shapes from `lib/shape.ts`,
  `GovernError` via `fail()`, terse comments that state why.

The check requires tests with exactly these titles, each passing:

- "import creates a new lane with provenance and never reuses the source identity"
- "import refuses a bundle whose manifest or any file hash does not match"
- "import refuses paths that escape the lane folder"
- "import refuses unknown fields and unknown bundle versions"
- "import refuses a slug that already exists"
- "imported approvals become history and every gate starts closed"
- "imported checks must be accepted by the owner before they can pass a stage"
- "import refuses dependencies on lanes the workspace does not have unless --drop-deps"
- "imported device approvals still verify with the carried public key"
- "timers restart from the import, not from the source's deadlines"
- "a failed import leaves no lane folder behind"

Reply with HANDOFF: the files you changed, and for each required test the behaviour it proves.

## What to build

- `govern import <bundle> [--as SLUG] [--drop-deps]`, verifying in the order PLAN.md gives, before any write.
- The lane rewrite: new identity and `importedFrom`, approvals moved to `importedApprovals`, live state dropped,
  runtime re-entered, the `import` and `cmd-set` ledger entries, the history files under `govern/`.
- Writing through a temporary folder in the lanes folder and one rename.

The adversarial tests must build bundles by hand (not only through `govern export`): a changed byte in a file, a
changed body with the old hash, `../x`, `/etc/x`, `a\b`, `govern/ledger.jsonl`, a duplicate path, an unknown key at
the top, in `body` and in a file entry, `format: "govern-lane-bundle/2"`. Each must be refused with a message naming the
problem, and leave no lane folder behind.
