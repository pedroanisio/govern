// site/lib/markdown.ts: each construct of the subset renders to a short expected string; each forbidden construct is a MarkdownError
// naming file and line; HTML in text is escaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownError, renderMarkdown } from "../site/lib/markdown.ts";
import "./helpers.ts"; // every test file runs in the sandbox

const md = (s: string) => renderMarkdown(s, { file: "t.md" }).html;
const bad = (s: string, line: number, re: RegExp, firstLine = 1) =>
  assert.throws(() => renderMarkdown(s, { file: "t.md", firstLine }), (e: unknown) => {
    assert.ok(e instanceof MarkdownError);
    assert.equal(e.file, "t.md");
    assert.equal(e.line, line);
    assert.match(e.message, re);
    assert.ok(e.message.startsWith(`t.md:${line}:`));
    return true;
  });

test("headings 1-4 with ids; duplicate ids are numbered", () => {
  assert.equal(md("# One\n## Two *x*\n### Three\n#### Four"), '<h1 id="one">One</h1>\n<h2 id="two-x">Two <em>x</em></h2>\n<h3 id="three">Three</h3>\n<h4 id="four">Four</h4>');
  assert.equal(md("## A\n## A"), '<h2 id="a">A</h2>\n<h2 id="a-2">A</h2>');
});

test("paragraphs, strong, em, code, escapes", () => {
  assert.equal(md("a **b** and *c* and `d`\nnext line\n\nsecond"), "<p>a <strong>b</strong> and <em>c</em> and <code>d</code>\nnext line</p>\n<p>second</p>");
  assert.equal(md("2 * 3 * 4 and \\*lit\\*"), "<p>2 * 3 * 4 and *lit*</p>");
  assert.equal(md("snake_case_name"), "<p>snake_case_name</p>");
  assert.equal(md("`a **b** <i>`"), "<p><code>a **b** &lt;i&gt;</code></p>");
  assert.equal(md("**bold `**` still**"), "<p><strong>bold <code>**</code> still</strong></p>");
});

test("fenced code, with and without a language, escaped", () => {
  assert.equal(md("```\na < b\n```"), "<pre><code>a &lt; b\n</code></pre>");
  assert.equal(md("```ts\nconst x = 1;\n\n# not a heading\n```"), '<pre><code class="language-ts">const x = 1;\n\n# not a heading\n</code></pre>');
  assert.equal(md("````\n```\ninner\n```\n````"), "<pre><code>```\ninner\n```\n</code></pre>");
});

test("links and images, and the refs they leave", () => {
  const r = renderMarkdown("see [docs](/docs/) and ![logo](/static/brand/logo.png)\n\n[out](https://example.test/a?b=1&c=2) [m](mailto:a@b.test) [h](#top)", { file: "t.md", firstLine: 10 });
  assert.equal(r.html, '<p>see <a href="/docs/">docs</a> and <img src="/static/brand/logo.png" alt="logo" loading="lazy"></p>\n<p><a href="https://example.test/a?b=1&amp;c=2" rel="noopener">out</a> <a href="mailto:a@b.test">m</a> <a href="#top">h</a></p>');
  assert.deepEqual(r.refs.map((x) => [x.kind, x.url, x.line]), [
    ["link", "/docs/", 10], ["image", "/static/brand/logo.png", 10], ["link", "https://example.test/a?b=1&c=2", 12], ["link", "mailto:a@b.test", 12], ["link", "#top", 12],
  ]);
  assert.equal(md("[`code` and *em*](/x/)"), '<p><a href="/x/"><code>code</code> and <em>em</em></a></p>');
  assert.equal(md("[not a link] and (parens)"), "<p>[not a link] and (parens)</p>");
});

test("lists: unordered, ordered, start number, one nested level, mixed kinds", () => {
  assert.equal(md("- a\n- b\n  - b1\n  - b2\n- c"), "<ul><li>a</li><li>b<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>");
  assert.equal(md("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(md("3. three\n4. four"), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md("1. a\n   - x\n2. b"), "<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>");
  assert.equal(md("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
  assert.equal(md("- a\n  continues\n- b"), "<ul><li>a\ncontinues</li><li>b</li></ul>");
  assert.equal(md("- a\n\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("block quotes hold paragraphs and lists", () => {
  assert.equal(md("> one\n> two\n>\n> - x"), "<blockquote>\n<p>one\ntwo</p>\n<ul><li>x</li></ul>\n</blockquote>");
});

test("tables: header, alignment, escaped pipe, short rows padded, wrapped for scrolling", () => {
  assert.equal(md("| A | B |\n| --- | --- |\n| 1 | 2 |"), '<div class="table-wrap"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
  assert.equal(md("A | B | C\n:-- | :-: | --:\nx \\| y | `z` |"),
    '<div class="table-wrap"><table><thead><tr><th style="text-align:left">A</th><th style="text-align:center">B</th><th style="text-align:right">C</th></tr></thead><tbody><tr><td style="text-align:left">x | y</td><td style="text-align:center"><code>z</code></td><td style="text-align:right"></td></tr></tbody></table></div>');
  assert.equal(md("| A |\n|---|"), '<div class="table-wrap"><table><thead><tr><th>A</th></tr></thead></table></div>');
});

test("horizontal rules", () => {
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>");
});

test("HTML in text is escaped", () => {
  assert.equal(md('1 < 2 & 3 > 2 "q"'), "<p>1 &lt; 2 &amp; 3 &gt; 2 &quot;q&quot;</p>");
  assert.equal(md("a \\<b> c"), "<p>a &lt;b&gt; c</p>");
  assert.equal(md("x\n\n```\n<script>alert(1)</script>\n```"), "<p>x</p>\n<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>");
  assert.equal(md('[a"b](/x/?q="1")').includes('"1"'), false);
});

test("forbidden: raw HTML, naming the file and the real line", () => {
  bad("fine\n\nhas <b>bold</b>", 3, /raw HTML/);
  bad("<div>x</div>", 1, /raw HTML/);
  bad("line\nline <!-- c -->", 2, /raw HTML/);
  bad("a\nb <br/> c", 12, /raw HTML/, 11);
  bad("- item <span>", 1, /raw HTML/);
  bad("| a |\n| - |\n| <i> |", 3, /raw HTML/);
});

test("forbidden: footnotes, nested quotes, unclosed fence, deep lists, deep headings", () => {
  bad("text[^1]\n\n[^1]: note", 1, /footnotes/);
  bad("> a\n> > b", 2, /nested block quotes/);
  bad("> a\n>> b", 2, /nested block quotes/);
  bad("para\n\n```ts\nno end", 3, /never closed/);
  bad("- a\n  - b\n    - c", 3, /one level/);
  bad("##### five", 1, /heading level 5/);
});

test("forbidden: tables without header or separator row, ragged rows", () => {
  bad("| a | b |\n| 1 | 2 |", 1, /header row followed by a separator row/);
  bad("| --- | --- |\n| 1 | 2 |", 1, /header row/);
  bad("| a | b |\n| --- |\n| 1 | 2 |", 2, /2 cells but the separator row has 1/);
  bad("| a |\n| --- |\n| 1 | 2 |", 3, /2 cells but the header has 1/);
});

test("forbidden: link targets outside the contract", () => {
  bad("[x](docs/commands.md)", 1, /site-root absolute/);
  bad("[x](javascript:alert(1))", 1, /site-root absolute/);
  bad("[x](//evil.test/a)", 1, /protocol-relative/);
  bad('[x](/a/ "title")', 1, /has a space/);
  bad("[x]()", 1, /empty/);
  bad("[x](/a/", 1, /not closed/);
});
