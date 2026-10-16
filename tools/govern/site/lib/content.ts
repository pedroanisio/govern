// Reads the site's Markdown pages: strict frontmatter (title, description, nav, section; any other key is an error), the URL
// each file is served at, and a refusal of two pages at one URL. A file named README.md documents its folder and is not a page.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ShapeError, obj, str, type Shape } from "../../lib/shape.ts";

/** A content problem: the file (relative to the content folder), the line when known, and what is wrong. */
export class ContentError extends Error {
  file: string;
  line: number;
  constructor(file: string, line: number, message: string) {
    super(line > 0 ? `${file}:${line}: ${message}` : `${file}: ${message}`);
    this.name = "ContentError";
    this.file = file;
    this.line = line;
  }
}

export interface Page {
  /** Path relative to the content folder, with "/" separators. */
  file: string;
  url: string;
  title: string;
  description: string;
  nav?: number;
  section?: string;
  body: string;
  /** The file line the body starts on. */
  bodyLine: number;
}

const text: Shape<string> = (v, p) => {
  const s = str(v, p);
  if (s.trim() === "") throw new ShapeError(p, "must not be empty");
  return s;
};
const nav: Shape<number> = (v, p) => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  throw new ShapeError(p, `must be a whole number, 0 or more (got ${JSON.stringify(v)})`);
};
const section: Shape<string> = (v, p) => {
  if (typeof v === "string" && /^[a-z]+$/.test(v)) return v;
  throw new ShapeError(p, `must be one lower-case word (got ${JSON.stringify(v)})`);
};
const FRONT = obj({ title: text, description: text }, { nav, section });

/** `key: value` lines between the two `---` lines. A value is a plain string, a quoted string, or (for nav) a digit string. */
function parseFrontmatter(file: string, lines: string[]): { fields: Record<string, unknown>; bodyLine: number; body: string } {
  if (lines[0]?.trim() !== "---") throw new ContentError(file, 1, "the file must begin with a --- frontmatter block (title, description)");
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i]!.trim() === "---") { end = i; break; }
  if (end < 0) throw new ContentError(file, 1, "frontmatter is never closed with ---");
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const at: Record<string, number> = Object.create(null) as Record<string, number>;
  for (let i = 1; i < end; i++) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(l);
    if (!m) throw new ContentError(file, i + 1, `frontmatter line is not "key: value": ${JSON.stringify(l)}`);
    const key = m[1]!;
    if (key in fields) throw new ContentError(file, i + 1, `frontmatter key "${key}" is given twice`);
    let raw: unknown = m[2]!;
    const q = /^(["'])(.*)\1$/.exec(m[2]!);
    if (q) raw = q[2]!;
    else if (key === "nav" && /^\d+$/.test(m[2]!)) raw = parseInt(m[2]!, 10);
    fields[key] = raw;
    at[key] = i + 1;
  }
  try {
    FRONT(fields, "");
  } catch (e) {
    if (!(e instanceof ShapeError)) throw e;
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]$/.exec(e.path);
    const key = quoted ? (JSON.parse(quoted[1]!) as string) : e.path.replace(/^\./, "");
    throw new ContentError(file, at[key] ?? 1, `frontmatter key "${key}": ${e.message}`);
  }
  return { fields, bodyLine: end + 2, body: lines.slice(end + 1).join("\n") };
}

/** The URL a content file is served at: index.md -> /, about.md -> /about/, docs/index.md -> /docs/, docs/a.md -> /docs/a/. */
export function urlOf(file: string): string {
  const parts = file.replace(/\.md$/, "").split("/");
  for (const p of parts) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(p)) throw new ContentError(file, 0, `"${p}" is not a usable URL part (lower-case letters, digits, - and _)`);
  }
  if (parts[parts.length - 1] === "index") parts.pop();
  return parts.length ? `/${parts.join("/")}/` : "/";
}

function listMarkdown(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listMarkdown(dir, r));
    else if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") out.push(r);
  }
  return out;
}

/** Every page under `dir`, in file order. Throws ContentError on the first bad file, or when two files share a URL. */
export function loadContent(dir: string): Page[] {
  let files: string[];
  try { files = listMarkdown(dir); } catch (e) {
    throw new ContentError(dir, 0, `cannot read the content folder (${(e as Error).message})`);
  }
  const pages: Page[] = [];
  const byUrl = new Map<string, string>();
  for (const file of files) {
    const { fields, bodyLine, body } = parseFrontmatter(file, readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n").split("\n"));
    const url = urlOf(file);
    const clash = byUrl.get(url);
    if (clash) throw new ContentError(file, 0, `serves the same URL ${url} as ${clash}`);
    byUrl.set(url, file);
    const f = FRONT(fields, "");
    pages.push({ file, url, title: f.title, description: f.description, nav: f.nav, section: f.section, body, bodyLine });
  }
  return pages;
}
