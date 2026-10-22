"""Infographic stage checks and bounded still production; never calls a model.

Model-authored briefs, plans and reviews remain untrusted until their explicit
JSON schemas and cross-file invariants pass. Visual scores are attestations,
not measurements or a substitute for the operator's Govern approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from PIL import Image

HERE = Path(__file__).resolve().parent
MAX_REVISIONS = 4
MAX_JSON = 2_000_000
MAX_SOURCE = 256 * 1024 * 1024
SCHEMAS = HERE / 'schemas'


class PipelineError(Exception):
    """A missing, invalid, stale or unapproved artifact: the stage cannot pass."""


def digest(path: Path) -> str:
    """The SHA-256 hex digest of the file at `path`."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def canonical(value: Any) -> bytes:
    """Canonical JSON bytes (sorted keys, no spaces, UTF-8): the input every hash in this file is taken over."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def fingerprint(value: dict[str, Any]) -> str:
    """The SHA-256 of a candidate manifest without its own candidateSha256 field."""
    return hashlib.sha256(canonical({k: v for k, v in value.items() if k != 'candidateSha256'})).hexdigest()


def local(root: Path, name: str) -> Path:
    """Only regular, relative, symlink-free local inputs belong in a delivery."""
    p = Path(name)
    if p.is_absolute() or '..' in p.parts or ':' in name or '\\' in name or not name:
        raise PipelineError(f'unsafe local path: {name}')
    q = root
    for part in p.parts:
        q = q / part
        if q.is_symlink(): raise PipelineError(f'symlink is not portable: {name}')
    if not q.resolve().is_relative_to(root.resolve()): raise PipelineError(f'path escapes source: {name}')
    return q


def reject_constant(value: str) -> None:
    """json.loads parse_constant hook: NaN and Infinity are not JSON, so they are refused."""
    raise ValueError(f'non-finite JSON number: {value}')


def read_json(path: Path) -> Any:
    """Strict JSON of at most MAX_JSON bytes; an unreadable, oversized or non-finite file is a PipelineError."""
    try:
        if path.stat().st_size > MAX_JSON: raise PipelineError(f'JSON too large: {path}')
        return json.loads(path.read_text(encoding='utf-8'), parse_constant=reject_constant)
    except (OSError, ValueError) as exc:
        raise PipelineError(f'cannot read {path}: {exc}') from exc


def checked(kind: str, value: Any) -> dict[str, Any]:
    """`value` unchanged once it passes schemas/<kind>.json; the first violation is a PipelineError."""
    schema = read_json(SCHEMAS / f'{kind}.json')
    error = next(Draft202012Validator(schema).iter_errors(value), None)
    if error: raise PipelineError(f'{kind} {error.json_path}: {error.message}')
    return value


def document(root: Path, kind: str) -> dict[str, Any]:
    """The lane's <kind>.json, read from a safe local path and checked against its schema."""
    return checked(kind, read_json(local(root, f'{kind}.json')))


def write_json(path: Path, value: Any) -> None:
    """Write `value` to a new file (never overwriting) with mode 600, its folders with mode 700."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('x', encoding='utf-8') as f:
        os.chmod(path, 0o600)
        json.dump(value, f, indent=2, ensure_ascii=False)
        f.write('\n')


def check_input(root: Path) -> dict[str, Any]:
    """The input stage: a schema-valid brief with non-blank content."""
    brief = document(root, 'brief')
    if not brief['content'].strip(): raise PipelineError('brief content is blank')
    return brief


def dimensions(brief: dict[str, Any]) -> tuple[int, int]:
    """The 4K (width, height) the brief's orientation asks for: portrait 2160x3840, otherwise 3840x2160."""
    return (2160, 3840) if brief.get('orientation', 'landscape') == 'portrait' else (3840, 2160)


def check_plan(root: Path) -> dict[str, Any]:
    """The plan stage: unique sources under sources/ whose hashes match, unique claims citing known sources, caveats on hypotheses."""
    check_input(root)
    plan = document(root, 'plan')
    ids: set[str] = set()
    for source in plan['sources']:
        if source['id'] in ids: raise PipelineError('duplicate source id')
        ids.add(source['id'])
        if not source['path'].startswith('sources/'):
            raise PipelineError('evidence must live under sources/')
        path = local(root, source['path'])
        if not path.is_file() or digest(path) != source['sha256']:
            raise PipelineError(f'source hash mismatch: {source["path"]}')
    claims: set[str] = set()
    for claim in plan['claims']:
        if claim['id'] in claims: raise PipelineError('duplicate claim id')
        claims.add(claim['id'])
        if not set(claim['sources']).issubset(ids): raise PipelineError('claim references unknown source')
        if claim['status'] in ('hypothesis', 'inference') and not claim['caveat'].strip():
            raise PipelineError('hypothesis/inference requires an explicit caveat')
    return plan


