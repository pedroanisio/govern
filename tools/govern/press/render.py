"""Parse the press release's small Markdown grammar and lay it out with ReportLab."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from html import escape
from pathlib import Path
import re
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    Flowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

DATELINE_PREFIX = "São Paulo, 2026-10-16 —"
INK = colors.HexColor("#101828")
PAPER = colors.HexColor("#F7F6F2")
ACCENT = colors.HexColor("#1F6F5F")
ACCENT_2 = colors.HexColor("#D98A1E")
MUTED = colors.HexColor("#5C6370")
RULE = colors.HexColor("#D9D6CE")
SECTIONS = ("Subheadline", "Key facts", "About govern", "Contact")


class ReleaseError(ValueError):
    """release.md breaks the press-release structure; the message names its line."""

    def __init__(self, line: int, message: str):
        self.line = line
        super().__init__(f"line {line}: {message}")


@dataclass
class Release:
    """The parsed press release: one field per section, body paragraphs in order."""

    headline: str
    subheadline: str
    dateline: str
    body: list[str]
    facts: list[str]
    about: str
    contact: str


def inline_markup(text: str, line: int = 1) -> str:
    """Escape text, accepting only paired strong and code spans."""
    result: list[str] = []
    index = 0
    while index < len(text):
        if text.startswith("**", index):
            end = text.find("**", index + 2)
            if end < 0 or end == index + 2:
                raise ReleaseError(line, "unclosed or empty strong span")
            result.append("<b>" + inline_markup(text[index + 2:end], line) + "</b>")
            index = end + 2
        elif text[index] == "`":
            end = text.find("`", index + 1)
            if end < 0 or end == index + 1:
                raise ReleaseError(line, "unclosed or empty code span")
            result.append('<font name="Courier">' + escape(text[index + 1:end]) + '</font>')
            index = end + 1
        else:
            if text[index] in "*_[]<>|\\" or text[index] == "#":
                raise ReleaseError(line, "unsupported Markdown construct")
            result.append(escape(text[index]))
            index += 1
    return "".join(result)


def parse_release(source: str) -> Release:
    """Validate structure and return typed release data, with source line errors."""
    headline = ""
    seen: dict[str, int] = {}
    blocks: dict[str, list[tuple[int, str]]] = {section: [] for section in SECTIONS}
    facts: list[str] = []
    section = ""
    pending: list[str] = []
    pending_line = 1
    lines = source.splitlines()

    def flush() -> None:
        if pending:
            if not section:
                raise ReleaseError(pending_line, "text before Subheadline section")
            if section == "Key facts":
                raise ReleaseError(pending_line, "Key facts accepts only '- ' list items")
            blocks[section].append((pending_line, " ".join(pending)))
            pending.clear()

    for number, raw in enumerate(lines, 1):
        text = raw.strip()
        if not text:
            flush()
            continue
        if raw != raw.lstrip():
            raise ReleaseError(number, "unsupported indented Markdown")
        if not headline and not text.startswith("# "):
            raise ReleaseError(number, "missing headline")
        if text.startswith("# "):
            flush()
            if headline:
                raise ReleaseError(number, "duplicate headline")
            headline = text[2:].strip()
            if not headline:
                raise ReleaseError(number, "empty headline")
            inline_markup(headline, number)
        elif text.startswith("## "):
            flush()
            section = text[3:].strip()
            if section not in SECTIONS:
                raise ReleaseError(number, f"unknown section: {section}")
            if section in seen:
                raise ReleaseError(number, f"duplicate section: {section}")
            if section != SECTIONS[len(seen)]:
                raise ReleaseError(number, f"missing section: {SECTIONS[len(seen)]}")
            seen[section] = number
        elif text.startswith("- "):
            flush()
            if section != "Key facts":
                raise ReleaseError(number, "list outside Key facts")
            fact = text[2:].strip()
            if not fact:
                raise ReleaseError(number, "empty fact")
            inline_markup(fact, number)
            facts.append(fact)
        else:
            if re.match(r"^(?:#|>|[-+*](?:\s|$)|\d+[.)]\s|={3,}$|-{3,}$|~{3,})", text):
                raise ReleaseError(number, "unsupported Markdown construct")
            inline_markup(text, number)
            if not pending:
                pending_line = number
            pending.append(text)
    flush()
    end_line = max(1, len(lines))
    if not headline:
        raise ReleaseError(1, "missing headline")
    for name in SECTIONS:
        if name not in seen:
            raise ReleaseError(end_line, f"missing section: {name}")
    lead = blocks["Subheadline"]
    if not lead:
        raise ReleaseError(seen["Subheadline"], "empty subheadline")
    if len(lead) < 2:
        raise ReleaseError(seen["Subheadline"], "missing dateline")
    if not lead[1][1].startswith(DATELINE_PREFIX):
        raise ReleaseError(lead[1][0], f"dateline must start with {DATELINE_PREFIX}")
    if len(lead) < 3:
        raise ReleaseError(seen["Subheadline"], "empty body")
    if len(facts) < 3:
        raise ReleaseError(seen["Key facts"], "at least three facts required")
    for name in ("About govern", "Contact"):
        if len(blocks[name]) != 1:
            raise ReleaseError(seen[name], f"{name} requires one paragraph")
    return Release(headline, lead[0][1], lead[1][1], [text for _, text in lead[2:]],
                   facts, blocks["About govern"][0][1], blocks["Contact"][0][1])


class TitleBlock(Flowable):
    """The drawn title band used when no banner image is given."""

    def __init__(self, width: float):
        super().__init__()
        self.width, self.height = width, 44

    def draw(self):
        """Paint the band, its accent stripe and square, and the govern wordmark."""
        self.canv.setFillColor(PAPER)
        self.canv.rect(0, 0, self.width, self.height, fill=1, stroke=0)
        self.canv.setFillColor(ACCENT)
        self.canv.rect(0, 0, 6, self.height, fill=1, stroke=0)
        self.canv.setFont("Helvetica-Bold", 20)
        self.canv.drawString(18, 14, "govern")
        self.canv.setFillColor(ACCENT_2)
        self.canv.rect(self.width - 28, 16, 12, 12, fill=1, stroke=0)


def image_flowable(path: Path, width: float, max_height: float) -> Image:
    """The image at PATH scaled to fit WIDTH and MAX_HEIGHT, aspect ratio kept."""
    image_width, image_height = ImageReader(str(path)).getSize()
    scale = min(width / image_width, max_height / image_height)
    return Image(str(path), width=image_width * scale, height=image_height * scale)


def render_release(release: Release, out: Path, banner: Path | None = None,
                   logo: Path | None = None) -> Path:
    """Build a LETTER PDF using a content-width banner and numbered pages."""
    for path in (banner, logo):
        if path is not None and not path.is_file():
            raise ValueError(f"image does not exist: {path}")
    out.mkdir(parents=True, exist_ok=True)
    target = out / "govern-press-release.pdf"
    width = LETTER[0] - 96
    body = ParagraphStyle("Body", fontName="Helvetica", fontSize=10.5, leading=15,
                          textColor=INK, spaceAfter=10)
    head = ParagraphStyle("Headline", parent=body, fontName="Helvetica-Bold", fontSize=25,
                          leading=29, spaceAfter=12)
    sub = ParagraphStyle("Subheadline", parent=body, fontSize=12.5, leading=17, textColor=MUTED)
    section = ParagraphStyle("Section", parent=body, fontName="Helvetica-Bold", fontSize=13,
                            leading=17, textColor=ACCENT, spaceBefore=10, keepWithNext=True)
    fact_style = ParagraphStyle("Fact", parent=body, fontSize=9, leading=13, spaceAfter=0)
    kicker = ParagraphStyle("Kicker", parent=body, fontName="Helvetica-Bold", fontSize=9,
                            textColor=ACCENT, spaceBefore=12)
    story = [image_flowable(banner, width, float("inf")) if banner else TitleBlock(width)]
    if logo:
        story.extend([Spacer(1, 10), image_flowable(logo, 60, 60)])
    story.extend([Paragraph("PRESS RELEASE", kicker), Paragraph(inline_markup(release.headline), head),
                  Paragraph(inline_markup(release.subheadline), sub)])
    # The dateline runs directly into the first body paragraph.
    story.append(Paragraph(inline_markup(release.dateline + " " + release.body[0]), body))
    story.extend(Paragraph(inline_markup(text), body) for text in release.body[1:])
    story.append(Paragraph("Key facts", section))
    cells = [Paragraph(inline_markup(fact), fact_style) for fact in release.facts]
    if len(cells) % 2:
        cells.append("")
    table = Table([cells[i:i + 2] for i in range(0, len(cells), 2)],
                  colWidths=[width / 2, width / 2], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PAPER),
        ("BOX", (0, 0), (-1, -1), 0.7, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    story.append(table)
    for title, text in (("About govern", release.about), ("Contact", release.contact)):
        story.extend([Paragraph(title, section), Paragraph(inline_markup(text), body)])

    def footer(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(RULE)
        canvas.line(48, 38, LETTER[0] - 48, 38)
        canvas.setFillColor(MUTED)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(48, 25, f"govern press release · page {document.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(str(target), pagesize=LETTER, leftMargin=48, rightMargin=48,
                            topMargin=36, bottomMargin=54, title=release.headline,
                            subject="govern: checked stages, owner gates, and visible agent work",
                            author="govern (super-tools)")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return target


class CommandParser(argparse.ArgumentParser):
    """An argument parser that raises usage errors instead of exiting."""

    def error(self, message):
        """Raise MESSAGE as a ValueError, so main() reports it on one line."""
        raise ValueError(message)


def main(argv: list[str] | None = None) -> int:
    """Render the --release file into --out; print the PDF path and page count, or one error line and return 1."""
    try:
        parser = CommandParser(description=__doc__)
        parser.add_argument("--out", type=Path, required=True)
        parser.add_argument("--release", type=Path, default=Path("press/release.md"))
        parser.add_argument("--banner", type=Path)
        parser.add_argument("--logo", type=Path)
        args = parser.parse_args(argv)
        release = parse_release(args.release.read_text(encoding="utf-8"))
        path = render_release(release, args.out, args.banner, args.logo)
        # Read back the actual output rather than estimating layout length.
        from pypdf import PdfReader
        pages = len(PdfReader(path).pages)
        print(f"{path} ({pages} pages)")
        return 0
    except Exception as error:
        print("press render: " + " ".join(str(error).splitlines()), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
