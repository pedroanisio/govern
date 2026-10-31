// govern slack (ext/slack/slack.ts, SLACK.md): decisions people make with buttons in Slack, verified by Slack's request
// signature and recorded as the mapped person's own decision, over real HTTP against a throwaway workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";
import { slackServer, parseAction, verifySignature, decisionValue, caseDigest, SKEW_SECONDS, MAX_BODY } from "../ext/slack/slack.ts";
import { parseProcess } from "../lib/process.ts";
import { load } from "../lib/project.ts";
import type { Project } from "../lib/project.ts";
import { GovernError } from "../lib/util.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TEAM = "T0TEAM";

const PROCESS = {
  version: 1, name: "support",
  fields: { draftSha: { type: "string" } },
  people: {
    ana: { user: "govern-test-ana", roles: ["suporte"], slack: "U0ANA" },
    gil: { user: "govern-test-gil", roles: ["gestor"], slack: "U0GIL" },
    otto: { user: "govern-test-otto", slack: "U0OTTO" },
    rui: { user: "govern-test-rui", roles: ["gestor"] },
  },
  stages: [
    { name: "draft", human: { role: "suporte" }, next: [{ to: ["review"] }] },
    { name: "review", next: [{ to: ["send"] }] },
    { name: "send", next: [] },
  ],
  gates: [
    { name: "validacao", stage: "review", policy: { role: "gestor", quorum: 1, rejectTo: "draft" } },
    { name: "go", stage: "send", owner: "otto" },
  ],
};

function setup(lanes: string[] = ["t1"]): Env {
  const e = makeEnv("slack");
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(PROCESS));
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: TEAM } }));
  for (const slug of lanes) {
    const r = govern(e, ["new", slug, "--process", "support", "--title", `Ticket ${slug}`]);
    assert.equal(r.code, 0, r.out + r.err);
  }
  return e;
}
const stateOf = (e: Env, slug = "t1"): Project => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
const ledgerOf = (e: Env, slug = "t1") => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));

/** Runs `f` in the workspace: GOVERN_REPO set, so the value builders and the server read its lanes. */
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}

