// What the command table and the extensions share without importing each other: the output writer, the command types,
// two small helpers and the two core operations an extension's command calls back into.
import { fail, type Args, type FlagSpec } from "./util.ts";
import type { Project } from "./project.ts";
import type { GateDef } from "./process.ts";

/** Print `s` on stdout, ended by one newline. */
export const out = (s: string): void => { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); };

/** One help line: the usage after `govern <command>[ <sub>]`, and what it does. */
export type Line = readonly [usage: string, help?: string];
/** A subcommand: its help lines, its own flags and what it runs. */
export interface Sub { lines: readonly Line[]; flags?: FlagSpec; run: (a: Args) => void | Promise<void> }
/** One command of the table: dispatch, flag parsing and the help text all come from this entry. */
export interface Cmd {
  name: string;
  section: number;
  lines?: readonly Line[];
  flags?: FlagSpec;
  run?: (a: Args) => void | Promise<void>;
  /** Subcommands: the word right after the command, each with its own flags. */
  subs?: Record<string, Sub>;
  /** The subcommand a bare `govern <name>` runs; without one, a missing or unknown subcommand is refused with `noSub`. */
  defaultSub?: string;
  noSub?: string;
  /** Print the context-size warning after the command (default true). */
  footer?: boolean;
}

/** A JSON text read as a value, `fallback` when there is no text; anything that does not parse is refused (exit 2). */
export function jsonValue(text: string | undefined, fallback: unknown = {}): unknown {
  try { return text === undefined ? fallback : JSON.parse(text); } catch { return fail("value must be valid JSON"); }
}

/** Whether `host` only accepts connections from this machine. */
export const loopback = (host: string): boolean => host === "localhost" || host === "::1" || /^127\./.test(host);

/** The core operations an extension's command calls: govern.ts sets them once at startup, so an extension never imports govern.ts. */
export const core: {
  /** `govern advance <slug> …` as the core runs it, from parsed arguments. */
  advance?: (a: Args) => void;
  /** A policy gate's approve or reject, recorded for the person the arguments name. */
  policyDecision?: (a: Args, p: Project, g: GateDef, decision: "approve" | "reject") => void;
} = {};
