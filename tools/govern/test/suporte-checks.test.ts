// The support example's stage checks (examples/suporte/checks.ts): each asks the system of record (Jira, Zendesk, Slack)
// whether the stage's work is really there, against fake APIs on loopback. Exit 0 passes, 1 fails with the reason, 2 is a
// usage or configuration error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { HERE, tempDir } from "./helpers.ts";

const CHECKS = join(HERE, "..", "examples", "suporte", "checks.ts");

interface Seen { method: string; url: string; auth: string | undefined; body: string }
/** A fake API: `routes` maps a path (with query) to [status, JSON]; anything else is 404. */
async function api(routes: Record<string, [number, unknown]>, f: (base: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw });
      const [status, body] = routes[req.url ?? ""] ?? [404, { error: "not found" }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}`, seen); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CHECKS, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

const jiraEnv = (base: string) => ({ JIRA_BASE_URL: base, JIRA_EMAIL: "bot@acme.test", JIRA_API_TOKEN: "jira-token" });
const issue = (category: string) => [200, { key: "SUP-7", fields: { status: { name: "x", statusCategory: { key: category } } } }] as [number, unknown];

test("jira-issue passes when the issue exists, and with --done only when its status is in the done category", async () => {
  await api({ "/rest/api/3/issue/SUP-7?fields=status": issue("indeterminate"), "/rest/api/3/issue/SUP-8?fields=status": issue("done") }, async (base, seen) => {
    assert.equal((await run(["jira-issue", "SUP-7"], jiraEnv(base))).code, 0);
    assert.equal(seen[0]!.auth, "Basic " + Buffer.from("bot@acme.test:jira-token").toString("base64"));
    const open = await run(["jira-issue", "SUP-7", "--done"], jiraEnv(base));
    assert.equal(open.code, 1);
    assert.match(open.out, /SUP-7 is not done \(status category indeterminate\)/);
    assert.equal((await run(["jira-issue", "SUP-8", "--done"], jiraEnv(base))).code, 0);
    const missing = await run(["jira-issue", "SUP-9"], jiraEnv(base));
    assert.equal(missing.code, 1);
    assert.match(missing.out, /SUP-9: Jira answered 404/);
  });
});

test("zendesk-ticket passes with --solved only for a solved or closed ticket", async () => {
  const env = (base: string) => ({ ZENDESK_BASE_URL: base, ZENDESK_CLIENT_ID: "ginga-govern", ZENDESK_CLIENT_SECRET: "zd-secret" });
  await api({ "/oauth/tokens": [200, { access_token: "zd-access", token_type: "bearer", scope: "tickets:read" }],
    "/api/v2/tickets/1001.json": [200, { ticket: { id: 1001, status: "solved" } }], "/api/v2/tickets/1002.json": [200, { ticket: { id: 1002, status: "open" } }] }, async (base, seen) => {
    assert.equal((await run(["zendesk-ticket", "1001", "--solved"], env(base))).code, 0);
    assert.deepEqual([seen[0]!.method, seen[0]!.url], ["POST", "/oauth/tokens"]);
    assert.deepEqual(JSON.parse(seen[0]!.body), { grant_type: "client_credentials", client_id: "ginga-govern", client_secret: "zd-secret", scope: "tickets:read" });
    assert.deepEqual([seen[1]!.url, seen[1]!.auth], ["/api/v2/tickets/1001.json", "Bearer zd-access"]);
    const open = await run(["zendesk-ticket", "1002", "--solved"], env(base));
    assert.equal(open.code, 1);
    assert.match(open.out, /1002 is open, not solved/);
    assert.equal((await run(["zendesk-ticket", "1002"], env(base))).code, 0);
  });
});

test("zendesk-ticket fails when Zendesk refuses the token, without echoing the secret; no client is exit 2", async () => {
  const env = (base: string) => ({ ZENDESK_BASE_URL: base, ZENDESK_CLIENT_ID: "ginga-govern", ZENDESK_CLIENT_SECRET: "zd-secret" });
  await api({ "/oauth/tokens": [401, { error: "invalid_client", error_description: "Client authentication failed." }] }, async (base, seen) => {
    const r = await run(["zendesk-ticket", "1001"], env(base));
    assert.equal(r.code, 1);
    assert.match(r.out, /Zendesk OAuth token: 401 invalid_client/);
    assert.doesNotMatch(r.out, /zd-secret/);
    assert.equal(seen.length, 1, "no ticket call without a token");
  });
  const r = await run(["zendesk-ticket", "1001"], { ZENDESK_BASE_URL: "http://127.0.0.1:9", ZENDESK_CLIENT_SECRET: "zd-secret" });
  assert.equal(r.code, 2);
  assert.match(r.out, /ZENDESK_CLIENT_ID is not set/);
});

test("slack-message passes when the channel holds a message with that ts", async () => {
  const env = (base: string) => ({ GOVERN_SLACK_API: base, SLACK_BOT_TOKEN: "xoxb-1" });
  await api({
    "/conversations.history?channel=C0SUP&latest=1793000000.000100&inclusive=true&limit=1": [200, { ok: true, messages: [{ ts: "1793000000.000100", text: "Ticket 1001" }] }],
    "/conversations.history?channel=C0SUP&latest=1793000000.000200&inclusive=true&limit=1": [200, { ok: true, messages: [{ ts: "1793000000.000100", text: "older" }] }],
    "/conversations.history?channel=C0BAD&latest=1793000000.000100&inclusive=true&limit=1": [200, { ok: false, error: "channel_not_found" }],
  }, async (base, seen) => {
    assert.equal((await run(["slack-message", "C0SUP", "1793000000.000100"], env(base))).code, 0);
    assert.equal(seen[0]!.auth, "Bearer xoxb-1");
    const gone = await run(["slack-message", "C0SUP", "1793000000.000200"], env(base));
    assert.equal(gone.code, 1);
    assert.match(gone.out, /no message 1793000000\.000200 in C0SUP/);
    const bad = await run(["slack-message", "C0BAD", "1793000000.000100"], env(base));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /channel_not_found/);
  });
});

test("suggestions passes for one to three distinct, non-empty replies with a confidence between 0 and 1", async () => {
  const dir = tempDir("suporte-suggestions");
  const file = (name: string, v: unknown) => { const f = join(dir, name); writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v)); return f; };
  const good = { suggestions: [{ text: "Restart the printer service.", confidence: 0.8 }, { text: "Reinstall the driver.", confidence: 0.5 }] };
  assert.equal((await run(["suggestions", file("good.json", good)], {})).code, 0);
  for (const [v, re] of [
    ["not json", /not JSON/],
    [{ suggestions: [] }, /1 to 3/],
    [{ suggestions: [1, 2, 3, 4].map((i) => ({ text: `r${i} text`, confidence: 0.5 })) }, /1 to 3/],
    [{ suggestions: [{ text: " ", confidence: 0.5 }] }, /empty/],
    [{ suggestions: [{ text: "same reply", confidence: 0.5 }, { text: "Same reply", confidence: 0.4 }] }, /twice/],
    [{ suggestions: [{ text: "a reply", confidence: 1.5 }] }, /confidence/],
    [{ suggestions: [{ text: "a reply", confidence: 0.5, extra: 1 }] }, /extra/],
    [{ suggestions: [{ text: "a reply", confidence: 0.5 }], other: 1 }, /other/],
  ] as const) {
    const r = await run(["suggestions", file("bad.json", v)], {});
    assert.equal(r.code, 1, JSON.stringify(v));
    assert.match(r.out, re);
  }
});

test("an @FIELD argument is read from the lane's case data (--lane DIR)", async () => {
  const dir = tempDir("suporte-lane");
  writeFileSync(join(dir, "govern.json"), JSON.stringify({ data: { jiraKey: "SUP-8" } }));
  await api({ "/rest/api/3/issue/SUP-8?fields=status": issue("done") }, async (base) => {
    assert.equal((await run(["jira-issue", "@jiraKey", "--done", "--lane", dir], jiraEnv(base))).code, 0);
    const missing = await run(["jira-issue", "@nope", "--lane", dir], jiraEnv(base));
    assert.equal(missing.code, 1);
    assert.match(missing.out, /nope is not recorded/);
    assert.equal((await run(["jira-issue", "@jiraKey"], jiraEnv(base))).code, 2, "@FIELD needs --lane");
  });
});

test("a missing credential or argument is a usage error (exit 2), never a pass", async () => {
  const noCreds = await run(["jira-issue", "SUP-7"], { JIRA_BASE_URL: "http://127.0.0.1:9" });
  assert.equal(noCreds.code, 2);
  assert.match(noCreds.out, /JIRA_EMAIL/);
  assert.equal((await run(["jira-issue"], {})).code, 2);
  assert.equal((await run(["nope"], {})).code, 2);
});
