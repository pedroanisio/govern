// The site build: content in, one folder of static files out. Everything is checked (frontmatter, Markdown subset, links)
// before the output folder is touched, so a failed build leaves the previous output alone.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ShapeError, parseFile, str, type Shape } from "../../lib/shape.ts";
import { fail } from "../../lib/util.ts";
import { ContentError, loadContent, type Page } from "./content.ts";
import { PRESS_URL, checkLinks } from "./links.ts";
import { escapeHtml, renderMarkdown, type Ref } from "./markdown.ts";
import { layout, type NavItem } from "../templates/layout.ts";

export interface BuildOptions {
  contentDir: string;
  outDir: string;
  staticDir: string;
  /** The press PDF; copied to /press/govern-press-release.pdf when the file exists. */
  pressFile: string;
  commit: string;
  version: string;
  log?: (line: string) => void;
}

/** The `version` of a package.json (the other keys are not this build's business). */
export function readVersion(file: string): string {
  const shape: Shape<string> = (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError(p, "must be an object");
    return str((v as Record<string, unknown>)["version"], `${p}.version`);
  };
  return parseFile(file, readFileSync(file, "utf8"), shape);
}

const FOOTER = [{ url: "/press/", title: "Press" }, { url: "/docs/", title: "Documentation" }];
const BRAND = (dir: string, name: string) => existsSync(join(dir, "brand", name));

const byNav = (a: Page, b: Page) =>
  (a.nav ?? Infinity) - (b.nav ?? Infinity) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.url < b.url ? -1 : 1);

/** Refuse to empty a folder that holds the inputs, the working folder, or is the filesystem root. */
function guardOut(out: string, inputs: string[]): void {
  const o = resolve(out);
  if (o === resolve("/") || o === dirname(o)) fail(`build: refusing to empty ${o}`);
  for (const i of [...inputs, process.cwd()]) {
    const r = relative(o, resolve(i));
    if (r === "" || (!r.startsWith("..") && !isAbsolute(r))) fail(`build: refusing to empty ${o}: it holds ${resolve(i)}`);
  }
  if (existsSync(o) && !statSync(o).isDirectory()) fail(`build: ${o} exists and is not a folder`);
}

export function buildSite(o: BuildOptions): { pages: string[] } {
  const log = o.log ?? (() => {});
  const pages = loadContent(o.contentDir);
  if (!pages.some((p) => p.url === "/")) throw new ContentError("index.md", 0, "missing: the site needs a home page at content/index.md");

  const rendered = pages.map((p) => ({ page: p, ...renderMarkdown(p.body, { file: p.file, firstLine: p.bodyLine }) }));
  const pressAvailable = existsSync(o.pressFile) && statSync(o.pressFile).isFile();
  const urls = new Set(pages.map((p) => p.url));
  checkLinks(rendered.map((r) => ({ file: r.page.file, refs: r.refs as Ref[] })), { urls, staticDir: o.staticDir, pressAvailable });

  guardOut(o.outDir, [o.contentDir, o.staticDir]);
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });

  const brand = {
    wordmark: BRAND(o.staticDir, "wordmark.png"),
    favicon: BRAND(o.staticDir, "favicon.png"),
    socialCard: BRAND(o.staticDir, "social-card.png"),
    hero: BRAND(o.staticDir, "hero.png"),
  };
  const nav: NavItem[] = pages.filter((p) => p.nav !== undefined).sort(byNav).map((p) => ({ url: p.url, title: p.title }));
  const footer: NavItem[] = FOOTER.filter((f) => {
    if (urls.has(f.url)) return true;
    log(`note: no page at ${f.url}, so the footer has no ${f.title} link`);
    return false;
  });
  const shared = { nav, version: o.version, commit: o.commit, footer, brand };

  const write = (rel: string, data: string | Buffer) => {
    const f = join(o.outDir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, data);
  };

  for (const r of rendered) {
    const p = r.page;
    const peers = p.section ? pages.filter((x) => x.section === p.section) : [];
    peers.sort((a, b) => Number(b.url === `/${p.section}/`) - Number(a.url === `/${p.section}/`) || byNav(a, b));
    const sideTitle = p.section ? p.section.charAt(0).toUpperCase() + p.section.slice(1) : "";
    const html = layout({
      ...shared, title: p.title, description: p.description, url: p.url, bodyHtml: r.html,
      side: peers.map((x) => ({ url: x.url, title: x.title })), sideTitle,
    });
    write(p.url === "/" ? "index.html" : `${p.url.slice(1)}index.html`, html);
    log(`wrote ${p.url}  (${p.file})`);
  }

  write("404.html", layout({
    ...shared, title: "Page not found", description: "The page you asked for is not on this site.", url: "/404.html", side: [], sideTitle: "",
    bodyHtml: '<p>Check the address, or start from the <a href="/">home page</a>.</p>',
  }));
  write("robots.txt", "User-agent: *\nAllow: /\n");
  const locs = [...urls].sort().map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join("\n");
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>\n`);

  if (existsSync(o.staticDir)) {
    cpSync(o.staticDir, join(o.outDir, "static"), { recursive: true, filter: (src) => src === o.staticDir || (basename(src) !== "README.md" && !basename(src).startsWith(".")) });
  }
  if (pressAvailable) {
    mkdirSync(join(o.outDir, "press"), { recursive: true });
    cpSync(o.pressFile, join(o.outDir, PRESS_URL.slice(1)));
  } else log(`note: no press file at ${o.pressFile}; /press/ links to the PDF would fail`);

  log(`built ${pages.length} page${pages.length === 1 ? "" : "s"} into ${o.outDir}`);
  return { pages: pages.map((p) => p.url) };
}
