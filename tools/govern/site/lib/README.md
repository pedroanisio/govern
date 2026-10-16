# site/lib

Part of the [govern website](../README.md), in [super-tools](../../../../README.md).

- `markdown.ts`: renders the Markdown subset to HTML and throws `MarkdownError { file, line, message }` outside it.
- `content.ts`: reads `content/`, parses frontmatter strictly through `lib/shape.ts`, derives each page's URL, refuses duplicate URLs.
- `links.ts`: checks that every internal link and image resolves to a page, a static file or the press PDF.
- `site.ts`: `buildSite()`, which runs those checks and then writes the output folder; `build.ts` beside this folder is the command line.