def run(argv: list[str], cwd: Path, log: Path, timeout: int = 120) -> str:
    """One bounded subprocess group. Failures retain logs, never partial success."""
    try:
        with log.open('xb') as stream:
            os.chmod(log, 0o600)
            proc = subprocess.Popen(argv, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT,
                                    start_new_session=True)
            try: code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                raise PipelineError(f'command timed out: {argv[0]}; see {log}') from exc
        if code: raise PipelineError(f'command failed ({code}): {argv[0]}; see {log}')
        if log.stat().st_size > 8_000_000: raise PipelineError(f'command output too large: {log}')
        return log.read_text(encoding='utf-8')
    except OSError as exc:
        raise PipelineError(f'cannot run {argv[0]}: {exc}') from exc


def source_files(root: Path) -> list[Path]:
    """Every file under `root` (no __pycache__), each path checked local; empty or over 4096 files or MAX_SOURCE bytes is refused."""
    files = []
    total = 0
    for p in sorted(root.rglob('*')):
        local(root, p.relative_to(root).as_posix())
        if p.is_file() and '__pycache__' not in p.parts:
            total += p.stat().st_size
            files.append(p)
    if not files or len(files) > 4096 or total > MAX_SOURCE:
        raise PipelineError('source bundle is empty or exceeds file/byte budget')
    return files


def check_scene(source: Path, size: tuple[int, int]) -> None:
    """SDK schema validation plus this lane's still/typography/portability contract."""
    try:
        from sr_core.scene import read
        scene = local(source, 'scene.xml')
        findings = read(scene).check(schema=True)
        if findings: raise PipelineError('SDK findings: ' + '; '.join(str(f) for f in findings))
        xml = ET.parse(scene).getroot()
    except (ImportError, OSError, ET.ParseError, ValueError) as exc:
        raise PipelineError(f'SDK/scene validation failed: {exc}') from exc
    p = xml.find('project')
    if p is None or (int(p.get('width', '0')), int(p.get('height', '0'))) != size:
        raise PipelineError('scene dimensions do not match the operator orientation')
    if p.get('fontPolicy') != 'pinned': raise PipelineError('scene must pin font assets')
    # Root schema uses no namespace. A one-second scene is fine: only frame 0 is rendered.
    safe = xml.find(f"safeAreas/safeArea[@id='{p.get('safeArea', '')}']")
    if safe is None or safe.get('enforce') != 'error': raise PipelineError('an enforced safe area is required')
    for side in ('top', 'bottom', 'left', 'right'):
        if float(safe.get(side, '0')) < .02: raise PipelineError('safe margins must be at least 2%')
    for node in xml.iter():
        if node.get('safeAreaForce') in ('true', '1'): raise PipelineError('safeAreaForce would bypass margins')
        if node.tag == 'text':
            if float(node.get('size', '0')) < 24: raise PipelineError('text smaller than 24 px')
            if not node.get('fontAsset'): raise PipelineError('text must use a bundled fontAsset')
        for attr in ('src', 'cache'):
            uri = node.get(attr)
            if uri and not uri.startswith('#'):
                if not local(source, uri).is_file(): raise PipelineError(f'missing local asset: {uri}')


