// Installing SKILL.md as the govern skill: an atomic copy (temp file in the destination's folder, then rename) that is read
// back and compared by sha256 before and after the rename, and a check that the installed copy is the current one.
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fail, sha256 } from "./util.ts";

export const sha256File = (f: string) => sha256(readFileSync(f));

/** The file operations the install uses; a test swaps one to prove a bad write is caught. */
export interface InstallIo {
  writeFile?: (path: string, data: Buffer) => void;
  rename?: (from: string, to: string) => void;
}

/** Copy `src` to `dest` atomically. The temp file is verified before it replaces `dest` (a bad write never replaces a good
 *  install) and `dest` is verified after; either mismatch is a GovernError (exit 1) naming the file and both hashes. The
 *  temp file is removed on every path. Returns the sha256 installed. */
export function installSkill(src: string, dest: string, io: InstallIo = {}): string {
  const writeFile = io.writeFile ?? ((p: string, b: Buffer) => writeFileSync(p, b));
  const rename = io.rename ?? renameSync;
  const data = readFileSync(src);
  const want = sha256(data);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomUUID()}.tmp`);
  const verify = (f: string) => {
    const got = sha256File(f);
    if (got !== want) fail(`install-skill: ${f}: read back sha256 ${got}, expected ${want} (the sha256 of ${src}); nothing is trusted, run it again`, 1);
  };
  try {
    writeFile(tmp, data);
    verify(tmp);
    rename(tmp, dest);
    verify(dest);
  } finally {
    rmSync(tmp, { force: true });
  }
  return want;
}

/** Whether `dest` is byte for byte `src`: null when it is, else the reason, naming both paths and both sha256s. */
export function skillDrift(src: string, dest: string): string | null {
  const want = sha256File(src);
  if (!existsSync(dest)) return `${dest} is missing; the source is ${src} sha256 ${want} (run govern install-skill)`;
  const got = sha256File(dest);
  if (got === want) return null;
  return `the installed skill differs from the source:\n  ${dest} sha256 ${got}\n  ${src} sha256 ${want}\n(run govern install-skill)`;
}
