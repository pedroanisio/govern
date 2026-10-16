// site/lib/links.ts: every internal link and image resolves to a page, a static file, or the press PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkError, checkLinks, resolveTarget } from "../site/lib/links.ts";
import { renderMarkdown } from "../site/lib/markdown.ts";

function withStatic(run: (staticDir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "govern-site-links-"));
  mkdirSync(join(dir, "brand"), { recursive: true });
  writeFileSync(join(dir, "brand", "logo.png"), "png");
  writeFileSync(join(dir, "site.css"), "x");
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const urls = new Set(["/", "/docs/", "/docs/commands/"]);
const pageOf = (file: string, src: string) => ({ file, refs: renderMarkdown(src, { file }).refs });

test("pages, static files, generated files, query and fragment pass; external and #anchor are not checked", () => {
  withStatic((staticDir) => {
    const src = "[a](/docs/) [b](/docs/commands/#x) [c](/?q=1) ![i](/static/brand/logo.png) [s](/static/site.css) [r](/robots.txt) [e](https://example.test/none) [h](#here)";
    checkLinks([pageOf("p.md", src)], { urls, staticDir, pressAvailable: false });
  });
});

test("a broken internal link fails naming page, line and target", () => {
  withStatic((staticDir) => {
    const src = "ok [a](/docs/)\n\nbroken [b](/docs/nope/) here";
    assert.throws(() => checkLinks([pageOf("docs/x.md", src)], { urls, staticDir, pressAvailable: false }), (e: unknown) => {
      assert.ok(e instanceof LinkError);
      assert.deepEqual(e.problems.map((p) => [p.file, p.line, p.target]), [["docs/x.md", 3, "/docs/nope/"]]);
      assert.match(e.message, /^docs\/x\.md:3: broken link \/docs\/nope\/ is not a page/);
      return true;
    });
  });
});

test("every broken target is reported, images too, with a hint for a missing slash", () => {
  withStatic((staticDir) => {
    const src = "[a](/docs)\n![i](/static/brand/missing.png)\n[c](/static/../../etc/passwd)";
    assert.throws(() => checkLinks([pageOf("a.md", src), pageOf("b.md", "[x](/gone/)")], { urls, staticDir, pressAvailable: false }), (e: unknown) => {
      assert.ok(e instanceof LinkError);
      assert.deepEqual(e.problems.map((p) => `${p.file}:${p.line}`), ["a.md:1", "a.md:2", "a.md:3", "b.md:1"]);
      assert.match(e.problems[0]!.message, /did you mean \/docs\//);
      assert.match(e.problems[1]!.message, /broken image .* not a file under static/);
      return true;
    });
  });
});

test("the press PDF link passes with a press file and fails without one", () => {
  withStatic((staticDir) => {
    const page = pageOf("press.md", "[pdf](/press/govern-press-release.pdf)");
    checkLinks([page], { urls, staticDir, pressAvailable: true });
    assert.throws(() => checkLinks([page], { urls, staticDir, pressAvailable: false }), /press\.md:1: broken link .* --press/);
  });
});

test("resolveTarget leaves non-internal targets alone and rejects a bad escape", () => {
  const t = { urls, staticDir: "/nonexistent", pressAvailable: false };
  assert.equal(resolveTarget("https://x.test/", t), "");
  assert.equal(resolveTarget("#a", t), "");
  assert.match(resolveTarget("/%E0%A4%A/", t), /not a valid URL/);
});
