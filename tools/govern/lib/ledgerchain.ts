// A lane's ledger as a hash chain. appendLedger (lib/project.ts) seals every entry it writes with `h`: the SHA-256 of
// the previous entry's `h` and of this entry's JSON without `h`. The entry before the first sealed one may be a plain
// line written by an older govern; then the first seal covers the bytes of every line before it. So changing,
// removing or inserting an entry breaks the chain at its line. Cutting the tail does not: the entries left still chain.
// That is what export is for: it copies the new entries to a directory meant to be append-only (a WORM bucket, a
// `chattr +a` mount, another host) and refuses a ledger that no longer begins with what it copied before.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fail } from "./util.ts";
import { ledgerFile } from "./project.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The seal of an entry whose JSON without `h` is `body`, after an entry sealed `prev`. */
export const seal = (prev: string, body: string): string => sha256(`${prev}\n${body}`);

/** What the next entry chains to: the last line's `h`, or (no sealed last line) the hash of the file's bytes so far,
 *  which is "" for an empty or missing file. Reads only the tail unless the last line is unsealed. */
export function chainHead(file: string): string {
  if (!existsSync(file)) return "";
  const last = lastLine(file);
  if (last === undefined) return "";
  const h = sealOf(last);
  return h ?? sha256(readFileSync(file, "utf8"));
}

function sealOf(line: string): string | undefined {
  try {
    const v = JSON.parse(line) as { h?: unknown };
    return typeof v === "object" && v !== null && typeof v.h === "string" ? v.h : undefined;
  } catch { return undefined; }
}

/** The last non-empty line of `file`, read backwards in chunks. */
function lastLine(file: string): string | undefined {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    let tail = "", pos = size;
    while (pos > 0) {
      const n = Math.min(65536, pos);
      pos -= n;
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, pos);
      tail = buf.toString("utf8") + tail;
      const trimmed = tail.replace(/\n+$/, "");
      const i = trimmed.lastIndexOf("\n");
      if (i >= 0 || pos === 0) return trimmed.slice(i + 1) || undefined;
    }
    return undefined;
  } finally { closeSync(fd); }
}

/** One ledger line for `entry`, sealed after `prev`. */
export function sealedLine(prev: string, entry: Record<string, unknown>): string {
  if ("h" in entry) fail("a ledger entry cannot carry its own h: the seal is govern's");
  const body = JSON.stringify(entry);
  return JSON.stringify({ ...entry, h: seal(prev, body) });
}

export interface Verdict {
  slug: string; ok: boolean; entries: number;
  /** Plain lines before the first sealed entry (an older govern's). */
  unsealed: number;
  /** The last entry's seal: what an outside record of the ledger keeps. */
  head?: string;
  problem?: string;
}

/** Check lane `slug`'s chain from its first line; with `against`, also that the ledger begins with the copy export made
 *  there (a copy longer than the ledger, or different, means the ledger was cut or rewritten after it was copied). */
export function verifyLedger(slug: string, o: { against?: string } = {}): Verdict {
  const file = ledgerFile(slug);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const ls = text.split("\n");
  if (ls.at(-1) === "") ls.pop();
  const v: Verdict = { slug, ok: true, entries: ls.length, unsealed: 0 };
  let prev: string | undefined, before = "";
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]!, at = `line ${i + 1}`;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { return { ...v, ok: false, problem: `${at}: not JSON` }; }
    const h = typeof entry.h === "string" ? entry.h : undefined;
    if (h === undefined) {
      if (prev !== undefined) return { ...v, ok: false, problem: `${at}: not sealed, after sealed entries (written around govern, or inserted)` };
      v.unsealed++;
      before += line + "\n";
      continue;
    }
    const { h: _, ...rest } = entry;
    const expected = seal(prev ?? (before ? sha256(before) : ""), JSON.stringify(rest));
    if (expected !== h) return { ...v, ok: false, problem: `${at}: its seal does not match: this entry or one before it was changed, removed or inserted` };
    prev = h;
  }
  if (prev !== undefined) v.head = prev;
  if (o.against) {
    const copy = copyLines(join(o.against, copyName(slug)));
    const diverge = copy.findIndex((l, i) => ls[i] !== l);
    if (copy.length > ls.length) return { ...v, ok: false, problem: `the export in ${o.against} holds ${copy.length} entries; the ledger has ${ls.length}: it was cut after it was copied` };
    if (diverge >= 0) return { ...v, ok: false, problem: `line ${diverge + 1} differs from the export in ${o.against}: the ledger was rewritten after it was copied` };
  }
  return v;
}

const copyName = (slug: string) => `${slug.replace(/\//g, "__")}.jsonl`;
function copyLines(file: string): string[] {
  if (!existsSync(file)) return [];
  const ls = readFileSync(file, "utf8").split("\n");
  if (ls.at(-1) === "") ls.pop();
  return ls;
}

/** Append to `dir`/<lane>.jsonl the entries of lane `slug` it does not hold yet. Fails, copying nothing, when the
 *  ledger does not begin with the copy (cut or rewritten since) or its own chain is broken. */
export function exportLedger(slug: string, dir: string): { copied: number; head?: string } {
  const v = verifyLedger(slug);
  if (!v.ok) fail(`${slug}: the ledger's chain is broken (${v.problem}); nothing exported`, 1);
  const target = join(dir, copyName(slug));
  const copy = copyLines(target);
  const text = existsSync(ledgerFile(slug)) ? readFileSync(ledgerFile(slug), "utf8") : "";
  const ls = text.split("\n");
  if (ls.at(-1) === "") ls.pop();
  if (copy.length > ls.length || copy.some((l, i) => ls[i] !== l))
    fail(`${slug}: the ledger does not begin with the ${copy.length} entries already exported to ${target}: it was cut or rewritten after they were copied; nothing exported`, 1);
  const fresh = ls.slice(copy.length);
  if (fresh.length) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(target, fresh.map((l) => l + "\n").join(""));
  }
  return { copied: fresh.length, ...(v.head ? { head: v.head } : {}) };
}
