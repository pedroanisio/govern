// site/build.ts end to end on a fixture content folder, through buildSite() and through the command line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContentError } from "../site/lib/content.ts";
import { LinkError } from "../site/lib/links.ts";
import { buildSite, readVersion } from "../site/lib/site.ts";
import "./helpers.ts"; // every test file runs in the sandbox

const BUILD = join(import.meta.dirname, "..", "site", "build.ts");
const page = (front: string, body: string) => `---\n${front}\n---\n${body}`;

interface Fx { root: string; content: string; staticDir: string; out: string; press: string }
function fixture(files: Record<string, string>, extra: Record<string, string> = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), "govern-site-build-"));
  const put = (base: string, rel: string, text: string) => { mkdirSync(dirname(join(root, base, rel)), { recursive: true }); writeFileSync(join(root, base, rel), text); };
  for (const [f, t] of Object.entries(files)) put("content", f, t);
  put("static", "site.css", "body{}");
  for (const [f, t] of Object.entries(extra)) put("static", f, t);
  return { root, content: join(root, "content"), staticDir: join(root, "static"), out: join(root, "out"), press: join(root, "press.pdf") };
}
const opts = (f: Fx, more: Partial<Parameters<typeof buildSite>[0]> = {}) =>
  ({ contentDir: f.content, outDir: f.out, staticDir: f.staticDir, pressFile: f.press, commit: "abc1234", version: "9.8.7", ...more });
const read = (f: Fx, rel: string) => readFileSync(join(f.out, rel), "utf8");

const SITE = {
  "index.md": page("title: govern\ndescription: Home <desc> & more.\nnav: 1", "Welcome to **govern**.\n\nSee the [docs](/docs/).\n"),
  "about.md": page("title: About\ndescription: About page.\nnav: 3", "About text.\n"),
  "press.md": page("title: Press\ndescription: Press page.", "[PDF](/press/govern-press-release.pdf)\n"),
  "docs/index.md": page("title: Docs\ndescription: Documentation.\nnav: 2\nsection: docs", "Start here.\n"),
  "docs/commands.md": page("title: Commands\ndescription: The commands.\nsection: docs\nnav: 9", "```\ngovern brief\n```\n"),
  "docs/concepts.md": page("title: Concepts\ndescription: The concepts.\nsection: docs", "Lanes.\n"),
};

