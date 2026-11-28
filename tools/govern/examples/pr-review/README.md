# PR review example: a pull request merged on a person's decision

An example of [govern](../../README.md). A case names a pull request. govern reads its facts from GitHub once the checks
have finished, asks a reviewer in Slack with those facts on the card, and merges the commit that was approved.

| Stage | Done by | What happens |
|---|---|---|
| `facts` | command (`pr.ts facts`) | Reads the title, target branch, head commit, size and check runs. While a check still runs it exits 75, and the stage's `poll` asks again a minute later |
| `review` | reviewer, in Slack | The gate `merge-approval` posts a card with the facts. Approve goes on to the merge; Send back goes to `exception` |
| `merge` | command (`pr.ts merge`) | Merges the head commit the facts were read at. A pull request already merged at that commit is the effect, so a retry merges nothing |
| `exception` | reviewer | A refused merge or unreadable facts land here with the reason in `problem`; completing the task reads the facts again |

The card cannot show a stale result on a merge. The merge names the approved commit, and GitHub refuses it when the
branch has moved, so commits pushed after the approval go back through `facts` and a new card. GitHub's branch protection
and required checks apply as they do to any merge made with the token.

The merge is made as the account of `GITHUB_TOKEN`. Who approved it is govern's record of the gate: the reviewer's signed
Slack click in the lane's ledger. An approval that must appear on GitHub under the reviewer's own name needs each
reviewer's own GitHub authorization, which this example does not do.

## Install

1. In a govern workspace (`govern init`), enable the extensions and copy the files. `pr.ts` imports the reference
   connector, so keep the two folders side by side:

   ```sh
   govern ext enable business && govern ext enable slack
   mkdir -p .govern/processes/pr-review .govern/processes/connector
   cp "$GOVERN"/examples/pr-review/pr-review.json .govern/processes/
   cp "$GOVERN"/examples/pr-review/pr.ts .govern/processes/pr-review/
   cp "$GOVERN"/examples/connector/connector.ts .govern/processes/connector/
   ```

2. In `.govern/config.json`, set `paths.pr` to the folder of `pr.ts` (absolute) and the Slack settings
   ([SLACK.md](../../SLACK.md)).
3. Replace `reviewer1` in `pr-review.json` with your reviewers: each `user` an OS account on the govern host, each
   `slack` a member id.
4. Give `govern drive` its environment in an env file, never a tracked file: `GITHUB_TOKEN` (a token that can read the
   repository's pull requests and checks and merge them), and optionally `PR_MERGE_METHOD` (`merge`, `squash` or
   `rebase`) and `GITHUB_API` (GitHub Enterprise Server).

## Run

Open a case for a pull request with the fields `repo` (`owner/name`) and `number`, then let `govern drive` advance it and
`govern slack notify` post the gate's card ([BUSINESS.md](../../BUSINESS.md), [SLACK.md](../../SLACK.md)). The Squad
Lead can open the case itself after it opens a pull request; it cannot approve the gate.

## Limits

- `facts` reads check runs, the first 100 of a commit. Commit statuses reported through GitHub's older status API are not
  counted.
- The card is posted again when the case's data changes. A check that fails after the card was posted changes nothing on
  the case, so the card keeps the result it was posted with; the merge is still refused by a required check.
