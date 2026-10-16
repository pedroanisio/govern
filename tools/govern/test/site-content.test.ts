// site/lib/content.ts: strict frontmatter, URL derivation, duplicate URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContentError, loadContent, urlOf } from "../site/lib/content.ts";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "govern-site-content-"));
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
  return dir;
}
const page = (front: string, body = "Body.\n") => `---\n${front}\n---\n${body}`;
const failsWith = (files: Record<string, string>, file: string, re: RegExp, line?: number) => {
  const dir = fixture(files);
  try {
    assert.throws(() => loadContent(dir), (e: unknown) => {
      assert.ok(e instanceof ContentError, String(e));
      assert.equal(e.file, file);
      assert.match(e.message, re);
      if (line !== undefined) assert.equal(e.line, line);
      assert.ok(e.message.startsWith(file));
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("frontmatter happy path: required, optional, quoted values, body line", () => {
  const dir = fixture({ "docs/commands.md": page('title: "Commands"\ndescription: What it runs: all of it.\nnav: 3\nsection: docs', "\n# Hi\n") });
  try {
    const [p] = loadContent(dir);
    assert.deepEqual(p, { file: "docs/commands.md", url: "/docs/commands/", title: "Commands", description: "What it runs: all of it.", nav: 3, section: "docs", body: "\n# Hi\n", bodyLine: 7 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("optional keys may be absent", () => {
  const dir = fixture({ "about.md": page("title: About\ndescription: d") });
  try {
    const [p] = loadContent(dir);
    assert.equal(p!.nav, undefined);
    assert.equal(p!.section, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing required key is named by file and key", () => {
  failsWith({ "a.md": page("title: A") }, "a.md", /key "description".*missing/);
  failsWith({ "a.md": page("description: d") }, "a.md", /key "title".*missing/);
});

test("extra key is named, with its line", () => {
  failsWith({ "a.md": page("title: A\ndescription: d\nauthor: me") }, "a.md", /key "author".*unknown key/, 4);
  failsWith({ "a.md": page("title: A\ndescription: d\ndraft-mode: x") }, "a.md", /key "draft-mode"/, 4);
});

test("wrongly typed or empty fields are named", () => {
  failsWith({ "a.md": page("title: A\ndescription: d\nnav: three") }, "a.md", /key "nav".*whole number/, 4);
  failsWith({ "a.md": page("title: A\ndescription: d\nnav: 2.5") }, "a.md", /key "nav".*whole number/, 4);
  failsWith({ "a.md": page("title: A\ndescription: d\nnav: -1") }, "a.md", /key "nav"/, 4);
  failsWith({ "a.md": page("title: A\ndescription: d\nsection: Docs") }, "a.md", /key "section".*lower-case word/, 4);
  failsWith({ "a.md": page("title: A\ndescription: d\nsection: two words") }, "a.md", /key "section"/, 4);
  failsWith({ "a.md": page("title:\ndescription: d") }, "a.md", /key "title".*must not be empty/, 2);
});

test("a duplicated key, a malformed line, no block, an unclosed block", () => {
  failsWith({ "a.md": page("title: A\ntitle: B\ndescription: d") }, "a.md", /"title" is given twice/, 3);
  failsWith({ "a.md": page("title: A\njust words\ndescription: d") }, "a.md", /not "key: value"/, 3);
  failsWith({ "a.md": "# no frontmatter\n" }, "a.md", /must begin with a ---/, 1);
  failsWith({ "a.md": "---\ntitle: A\ndescription: d\n# body\n" }, "a.md", /never closed/, 1);
});

test("URL derivation", () => {
  assert.equal(urlOf("index.md"), "/");
  assert.equal(urlOf("about.md"), "/about/");
  assert.equal(urlOf("docs/index.md"), "/docs/");
  assert.equal(urlOf("docs/commands.md"), "/docs/commands/");
  assert.equal(urlOf("a/b/c_d-e.md"), "/a/b/c_d-e/");
  assert.throws(() => urlOf("About.md"), ContentError);
  assert.throws(() => urlOf("my page.md"), /not a usable URL part/);
});

test("two pages at one URL are refused, naming both files", () => {
  failsWith({
    "docs.md": page("title: A\ndescription: d"),
    "docs/index.md": page("title: B\ndescription: d"),
  }, "docs.md", /same URL \/docs\/ as docs\/index\.md/);
});

test("README.md and non-Markdown files are not pages; files come in name order", () => {
  const dir = fixture({
    "README.md": "# not a page\n", "docs/README.md": "x", "notes.txt": "x", ".hidden.md": "x",
    "b.md": page("title: B\ndescription: d"), "a.md": page("title: A\ndescription: d"),
  });
  try { assert.deepEqual(loadContent(dir).map((p) => p.file), ["a.md", "b.md"]); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing content folder is a ContentError", () => {
  assert.throws(() => loadContent(join(tmpdir(), "govern-site-no-such-folder")), ContentError);
});
