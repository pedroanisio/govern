"""Contract tests for the press release parser, PDF output, and CLI."""
import importlib.util
from pathlib import Path
import struct
import subprocess
import sys
import zlib

import pytest
from pypdf import PdfReader

MODULE_PATH = Path(__file__).with_name("render.py")
spec = importlib.util.spec_from_file_location("press_render", MODULE_PATH)
render = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = render
spec.loader.exec_module(render)
RELEASE_PATH = Path(__file__).with_name("release.md")
VALID = """# govern announcement

## Subheadline

Checked agent work

São Paulo, 2026-10-16 — govern is available.

Work follows **checked stages** with `govern`.

## Key facts

- Lanes
- Gates
- Checks

## About govern

govern organizes agent work.

## Contact

Through the super-tools repository's issue tracker.
"""


def test_real_release_fields():
    release = render.parse_release(RELEASE_PATH.read_text())
    assert all((release.headline, release.subheadline, release.dateline,
                release.body, release.facts, release.about, release.contact))
    assert all(release.body) and all(release.facts)
    assert release.dateline.startswith(render.DATELINE_PREFIX)
    assert 5 <= len(release.facts) <= 8


def test_real_pdf(tmp_path):
    release = render.parse_release(RELEASE_PATH.read_text())
    path = render.render_release(release, tmp_path)
    pdf = PdfReader(path)
    assert len(pdf.pages) >= 1
    text = " ".join(" ".join(page.extract_text().split()) for page in pdf.pages)
    assert release.headline in text
    assert "Through the super-tools repository's issue tracker." in text
    assert pdf.metadata.title == release.headline
    assert pdf.metadata.author == "govern (super-tools)"
    assert pdf.metadata.subject
    for i, page in enumerate(pdf.pages, 1):
        assert f"govern press release · page {i}" in page.extract_text()
        assert list(page.mediabox) == [0, 0, 612, 792]


@pytest.mark.parametrize("source,line", [
    (VALID.replace("# govern announcement\n\n", ""), 1),
    (VALID.replace("## Key facts", "## Unknown"), 11),
    (VALID.replace("- Checks\n", ""), 11),
    (VALID.replace("São Paulo, 2026-10-16 —", "Elsewhere —"), 7),
    (VALID.replace("Work follows **checked stages** with `govern`.", "> unsupported"), 9),
], ids=["missing-headline", "unknown-section", "two-facts", "bad-dateline", "unsupported-markdown"])
def test_malformed(source, line):
    with pytest.raises(render.ReleaseError) as error:
        render.parse_release(source)
    assert error.value.line == line
    assert f"line {line}:" in str(error.value)


@pytest.mark.parametrize("source", [
    VALID.replace("# govern announcement", "    # govern announcement"),
    VALID.replace("## Subheadline", "# Another headline\n\n## Subheadline"),
    VALID.replace("## Contact\n\nThrough the super-tools repository's issue tracker.", ""),
    VALID.replace("Work follows **checked stages** with `govern`.\n\n", ""),
    VALID.replace("## Contact", "## About govern"),
    VALID.replace("checked stages**", "checked stages*"),
    VALID.replace("Work follows **checked stages** with `govern`.", "[link](https://example.org)"),
    VALID.replace("## About govern", "### About govern"),
    VALID.replace("Work follows **checked stages** with `govern`.", "<b>raw HTML</b>"),
    VALID.replace("Work follows **checked stages** with `govern`.", "1. ordered list"),
    VALID.replace("Work follows **checked stages** with `govern`.", "![image](file.png)"),
    VALID.replace("Work follows **checked stages** with `govern`.", "---"),
])
def test_other_invalid_structure(source):
    with pytest.raises(render.ReleaseError) as error:
        render.parse_release(source)
    assert error.value.line >= 1


def write_png(path):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 12, 6, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress((b"\0" + b"\x1f\x6f\x5f" * 12) * 6))
                     + chunk(b"IEND", b""))


def test_banner_and_logo_cli(tmp_path):
    banner = tmp_path / "banner.png"
    write_png(banner)
    result = subprocess.run([sys.executable, str(MODULE_PATH), "--release", str(RELEASE_PATH),
                             "--out", str(tmp_path), "--banner", str(banner), "--logo", str(banner)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    pdf = PdfReader(tmp_path / "govern-press-release.pdf")
    assert len(pdf.pages) >= 1
    assert "page" in result.stdout and "govern-press-release.pdf" in result.stdout
    assert any(page.images for page in pdf.pages)


def test_missing_banner_cli(tmp_path):
    missing = tmp_path / "missing.png"
    result = subprocess.run([sys.executable, str(MODULE_PATH), "--release", str(RELEASE_PATH),
                             "--out", str(tmp_path), "--banner", str(missing)], capture_output=True, text=True)
    assert result.returncode == 1
    assert str(missing) in result.stderr
    assert len(result.stderr.splitlines()) == 1


def test_cli_default_release(tmp_path):
    result = subprocess.run([sys.executable, "press/render.py", "--out", str(tmp_path)],
                            cwd=MODULE_PATH.parent.parent, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "govern-press-release.pdf").is_file()


def test_inline_formatting():
    assert render.inline_markup("A **bold** `code` & plain") == 'A <b>bold</b> <font name="Courier">code</font> &amp; plain'
