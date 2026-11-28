// The pr-review example (examples/pr-review): a pull request's facts read from GitHub once its checks finish, shown on a
// gate's card, and merged at the approved commit. The connectors run against a fake GitHub API on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, tempDir } from "./helpers.ts";
import { parseProcess } from "../lib/process.ts";

const PR = join(HERE, "..", "examples", "pr-review", "pr.ts"), HEAD = "a".repeat(40), MOVED = "b".repeat(40);

interface Hub { base: string; seen: { method: string; path: string; body?: unknown; auth?: string }[]; close(): Promise<void>;
  state: { head: string; merged: boolean; open: boolean; runs: { status: string; conclusion: string | null }[]; protect: boolean } }
async function hub(): Promise<Hub> {
  const state: Hub["state"] = { head: HEAD, merged: false, open: true, runs: Array.from({ length: 28 }, () => ({ status: "completed", conclusion: "success" })), protect: false };
  const seen: Hub["seen"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = req.url ?? "", method = req.method ?? "";
      const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      seen.push({ method, path, ...(raw ? { body: JSON.parse(raw) } : {}), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "Bad credentials" });
      if (method === "GET" && path === "/repos/acme/shop/pulls/248") return send(200, { title: "Troca de perfil", html_url: "https://github.com/acme/shop/pull/248",
        state: state.open && !state.merged ? "open" : "closed", merged: state.merged, merge_commit_sha: state.merged ? "c".repeat(40) : null,
        additions: 84, deletions: 21, changed_files: 3, base: { ref: "main" }, head: { sha: state.head } });
      if (method === "GET" && path === `/repos/acme/shop/commits/${state.head}/check-runs?per_page=100`) return send(200, { total_count: state.runs.length, check_runs: state.runs });
      if (method === "PUT" && path === "/repos/acme/shop/pulls/248/merge") {
        const b = JSON.parse(raw) as { sha: string };
        if (b.sha !== state.head) return send(409, { message: "Head branch was modified. Review and try the merge again." });
        if (state.protect) return send(405, { message: "Required status check is failing" });
        state.merged = true;
        return send(200, { merged: true, sha: "c".repeat(40) });
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, state,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); } };
}
function lane(data: Record<string, unknown> = {}): { dir: string; out: string } {
  const dir = tempDir("pr-review");
  writeFileSync(join(dir, "govern.json"), JSON.stringify({ slug: "pr-248", title: "PR 248", data: { repo: "acme/shop", number: 248, ...data } }));
  return { dir, out: join(dir, "outputs.json") };
}
function run(h: Hub, verb: string, l: { dir: string; out: string }, extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", PR, verb, l.dir], { env: { PATH: process.env.PATH ?? "", GITHUB_API: h.base,
      GITHUB_TOKEN: "test-token", GOVERN_OUTPUTS: l.out, GOVERN_IDEMPOTENCY_KEY: `pr-248:${verb}:0`, ...extra } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const outputs = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("facts waits for the checks to finish, then writes what the gate's card shows; a closed pull request is refused", async () => {
  const h = await hub();
  try {
    const l = lane();
    h.state.runs[3] = { status: "in_progress", conclusion: null };
    const waiting = await run(h, "facts", l);
    assert.equal(waiting.code, 75, waiting.out);
    assert.match(waiting.out, /1 of 28 checks still run on aaaaaaa/);
    assert.equal(existsSync(l.out), false, "no facts while a check runs");

    h.state.runs[3] = { status: "completed", conclusion: "success" };
    const done = await run(h, "facts", l);
    assert.equal(done.code, 0, done.out);
    assert.deepEqual(outputs(l.out), { prTitle: "Troca de perfil", prUrl: "https://github.com/acme/shop/pull/248", base: "main", head: HEAD,
      checks: "28 checks passed", files: 3, additions: 84, deletions: 21 });
    assert.ok(h.seen.every((s) => s.method === "GET"), "reading changes nothing");

    h.state.runs[0] = { status: "completed", conclusion: "failure" };
    h.state.runs[1] = { status: "completed", conclusion: "skipped" };
    assert.equal((await run(h, "facts", l)).code, 0);
    assert.equal(outputs(l.out).checks, "1 of 28 checks failed");

    h.state.open = false;
    const closed = await run(h, "facts", l);
    assert.equal(closed.code, 65, closed.out);
    assert.match(closed.out, /the pull request is closed/);
    assert.equal((await run(h, "facts", lane({ repo: "acme/shop/../x" }))).code, 65, "a repo that is not owner/name");
    assert.equal((await run(h, "facts", l, { GITHUB_TOKEN: "wrong" })).code, 65, "a refused token is permanent");
  } finally { await h.close(); }
});

test("merge merges the approved commit once; a head that moved or a protected branch is a permanent refusal", async () => {
  const h = await hub();
  try {
    const l = lane({ head: HEAD });
    const dry = await run(h, "merge", l, { GOVERN_DRY_RUN: "1" });
    assert.equal(dry.code, 0, dry.out);
    assert.deepEqual(JSON.parse(dry.out).plan, { method: "PUT", path: "/repos/acme/shop/pulls/248/merge", body: { sha: HEAD, merge_method: "merge" } });
    assert.equal(h.state.merged, false, "a dry run merges nothing");

    // Commits pushed after the facts were read: GitHub refuses the approved sha, and nothing is merged.
    h.state.head = MOVED;
    const moved = await run(h, "merge", l);
    assert.equal(moved.code, 65, moved.out);
    assert.match(moved.out, /409 .*Head branch was modified/);
    h.state.head = HEAD;
    h.state.protect = true;
    assert.equal((await run(h, "merge", l)).code, 65, "branch protection refuses");
    assert.equal(h.state.merged, false);

    h.state.protect = false;
    const merged = await run(h, "merge", l, { PR_MERGE_METHOD: "squash" });
    assert.equal(merged.code, 0, merged.out);
    assert.deepEqual(outputs(l.out), { mergeSha: "c".repeat(40) });
    assert.deepEqual(h.seen.filter((s) => s.method === "PUT").at(-1)!.body, { sha: HEAD, merge_method: "squash" });

    // A second run (a retry after a lost answer) finds it merged and merges nothing.
    const puts = h.seen.filter((s) => s.method === "PUT").length;
    const again = await run(h, "merge", l);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already done/);
    assert.equal(h.seen.filter((s) => s.method === "PUT").length, puts);
    // Merged by someone else at another commit: not what was approved.
    const other = await run(h, "merge", lane({ head: MOVED }));
    assert.equal(other.code, 65, other.out);
    assert.match(other.out, /merged at aaaaaaa, not at the approved bbbbbbb/);
    assert.equal((await run(h, "merge", lane())).code, 65, "no head on the case: the facts were never read");
  } finally { await h.close(); }
});

test("the pr-review process parses: facts, a review stage held by the merge gate, the merge, and an exception a reviewer clears", () => {
  const raw = readFileSync(join(HERE, "..", "examples", "pr-review", "pr-review.json"), "utf8");
  const pr = parseProcess("pr-review.json", raw);
  assert.deepEqual(pr.stages.map((s) => s.name), ["facts", "review", "merge", "exception"]);
  assert.deepEqual(pr.gates.map((g) => [g.name, g.stage, g.policy?.rejectTo]), [["merge-approval", "review", "exception"]]);
  assert.match(pr.gates[0]!.message!, /\{data\.checks\}/);
  assert.equal(pr.stages[0]!.service!.poll, 60);
});
