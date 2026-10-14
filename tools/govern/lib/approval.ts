// Who is approving, and are the quoted words really the person's? Inside a Claude Code session the quote must appear in a
// message the person typed in that session's transcript; from a plain terminal the OS user approves for themselves; a Codex
// shell cannot be verified and is refused. This raises the bar from "any string" to "words in the person's own turn".
// It is NOT tamper-proof: an agent that can write the transcript file (or the registry) can forge a message.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fail } from "./util.ts";
import { callingSession } from "./sessions.ts";

/** Where an approval's words came from, as govern.json and the ledger record it. */
export type Source =
  | { kind: "terminal"; user: string }
  | { kind: "session"; sessionId: string; message: string; messageAt: string };

/** Variables a Codex shell sets. Read from the codex binary's strings (CODEX_THREAD_ID, CODEX_SESSION_ID,
 *  CODEX_SANDBOX_NETWORK_DISABLED), not observed in a live Codex shell: unverified, so a Claude check does not rely on them alone. */
export const CODEX_MARKERS = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_SANDBOX"];

const CLAUDE_DIR = () => process.env.GOVERN_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");

/** Tags the harness adds around or inside a person's turn: their content is not the person's words. */
const HARNESS_TAGS = ["pasted_content", "system-reminder", "ide_selection", "ide_opened_file", "ide_diagnostics", "local-command-stdout",
  "local-command-stderr", "local-command-caveat", "command-name", "command-message", "command-args", "task-notification",
  "user-prompt-submit-hook", "bash-input", "bash-stdout", "bash-stderr"];
const BLOCK = new RegExp(`<(${HARNESS_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "g");
const OPEN = new RegExp(`<(${HARNESS_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`);

/** Case, whitespace and typographic quotes folded, so a quote matches the words however they were typed. */
export const normalize = (s: string): string =>
  s.normalize("NFKC").replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** The text of a message's content that the person typed: text parts only (no tool results), harness tags removed
 *  (a tag never closed removes the rest of the text). */
export function typedText(content: unknown): string {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "";
  return text.replace(BLOCK, "").replace(OPEN, "");
}

interface Line { type?: unknown; uuid?: unknown; timestamp?: unknown; isMeta?: unknown; isSidechain?: unknown; origin?: { kind?: unknown }; turnOrigin?: unknown; message?: { content?: unknown } }
/** A line that records a message the person typed: not meta, not a sidechain, and from the human (origin.kind, or turnOrigin on older lines). */
const isHuman = (l: Line): boolean =>
  l.type === "user" && !l.isMeta && !l.isSidechain && (l.origin ? l.origin.kind === "human" : l.turnOrigin === "human");

/** The newest typed message that contains `quote`, as its uuid and timestamp; undefined when none does. */
export function findTyped(lines: unknown[], quote: string): { uuid: string; timestamp: string } | undefined {
  const q = normalize(quote);
  if (!q) return undefined;
  for (const l of [...lines].reverse() as Line[]) {
    if (l && typeof l === "object" && isHuman(l) && normalize(typedText(l.message?.content)).includes(q))
      return { uuid: typeof l.uuid === "string" ? l.uuid : "", timestamp: typeof l.timestamp === "string" ? l.timestamp : "" };
  }
  return undefined;
}

/** The transcript file of a session: <projects>/<dir>/<sessionId>.jsonl. */
function transcriptOf(sessionId: string): string | undefined {
  const root = CLAUDE_DIR();
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return undefined; }
  return dirs.map((d) => join(root, d, `${sessionId}.jsonl`)).find((f) => existsSync(f));
}

function readLines(file: string): unknown[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Where the approval is being given, and whether it can be checked: a Claude session (its id), a terminal, or a refusal.
 *  Codex first: a Codex run started from a Claude session has that session in its parent chain. */
export function origin(o: { env?: NodeJS.ProcessEnv; dir?: string; chain?: () => number[] } = {}): { kind: "terminal" } | { kind: "session"; sessionId: string } {
  const env = o.env ?? process.env;
  const codex = CODEX_MARKERS.find((k) => env[k]);
  if (codex) fail(`an approval from a Codex session cannot be verified (${codex} is set, and Codex has no transcript format govern can rely on): ` +
    "ask the person to approve from their own terminal or a Claude session", 1);
  const reg = callingSession({ dir: o.dir, chain: o.chain });
  if (reg || env.CLAUDECODE) {
    const id = reg?.sessionId ?? env.CLAUDE_CODE_SESSION_ID;
    if (!id) return fail("cannot tell which session this is (inside a Claude Code session, but no session id in the registry or CLAUDE_CODE_SESSION_ID): approve from the person's own terminal", 1);
    if (!/^[0-9A-Za-z][0-9A-Za-z_-]*$/.test(id)) return fail(`"${id}" is not a session id`, 1);
    return { kind: "session", sessionId: id };
  }
  return { kind: "terminal" };
}

/** The source to record for an approval with these words: checked against the transcript inside a session, the OS user at a terminal. */
export function verifyQuote(quote: string, o: Parameters<typeof origin>[0] = {}): Source {
  const where = origin(o);
  if (where.kind === "terminal") return { kind: "terminal", user: userInfo().username };
  const file = transcriptOf(where.sessionId);
  if (!file) return fail(`no transcript for session ${where.sessionId} under ${CLAUDE_DIR()}: the quote cannot be checked against the person's words, so it is not accepted`, 1);
  const hit = findTyped(readLines(file), quote);
  if (!hit) return fail(`the quote was not found in the person's typed messages of this session (looked in ${file}); only the person's own typed words count, ` +
    "not tool output, files, pasted content or other sessions' messages", 1);
  return { kind: "session", sessionId: where.sessionId, message: hit.uuid, messageAt: hit.timestamp };
}
