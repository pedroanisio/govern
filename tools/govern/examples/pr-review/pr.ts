// Two connectors (CONNECTORS.md) on GitHub's REST API for the pr-review example: what a pull request is, read once its
// checks have finished, and its merge, at the commit the facts were read at.
//
//   pr.ts facts [DIR]   -> {prTitle, prUrl, base, head, checks, files, additions, deletions}
//                          exits 75 while a check still runs, so a stage with `poll` asks again later
//   pr.ts merge [DIR]   -> {mergeSha}   merges the case's `head` and no other commit; a pull request already merged at
//                          that commit is the effect, so a second run merges nothing
//
// The case names the pull request: `repo` ("owner/name") and `number`. GITHUB_TOKEN is the token the calls are made
// with, GITHUB_API the API's base (default https://api.github.com), PR_MERGE_METHOD merge, squash or rebase (default
// merge). The merge is made as that token's account; who approved it is govern's record of the gate.
import { main, http, env, Permanent, Transient, type Connector, type Context } from "../connector/connector.ts";

interface Pull { title: string; html_url: string; state: string; merged: boolean; merge_commit_sha: string | null;
  additions: number; deletions: number; changed_files: number; base: { ref: string }; head: { sha: string } }
interface Facts { pull: Pull; checks: string }
type Json = Record<string, unknown>;

const api = () => (process.env.GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
const headers = () => ({ Authorization: `Bearer ${env("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
/** The pull request the case names, as an API path. */
function target(ctx: Context): string {
  const repo = ctx.data.repo, number = ctx.data.number;
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Permanent("the case's repo is not owner/name");
  if (!Number.isInteger(number) || (number as number) < 1) throw new Permanent("the case's number is not a pull request number");
  return `/repos/${repo}/pulls/${number as number}`;
}
async function pull(ctx: Context): Promise<Pull> {
  const p = (await http("GitHub", "GET", api() + target(ctx), { headers: headers() })).body as Pull;
  if (typeof p?.title !== "string" || typeof p.head?.sha !== "string" || typeof p.base?.ref !== "string") throw new Permanent("GitHub's answer is not a pull request");
  return p;
}
/** How the check runs of commit `sha` ended: "28 checks passed", "2 of 30 checks failed", "no checks". Transient while
 *  one still runs. Only the first 100 are read, and a commit with more is refused, never summed up short. */
async function checksOf(ctx: Context, sha: string): Promise<string> {
  const repo = ctx.data.repo as string;
  const r = (await http("GitHub", "GET", `${api()}/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { headers: headers() })).body as
    { total_count?: number; check_runs?: { status?: string; conclusion?: string | null }[] };
  const runs = Array.isArray(r?.check_runs) ? r.check_runs : (() => { throw new Permanent("GitHub's answer has no check runs"); })();
  if ((r.total_count ?? runs.length) > runs.length) throw new Permanent(`${sha} has ${r.total_count} check runs: more than this connector reads`);
  const running = runs.filter((c) => c.status !== "completed").length;
  if (running) throw new Transient(`${running} of ${runs.length} checks still run on ${sha.slice(0, 7)}`);
  const failed = runs.filter((c) => !["success", "neutral", "skipped"].includes(c.conclusion ?? "")).length;
  return !runs.length ? "no checks" : failed ? `${failed} of ${runs.length} checks failed` : `${runs.length} check${runs.length === 1 ? "" : "s"} passed`;
}

const facts: Connector<Facts> = {
  name: "pr facts",
  // Reading makes no effect to find: every run reads the pull request as it stands.
  async probe() { return undefined; },
  async execute(ctx) {
    const p = await pull(ctx);
    if (p.state !== "open") throw new Permanent(`the pull request is ${p.merged ? "merged" : p.state}: there is nothing to review`);
    return { pull: p, checks: await checksOf(ctx, p.head.sha) };
  },
  async confirm(_ctx, f) {
    return { prTitle: f.pull.title, prUrl: f.pull.html_url, base: f.pull.base.ref, head: f.pull.head.sha, checks: f.checks,
      files: f.pull.changed_files, additions: f.pull.additions, deletions: f.pull.deletions };
  },
  plan(ctx) { return { method: "GET", path: target(ctx) }; },
};

const request = (ctx: Context): Json => {
  const method = process.env.PR_MERGE_METHOD ?? "merge";
  if (!["merge", "squash", "rebase"].includes(method)) throw new Permanent("PR_MERGE_METHOD is merge, squash or rebase");
  if (typeof ctx.data.head !== "string" || !/^[0-9a-f]{40}$/.test(ctx.data.head)) throw new Permanent("the case has no head commit: the facts stage reads it");
  return { sha: ctx.data.head, merge_method: method };
};
const merge: Connector<Pull> = {
  name: "pr merge",
  async probe(ctx) { const p = await pull(ctx); return p.merged ? p : undefined; },
  // GitHub refuses (409) when the branch's head is not `sha`: commits pushed after the facts were read are never merged
  // on an approval that did not see them. A refusal by branch protection or a conflict is 405; both are permanent.
  async execute(ctx) {
    await http("GitHub", "PUT", `${api()}${target(ctx)}/merge`, { headers: headers(), body: request(ctx) });
    return pull(ctx);
  },
  async confirm(ctx, p) {
    if (!p.merged || !p.merge_commit_sha) throw new Permanent("confirm: the pull request is not merged");
    if (p.head.sha !== ctx.data.head) throw new Permanent(`confirm: it was merged at ${p.head.sha.slice(0, 7)}, not at the approved ${String(ctx.data.head).slice(0, 7)}`);
    return { mergeSha: p.merge_commit_sha };
  },
  plan(ctx) { return { method: "PUT", path: `${target(ctx)}/merge`, body: request(ctx) }; },
};

const verb = process.argv[2];
process.exitCode = verb === "merge" ? await main(merge, "merge", process.argv.slice(2)) : await main(facts, "facts", process.argv.slice(2));
