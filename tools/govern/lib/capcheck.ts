// Grant self-test: one probe per capability of a profile, each in a sealed session with the profile's own grant, answered in a
// fixed JSON shape and verified by govern, never trusted. The result is recorded with the profile's hash (see caps.ts).
/**
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * LLMs statistically produce errors: omissions, hallucinations,
 * partial completions, schema violations, and silent failures.
 * These are properties of the model class, not exceptional conditions.
 *
 * Any caller of this function that skips output validation is
 * introducing an architectural omission — not a code bug downstream.
 *
 * Verification is mandatory. Treat all LLM output as untrusted input.
 */
// The five controls: (1) strict parse, unknown keys and bad values rejected; (2) the reply must be about the capability asked;
// (3) claims are checked against ground truth (a random nonce in evidence, a file govern reads itself); (4) an unparseable or
// missing reply is a failed check, never a pass; (5) one call per capability, no retries, results recorded, not summarised.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { obj, str, literal, check, ShapeError } from "./shape.ts";
import { nowIso, writeJson } from "./util.ts";
import { runSealed } from "./queue.ts";
import { checkFile, getProfile, capsOf, profileHash, type CheckRecord, type ProbeResult, type Registry, type Capability, type Profile } from "./caps.ts";

const EVIDENCE_MAX = 2000;
const REPLY = obj({ capability: str, status: literal("ok", "refused", "error"), evidence: str });

const probePrompt = (c: Capability, instruction: string): string => [
  `You are being tested to see whether one grant works. The capability is "${c.name}" (${c.description}).`,
  `Do exactly this, using only your granted tools: ${instruction}`,
  `If a tool is refused or unavailable, do not work around it: report it.`,
  `Answer with JSON only: {"capability": "${c.name}", "status": "ok" | "refused" | "error", "evidence": what the tool returned or why it failed}.`,
].join("\n");

/** Strictly parse one probe reply; the second value is the reason it is invalid. */
export function parseProbe(text: string | undefined, cap: string): { reply: { status: "ok" | "refused" | "error"; evidence: string } } | { invalid: string } {
  if (text === undefined || text.trim() === "") return { invalid: "no reply" };
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try { raw = JSON.parse(t); } catch { return { invalid: "not JSON" }; }
  let r;
  try { r = check("probe reply", raw, REPLY); } catch (e) { return { invalid: e instanceof ShapeError ? e.message : String(e) }; }
  if (r.capability !== cap) return { invalid: `answered for ${r.capability}, asked about ${cap}` };
  if (r.evidence.length > EVIDENCE_MAX) return { invalid: `evidence is ${r.evidence.length} characters, the limit is ${EVIDENCE_MAX}` };
  return { reply: { status: r.status, evidence: r.evidence } };
}

function probeOne(reg: Registry, prof: Profile, c: Capability, dir: string, model: string, timeoutSec: number): ProbeResult {
  const probe = c.probe;
  if (!probe) return { capability: c.name, status: "untested", evidence: "the capability defines no probe" };
  const nonce = `chk-${randomBytes(8).toString("hex")}`;
  const sub = (s: string) => s.replaceAll("{nonce}", nonce);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe.txt"), nonce);
  const r = runSealed(reg, prof, dir, probePrompt(c, sub(probe.instruction)), timeoutSec, { model, lastMessage: join(dir, "reply.txt") });
  if (r.error) return { capability: c.name, status: "error", evidence: r.error };
  const p = parseProbe(r.text, c.name);
  if ("invalid" in p) return { capability: c.name, status: "invalid", evidence: `invalid reply: ${p.invalid}` };
  if (p.reply.status !== "ok") return { capability: c.name, status: p.reply.status, evidence: p.reply.evidence };
  if (probe.expect !== undefined && !p.reply.evidence.includes(sub(probe.expect))) return { capability: c.name, status: "invalid", evidence: "invalid reply: evidence does not contain the probe's expected text" };
  if (probe.file) {
    const f = resolve(dir, probe.file.path);
    const inside = f.startsWith(resolve(dir) + sep);
    if (!inside || !existsSync(f) || !readFileSync(f, "utf8").includes(sub(probe.file.contains))) return { capability: c.name, status: "invalid", evidence: `invalid reply: ${probe.file.path} was not written with the probe's text` };
  }
  return { capability: c.name, status: "ok", evidence: p.reply.evidence };
}

/** Run the self-test of `profile` and record it under `<queue>/checks/`. The probe model is GOVERN_CAPS_CHECK_MODEL, else haiku (claude). */
export function checkProfile(queueDir: string, reg: Registry, profile: string, timeoutSec = 300): CheckRecord {
  const prof = getProfile(profile, reg);
  const model = prof.engine === "claude" ? process.env.GOVERN_CAPS_CHECK_MODEL ?? "haiku" : prof.model ?? "default";
  const root = join(queueDir, "checks", prof.name, `run-${nowIso().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`);
  const results = capsOf(reg, prof).map((c) => probeOne(reg, prof, c, join(root, c.name), prof.engine === "claude" ? model : prof.model ?? "", timeoutSec));
  rmSync(join(queueDir, "checks", prof.name), { recursive: true, force: true });
  const rec: CheckRecord = { version: 1, profile: prof.name, hash: profileHash(reg, prof), at: nowIso(), model, ok: results.every((r) => r.status === "ok" || r.status === "untested"), results };
  writeJson(checkFile(queueDir, prof.name), rec);
  return rec;
}
