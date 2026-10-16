# govern press release

Part of [super-tools](../../../README.md).

`release.md` is the press release. `render.py` validates its structure and renders
`govern-press-release.pdf` with ReportLab. `requirements.txt` pins the PDF layout
and read-back dependencies; `test_render.py` checks parsing, PDF content and
metadata, images, and CLI failures. No model is called.

From `tools/govern`, with the pinned requirements installed:

```sh
python press/render.py --out press/dist
```

Optional arguments are `--release FILE`, `--banner PNG`, and `--logo PNG`.
Without images, the PDF uses a drawn title block in the shared palette. The
banner fills the content width while preserving its aspect ratio. The CLI
prints the PDF path and actual page count, or exits 1 with a one-line error.
Generated PDFs belong in `dist/` and are not committed.

From the repository root, with pytest installed in the Python environment:

```sh
python -m pytest tools/govern/press -q
```

The parser accepts a single headline, then the Subheadline section containing
its paragraph, the fixed dateline paragraph, and body paragraphs. Key facts,
About govern, and Contact follow in that order. Only plain paragraphs, `- `
facts, paired strong spans, and code spans are accepted inside that structure.
Errors identify the source line. The press page mirrors the release at
`../site/content/press.md`; update both when editing the announcement.

The release's facts are grounded in these package documents:

| Fact or topic | Source |
| --- | --- |
| Purpose, chat overhead, intended users, lane ledger | [PURPOSE.md](../PURPOSE.md) |
| File state, built-in processes, advancement conditions, Node runtime | [README.md](../README.md) |
| Briefs, owner approval words, fresh queue sessions, profile self-tests, usage attribution | [SKILL.md](../SKILL.md), sections Start, The task queue, The owner's gates, and usage guidance |
| Profiles, reply verification, command center | [CHANGELOG.md](../CHANGELOG.md), 0.1.0 and Unreleased |

The announcement's dateline, contact wording, and availability wording follow
the publishing task. Brand assets and the site build are supplied separately;
the press page links to their agreed public paths.
