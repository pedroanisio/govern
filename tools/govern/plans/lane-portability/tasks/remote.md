# Build stage: remote

You are building one stage of govern's lane-portability feature.

- The code is the git worktree `./src` (super-tools, branch lane-portability). Change files only under `./src`.
- The design is `./src/tools/govern/plans/lane-portability/PLAN.md`, section Remote protocol govern-remote/2. Read that section and
  `./src/CLAUDE.md` before writing anything; both bind you.
- Do not edit anything under `./src/tools/govern/plans/`. The stage's exit check runs from another checkout and
  ignores changes there; the review stage fails the branch if you touch it.
- Write the tests first, in `./src/tools/govern/test/remote.test.ts` and the Android tests under `./src/tools/govern/android/app/src/test/`, using the helpers in `./src/tools/govern/test/helpers.ts` (`makeEnv`,
  `govern`, `asSession`, `typed`, `write`, `jsonl`). Then write the code that makes them pass.
- You cannot run commands. After your reply the orchestrator runs the exit check
  (`acceptance/remote.json`: TypeScript type-check, the tests below, no skipped or todo test; the orchestrator commits your work)
  and sends you its output if it fails.
- No placeholders, no skipped tests, no `TODO`. Match the surrounding code's style: typed shapes from `lib/shape.ts`,
  `GovernError` via `fail()`, terse comments that state why.

The check requires tests with exactly these titles, each passing:

- "the desk shows frozen lanes and imported provenance"
- "a signed approval on a frozen lane is refused"
- "the server's desk and lane match the app's contract fixtures (android/app/src/test/resources/fixtures)"
- Android `ModelTest.frozenAndImportedFieldsParse`
- Android `ModelTest.versions`
- Android `ModelTest.deskFixtureParses`
- Android `EndToEndTest.pairReadApproveAndStream`
- Android `EndToEndTest.frozenLaneRefusesApproval`

Reply with HANDOFF: the files you changed, and for each required test the behaviour it proves.

## What to build

- `lib/remote-view.ts`: `frozen` and `importedFrom` on every lane summary, `importedApprovals` on the lane detail;
  `PROTOCOL = "govern-remote/2"`.
- `tools/govern/android`: the same fields in `Model.kt` (nullable objects, strict parse kept), `speaks()` accepting only
  `/2`, a frozen badge and the import origin in the lane list and lane screen, Approve and Ack hidden on a frozen lane.
- The fixtures `android/app/src/test/resources/fixtures/desk.json` and `lane.json` with the new fields filled in
  (non-null), so the contract test covers them.
- `ModelTest.versions` updated for `/2`; `ModelTest.frozenAndImportedFieldsParse` new; `EndToEndTest.frozenLaneRefusesApproval`
  new: it freezes the lane with `govern freeze` (from the test's own environment, a plain terminal) and asserts a signed
  approval gets 409 naming the freeze.
- REMOTE.md: the version, the new fields, and why the version changed.