/** A server on a free loopback port, with the clock `now` (seconds) fixed for the test. */
async function serving(e: Env, f: (url: string) => Promise<void>, now = () => NOW): Promise<void> {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const server: Server = slackServer(SECRET, { now, request: (async () => new Response("ok")) as typeof fetch });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}/slack/actions`); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old;
  }
}

const NOW = 1_793_000_000;
let actionSeq = 0;
/** A block_actions payload as Slack sends it: one button, clicked by `user`, carrying `value`. */
function payload(user: string, value: string, label = "Aprovar", o: { team?: string; type?: string } = {}): Record<string, unknown> {
  actionSeq += 1;
  return {
    type: o.type ?? "block_actions",
    team: { id: o.team ?? TEAM, domain: "acme" },
    user: { id: user, username: "someone", team_id: o.team ?? TEAM },
    api_app_id: "A0APP",
    trigger_id: `1.${actionSeq}.abc`,
    channel: { id: "C0SUP", name: "suporte" },
    message: { ts: "1793000000.000100", text: "decision" },
    response_url: "https://hooks.slack.com/actions/T0TEAM/1/xyz",
    actions: [{ type: "button", action_id: "govern.decide", block_id: "b1", value, text: { type: "plain_text", text: label, emoji: true }, action_ts: `${NOW}.${actionSeq}` }],
  };
}
const formBody = (p: Record<string, unknown>) => "payload=" + encodeURIComponent(JSON.stringify(p));
const signatureOf = (body: string, ts: number, secret = SECRET) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
const send = (url: string, body: string, o: { ts?: number; signature?: string; headers?: Record<string, string> } = {}) => {
  const ts = o.ts ?? NOW;
  return fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded",
    "X-Slack-Request-Timestamp": String(ts), "X-Slack-Signature": o.signature ?? signatureOf(body, ts), ...o.headers } });
};
const refusalOf = (f: () => unknown): GovernError => {
  try { f(); } catch (err) { assert.ok(err instanceof GovernError, String(err)); return err; }
  return assert.fail("expected a refusal");
};

// ---------------------------------------------------------------- the signature

test("a request signed with the signing secret verifies; any other secret, body or clock is refused", () => {
  const body = Buffer.from(formBody(payload("U0GIL", "{}")));
  verifySignature(SECRET, String(NOW), signatureOf(body.toString(), NOW), body, NOW);
  assert.match(refusalOf(() => verifySignature(SECRET, String(NOW), signatureOf(body.toString(), NOW, "another-secret-of-32-characters!"), body, NOW)).message, /signature/i);
  assert.match(refusalOf(() => verifySignature(SECRET, String(NOW), signatureOf(body.toString(), NOW), Buffer.concat([body, Buffer.from("x")]), NOW)).message, /signature/i);
  assert.match(refusalOf(() => verifySignature(SECRET, String(NOW - SKEW_SECONDS - 1), signatureOf(body.toString(), NOW - SKEW_SECONDS - 1), body, NOW)).message, /clock|old/);
  assert.match(refusalOf(() => verifySignature(SECRET, String(NOW + SKEW_SECONDS + 1), signatureOf(body.toString(), NOW + SKEW_SECONDS + 1), body, NOW)).message, /clock|old/);
  assert.match(refusalOf(() => verifySignature(SECRET, undefined, signatureOf(body.toString(), NOW), body, NOW)).message, /timestamp/i);
  assert.match(refusalOf(() => verifySignature(SECRET, String(NOW), undefined, body, NOW)).message, /signature/i);
  assert.match(refusalOf(() => verifySignature(SECRET, "12abc", signatureOf(body.toString(), NOW), body, NOW)).message, /timestamp/i);
  assert.match(refusalOf(() => verifySignature(SECRET, String(NOW), "v0=zz", body, NOW)).message, /signature/i);
});

// ---------------------------------------------------------------- the payload

test("an action is parsed strictly: one govern button, a typed value, the person's label", () => {
  const value = JSON.stringify({ v: 1, lane: "t1", gate: "validacao", decision: "approve", digest: "a".repeat(64) });
  const a = parseAction(Buffer.from(formBody(payload("U0GIL", value, "Aprovar resposta"))));
  assert.deepEqual({ team: a.team, user: a.user, lane: a.lane, target: a.target, decision: a.decision, quote: a.quote, digest: a.digest },
    { team: TEAM, user: "U0GIL", lane: "t1", target: { gate: "validacao" }, decision: "approve", quote: "Aprovar resposta", digest: "a".repeat(64) });
  const task = parseAction(Buffer.from(formBody(payload("U0ANA", JSON.stringify({ v: 1, lane: "t1", task: "draft", decision: "complete", digest: "b".repeat(64) }), "Concluído"))));
  assert.deepEqual(task.target, { task: "draft" });

  const bad = (p: unknown, re: RegExp) => assert.match(refusalOf(() => parseAction(Buffer.from(typeof p === "string" ? p : formBody(p as Record<string, unknown>)))).message, re);
  bad("payload=%7Bnot-json", /JSON/);
  bad("text=hello", /payload/);
  bad(payload("U0GIL", value, "Aprovar", { type: "view_submission" }), /block_actions/);
  bad(payload("U0GIL", "not json"), /value/);
  bad(payload("U0GIL", JSON.stringify({ v: 1, lane: "t1", gate: "validacao", decision: "approve", digest: "a".repeat(64), extra: 1 })), /extra/);
  bad(payload("U0GIL", JSON.stringify({ v: 2, lane: "t1", gate: "validacao", decision: "approve", digest: "a".repeat(64) })), /\bv\b/);
  bad(payload("U0GIL", JSON.stringify({ v: 1, lane: "t1", gate: "validacao", task: "draft", decision: "approve", digest: "a".repeat(64) })), /gate or a task/);
  bad(payload("U0GIL", JSON.stringify({ v: 1, lane: "t1", decision: "approve", digest: "a".repeat(64) })), /gate or a task/);
  bad(payload("U0GIL", JSON.stringify({ v: 1, lane: "t1", gate: "validacao", decision: "complete", digest: "a".repeat(64) })), /approve or reject/);
  bad(payload("U0ANA", JSON.stringify({ v: 1, lane: "t1", task: "draft", decision: "approve", digest: "a".repeat(64) })), /complete/);
  bad(payload("U0GIL", JSON.stringify({ v: 1, lane: "t1", gate: "validacao", decision: "approve", digest: "short" })), /digest/);
  bad(payload("U0GIL", value, " "), /label|words/);
  const two = payload("U0GIL", value);
  (two.actions as unknown[]).push((two.actions as unknown[])[0]);
  bad(two, /one action/);
  const other = payload("U0GIL", value);
  (other.actions as { action_id: string }[])[0]!.action_id = "something.else";
  bad(other, /govern\.decide/);
  const lookalike = payload("U0GIL", value);
  (lookalike.actions as { action_id: string }[])[0]!.action_id = "govern.decider";
  bad(lookalike, /govern\.decide/);
  const suffixed = payload("U0GIL", value);
  (suffixed.actions as { action_id: string }[])[0]!.action_id = "govern.decide.approve";
  assert.equal(parseAction(Buffer.from(formBody(suffixed))).decision, "approve", "a suffix keeps action_ids unique within a block");
  const noUser = payload("U0GIL", value);
  delete noUser.user;
  bad(noUser, /user/);
});

test("a person's Slack user id is part of the process's people map: well formed and held by one person", () => {
  const withSlack = (people: Record<string, unknown>) => () => parseProcess("p.json", JSON.stringify({ ...PROCESS, people }));
  withSlack(PROCESS.people)();
  assert.match(refusalOf(withSlack({ ...PROCESS.people, rui: { user: "govern-test-rui", roles: ["gestor"], slack: "U0GIL" } })).message, /\$\.people\.rui\.slack.*one person/);
  assert.match(refusalOf(withSlack({ ...PROCESS.people, rui: { user: "govern-test-rui", roles: ["gestor"], slack: "gil" } })).message, /\$\.people\.rui\.slack/);
});

// ---------------------------------------------------------------- decisions over HTTP

test("a gestor's Slack approval is recorded as their policy vote, with Slack as the source", async () => {
  const e = setup();
  await serving(e, async (url) => {
    const value = inWorkspace(e, () => decisionValue(load("t1"), { task: "draft" }, "complete"));
    const r = await send(url, formBody(payload("U0ANA", value, "Concluído")));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(stateOf(e).humanTasks?.["draft"]?.completedBy, "ana");
    assert.equal(govern(e, ["advance", "t1", "--note", "draft done in Slack"]).code, 0);
    assert.equal(stateOf(e).stage, "review");

    const approve = inWorkspace(e, () => decisionValue(load("t1"), { gate: "validacao" }, "approve"));
    const body = formBody(payload("U0GIL", approve, "Aprovar resposta"));
    const ok = await send(url, body);
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(await ok.json(), { ok: true, text: "t1: validacao approve by gil · approved" });
  });
  const p = stateOf(e);
  assert.equal(p.votes?.["validacao"]?.[0]?.by, "gil");
  assert.equal(p.votes?.["validacao"]?.[0]?.quote, "Aprovar resposta");
  const entry = ledgerOf(e).find((x) => x.kind === "approve" && x.gate === "validacao");
  assert.equal(entry?.source?.kind, "slack");
  assert.equal(entry?.source?.team, TEAM);
  assert.equal(entry?.source?.user, "U0GIL");
  assert.equal(entry?.source?.timestamp, String(NOW));
  assert.match(entry?.source?.signature, /^v0=[0-9a-f]{64}$/);
  assert.equal(entry?.source?.signature, signatureOf(entry?.source?.signedBody, NOW), "the recorded body and signature verify again");
  const done = ledgerOf(e).filter((x) => x.kind === "human-claim" || x.kind === "human-complete");
  assert.deepEqual(done.map((x) => [x.kind, x.by, x.source?.kind]), [["human-claim", "ana", "slack"], ["human-complete", "ana", "slack"]]);
});

test("a gestor's Slack rejection sends the case back to the policy's rejectTo stage", async () => {
  const e = setup();
  await serving(e, async (url) => {
    const v = inWorkspace(e, () => decisionValue(load("t1"), { task: "draft" }, "complete"));
    assert.equal((await send(url, formBody(payload("U0ANA", v, "Concluído")))).status, 200);
    assert.equal(govern(e, ["advance", "t1", "--note", "draft done in Slack"]).code, 0);
    const reject = inWorkspace(e, () => decisionValue(load("t1"), { gate: "validacao" }, "reject"));
    const r = await send(url, formBody(payload("U0GIL", reject, "Ajustar")));
    assert.equal(r.status, 200, await r.clone().text());
  });
  const p = stateOf(e);
  assert.equal(p.stage, "draft");
  assert.equal(p.votes?.["validacao"]?.[0]?.decision, "reject");
  assert.equal(ledgerOf(e).find((x) => x.kind === "reject")?.source?.kind, "slack");
});

test("an owner gate is approved from Slack only by its owner", async () => {
  const e = setup();
  await serving(e, async (url) => {
    const v = inWorkspace(e, () => decisionValue(load("t1"), { gate: "go" }, "approve"));
    const wrong = await send(url, formBody(payload("U0GIL", v, "Enviar")));
    assert.equal(wrong.status, 409);
    assert.match(((await wrong.json()) as { error: string }).error, /decided by otto/);
    const right = await send(url, formBody(payload("U0OTTO", v, "Enviar")));
    assert.equal(right.status, 200, await right.clone().text());
    const reject = inWorkspace(e, () => decisionValue(load("t1"), { gate: "go" }, "reject"));
    const r = await send(url, formBody(payload("U0OTTO", reject, "Não enviar")));
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /no approval policy/);
  });
  const p = stateOf(e);
  assert.equal(p.approvals["go"]?.by, "otto");
  assert.equal(p.approvals["go"]?.source?.kind, "slack");
});

test("an unmapped Slack user, another Slack team or a person outside the role decides nothing", async () => {
  const e = setup();
  const before = readFileSync(join(e.projects, "t1", "govern.json"), "utf8");
  await serving(e, async (url) => {
    const v = inWorkspace(e, () => decisionValue(load("t1"), { task: "draft" }, "complete"));
    const stranger = await send(url, formBody(payload("U0NOBODY", v, "Concluído")));
    assert.equal(stranger.status, 403);
    assert.match(((await stranger.json()) as { error: string }).error, /U0NOBODY.*no person/);
    const team = await send(url, formBody(payload("U0ANA", v, "Concluído", { team: "T0OTHER" })));
    assert.equal(team.status, 403);
    assert.match(((await team.json()) as { error: string }).error, /T0OTHER/);
    const role = await send(url, formBody(payload("U0GIL", v, "Concluído")));
    assert.equal(role.status, 409);
    assert.match(((await role.json()) as { error: string }).error, /gil is not eligible/);
  });
  assert.equal(readFileSync(join(e.projects, "t1", "govern.json"), "utf8"), before);
});

test("a replayed, stale or forged request decides nothing", async () => {
  const e = setup();
  await serving(e, async (url) => {
    const v = inWorkspace(e, () => decisionValue(load("t1"), { task: "draft" }, "complete"));
    const body = formBody(payload("U0ANA", v, "Concluído"));
    const forged = await send(url, body, { signature: signatureOf(body, NOW, "not-the-signing-secret-at-all!!") });
    assert.equal(forged.status, 401);
    assert.equal(stateOf(e).humanTasks?.["draft"]?.completedBy, undefined);
    const old = await send(url, body, { ts: NOW - SKEW_SECONDS - 10 });
    assert.equal(old.status, 401);
    assert.equal((await send(url, body)).status, 200);
    const again = await send(url, body);
    assert.equal(again.status, 401);
    assert.match(((await again.json()) as { error: string }).error, /already received/);
  });
});

test("a button made for an earlier version of the case is refused", async () => {
  const e = setup();
  await serving(e, async (url) => {
    const v = inWorkspace(e, () => decisionValue(load("t1"), { task: "draft" }, "complete"));
    assert.equal((await send(url, formBody(payload("U0ANA", v, "Concluído")))).status, 200);
    assert.equal(govern(e, ["advance", "t1", "--note", "draft done in Slack"]).code, 0);
    const approve = inWorkspace(e, () => decisionValue(load("t1"), { gate: "validacao" }, "approve"));
    assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ draftSha: "c".repeat(64) })]).code, 0);
    const r = await send(url, formBody(payload("U0GIL", approve, "Aprovar")));
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /changed since/);
  });
  assert.equal(stateOf(e).votes?.["validacao"], undefined);
});

test("the digest covers the case data and the loop counters", () => {
  const e = setup();
  inWorkspace(e, () => {
    const p = load("t1");
    const d = caseDigest(p);
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.equal(caseDigest({ ...p, data: { ...p.data, draftSha: "x" } }) === d, false);
    assert.equal(caseDigest({ ...p, workflow: { ...p.workflow!, loops: { review: 1 } } }) === d, false);
    const noted: Project = { ...p, notes: [...p.notes, { at: "2026-10-29T00:00:00.000Z", stage: "draft", text: "n" }] };
    assert.equal(caseDigest(noted), d, "a note is not a new version of the case");
  });
});

test("the server answers only POST /slack/actions, within its size limit", async () => {
  const e = setup();
  await serving(e, async (url) => {
    const base = url.replace(/\/slack\/actions$/, "");
    assert.equal((await fetch(`${base}/slack/actions`)).status, 404);
    assert.equal((await fetch(`${base}/other`, { method: "POST", body: "x" })).status, 404);
    const big = "payload=" + "x".repeat(MAX_BODY);
    assert.equal((await send(url, big)).status, 413);
    const bad = "payload=%7Bnot-json";
    assert.equal((await send(url, bad)).status, 400);
    const unknownLane = inWorkspace(e, () => decisionValue(load("t1"), { task: "draft" }, "complete")).replace('"t1"', '"t9"');
    assert.equal((await send(url, formBody(payload("U0ANA", unknownLane, "Concluído")))).status, 404);
  });
});

test("the slack command refuses to serve without a signing secret or a team, and is part of the slack extension", () => {
  const e = makeEnv("slack-cli");
  const noTeam = govern(e, ["slack", "serve", "--port", "0"], { SLACK_SIGNING_SECRET: SECRET });
  assert.notEqual(noTeam.code, 0);
  assert.match(noTeam.err, /slack\.team/);
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: TEAM } }));
  const noSecret = govern(e, ["slack", "serve", "--port", "0"], { SLACK_SIGNING_SECRET: "" });
  assert.notEqual(noSecret.code, 0);
  assert.match(noSecret.err, /SLACK_SIGNING_SECRET/);
  const short = govern(e, ["slack", "serve", "--port", "0"], { SLACK_SIGNING_SECRET: "short" });
  assert.notEqual(short.code, 0);
  assert.match(short.err, /at least 16/);
  const off = govern(e, ["slack", "serve"], { GOVERN_EXTENSIONS: "business" });
  assert.equal(off.code, 4);
  assert.match(off.err, /slack extension/);
});

test("the signing secret can come from the dotenv file the config names", () => {
  const e = makeEnv("slack-env");
  const envFile = write(join(e.root, "slack.env"), `OTHER=1\nSLACK_SIGNING_SECRET=${SECRET}\n`);
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: TEAM, envFile: "slack.env" } }));
  assert.ok(envFile);
  const r = govern(e, ["slack", "serve", "--port", "99999"], { SLACK_SIGNING_SECRET: "" });
  // the secret was found: the refusal is the port, not the secret
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.err, /SLACK_SIGNING_SECRET/);
  assert.match(r.err, /port/);
});

// ---------------------------------------------------------------- options: an approval that also sets case data

const OPTIONS_PROCESS = {
  ...PROCESS,
  fields: { draftSha: { type: "string" }, sugestao1: { type: "string" }, sugestao2: { type: "string" }, respostaFinal: { type: "string" } },
  stages: [{ name: "responder", next: [{ to: ["send"] }] }, { name: "send", next: [] }],
  gates: [{ name: "envio", stage: "responder", policy: { role: "gestor", quorum: 1 },
    options: [{ label: "Enviar sugestão 1", set: { respostaFinal: "{data.sugestao1}" } }, { label: "Enviar sugestão 2", set: { respostaFinal: "{data.sugestao2}" } }] }],
};
function optionsSetup(): Env {
  const e = setup([]);
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(OPTIONS_PROCESS));
  assert.equal(govern(e, ["new", "t1", "--process", "support", "--title", "Ticket t1"]).code, 0);
  assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ sugestao1: "Restart it.", sugestao2: "Reinstall the driver." })]).code, 0);
  return e;
}

test("an approval with an option sets the option's case data, then records the vote", async () => {
  const e = optionsSetup();
  await serving(e, async (url) => {
    const v = inWorkspace(e, () => decisionValue(load("t1"), { gate: "envio" }, "approve", { respostaFinal: "Reinstall the driver." }));
    const r = await send(url, formBody(payload("U0GIL", v, "Enviar sugestão 2")));
    assert.equal(r.status, 200, await r.clone().text());
  });
  const p = stateOf(e);
  assert.equal(p.data?.["respostaFinal"], "Reinstall the driver.");
  assert.equal(p.votes?.["envio"]?.[0]?.decision, "approve");
  const entry = ledgerOf(e).find((x) => x.kind === "approve" && x.gate === "envio");
  assert.deepEqual(entry?.set, { respostaFinal: "Reinstall the driver." });
});

test("a set that is not one of the gate's options as the case stands is refused", async () => {
  const e = optionsSetup();
  await serving(e, async (url) => {
    const forged = inWorkspace(e, () => decisionValue(load("t1"), { gate: "envio" }, "approve", { respostaFinal: "Anything I like." }));
    const r = await send(url, formBody(payload("U0GIL", forged, "Enviar")));
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /not one of envio's options/);
    const onReject = inWorkspace(e, () => decisionValue(load("t1"), { gate: "envio" }, "reject", { respostaFinal: "Restart it." }));
    assert.equal((await send(url, formBody(payload("U0GIL", onReject, "Não")))).status, 400);
  });
  assert.equal(stateOf(e).data?.["respostaFinal"], undefined);
  assert.equal(stateOf(e).votes?.["envio"], undefined);
});
