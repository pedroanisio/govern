# Security review: lane portability before merge

Review the whole branch in the worktree `./src` (super-tools, branch lane-portability) against `main`. This task is
read-only. The design is `./src/tools/govern/plans/lane-portability/PLAN.md`. The owner reads this review before
approving the `security` gate, so each finding must be concrete enough to decide on.

Treat a bundle as written by an attacker who knows the code. For each item, say whether the code prevents it, citing
`path:line`, or give the bundle or command sequence that gets through:

1. **Writing outside the lane folder.** Path traversal, absolute paths, backslashes, NUL, Unicode normalisation of
   `..`, symlinks created by any means, case-insensitive collisions, a slug in `--as` or in the bundle that escapes the
   lanes folder.
2. **Running the attacker's commands.** Any path by which an imported command or check runs (advance, check, run,
   tick, a hook, the dispatcher) before the owner has accepted it.
3. **Passing a gate without the owner.** Imported approvals, votes, human-task completions, policy state or a
   `frozen.source` reaching live state; a forged device approval in history that import accepts.
4. **Resource exhaustion.** Bundle size, file count, base64 expansion, deep JSON nesting, ledger size, time spent
   verifying; each limit enforced before the memory or disk is spent.
5. **Freeze bypass.** Any write to a frozen lane's `govern.json` or ledger (a command, the dispatcher, the remote
   API, a conversation, a timer) that does not go through the refusal.
6. **Leaking the source.** Anything in a bundle that the source workspace would not want copied: secrets in job logs,
   tokens in state files, paths outside the lane folder, other lanes' data.

Reply with REVIEW. Start each finding with `BLOCKING:` or `NOTE:`. End with one line: `verdict: no blocking findings`
or `verdict: N blocking findings`.
