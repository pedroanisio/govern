// After rendering, every internal link and image (a target that starts with "/") must be a page URL, a file under static/, the
// press PDF (only when the build was given one that exists) or a file the build writes itself. External links are not fetched;
// a "#anchor" on its own is not checked.
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Ref } from "./markdown.ts";

export const PRESS_URL = "/press/govern-press-release.pdf";
const GENERATED = new Set(["/robots.txt", "/sitemap.xml", "/404.html"]);

export interface Problem { file: string; line: number; target: string; message: string }

/** Every broken target of one build, in page order. */
export class LinkError extends Error {
  problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map((p) => `${p.file}:${p.line}: ${p.message}`).join("\n"));
    this.name = "LinkError";
    this.problems = problems;
  }
}

export interface Targets { urls: Set<string>; staticDir: string; pressAvailable: boolean }

/** Why `target` does not resolve, or "" when it does. */
export function resolveTarget(target: string, t: Targets): string {
  if (!target.startsWith("/")) return "";
  let path = target.replace(/[?#].*$/, "");
  try { path = decodeURI(path); } catch { return "is not a valid URL"; }
  if (t.urls.has(path) || GENERATED.has(path)) return "";
  if (path === PRESS_URL) return t.pressAvailable ? "" : "is the press PDF, but the build has no --press file (or it does not exist)";
  if (path.startsWith("/static/")) {
    const file = normalize(join(t.staticDir, path.slice("/static/".length)));
    const root = normalize(t.staticDir) + sep;
    if (!file.startsWith(root)) return "leaves the static folder";
    return existsSync(file) && statSync(file).isFile() ? "" : "is not a file under static/";
  }
  if (!path.endsWith("/") && t.urls.has(path + "/")) return `is not a page; pages end with a slash (did you mean ${path}/ ?)`;
  return "is not a page, a static file or the press PDF";
}

/** Check every ref of every page; throws LinkError listing all broken ones. */
export function checkLinks(pages: { file: string; refs: Ref[] }[], t: Targets): void {
  const problems: Problem[] = [];
  for (const p of pages) {
    for (const r of p.refs) {
      const why = resolveTarget(r.url, t);
      if (why) problems.push({ file: p.file, line: r.line, target: r.url, message: `broken ${r.kind} ${r.url} ${why}` });
    }
  }
  if (problems.length) throw new LinkError(problems);
}
