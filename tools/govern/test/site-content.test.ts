// The real site/content builds: every page renders and every internal link resolves to a page, a file under site/static
// or the press PDF. The PDF itself is rendered by press/render.py in the image build, so a stand-in file takes its place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../site/lib/site.ts";
import "./helpers.ts"; // every test file runs in the sandbox

const SITE = join(import.meta.dirname, "..", "site");

test("the site content builds with every internal link resolved", () => {
  const root = mkdtempSync(join(tmpdir(), "govern-site-content-"));
  try {
    const pressFile = join(root, "press.pdf");
    writeFileSync(pressFile, "%PDF-1.7\n");
    const { pages } = buildSite({ contentDir: join(SITE, "content"), outDir: join(root, "out"), staticDir: join(SITE, "static"),
      pressFile, commit: "abc1234", version: "0.0.0" });
    assert.ok(pages.includes("/") && pages.includes("/docs/"), `pages: ${pages.join(" ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
