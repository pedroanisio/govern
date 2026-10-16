// Installing the govern skill: `<skills dir>/govern` is a symbolic link to the tool's tracked folder (SKILL.md and REFERENCE.md
// beside the code), never a copy; and a check that the entry is that link and the folder's SKILL.md is the current one.
import { readFileSync, mkdirSync, statSync, lstatSync, readlinkSync, realpathSync, symlinkSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail, sha256, type FlagSpec } from "./util.ts";

/** The SHA-256 hex digest of file `f`'s bytes; a missing or unreadable file throws the fs error. */
export const sha256File = (f: string) => sha256(readFileSync(f));

/** The entry's own kind, without following a link: missing, a link (with its target as written), a directory or a file. */
type Entry = { kind: "missing" } | { kind: "link"; target: string } | { kind: "dir" } | { kind: "file" };
function entryAt(path: string): Entry {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return { kind: "missing" };
  if (st.isSymbolicLink()) return { kind: "link", target: readlinkSync(path) };
  return { kind: st.isDirectory() ? "dir" : "file" };
}

/** Whether the link at `link` resolves to the folder `toolDir` (a dangling link does not). */
function pointsAt(link: string, toolDir: string): boolean {
  try { return realpathSync(link) === realpathSync(toolDir); } catch { return false; }
}

/** Refuse, as a failed check (exit 1), a tool folder without a SKILL.md: there is nothing to link. */
function preflight(toolDir: string): void {
  if (!statSync(join(toolDir, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) fail(`install-skill: ${toolDir} has no SKILL.md; the tool folder is missing or not govern's`, 1);
}

/** What an install did to `<skills dir>/govern`. */
export type InstallResult = "installed" | "already installed" | "replaced a link elsewhere" | "replaced a copy";

/** Make `<skillsDir>/govern` a symbolic link to the absolute `toolDir`. A link already there to `toolDir` is left alone; a link
 *  elsewhere is replaced (a temp link renamed over it); a real directory or file is a GovernError (exit 1) naming it and the fix,
 *  unless `replace`, which removes it first. Nothing outside `<skillsDir>/govern` is touched. */
export function installSkill(toolDir: string, skillsDir: string, replace = false): InstallResult {
  preflight(toolDir);
  const target = resolve(toolDir);
  const link = join(skillsDir, "govern");
  const have = entryAt(link);
  if (have.kind === "link" && pointsAt(link, target)) return "already installed";
  if ((have.kind === "dir" || have.kind === "file") && !replace) {
    fail(`install-skill: ${link} is a ${have.kind === "dir" ? "directory" : "file"}, not a link to ${target}; the skill is linked, never copied. Remove it and run install-skill again, or run install-skill --replace`, 1);
  }
  mkdirSync(skillsDir, { recursive: true });
  if (have.kind === "link") {
    const tmp = join(skillsDir, `.govern.${randomUUID()}.tmp`);
    try { symlinkSync(target, tmp, "dir"); renameSync(tmp, link); } finally { rmSync(tmp, { force: true }); }
    return "replaced a link elsewhere";
  }
  if (have.kind !== "missing") rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, "dir");
  return have.kind === "missing" ? "installed" : "replaced a copy";
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

/** The bytes per token `govern manual --size` and the desk divide by: an estimate for English markdown, not a tokenizer. */
export const BYTES_PER_TOKEN = 3.6;

/** The approximate token count of `bytes` bytes of manual text. */
export const approxTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

/** The tool's folder: where SKILL.md, REFERENCE.md and the topic documents live. */
export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The core manual's approximate token count, for the desk's tuning line. */
export const coreManualTokens = (dir = TOOL_DIR): number => approxTokens(statSync(join(dir, "SKILL.md")).size);

/** Whether `<skillsDir>/govern` is a link resolving to `toolDir` whose SKILL.md is the current one: null when it is, else the
 *  problem, naming the path, what was found and the fix. */
export function skillDrift(toolDir: string, skillsDir: string): string | null {
  preflight(toolDir);
  const link = join(skillsDir, "govern");
  const have = entryAt(link);
  if (have.kind === "missing") return `${link} is missing (run govern install-skill)`;
  if (have.kind !== "link") return `${link} is a ${have.kind === "dir" ? "directory" : "file"} (a copy), not a link to ${toolDir} (remove it and run govern install-skill, or run govern install-skill --replace)`;
  if (!pointsAt(link, toolDir)) return `${link} is a link elsewhere: it points to ${have.target}, not ${toolDir} (run govern install-skill)`;
  const want = sha256File(join(toolDir, "SKILL.md"));
  let got = "unreadable";
  try { got = sha256File(join(link, "SKILL.md")); } catch { /* reported as stale below */ }
  if (got !== want) return `${link}/SKILL.md is stale: sha256 ${got}, the tool's is ${want} (run govern install-skill)`;
  return null;
}
