// A small Markdown renderer for the govern site: exactly the subset in govern/RULES.md (ATX headings 1-4, paragraphs, strong,
// em, code, fenced code, links, images, lists with one level of nesting, block quotes, pipe tables, rules). Everything else
// that would need HTML, footnotes or nested quotes is a MarkdownError naming the file and line; all text is escaped.

export class MarkdownError extends Error {
  file: string;
  line: number;
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = "MarkdownError";
    this.file = file;
    this.line = line;
  }
}

/** A link or image target found while rendering, with the line it was written on. */
export interface Ref { kind: "link" | "image"; url: string; line: number }
export interface Rendered { html: string; refs: Ref[] }

interface Ctx { file: string; refs: Ref[]; slugs: Map<string, number> }

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const countNl = (s: string) => { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++; return n; };
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";

// ---------- inline ----------

/** The backtick run that opens at `i` and the index where a run of the same length closes it (-1 if none). */
function codeSpan(t: string, i: number): { run: number; close: number } {
  let run = 0;
  while (t[i + run] === "`") run++;
  let j = i + run;
  while (j < t.length) {
    if (t[j] !== "`") { j++; continue; }
    let k = 0;
    while (t[j + k] === "`") k++;
    if (k === run) return { run, close: j };
    j += k;
  }
  return { run, close: -1 };
}

/** Index of the last character of the code span at `j`, or of its opening run when it never closes. */
const spanEnd = (t: string, j: number) => { const s = codeSpan(t, j); return s.close >= 0 ? s.close + s.run - 1 : j + s.run - 1; };

