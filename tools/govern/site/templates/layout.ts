// The one page layout: header with wordmark and top navigation, a side list for the page's section, title, description,
// content, footer. Brand images are used only when the build found them in static/brand/.
import { escapeHtml as e } from "../lib/markdown.ts";

export interface NavItem { url: string; title: string }

export interface LayoutInput {
  title: string;
  description: string;
  url: string;
  bodyHtml: string;
  nav: NavItem[];
  /** Pages of the current section (the side list); empty when the page has none. */
  side: NavItem[];
  sideTitle: string;
  version: string;
  commit: string;
  /** Footer links that exist as pages. */
  footer: NavItem[];
  /** Which of the brand images are present in static/brand/. */
  brand: { wordmark: boolean; favicon: boolean; socialCard: boolean; hero: boolean };
}

const JS_FLAG = `document.documentElement.className+=" js"`;
const JS_TOGGLE = `var b=document.querySelector(".nav-toggle"),n=document.getElementById("site-nav");if(b&&n){b.addEventListener("click",function(){var o=n.classList.toggle("open");b.setAttribute("aria-expanded",o?"true":"false")})}`;

export function layout(p: LayoutInput): string {
  const docTitle = p.url === "/" ? p.title : `${p.title} · govern`;
  const brand = p.brand.wordmark ? `<img src="/static/brand/wordmark.png" alt="govern">` : "govern";
  const nav = p.nav.map((n) => `<li><a href="${e(n.url)}"${n.url === p.url ? ' aria-current="page"' : ""}>${e(n.title)}</a></li>`).join("");
  const side = p.side.length
    ? `<aside class="side" aria-label="${e(p.sideTitle)}"><p class="side-title">${e(p.sideTitle)}</p><ul>${p.side
        .map((n) => `<li><a href="${e(n.url)}"${n.url === p.url ? ' aria-current="page"' : ""}>${e(n.title)}</a></li>`).join("")}</ul></aside>`
    : "";
  const hero = p.url === "/" && p.brand.hero ? `<img class="hero" src="/static/brand/hero.png" alt="">\n` : "";
  const foot = p.footer.map((n) => ` · <a href="${e(n.url)}">${e(n.title)}</a>`).join("");
  const card = p.brand.socialCard
    ? `<meta property="og:image" content="/static/brand/social-card.png">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="/static/brand/social-card.png">\n`
    : `<meta name="twitter:card" content="summary">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(docTitle)}</title>
<meta name="description" content="${e(p.description)}">
<meta name="color-scheme" content="light dark">
${p.brand.favicon ? '<link rel="icon" href="/static/brand/favicon.png">\n' : ""}<meta property="og:type" content="website">
<meta property="og:site_name" content="govern">
<meta property="og:title" content="${e(p.title)}">
<meta property="og:description" content="${e(p.description)}">
<meta property="og:url" content="${e(p.url)}">
${card}<meta name="twitter:title" content="${e(p.title)}">
<meta name="twitter:description" content="${e(p.description)}">
<link rel="stylesheet" href="/static/site.css">
<script>${JS_FLAG}</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site-header">
<div class="bar">
<a class="brand" href="/">${brand}</a>
<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
<nav id="site-nav" aria-label="Main"><ul>${nav}</ul></nav>
</div>
</header>
<div class="shell${side ? " has-side" : ""}">
${side}<main id="content">
${hero}<h1>${e(p.title)}</h1>
<p class="lede">${e(p.description)}</p>
${p.bodyHtml}
</main>
</div>
<footer class="site-footer">
<p>govern ${e(p.version)} · ${e(p.commit)}${foot}</p>
</footer>
<script>${JS_TOGGLE}</script>
</body>
</html>
`;
}