def render(root: Path, engine: str) -> dict[str, Any]:
    """Freeze a new attempt, build via Python SDK, strictly render exactly frame 0."""
    plan = check_plan(root)
    out = root / 'generated/infographic'
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    revisions = sorted(out.glob('r[0-9][0-9][0-9]'))
    if len(revisions) >= MAX_REVISIONS: raise PipelineError('render revision budget exhausted; report to operator')
    number = max([int(p.name[1:]) for p in revisions] or [0]) + 1
    if number > MAX_REVISIONS: raise PipelineError('render revision budget exhausted')
    dest = out / f'r{number:03}'
    dest.mkdir(mode=0o700)  # exclusive: concurrent runs cannot overwrite a candidate
    inputs = dest / 'inputs'
    inputs.mkdir(mode=0o700)
    for name in ('brief.json', 'plan.json'):
        shutil.copyfile(local(root, name), inputs / name)
    for s in plan['sources']:
        target = local(inputs, s['path'])
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(local(root, s['path']), target)
    src = local(root, 'source')
    authored = [{'path': p.relative_to(src).as_posix(), 'sha256': digest(p)} for p in source_files(src)]
    snapshot = dest / 'source'
    shutil.copytree(src, snapshot, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    if not (snapshot / 'build.py').is_file(): raise PipelineError('source/build.py is required')
    run([sys.executable, '-B', 'build.py'], snapshot, dest / 'build.log', 300)
    size = dimensions(check_input(inputs))
    check_scene(snapshot, size)
    run([engine, 'validate', str(snapshot / 'scene.xml'), '--deny-warnings'], root, dest / 'validate.log')
    # CLI JSON is the only accepted engine result. Stderr is retained separately.
    run([engine, 'render', str(snapshot / 'scene.xml'), '--time', '0', '--quality', 'final', '--strict',
         '-o', str(dest / 'frame.png'), '--format', 'json'], root, dest / 'render.log', 900)
    report = read_json(dest / 'render.log')
    if not isinstance(report, dict) or report.get('format') != 'scene-render-cli/1' or report.get('ok') is not True:
        raise PipelineError('invalid engine JSON envelope')
    result = report.get('result', {})
    if not isinstance(result, dict) or result.get('rendered') != 1 or result.get('unsupported') or result.get('warnings'):
        raise PipelineError('engine did not render exactly one clean frame')
    with Image.open(dest / 'frame.png') as image:
        image.load()
        if image.format != 'PNG' or image.size != size: raise PipelineError('render is not the requested 4K PNG')
        for name, scale in [('half', .5), ('thumbnail', .25)]:
            image.resize((int(size[0]*scale), int(size[1]*scale)), Image.Resampling.LANCZOS).save(dest / f'{name}.png')
    import sr_core
    engine_version = run([engine, '--version'], root, dest / 'engine.log').strip()
    # Canonical packer walks model dependencies and rejects nonportable references.
    spec = json.loads(run([sys.executable, '-m', 'sr_core.vpkg', 'init', str(snapshot), '--stdout'], root, dest / 'pack-init.log'))
    spec['package']['id'] = 'infographic'
    spec['package']['version'] = f'1.0.{number}'
    spec['requirements']['python'] = list(dict.fromkeys(spec['requirements'].get('python', []) + [f'sr-core=={sr_core.__version__}']))
    spec['requirements']['tools'] = [{'name': 'python', 'version': '>=3.11'}, {'name': 'scene-render', 'version': engine_version}]
    spec['pipeline'] = {'steps': [{'id': 'build', 'kind': 'generate', 'run': ['python3', 'build.py'], 'inputs': ['build.py'], 'outputs': ['scene.xml']},
                                 {'id': 'frame', 'kind': 'generate', 'needs': ['build'], 'run': ['scene-render', 'render', 'scene.xml', '--time', '0', '--quality', 'final', '--strict', '-o', 'frame.png'], 'inputs': ['scene.xml'], 'outputs': ['frame.png']}],
                        'deliverables': [{'path': 'frame.png', 'role': 'master', 'step': 'frame'}]}
    write_json(snapshot / 'vpkg.json', spec)
    run([sys.executable, '-m', 'sr_core.vpkg', 'pack', str(snapshot), '--no-system-fonts', '-o', str(dest / 'source.vpkg.zip')], root, dest / 'pack.log')
    run([sys.executable, '-m', 'sr_core.vpkg', 'verify', str(dest / 'source.vpkg.zip')], root, dest / 'pack-verify.log')
    files = [{'path': p.relative_to(dest).as_posix(), 'sha256': digest(p)} for p in source_files(dest)]
    manifest = {'version': 1, 'revision': number, 'width': size[0], 'height': size[1], 'engine': engine_version,
                'sdk': sr_core.__version__, 'files': files, 'authored': authored}
    manifest['candidateSha256'] = fingerprint(manifest)
    checked('candidate', manifest)
    write_json(dest / 'candidate.json', manifest)
    # A failed attempt never replaces the previous successful candidate pointer.
    pointer = out / 'candidate.json'
    temporary = out / f'candidate-r{number:03}.json'
    write_json(temporary, manifest)
    temporary.replace(pointer)
    for p in dest.rglob('*'): os.chmod(p, 0o700 if p.is_dir() else 0o600)
    return manifest


def candidate(root: Path) -> tuple[dict[str, Any], Path]:
    """The current candidate manifest and its frozen revision folder, once its hashes, inputs and authored source still match."""
    check_plan(root)
    out = root / 'generated/infographic'
    m = checked('candidate', read_json(local(root, 'generated/infographic/candidate.json')))
    dest = local(out, f'r{m["revision"]:03}')
    if m['candidateSha256'] != fingerprint(m): raise PipelineError('candidate fingerprint mismatch')
    if read_json(dest / 'candidate.json') != m: raise PipelineError('candidate pointer does not match frozen revision')
    for item in m['files']:
        p = local(dest, item['path'])
        if not p.is_file() or digest(p) != item['sha256']: raise PipelineError(f'candidate hash mismatch: {item["path"]}')
    if dimensions(check_input(root)) != (m['width'], m['height']): raise PipelineError('candidate orientation is stale')
    for name in ('brief.json', 'plan.json'):
        if digest(root / name) != digest(dest / 'inputs' / name): raise PipelineError(f'stale candidate: {name}')
    # Unrendered authoring edits also invalidate a review.
    authored = {p.relative_to(root / 'source').as_posix(): digest(p) for p in source_files(root / 'source')}
    frozen = {p['path']: p['sha256'] for p in m['authored']}
    if authored != frozen: raise PipelineError('unrendered source edit, addition or deletion')
    return m, dest


def check_review(root: Path) -> dict[str, Any]:
    """The review stage: a ready review of the current candidate, all images inspected, no issues, the score floors met."""
    m, _ = candidate(root)
    review = document(root, 'review')
    if review['candidateSha256'] != m['candidateSha256']: raise PipelineError('review is for a different candidate')
    if review['verdict'] != 'ready' or review['issues'] or not all(review['inspected'].values()):
        raise PipelineError('review requires all three images inspected, ready verdict and no unresolved issues')
    scores = [x['score'] for x in review['criteria'].values()]
    if min(scores) < 8.5 or sum(scores)/len(scores) < 9 or review['criteria']['fidelity']['score'] < 9:
        raise PipelineError('editorial quality floor not met')
    return review


def deliver(root: Path) -> dict[str, str]:
    """Verify the exact candidate, review and owner quote before packaging delivery."""
    review = check_review(root)
    m, dest = candidate(root)
    state = read_json(root / 'govern.json')
    approval = state.get('approvals', {}).get('final', {})
    if not approval.get('source') or m['candidateSha256'] not in approval.get('quote', ''):
        raise PipelineError('final owner approval must quote this candidate SHA-256 through govern approve')
    delivery = root / 'generated/infographic' / ('delivery-' + m['candidateSha256'][:16])
    expected = {'candidateSha256': m['candidateSha256'], 'reviewSha256': digest(root / 'review.json'),
                'approvalSha256': hashlib.sha256(canonical(approval)).hexdigest()}
    if delivery.exists():
        receipt = read_json(delivery / 'receipt.json')
        if any(receipt.get(k) != v for k,v in expected.items()): raise PipelineError('existing delivery evidence changed')
        for name in ('frame.png', 'reproduce.vpkg.zip', 'review.json'):
            if digest(delivery / name) != receipt['files'][name]: raise PipelineError('delivery file hash mismatch')
        return {'png': str(delivery / 'frame.png'), 'source': str(delivery / 'reproduce.vpkg.zip')}
    delivery.mkdir(mode=0o700)
    for src, target in [(dest / 'frame.png', 'frame.png'), (dest / 'source.vpkg.zip', 'reproduce.vpkg.zip'), (root / 'review.json', 'review.json')]:
        shutil.copyfile(src, delivery / target)
        os.chmod(delivery / target, 0o600)
    expected['files'] = {n: digest(delivery / n) for n in ('frame.png', 'reproduce.vpkg.zip', 'review.json')}
    write_json(delivery / 'receipt.json', expected)
    return {'png': str(delivery / 'frame.png'), 'source': str(delivery / 'reproduce.vpkg.zip')}


def main() -> int:
    """Run one stage check on a lane folder; print its JSON result and exit 0, or the reason on stderr and exit 1."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['input', 'plan', 'render', 'candidate', 'review', 'deliver'])
    parser.add_argument('lane', type=Path)
    parser.add_argument('--engine', default=os.environ.get('SCENE_RENDER_BIN', 'scene-render'))
    args = parser.parse_args()
    root = args.lane.resolve()
    try:
        functions = {'input': check_input, 'plan': check_plan, 'review': check_review, 'deliver': deliver}
        result = render(root, args.engine) if args.command == 'render' else candidate(root)[0] if args.command == 'candidate' else functions[args.command](root)
        print(json.dumps({'ok': True, 'stage': args.command, 'result': result}, ensure_ascii=False))
        return 0
    except (PipelineError, OSError, ValueError, KeyError, TypeError) as exc:
        print(f'infographic: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__': raise SystemExit(main())
