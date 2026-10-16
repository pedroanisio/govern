// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// Built-in reply check for a fact-check, selected by `govern task send --check claims-cited --file LEDGER.json`: every claim of the
// ledger must be addressed in the reply, that is, its id appears there as a whole token. It proves each claim is mentioned, not that
// the verdict on it is right.
// The ledger is the first attached .json file (GOVERN_TASK_FILES, a JSON array of absolute paths, in the order of --file) whose top level
// is an object with a `claims` key. Its shape is: { "claims": [ { "id": "<non-empty string>", ... } ] }, `claims` non-empty, ids distinct;
// other keys of the object and of a claim are allowed and ignored. Any other shape is an error, never a pass.
// usage: claims-cited.ts <reply file>
//   exit 0: every id appears; exit 1: some id is missing (named on stderr); exit 2: the check could not run (no ledger, or a wrong shape).
import { readFileSync } from "node:fs";

const [replyFile] = process.argv.slice(2);
const couldNot = (why: string): never => { console.error(`could not run: ${why}`); process.exit(2); };
if (!replyFile) couldNot("usage: claims-cited.ts <reply file>");
let files: unknown;
try { files = JSON.parse(process.env.GOVERN_TASK_FILES ?? "[]"); } catch { couldNot("GOVERN_TASK_FILES is not a JSON array"); }
if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) couldNot("GOVERN_TASK_FILES is not a JSON array of paths");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

let ledger: { file: string; claims: unknown } | undefined;
for (const file of (files as string[]).filter((f) => f.endsWith(".json"))) {
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, "utf8")); } catch (e) { couldNot(`${file} is not readable JSON (${(e as Error).message})`); }
  if (isObj(v) && "claims" in v) { ledger = { file, claims: v["claims"] }; break; }
}
if (!ledger) couldNot("no attached .json file has a top-level `claims` (send the ledger with --file LEDGER.json)");
const { file, claims } = ledger!;
if (!Array.isArray(claims) || !claims.length) couldNot(`${file}: \`claims\` must be a non-empty array`);
const ids: string[] = [];
(claims as unknown[]).forEach((c, i) => {
  if (!isObj(c)) couldNot(`${file}: claims[${i}] must be an object`);
  const id = (c as Record<string, unknown>)["id"];
  if (typeof id !== "string" || !id.trim()) couldNot(`${file}: claims[${i}].id must be a non-empty string`);
  if (ids.includes(id as string)) couldNot(`${file}: claims[${i}].id ${JSON.stringify(id)} is used twice`);
  ids.push(id as string);
});
const text = readFileSync(replyFile!, "utf8");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const missing = ids.filter((id) => !new RegExp(`(?<![\\w-])${esc(id)}(?![\\w-])`).test(text));
if (missing.length) { console.error(`claims not addressed (${ids.length - missing.length}/${ids.length}): ${missing.join(", ")}`); process.exit(1); }
console.log(`${ids.length}/${ids.length} claims addressed`);