/** First index >= from where `marker` closes an emphasis, skipping escapes and code spans; -1 if none. */
function findClose(t: string, from: number, marker: "*" | "**"): number {
  for (let j = from; j < t.length; j++) {
    const c = t[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") { j = spanEnd(t, j); continue; }
    if (c !== "*") continue;
    if (marker === "**") {
      if (t[j + 1] === "*") { if (j > from) return j; j++; }
      continue;
    }
    if (t[j + 1] === "*") { j++; continue; }
    if (j > from && t[j - 1] !== " " && t[j - 1] !== "\n") return j;
  }
  return -1;
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function closeBracket(t: string, open: number): number {
  let depth = 0;
  for (let j = open; j < t.length; j++) {
    const c = t[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") { j = spanEnd(t, j); continue; }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return j;
  }
  return -1;
}

function checkUrl(ctx: Ctx, line: number, url: string): void {
  if (/\s/.test(url)) throw new MarkdownError(ctx.file, line, `link target "${url}" has a space (titles are not part of the subset)`);
  if (url === "") throw new MarkdownError(ctx.file, line, "link target is empty");
  if (url.startsWith("//")) throw new MarkdownError(ctx.file, line, `link target "${url}" is protocol-relative; use /path or https://`);
  if (/^(https?:\/\/\S+|mailto:\S+|#\S*|\/\S*)$/.test(url)) return;
  throw new MarkdownError(ctx.file, line, `link target "${url}" must be site-root absolute (/path), http(s)://, mailto: or #anchor`);
}

function inline(t: string, ctx: Ctx, line: number): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    const here = line + countNl(t.slice(0, i));
    if (c === "\\" && i + 1 < t.length && /[!-/:-@[-`{-~]/.test(t[i + 1]!)) { out += escapeHtml(t[i + 1]!); i++; continue; }
    if (c === "`") {
      const s = codeSpan(t, i);
      if (s.close < 0) { out += "`".repeat(s.run); i += s.run - 1; continue; }
      let body = t.slice(i + s.run, s.close).replace(/\n/g, " ");
      if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ")) body = body.slice(1, -1);
      out += `<code>${escapeHtml(body)}</code>`;
      i = s.close + s.run - 1;
      continue;
    }
    if (c === "<") {
      if (/^<\/?[A-Za-z!?]/.test(t.slice(i, i + 3))) throw new MarkdownError(ctx.file, here, "raw HTML is not part of the subset (put `<` in a code span or write \\<)");
      out += "&lt;";
      continue;
    }
    if (c === "[" && t[i + 1] === "^") throw new MarkdownError(ctx.file, here, "footnotes are not part of the subset");
    if (c === "[" || (c === "!" && t[i + 1] === "[")) {
      const isImage = c === "!";
      const open = isImage ? i + 1 : i;
      const close = closeBracket(t, open);
      if (close > 0 && t[close + 1] === "(") {
        const end = t.indexOf(")", close + 2);
        if (end < 0) throw new MarkdownError(ctx.file, here, "link target is not closed with )");
        const url = t.slice(close + 2, end);
        checkUrl(ctx, here, url);
        const label = t.slice(open + 1, close);
        ctx.refs.push({ kind: isImage ? "image" : "link", url, line: here });
        if (isImage) out += `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy">`;
        else {
          const ext = /^https?:/.test(url) ? ' rel="noopener"' : "";
          out += `<a href="${escapeHtml(url)}"${ext}>${inline(label, ctx, here)}</a>`;
        }
        i = end;
        continue;
      }
      out += escapeHtml(c);
      continue;
    }
    if (c === "*") {
      if (t[i + 1] === "*") {
        const close = findClose(t, i + 2, "**");
        if (close > i + 2) { out += `<strong>${inline(t.slice(i + 2, close), ctx, here)}</strong>`; i = close + 1; continue; }
        out += "**"; i++; continue;
      }
      if (t[i + 1] !== undefined && t[i + 1] !== " " && t[i + 1] !== "\n") {
        const close = findClose(t, i + 1, "*");
        if (close > i + 1) { out += `<em>${inline(t.slice(i + 1, close), ctx, here)}</em>`; i = close; continue; }
      }
      out += "*";
      continue;
    }
    out += escapeHtml(c);
  }
  return out;
}

// ---------- blocks ----------

const FENCE = /^ {0,3}(`{3,})\s*([^`\s]*)\s*$/;
const HEADING_LINE = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HEADING_START = /^ {0,3}#{1,6}(\s|$)/;
const HR = /^ {0,3}-{3,}\s*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(\S.*)$/;
const SEP_CELL = /^:?-+:?$/;
const SEP_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A separator row has a pipe; a bare `---` is a horizontal rule. */
const isSepRow = (l: string) => l.includes("|") && SEP_ROW.test(l);

function splitRow(l: string): string[] {
  let s = l.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const startsTable = (lines: string[], i: number) => lines[i]!.includes("|") && i + 1 < lines.length && isSepRow(lines[i + 1]!);

/** True when `lines[i]` begins a block other than a paragraph (so a paragraph or list item ends before it). */
const startsBlock = (lines: string[], i: number) => {
  const l = lines[i]!;
  return FENCE.test(l) || HEADING_START.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || startsTable(lines, i);
};

interface Item { indent: number; ordered: boolean; num: number; text: string; line: number }

function group<T>(xs: T[], key: (x: T) => boolean, render: (g: T[]) => string): string {
  let html = "";
  for (let i = 0; i < xs.length;) {
    let j = i + 1;
    while (j < xs.length && key(xs[j]!) === key(xs[i]!)) j++;
    html += render(xs.slice(i, j));
    i = j;
  }
  return html;
}

const wrapList = (ordered: boolean, first: number, inner: string) =>
  ordered ? `<ol${first !== 1 ? ` start="${first}"` : ""}>${inner}</ol>` : `<ul>${inner}</ul>`;

function renderList(items: Item[], ctx: Ctx): string {
  const base = items[0]!.indent;
  const tops: { item: Item; kids: Item[] }[] = [];
  let kidBase = -1;
  for (const it of items) {
    if (it.indent <= base) { tops.push({ item: it, kids: [] }); kidBase = -1; continue; }
    const last = tops[tops.length - 1]!;
    if (kidBase < 0) kidBase = it.indent;
    if (it.indent >= kidBase + 2) throw new MarkdownError(ctx.file, it.line, "lists nest one level only");
    last.kids.push(it);
  }
  return group(tops, (x) => x.item.ordered, (g) => wrapList(g[0]!.item.ordered, g[0]!.item.num, g.map((x) => {
    const kids = group(x.kids, (k) => k.ordered, (kg) =>
      wrapList(kg[0]!.ordered, kg[0]!.num, kg.map((k) => `<li>${inline(k.text, ctx, k.line)}</li>`).join("")));
    return `<li>${inline(x.item.text, ctx, x.item.line)}${kids}</li>`;
  }).join("")));
}

function fence(lines: string[], i: number, ln: (k: number) => number, ctx: Ctx): { html: string; next: number } {
  const f = FENCE.exec(lines[i]!)!;
  const close = new RegExp("^ {0,3}`{" + f[1]!.length + ",}\\s*$");
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j]!)) j++;
  if (j >= lines.length) throw new MarkdownError(ctx.file, ln(i), "fenced code block is never closed");
  const lang = f[2]!;
  if (lang !== "" && !/^[\w+#.-]+$/.test(lang)) throw new MarkdownError(ctx.file, ln(i), `code fence language "${lang}" is not a plain word`);
  const cls = lang !== "" ? ` class="language-${escapeHtml(lang)}"` : "";
  return { html: `<pre><code${cls}>${escapeHtml(lines.slice(i + 1, j).join("\n"))}\n</code></pre>`, next: j + 1 };
}

function table(lines: string[], i: number, ln: (k: number) => number, ctx: Ctx): { html: string; next: number } {
  const head = splitRow(lines[i]!);
  const sep = splitRow(lines[i + 1]!);
  if (!sep.every((c) => SEP_CELL.test(c))) throw new MarkdownError(ctx.file, ln(i + 1), "table separator row must hold only ---, :--, --: or :-: cells");
  if (sep.length !== head.length) throw new MarkdownError(ctx.file, ln(i + 1), `table header has ${head.length} cells but the separator row has ${sep.length}`);
  const align = sep.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const cell = (tag: string, text: string, k: number, at: number) =>
    `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(text, ctx, at)}</${tag}>`;
  let html = `<thead><tr>${head.map((c, k) => cell("th", c, k, ln(i))).join("")}</tr></thead>`;
  let j = i + 2;
  const rows: string[] = [];
  while (j < lines.length && lines[j]!.trim() !== "" && lines[j]!.includes("|") && !startsBlock(lines, j)) {
    const cells = splitRow(lines[j]!);
    if (cells.length > head.length) throw new MarkdownError(ctx.file, ln(j), `table row has ${cells.length} cells but the header has ${head.length}`);
    while (cells.length < head.length) cells.push("");
    rows.push(`<tr>${cells.map((c, k) => cell("td", c, k, ln(j))).join("")}</tr>`);
    j++;
  }
  if (rows.length) html += `<tbody>${rows.join("")}</tbody>`;
  return { html: `<div class="table-wrap"><table>${html}</table></div>`, next: j };
}

function list(lines: string[], i: number, ln: (k: number) => number, ctx: Ctx): { html: string; next: number } {
  const items: Item[] = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (m) {
      const ordered = /\d/.test(m[2]!);
      items.push({ indent: m[1]!.length, ordered, num: ordered ? parseInt(m[2]!, 10) : 1, text: m[3]!.trim(), line: ln(i) });
      i++;
      continue;
    }
    if (lines[i]!.trim() === "") {
      let k = i;
      while (k < lines.length && lines[k]!.trim() === "") k++;
      if (k < lines.length && ITEM.test(lines[k]!)) { i = k; continue; }
      break;
    }
    if (startsBlock(lines, i)) break;
    items[items.length - 1]!.text += "\n" + lines[i]!.trim();
    i++;
  }
  return { html: renderList(items, ctx), next: i };
}

function blocks(lines: string[], first: number, ctx: Ctx): string {
  const out: string[] = [];
  let i = 0;
  const ln = (k: number) => first + k;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trim() === "") { i++; continue; }

    if (FENCE.test(l)) { const r = fence(lines, i, ln, ctx); out.push(r.html); i = r.next; continue; }

    if (HEADING_START.test(l)) {
      const h = HEADING_LINE.exec(l)!;
      const level = h[1]!.length;
      if (level > 4) throw new MarkdownError(ctx.file, ln(i), `heading level ${level} is outside the subset (levels 1-4)`);
      const text = (h[2] ?? "").trim();
      if (text === "") throw new MarkdownError(ctx.file, ln(i), "heading has no text");
      let slug = slugOf(text);
      const seen = ctx.slugs.get(slug) ?? 0;
      ctx.slugs.set(slug, seen + 1);
      if (seen > 0) slug = `${slug}-${seen + 1}`;
      out.push(`<h${level} id="${slug}">${inline(text, ctx, ln(i))}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(l)) { out.push("<hr>"); i++; continue; }

    if (QUOTE.test(l)) {
      const inner: string[] = [];
      const start = i;
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        const stripped = lines[i]!.replace(/^ {0,3}> ?/, "");
        if (QUOTE.test(stripped)) throw new MarkdownError(ctx.file, ln(i), "nested block quotes are not part of the subset");
        inner.push(stripped);
        i++;
      }
      out.push(`<blockquote>\n${blocks(inner, ln(start), ctx)}\n</blockquote>`);
      continue;
    }

    if (startsTable(lines, i)) { const r = table(lines, i, ln, ctx); out.push(r.html); i = r.next; continue; }
    if (isSepRow(l) || l.trim().startsWith("|")) {
      throw new MarkdownError(ctx.file, ln(i), "a table needs a header row followed by a separator row (| --- | --- |)");
    }

    if (ITEM.test(l)) { const r = list(lines, i, ln, ctx); out.push(r.html); i = r.next; continue; }

    const start = i;
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (i === start || !startsBlock(lines, i))) { para.push(lines[i]!.trim()); i++; }
    out.push(`<p>${inline(para.join("\n"), ctx, ln(start))}</p>`);
  }
  return out.join("\n");
}

/** Render `src` (Markdown) to HTML. `firstLine` is the file line of the first line of `src`, so errors name the real line. */
export function renderMarkdown(src: string, opts: { file: string; firstLine?: number }): Rendered {
  const ctx: Ctx = { file: opts.file, refs: [], slugs: new Map() };
  const html = blocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), opts.firstLine ?? 1, ctx);
  return { html, refs: ctx.refs };
}