test("buildSite writes every page, the static folder, 404, robots and sitemap", () => {
  const f = fixture(SITE, { "brand/logo.png": "png", "README.md": "not copied" });
  writeFileSync(f.press, "%PDF-fixture");
  try {
    const lines: string[] = [];
    const r = buildSite(opts(f, { log: (l) => lines.push(l) }));
    assert.equal(r.pages.length, 6);
    for (const p of ["index.html", "about/index.html", "press/index.html", "docs/index.html", "docs/commands/index.html", "docs/concepts/index.html", "404.html", "robots.txt", "sitemap.xml", "static/site.css", "static/brand/logo.png", "press/govern-press-release.pdf"]) {
      assert.ok(existsSync(join(f.out, p)), p);
    }
    assert.ok(!existsSync(join(f.out, "static", "README.md")));
    assert.equal(readFileSync(join(f.out, "press/govern-press-release.pdf"), "utf8"), "%PDF-fixture");
    assert.equal(lines.filter((l) => l.startsWith("wrote ")).length, 6);
    assert.equal(lines.at(-1), `built 6 pages into ${f.out}`);

    const home = read(f, "index.html");
    assert.match(home, /<html lang="en">/);
    assert.match(home, /<title>govern<\/title>/);
    assert.match(home, /<meta name="description" content="Home &lt;desc&gt; &amp; more\.">/);
    assert.match(home, /<a class="skip" href="#content">/);
    assert.match(home, /<p>Welcome to <strong>govern<\/strong>\.<\/p>/);
    assert.match(read(f, "docs/commands/index.html"), /<title>Commands · govern<\/title>/);
    assert.match(read(f, "docs/commands/index.html"), /<pre><code>govern brief\n<\/code><\/pre>/);

    const robots = read(f, "robots.txt");
    assert.match(robots, /^User-agent: \*\nAllow: \/\n/);
    const sitemap = read(f, "sitemap.xml");
    for (const u of ["/", "/about/", "/docs/", "/docs/commands/", "/docs/concepts/", "/press/"]) assert.ok(sitemap.includes(`<loc>${u}</loc>`), u);
    assert.ok(!/<loc>http/.test(sitemap),"sitemap URLs are relative to the site root");
    assert.ok(!sitemap.includes("404"));
    assert.match(read(f, "404.html"), /Page not found/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("navigation is ordered by nav and holds only pages with nav", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    buildSite(opts(f));
    const nav = /<nav id="site-nav"[^>]*><ul>(.*?)<\/ul><\/nav>/.exec(read(f, "about/index.html"))![1]!;
    const links = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, ["/", "/docs/", "/about/", "/docs/commands/"]);
    assert.match(nav, /<a href="\/about\/" aria-current="page">About<\/a>/);
    assert.ok(!nav.includes("/press/") && !nav.includes("/docs/concepts/"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the side list shows the section's pages (index first), and only for a page with a section", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    buildSite(opts(f));
    const doc = read(f, "docs/concepts/index.html");
    const side = /<aside class="side"[^>]*>(.*?)<\/aside>/.exec(doc)![1]!;
    assert.deepEqual([...side.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ["/docs/", "/docs/commands/", "/docs/concepts/"]);
    assert.match(side, /<a href="\/docs\/concepts\/" aria-current="page">Concepts<\/a>/);
    assert.match(doc, /class="shell has-side"/);
    assert.ok(!read(f, "about/index.html").includes('class="side"'));
    assert.ok(!read(f, "index.html").includes('class="side"'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the home hero appears only when static/brand/hero.png exists; brand meta follows the files", () => {
  const without = fixture(SITE);
  writeFileSync(without.press, "x");
  const withHero = fixture(SITE, { "brand/hero.png": "p", "brand/wordmark.png": "p", "brand/favicon.png": "p", "brand/social-card.png": "p" });
  writeFileSync(withHero.press, "x");
  try {
    buildSite(opts(without));
    const a = read(without, "index.html");
    assert.ok(!a.includes("hero.png") && !a.includes("wordmark.png") && !a.includes("favicon.png") && !a.includes("social-card.png"));
    assert.match(a, /<a class="brand" href="\/">govern<\/a>/);
    buildSite(opts(withHero));
    const b = read(withHero, "index.html");
    assert.match(b, /<img class="hero" src="\/static\/brand\/hero\.png" alt="">/);
    assert.match(b, /<img src="\/static\/brand\/wordmark\.png" alt="govern">/);
    assert.match(b, /<link rel="icon" href="\/static\/brand\/favicon\.png">/);
    assert.match(b, /<meta property="og:image" content="\/static\/brand\/social-card\.png">/);
    assert.match(b, /<meta name="twitter:card" content="summary_large_image">/);
    assert.ok(!read(withHero, "about/index.html").includes('class="hero"'), "hero is for the home page only");
    assert.ok(!read(withHero, "docs/index.html").includes('class="hero"'));
  } finally { rmSync(without.root, { recursive: true, force: true }); rmSync(withHero.root, { recursive: true, force: true }); }
});

test("the footer carries version, commit and the press and docs links", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    buildSite(opts(f));
    for (const p of ["index.html", "docs/commands/index.html", "404.html"]) {
      const html = read(f, p);
      assert.match(html, /<footer class="site-footer">\n<p>govern 9\.8\.7 · abc1234 · <a href="\/press\/">Press<\/a> · <a href="\/docs\/">Documentation<\/a><\/p>/);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a footer link whose page does not exist is left out, with a note", () => {
  const f = fixture({ "index.md": page("title: govern\ndescription: d", "Hi.\n") });
  try {
    const lines: string[] = [];
    buildSite(opts(f, { log: (l) => lines.push(l) }));
    assert.match(read(f, "index.html"), /<p>govern 9\.8\.7 · abc1234<\/p>/);
    assert.ok(lines.some((l) => l.includes("no page at /press/")));
    assert.ok(lines.some((l) => l.includes("no press file")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a second run leaves no stale file", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    buildSite(opts(f));
    mkdirSync(join(f.out, "old"), { recursive: true });
    writeFileSync(join(f.out, "old", "index.html"), "stale");
    writeFileSync(join(f.out, "stale.txt"), "stale");
    rmSync(join(f.content, "about.md"));
    rmSync(join(f.staticDir, "site.css"));
    writeFileSync(join(f.staticDir, "other.css"), "x");
    buildSite(opts(f));
    assert.ok(!existsSync(join(f.out, "old")) && !existsSync(join(f.out, "stale.txt")));
    assert.ok(!existsSync(join(f.out, "about")), "page removed from content is gone from the output");
    assert.ok(!existsSync(join(f.out, "static", "site.css")) && existsSync(join(f.out, "static", "other.css")));
    assert.ok(!read(f, "sitemap.xml").includes("/about/"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed build leaves the previous output alone", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    buildSite(opts(f));
    writeFileSync(join(f.content, "about.md"), page("title: About\ndescription: d", "[x](/missing/)\n"));
    assert.throws(() => buildSite(opts(f)), LinkError);
    assert.ok(existsSync(join(f.out, "about", "index.html")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("no index.md fails; a missing press file makes the press link fail", () => {
  const f = fixture({ "about.md": page("title: A\ndescription: d", "x\n") });
  try { assert.throws(() => buildSite(opts(f)), (e: unknown) => e instanceof ContentError && /index\.md/.test(e.message)); } finally { rmSync(f.root, { recursive: true, force: true }); }
  const g = fixture(SITE);
  try { assert.throws(() => buildSite(opts(g)), (e: unknown) => e instanceof LinkError && /press\.md:5: .*--press/.test(e.message)); } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test("the output folder may not hold the content, the static folder or the working folder", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    assert.throws(() => buildSite(opts(f, { outDir: f.root })), /refusing to empty/);
    assert.throws(() => buildSite(opts(f, { outDir: f.content })), /refusing to empty/);
    assert.throws(() => buildSite(opts(f, { outDir: process.cwd() })), /refusing to empty/);
    assert.throws(() => buildSite(opts(f, { outDir: "/" })), /refusing to empty/);
    assert.ok(existsSync(join(f.content, "index.md")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("readVersion reads package.json strictly", () => {
  assert.match(readVersion(join(import.meta.dirname, "..", "package.json")), /^\d+\.\d+\.\d+/);
  const f = fixture({});
  try {
    writeFileSync(join(f.root, "p.json"), '{"version": 3}');
    assert.throws(() => readVersion(join(f.root, "p.json")), /\.version/);
    writeFileSync(join(f.root, "p.json"), "{nope");
    assert.throws(() => readVersion(join(f.root, "p.json")), /not JSON/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const cli = (args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BUILD, ...args], { encoding: "utf8" });

test("command line: success prints a line per page and the count; errors exit nonzero naming file and line", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    const ok = cli(["--content", f.content, "--out", f.out, "--press", f.press, "--commit", "deadbee"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.split("\n").filter((l) => l.startsWith("wrote ")).length, 6);
    assert.match(ok.stdout, /built 6 pages into /);
    assert.match(read(f, "index.html"), /govern \d+\.\d+\.\d+ · deadbee/);

    writeFileSync(join(f.content, "about.md"), page("title: About\ndescription: d", "fine\n\n<b>raw</b>\n"));
    const raw = cli(["--content", f.content, "--out", f.out, "--press", f.press, "--commit", "deadbee"]);
    assert.equal(raw.status, 1);
    assert.match(raw.stderr, /about\.md:7: raw HTML/);

    writeFileSync(join(f.content, "about.md"), page("title: About\ndescription: d\nbogus: 1", "x\n"));
    const key = cli(["--content", f.content, "--out", f.out, "--press", f.press, "--commit", "deadbee"]);
    assert.equal(key.status, 1);
    assert.match(key.stderr, /about\.md:4: frontmatter key "bogus"/);

    const usage = cli(["--nope", "1"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown argument --nope/);
    assert.equal(cli(["--commit", "bad sha", "--content", f.content, "--out", f.out]).status, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("command line: without --commit the short git hash is used", () => {
  const f = fixture(SITE);
  writeFileSync(f.press, "x");
  try {
    const r = cli(["--content", f.content, "--out", f.out, "--press", f.press]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(read(f, "index.html"), /govern \d+\.\d+\.\d+ · [0-9a-f]{4,40} ·/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
