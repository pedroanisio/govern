# Build stage: clone

You are building one stage of govern's lane-portability feature.

- The code is the git worktree `./src` (super-tools, branch lane-portability). Change files only under `./src`.
- The design is `./src/tools/govern/plans/lane-portability/PLAN.md`, section Clone. Read that section and
  `./src/CLAUDE.md` before writing anything; both bind you.
- Do not edit anything under `./src/tools/govern/plans/`. The stage's exit check runs from another checkout and
  ignores changes there; the review stage fails the branch if you touch it.
- Write the tests first, in `./src/tools/govern/test/clone.test.ts`, using the helpers in `./src/tools/govern/test/helpers.ts` (`makeEnv`,
  `govern`, `asSession`, `typed`, `write`, `jsonl`). Then write the code that makes them pass.
- You cannot run commands. After your reply the orchestrator runs the exit check
  (`acceptance/clone.json`: TypeScript type-check, the tests below, no skipped or todo test; the orchestrator commits your work)
  and sends you its output if it fails.
- No placeholders, no skipped tests, no `TODO`. Match the surrounding code's style: typed shapes from `lib/shape.ts`,
  `GovernError` via `fail()`, terse comments that state why.

The check requires tests with exactly these titles, each passing:

- "clone --full continues at the source stage with history and closed gates"
- "clone --template starts at the first stage with no history"
- "clone leaves the source lane unchanged"
- "a bundle round-trips between two workspaces"

Reply with HANDOFF: the files you changed, and for each required test the behaviour it proves.

## What to build

- `govern clone <slug> --as NEW [--template] [--exclude GLOB]...`: export to a file under the workspace's state folder,
  import it, delete the file.

"a bundle round-trips between two workspaces" uses two `makeEnv()` workspaces: export in the first, import in the
second, and assert the second lane's brief, files and history match, with closed gates and checks pending acceptance.
"clone leaves the source lane unchanged" asserts the source govern.json is byte-identical and its ledger gained exactly
one `export` entry.
