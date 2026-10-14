import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, jsonl, write, asSession, typed, present } from "./helpers.ts";
import { normalize, typedText, findTyped } from "../lib/approval.ts";
import { parseProcess } from "../lib/process.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const state = (e: ReturnType<typeof makeEnv>, slug: string) => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
const ledger = (e: ReturnType<typeof makeEnv>, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
function lane(process = "video") {
  const e = makeEnv();
  const r = govern(e, ["new", "film", "--process", process, "--title", "A Test", ...(process === "video" ? ["--kind", "short"] : [])]);
  assert.equal(r.code, 0, r.err);
  return e;
}

// ---------------------------------------------------------------- the text check

test("normalize folds case, whitespace and typographic quotes", () => {
  assert.equal(normalize("  It’s  “OK”\n\tgo "), `it's "ok" go`);
});

test("typedText keeps the person's typed segments: harness tags and non-text parts dropped, a removed block splits the text", () => {
  assert.deepEqual(typedText("ok <pasted_content id=1>secret go</pasted_content> now"), ["ok ", " now"]);
  assert.deepEqual(typedText("a<system-reminder>b</system-reminder>c<ide_selection>d</ide_selection>e"), ["a", "c", "e"]);
  assert.deepEqual(typedText("yes <pasted_content>never closed"), ["yes "]);
  assert.deepEqual(typedText([{ type: "tool_result", content: "approved" }, { type: "text", text: "fine" }, { type: "image" }]), ["fine"]);
});

test("typedText drops a whole part whose harness tags nest or do not balance (fails closed); other parts are kept", () => {
  assert.deepEqual(typedText("<pasted_content>x <pasted_content>y</pasted_content> approve it</pasted_content> ok"), []);
  assert.deepEqual(typedText("<system-reminder>a <system-reminder>b</system-reminder> go</system-reminder>"), []);
  assert.deepEqual(typedText("approve it</pasted_content>"), []);
  assert.deepEqual(typedText([{ type: "text", text: "<system-reminder>a <ide_selection>b</ide_selection></system-reminder>" }, { type: "text", text: "go ahead" }]), ["go ahead"]);
});

test("a quote matches whole words only, and never across a removed block", () => {
  assert.equal(findTyped([typed("look at google")], "ok"), undefined);
  assert.equal(findTyped([typed("look at google")], "go"), undefined);
  assert.equal(findTyped([typed("ok, go ahead")], "ok")?.uuid, typed("ok, go ahead").uuid);
  assert.ok(findTyped([typed("Yes — ship it.")], "ship it"));
  assert.equal(findTyped([typed("ok <pasted_content>pasted</pasted_content>go")], "ok go"), undefined);
});

test("findTyped returns the newest of two matching typed messages", () => {
  assert.equal(findTyped([typed("go ahead", { uuid: "first" }), typed("fine, go ahead", { uuid: "second" })], "go ahead")?.uuid, "second");
});

test("findTyped accepts only human, non-meta, non-sidechain messages, newest first", () => {
  const lines = [
    typed("approved, ship it", { uuid: "old" }),
    typed("approved, ship it", { uuid: "peer", origin: { kind: "peer" } }),
    typed("approved, ship it", { uuid: "meta", isMeta: true }),
    typed("approved, ship it", { uuid: "side", isSidechain: true }),
    typed("approved, ship it", { uuid: "task", origin: { kind: "task-notification" } }),
    { type: "assistant", uuid: "asst", message: { role: "assistant", content: [{ type: "text", text: "approved, ship it" }] } },
    { type: "user", uuid: "legacy", turnOrigin: "human", message: { content: "legacy approved words" } },
    { type: "user", uuid: "bare", message: { content: "no origin at all" } },
  ];
  assert.equal(findTyped(lines, "SHIP  it")?.uuid, "old");
  assert.equal(findTyped(lines, "legacy approved")?.uuid, "legacy");
  assert.equal(findTyped(lines, "no origin"), undefined);
  assert.equal(findTyped([typed("x <pasted_content>approve it</pasted_content>")], "approve it"), undefined);
});

// ---------------------------------------------------------------- inside a Claude session

test("in a session, the quote must be in a message the person typed, and the approval records where", () => {
  const e = lane();
  asSession(e, SID, [typed("hello"), typed("Script is fine — go ahead", { uuid: "m-7", timestamp: "2026-10-14T10:11:12.000Z" })]);
  const r = govern(e, ["approve", "film", "script", "--quote", "script is FINE"]);
  assert.equal(r.code, 0, r.err);
  const a = state(e, "film").approvals.script;
  assert.deepEqual(a.source, { kind: "session", sessionId: SID, message: "m-7", messageAt: "2026-10-14T10:11:12.000Z" });
  assert.equal(a.by, "owner");
  const l = present(ledger(e, "film").find((x) => x.kind === "approve"), "approve entry");
  assert.deepEqual(l.source, a.source);
  assert.equal(l.by, "owner");
});

test("a quote that is not in the person's words fails with exit 1 and says where it looked", () => {
  const e = lane();
  asSession(e, SID, [
    typed("please look at the script"),
    typed("approved the script", { origin: { kind: "peer" } }),
    { type: "user", message: { content: [{ type: "tool_result", content: "approved the script" }] } },
    typed("see <pasted_content>approved the script</pasted_content>"),
  ]);
  const r = govern(e, ["approve", "film", "script", "--quote", "approved the script"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not found in the person's typed messages/);
  assert.match(r.err, new RegExp(`${SID}\\.jsonl`));
  assert.match(r.err, /only the person's own typed words count/);
  assert.deepEqual(state(e, "film").approvals, {});
  assert.deepEqual(ledger(e, "film").filter((x) => x.kind === "approve"), []);
});

test("a session whose transcript cannot be found cannot approve", () => {
  const e = lane();
  asSession(e, SID, []);
  const r = govern(e, ["approve", "film", "script", "--quote", "ok"], { GOVERN_CLAUDE_PROJECTS: join(e.root, "elsewhere") });
  assert.equal(r.code, 1);
  assert.match(r.err, /no transcript for session 1111/);
});

test("a session id that is not a plain id is refused, not used as a path", () => {
  const e = lane();
  asSession(e, "../../etc/x", []);
  const r = govern(e, ["approve", "film", "script", "--quote", "ok"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a session id/);
});

test("CLAUDE_CODE_SESSION_ID wins over a stale registry entry", () => {
  const e = lane();
  asSession(e, SID, [typed("nothing here")]);
  const other = "99999999-2222-3333-4444-555555555555";
  write(join(e.root, "claude", "proj", `${other}.jsonl`), JSON.stringify(typed("approved, go on")) + "\n");
  const r = govern(e, ["approve", "film", "script", "--quote", "approved"], { CLAUDE_CODE_SESSION_ID: other });
  assert.equal(r.code, 0, r.err);
  assert.equal(state(e, "film").approvals.script.source.sessionId, other);
});

test("any Claude Code marker means a session, never a terminal approval", () => {
  for (const marker of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"]) {
    const r = govern(lane(), ["approve", "film", "script", "--quote", "approved"], { [marker]: marker === "CLAUDE_CODE_SESSION_ID" ? SID : "cli" });
    assert.equal(r.code, 1, marker);
    assert.doesNotMatch(r.err, /terminal approval/);
  }
});

test("an unreadable transcript is a govern error (exit 1), not a crash", () => {
  const e = lane();
  const f = asSession(e, SID, []);
  rmSync(f);
  mkdirSync(f);
  const r = govern(e, ["approve", "film", "script", "--quote", "ok"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot read the transcript/);
});

test("CLAUDECODE without a registered session uses CLAUDE_CODE_SESSION_ID, and is refused without one", () => {
  const e = lane();
  write(join(e.root, "claude", "proj", `${SID}.jsonl`), JSON.stringify(typed("fine, approved")) + "\n");
  assert.equal(govern(e, ["approve", "film", "script", "--quote", "approved"], { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID }).code, 0);
  const r = govern(lane(), ["approve", "film", "script", "--quote", "approved"], { CLAUDECODE: "1" });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot tell which session/);
});

// ---------------------------------------------------------------- Codex and terminal

test("an approval from a Codex shell is refused, even under a Claude session", () => {
  const e = lane();
  asSession(e, SID, [typed("approved")]);
  for (const marker of ["CODEX_THREAD_ID", "CODEX_SANDBOX_NETWORK_DISABLED"]) {
    const r = govern(e, ["approve", "film", "script", "--quote", "approved"], { [marker]: "1" });
    assert.equal(r.code, 1, marker);
    assert.match(r.err, /Codex session cannot be verified/);
    assert.match(r.err, /own terminal or a Claude session/);
  }
  assert.deepEqual(state(e, "film").approvals, {});
});

test("an approval from a Grok shell is refused, even under a Claude session: grok has no transcript govern can rely on", () => {
  const e = lane();
  asSession(e, SID, [typed("approved")]);
  for (const marker of ["GROK_AGENT", "GROK_SESSION_ID"]) {
    const r = govern(e, ["approve", "film", "script", "--quote", "approved"], { [marker]: "1" });
    assert.equal(r.code, 1, marker);
    assert.match(r.err, /Grok session cannot be verified \(.*is set/);
    assert.match(r.err, /own terminal or a Claude session/);
  }
  assert.deepEqual(state(e, "film").approvals, {});
});

test("from a plain terminal the approval is recorded as typed by the OS user", () => {
  const e = lane();
  assert.equal(govern(e, ["approve", "film", "script", "--quote", "go"]).code, 0);
  const a = state(e, "film").approvals.script;
  assert.deepEqual(a.source, { kind: "terminal", user: userInfo().username });
  assert.equal(a.quote, "go");
  assert.deepEqual(present(ledger(e, "film").find((x) => x.kind === "approve"), "approve entry").source, a.source);
});

// ---------------------------------------------------------------- decision owner

const gated = (e: ReturnType<typeof makeEnv>, gates: unknown[]) =>
  write(join(e.root, "PALS-Notes", "processes", "team.json"), JSON.stringify({ version: 1, name: "team", stages: [{ name: "draft" }, { name: "live" }], gates }));

test("a gate that names another owner needs --by to match, and the approval records whose words they are", () => {
  const e = makeEnv();
  gated(e, [{ name: "script", stage: "draft", owner: "editor" }, { name: "publish", stage: "live", owner: "publisher", needs: ["script"] }, { name: "plain" }]);
  assert.equal(govern(e, ["new", "t1", "--process", "team", "--title", "T"]).code, 0);
  assert.match(govern(e, ["approve", "t1", "script", "--quote", "ok"]).err, /gate script is decided by editor: pass --by editor/);
  assert.match(govern(e, ["approve", "t1", "script", "--quote", "ok", "--by", "owner"]).err, /gate script is decided by editor, not owner/);
  assert.equal(govern(e, ["approve", "t1", "script", "--quote", "ok", "--by", "editor"]).code, 0);
  assert.equal(state(e, "t1").approvals.script.by, "editor");
  assert.match(present(state(e, "t1").notes.at(-1), "note").text, /editor approved script/);
  assert.equal(present(ledger(e, "t1").find((x) => x.kind === "approve"), "approve entry").by, "editor");
  // a gate with no owner is the owner's; --by must then say owner
  assert.match(govern(e, ["approve", "t1", "plain", "--quote", "ok", "--by", "editor"]).err, /gate plain is decided by owner, not editor/);
  assert.equal(govern(e, ["approve", "t1", "plain", "--quote", "ok", "--by", "owner"]).code, 0);
});

test("the process file checks the owner field, and files without it keep working", () => {
  const ok = parseProcess("p.json", JSON.stringify({ version: 1, name: "p", stages: [{ name: "a" }], gates: [{ name: "g", owner: "editor" }, { name: "h" }] }));
  assert.equal(present(ok.gates[0], "gate").owner, "editor");
  assert.equal(present(ok.gates[1], "gate").owner, undefined);
  assert.throws(() => parseProcess("p.json", JSON.stringify({ version: 1, name: "p", stages: [{ name: "a" }], gates: [{ name: "g", owner: "" }] })), /p\.json: \$\.gates\[0\]\.owner: must be a non-empty string/);
  assert.throws(() => parseProcess("p.json", JSON.stringify({ version: 1, name: "p", stages: [{ name: "a" }], gates: [{ name: "g", owner: 3 }] })), /\$\.gates\[0\]\.owner/);
});

test("an approval recorded before this field existed still loads", () => {
  const e = lane();
  const f = join(e.projects, "film", "govern.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  s.approvals.script = { at: "2026-10-01T10:00:00.000Z", quote: "ok" };
  write(f, JSON.stringify(s));
  assert.match(govern(e, ["brief", "film"]).out, /script ✓/);
});

// ---------------------------------------------------------------- accepting a check change is an approval too

test("accepting a check change is checked like an approval: typed words in a session, and the source recorded", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "lib", "--process", "dev", "--title", "L"]).code, 0);
  govern(e, ["cmd", "lib", "test", "--", "false"]);
  govern(e, ["cmd", "lib", "test", "--", "true"]);
  asSession(e, SID, [typed("run the tests again please")]);
  const refused = govern(e, ["check", "lib", "test", "--accept", "--quote", "true is fine for now"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /not found in the person's typed messages/);
  assert.deepEqual(ledger(e, "lib").filter((x) => x.kind === "check-accept"), [], "a refused accept writes nothing");

  asSession(e, SID, [typed("True is fine for now, accept it", { uuid: "m-9", timestamp: "2026-10-14T11:00:00.000Z" })]);
  const r = govern(e, ["check", "lib", "test", "--accept", "--quote", "true is fine for now"]);
  assert.equal(r.code, 0, r.err);
  const l = present(ledger(e, "lib").find((x) => x.kind === "check-accept"), "check-accept entry");
  assert.deepEqual(l.source, { kind: "session", sessionId: SID, message: "m-9", messageAt: "2026-10-14T11:00:00.000Z" });
  assert.equal(l.by, "owner");
});

test("accepting a check change from a Codex shell is refused", () => {
  const e = makeEnv();
  govern(e, ["new", "lib", "--process", "dev", "--title", "L"]);
  govern(e, ["cmd", "lib", "test", "--", "false"]);
  govern(e, ["cmd", "lib", "test", "--", "true"]);
  const r = govern(e, ["check", "lib", "test", "--accept", "--quote", "fine"], { CODEX_THREAD_ID: "t" });
  assert.equal(r.code, 1);
  assert.match(r.err, /Codex session cannot be verified/);
});
