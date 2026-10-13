// Installing SKILL.md as the govern skill: an atomic copy (temp file in the destination's folder, then rename) that is read
// back and compared by sha256 before and after the rename, and a check that the installed copy is the current one.
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fail, sha256, type FlagSpec } from "./util.ts";

export const sha256File = (f: string) => sha256(readFileSync(f));

/** Refuse, as a failed check (exit 1), a source that is not a file and a destination that is a directory: both would
 *  otherwise surface as a raw EISDIR/ENOENT from the fs call. */
function preflight(src: string, dest: string): void {
  if (!statSync(src, { throwIfNoEntry: false })?.isFile()) fail(`install-skill: the source ${src} is missing or not a file`, 1);
  if (statSync(dest, { throwIfNoEntry: false })?.isDirectory()) fail(`install-skill: ${dest} is a directory, not a file; remove it and run install-skill again`, 1);
}

/** The file operations the install uses; a test swaps one to prove a bad write is caught. */
export interface InstallIo {
  writeFile?: (path: string, data: Buffer) => void;
  rename?: (from: string, to: string) => void;
}

/** Copy `src` to `dest` atomically. The temp file is verified before it replaces `dest` (a bad write never replaces a good
 *  install) and `dest` is verified after; either mismatch is a GovernError (exit 1) naming the file and both hashes. The
 *  temp file is removed on every path. A source that is not a file, or a directory at `dest`, is a GovernError (exit 1)
 *  before anything is written. Returns the sha256 installed. */
export function installSkill(src: string, dest: string, io: InstallIo = {}): string {
  const writeFile = io.writeFile ?? ((p: string, b: Buffer) => writeFileSync(p, b));
  const rename = io.rename ?? renameSync;
  preflight(src, dest);
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

/** What the SKILL.md check needs of a command-table entry (govern.ts's Cmd fits it). */
export interface SkillCmd { name: string; flags?: FlagSpec; subs?: Record<string, { flags?: FlagSpec }>; defaultSub?: string }

/** One `govern <command> [<word>] …` in a manual's code: the command, the word after it, and the mention's own text (to the
 *  end of its line, a `&&` or `;`, or the next `govern `). */
export interface Mention { cmd: string; sub?: string; text: string }

/** Every `govern <command> …` in the code of `md`: fenced blocks and inline code spans. Prose is not read. */
export function skillMentions(md: string): Mention[] {
  // group 1 of each pattern below is mandatory: flatMap only states that to the type checker, it drops nothing
  const code = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) => m[1] ?? []);
  const rest = md.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  code.push(...[...rest.matchAll(/`([^`\n]+)`/g)].flatMap((m) => m[1] ?? []));
  return code.flatMap((c) => [...c.matchAll(/(?:^|[\s(])(govern ([a-z][a-z-]*)(?![\w-])(?: ([a-z][a-z-]*)(?![\w-]))?(?:(?!govern |&&|;)[^\n])*)/g)]
    .flatMap(({ 1: text, 2: cmd, 3: sub }) => (text === undefined || cmd === undefined ? [] : [{ cmd, sub, text: text.trim() }])));
}

/** The flags written in a mention: not inside a quoted value, not after `--` (that is the argv's). */
const flagsIn = (text: string): string[] => {
  const unquoted = text.replace(/"[^"]*"|'[^']*'/g, " ");
  const argvAt = unquoted.search(/(?:^|\s)--(?:\s|$)/);
  const words = argvAt < 0 ? unquoted : unquoted.slice(0, argvAt);
  return [...words.matchAll(/(?:^|[\s[(|])--([A-Za-z][\w-]*)/g)].flatMap((m) => m[1] ?? []);
};

/** The drift between a manual's text and the command table, as one line per problem; empty when they agree:
 *  - a command or subcommand the text never mentions;
 *  - a mention of a command, or of a subcommand, the table does not have (an own key: `constructor` is no subcommand);
 *  - a `--flag` in a mention that the command (or the subcommand named) does not declare. */
export function skillProblems(md: string, commands: readonly SkillCmd[]): string[] {
  const problems: string[] = [];
  const mentions = skillMentions(md);
  const said = new Set(mentions.map((m) => m.cmd));
  const saidSub = new Set(mentions.map((m) => `${m.cmd} ${m.sub}`));
  for (const c of commands) {
    if (!said.has(c.name)) problems.push(`never mentions \`govern ${c.name}\``);
    for (const s of Object.keys(c.subs ?? {})) if (!saidSub.has(`${c.name} ${s}`)) problems.push(`never mentions \`govern ${c.name} ${s}\``);
  }
  const byName = new Map(commands.map((c) => [c.name, c]));
  for (const { cmd: c, sub: s, text } of mentions) {
    const cmd = byName.get(c);
    if (!cmd) { problems.push(`mentions \`govern ${c}\`, which is not a command`); continue; }
    let spec = cmd.flags, label = c;
    if (cmd.subs) {
      const named = s !== undefined && Object.hasOwn(cmd.subs, s) ? cmd.subs[s] : undefined;
      if (named) { spec = named.flags; label = `${c} ${s}`; }
      else if (s !== undefined && !cmd.defaultSub) { problems.push(`mentions \`govern ${c} ${s}\`, which is not a subcommand of ${c}`); continue; }
      else if (cmd.defaultSub) spec = { ...cmd.subs[cmd.defaultSub]?.flags, ...spec };
    }
    const known = [...(spec?.value ?? []), ...(spec?.multi ?? []), ...(spec?.bool ?? []), "help"];
    for (const f of flagsIn(text)) if (!known.includes(f)) problems.push(`\`${text}\`: ${label} takes no --${f} (valid: ${known.map((k) => `--${k}`).join(", ")})`);
  }
  return problems;
}

/** Whether `dest` is byte for byte `src`: null when it is, else the reason, naming both paths and both sha256s. A source
 *  that is not a file, or a directory at `dest`, is a GovernError (exit 1). */
export function skillDrift(src: string, dest: string): string | null {
  preflight(src, dest);
  const want = sha256File(src);
  if (!existsSync(dest)) return `${dest} is missing; the source is ${src} sha256 ${want} (run govern install-skill)`;
  const got = sha256File(dest);
  if (got === want) return null;
  return `the installed skill differs from the source:\n  ${dest} sha256 ${got}\n  ${src} sha256 ${want}\n(run govern install-skill)`;
}
