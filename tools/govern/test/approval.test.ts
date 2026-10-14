import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("typedText drops pasted content, reminders and IDE tags, and keeps only text parts", () => {
  assert.equal(typedText("ok <pasted_content id=1>secret go</pasted_content> now").replace(/\s+/g, " "), "ok now");
  assert.equal(typedText("a<system-reminder>b</system-reminder>c<ide_selection>d</ide_selection>e"), "ace");
  assert.equal(typedText("yes <pasted_content>never closed"), "yes ");
  assert.equal(typedText([{ type: "tool_result", content: "approved" }, { type: "text", text: "fine" }, { type: "image" }]), "fine");
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
