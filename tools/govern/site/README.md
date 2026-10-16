# govern website

Part of [govern](../README.md), in [super-tools](../../../README.md).

The generator, theme and deploy files for the govern website. It turns the Markdown pages in `content/` into plain static files. It has no runtime dependencies: Node runs the TypeScript directly, and the only packages are govern's own devDependencies.

## Build locally

From the repository root:

```
node --disable-warning=ExperimentalWarning tools/govern/site/build.ts
```

The site is written to `tools/govern/site/dist/` (git-ignored). The folder is emptied first, so a second run leaves no stale file. Options:

| Option | Default |
| --- | --- |
| `--content DIR` | `tools/govern/site/content` |
| `--out DIR` | `tools/govern/site/dist` |
| `--press FILE` | `tools/govern/press/dist/govern-press-release.pdf` |
| `--commit SHA` | `git rev-parse --short HEAD`; the build stops if there is neither |

The build prints one line per page and ends with the page count. It exits 0 only when everything was written, 1 on a content, Markdown or link error, and 2 on a bad option. The output folder is only emptied after every check has passed, and the build refuses to empty a folder that holds the content, `static/` or the working folder.

To look at the result, serve `dist/` from any static server, for example `python3 -m http.server --directory tools/govern/site/dist 8080`. Links are site-root absolute (`/docs/`), so open the site at the root of a server, not from a file path.

## Run with Docker

From `tools/govern`:

```
docker build -f site/Dockerfile --build-arg SITE_COMMIT=$(git rev-parse --short HEAD) -t govern-site .
docker run --rm -p 8080:80 govern-site
```

Or, from `tools/govern/site`:

```
SITE_COMMIT=$(git rev-parse --short HEAD) docker compose up --build
```

The site is then at <http://localhost:8080/>. The image has three stages: `python:3.13-slim` renders the press release PDF (`press/render.py`), `node:24-alpine` runs this build, and `nginx:1.27-alpine` serves `dist/` with `nginx.conf` (directory index, `404.html` as the error page, gzip, one-week cache for `/static/`). `SITE_COMMIT` defaults to `unknown`.

The Dockerfile and the compose file have not been run: Docker was not available where they were written.

## Where content goes

Pages are Markdown files under `content/`, one page per file, with frontmatter (`title`, `description`, optional `nav` and `section`). The path decides the URL: `content/docs/commands.md` is served at `/docs/commands/`, `content/index.md` at `/`. Frontmatter, the Markdown subset, links and images follow the rules under "What the build checks" below, and the build enforces them. Links and images use site-root absolute paths (`/docs/commands/`, `/static/brand/logo.png`). A file named `README.md` documents its folder and is not a page.

Brand images go in `static/brand/`: `wordmark.png`, `favicon.png`, `social-card.png` and `hero.png`. Each one is used when it exists. The home page shows `hero.png` above its content.

## What the build checks

- Frontmatter: `title` and `description` are required non-empty strings, `nav` is a whole number, `section` is one lower-case word, and any other key is an error naming the file and the key.
- URLs: file names are lower-case letters, digits, `-` and `_`; two files may not serve the same URL; `content/index.md` must exist.
- Markdown: only the subset (headings 1-4, paragraphs, strong, em, code, fenced code, links, images, lists with one level of nesting, block quotes, pipe tables with a header row, rules). Raw HTML, footnotes, nested block quotes, unclosed fences and table rows that do not fit their header are errors naming the file and line. Everything else in text is escaped.
- Links and images: every target that starts with `/` must be a page URL, a file under `static/`, the press PDF (only when `--press` names an existing file), or `/robots.txt`, `/sitemap.xml`. All broken targets are listed with page, line and target. External links are not fetched, and `#anchor` links are not checked.

Besides the pages the build writes `404.html`, `robots.txt` and `sitemap.xml` (page URLs relative to the site root, because no host name is known), copies `static/` to `dist/static/` and the press PDF to `dist/press/govern-press-release.pdf`.

## Layout of this folder

- [lib/](lib/README.md): the Markdown renderer, content loader, link checker and build.
- [templates/](templates/README.md): the page layout.
- [static/](static/README.md): the stylesheet and brand images.
- `Dockerfile`, `Dockerfile.dockerignore`, `.dockerignore`, `docker-compose.yml`, `nginx.conf`: deploy.

Tests are `test/site-*.test.ts` in the govern package.
