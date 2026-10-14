"""Failure-path and delivery-contract tests, no network or renderer required."""
import copy
import importlib.util
import json
import tempfile
import unittest
import sys
from unittest.mock import patch
from types import SimpleNamespace
from PIL import Image
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('infographic_pipeline', Path(__file__).with_name('pipeline.py'))
pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pipeline)


class Contracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.brief = {'version': 1, 'title': 'Water', 'content': 'A sourced explanation',
                      'audience': 'General', 'language': 'en-US', 'orientation': 'landscape'}
        self.write('brief.json', self.brief)
        self.write('sources/source.txt', 'The reference content.')
        self.plan = {'version': 1, 'centralMessage': 'Water changes state.', 'conclusion': 'Energy drives the change.',
                     'grammar': 'diagram', 'readingOrder': ['Start', 'Process', 'Conclusion'],
                     'originality': 'Show energy flow through a cutaway, rather than three cards.',
                     'effects': [{'effect': 'Glow', 'purpose': 'Trace heat entering the water.'}],
                     'sources': [{'id': 's1', 'path': 'sources/source.txt', 'locator': 'operator input, paragraph 1',
                                  'sha256': pipeline.digest(self.root / 'sources/source.txt')}],
                     'claims': [{'id': 'c1', 'text': 'Water changes state.', 'status': 'observation',
                                 'sources': ['s1'], 'locator': 'paragraph 1', 'caveat': 'Conceptual.'}]}
        self.write('plan.json', self.plan)

    def write(self, name, value):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(value) if not isinstance(value, str) else value)

    def test_brief_default_dimensions_and_portrait(self):
        self.assertEqual(pipeline.dimensions(pipeline.check_input(self.root)), (3840, 2160))
        del self.brief['orientation']
        self.write('brief.json', self.brief)
        self.assertEqual(pipeline.dimensions(pipeline.check_input(self.root)), (3840, 2160))
        self.brief['orientation'] = 'portrait'
        self.write('brief.json', self.brief)
        self.assertEqual(pipeline.dimensions(pipeline.check_input(self.root)), (2160, 3840))

    def test_unknown_missing_and_adversarial_fields_rejected(self):
        for change in [{'orientation': 'square'}, {'content': ''}, {'extra': True}, {'version': True}]:
            with self.subTest(change=change):
                self.write('brief.json', {**self.brief, **change})
                with self.assertRaises(pipeline.PipelineError): pipeline.check_input(self.root)
        del self.brief['content']
        self.write('brief.json', self.brief)
        with self.assertRaises(pipeline.PipelineError): pipeline.check_input(self.root)

    def test_plan_provenance_cannot_be_stale_or_invented(self):
        pipeline.check_plan(self.root)
        self.plan['claims'][0]['sources'] = ['nonexistent']
        self.write('plan.json', self.plan)
        with self.assertRaisesRegex(pipeline.PipelineError, 'source'): pipeline.check_plan(self.root)
        self.plan['claims'][0]['sources'] = ['s1']
        self.write('plan.json', self.plan)
        self.write('sources/source.txt', 'changed')
        with self.assertRaisesRegex(pipeline.PipelineError, 'hash'): pipeline.check_plan(self.root)

    def test_paths_and_symlinks_cannot_escape_bundle(self):
        for name in ['../outside', '/etc/passwd', 'https://host/file', 'source/../../outside']:
            with self.subTest(name=name), self.assertRaises(pipeline.PipelineError): pipeline.local(self.root, name)
        (self.root / 'link').symlink_to('/etc/passwd')
        with self.assertRaises(pipeline.PipelineError): pipeline.local(self.root, 'link')

    def test_render_failure_never_creates_accepted_candidate(self):
        (self.root / 'source').mkdir()
        self.write('source/build.py', 'raise SystemExit(2)')
        with self.assertRaises(pipeline.PipelineError): pipeline.render(self.root, 'missing-engine')
        self.assertFalse((self.root / 'generated/infographic/candidate.json').exists())

    def test_revision_budget_is_owned_by_code(self):
        out = self.root / 'generated/infographic'
        out.mkdir(parents=True)
        for n in range(1, pipeline.MAX_REVISIONS + 1): (out / f'r{n:03}').mkdir()
        with self.assertRaisesRegex(pipeline.PipelineError, 'budget'): pipeline.render(self.root, 'missing')

    def test_missing_review_and_delivery_fail_closed(self):
        with self.assertRaises(pipeline.PipelineError): pipeline.check_review(self.root)
        with self.assertRaises(pipeline.PipelineError): pipeline.deliver(self.root)


    def freeze(self):
        self.write('source/build.py', '# reproducible authoring')
        self.write('source/asset.txt', 'asset')
        dest = self.root / 'generated/infographic/r001'
        for name in ['brief.json', 'plan.json']:
            self.write('generated/infographic/r001/inputs/' + name, (self.root / name).read_text())
        for p in (self.root / 'source').iterdir():
            self.write('generated/infographic/r001/source/' + p.name, p.read_text())
        Image.new('RGB', (3840, 2160)).save(dest / 'frame.png')
        self.write('generated/infographic/r001/source.vpkg.zip', 'unit package fixture')
        files = [{'path': p.relative_to(dest).as_posix(), 'sha256': pipeline.digest(p)} for p in pipeline.source_files(dest)]
        authored = [{'path': p.relative_to(self.root / 'source').as_posix(), 'sha256': pipeline.digest(p)} for p in pipeline.source_files(self.root / 'source')]
        m = dict(version=1, revision=1, width=3840, height=2160, engine='test', sdk='test', files=files, authored=authored)
        m['candidateSha256'] = pipeline.fingerprint(m)
        self.write('generated/infographic/r001/candidate.json', m)
        self.write('generated/infographic/candidate.json', m)
        return m, dest

    def ready(self, m):
        review = dict(version=1, candidateSha256=m['candidateSha256'], reviewer='unit fixture', verdict='ready',
                      inspected=dict(full=True, half=True, thumbnail=True), issues=[],
                      criteria={k: {'score': 9, 'evidence': 'Test evidence'} for k in ['fidelity', 'narrative', 'originality', 'finish']})
        self.write('review.json', review)
        return review

    def test_deleted_authoring_asset_invalidates_candidate(self):
        self.freeze()
        (self.root / 'source/asset.txt').unlink()
        with self.assertRaisesRegex(pipeline.PipelineError, 'source'): pipeline.candidate(self.root)

    def test_changed_frame_and_unrendered_edit_invalidate_candidate(self):
        m, dest = self.freeze()
        self.assertEqual(pipeline.candidate(self.root)[0], m)
        self.write('source/build.py', 'changed code')
        with self.assertRaisesRegex(pipeline.PipelineError, 'source'): pipeline.candidate(self.root)
        self.write('source/build.py', '# reproducible authoring')
        (dest / 'frame.png').write_bytes(b'changed')
        with self.assertRaisesRegex(pipeline.PipelineError, 'hash'): pipeline.candidate(self.root)

    def test_review_cannot_self_certify_missing_images_or_low_quality(self):
        m, _ = self.freeze()
        review = self.ready(m)
        self.assertEqual(pipeline.check_review(self.root), review)
        changes = [dict(candidateSha256='0'*64), dict(verdict='revise'),
                   dict(inspected=dict(full=True, half=True, thumbnail=False)), dict(issues=['overlap']),
                   dict(criteria={**review['criteria'], 'fidelity': {'score': 8.9, 'evidence': 'Unresolved'}}),
                   dict(criteria={k: {'score': 8.9, 'evidence': 'Borderline'} for k in review['criteria']})]
        for change in changes:
            with self.subTest(change=change):
                self.write('review.json', {**review, **change})
                with self.assertRaises(pipeline.PipelineError): pipeline.check_review(self.root)

    def test_delivery_requires_matching_native_approval_and_is_idempotent(self):
        m, dest = self.freeze()
        self.ready(m)
        self.write('govern.json', {'approvals': {}})
        with self.assertRaisesRegex(pipeline.PipelineError, 'approval'): pipeline.deliver(self.root)
        self.write('govern.json', {'approvals': {'final': {'source': {'kind': 'unit-fixture'}, 'quote': 'Approved old hash'}}})
        with self.assertRaisesRegex(pipeline.PipelineError, 'approval'): pipeline.deliver(self.root)
        self.write('govern.json', {'approvals': {'final': {'source': {'kind': 'unit-fixture'}, 'quote': 'Approved ' + m['candidateSha256']}}})
        first = pipeline.deliver(self.root)
        self.assertEqual(first, pipeline.deliver(self.root))
        self.assertEqual(pipeline.digest(Path(first['png'])), pipeline.digest(dest / 'frame.png'))
        Path(first['png']).write_bytes(b'corrupt')
        with self.assertRaisesRegex(pipeline.PipelineError, 'hash'): pipeline.deliver(self.root)

    def test_provenance_duplicates_and_hypothesis_without_caveat_fail(self):
        for kind in ['sources', 'claims']:
            plan = copy.deepcopy(self.plan)
            plan[kind].append(copy.deepcopy(plan[kind][0]))
            self.write('plan.json', plan)
            with self.assertRaisesRegex(pipeline.PipelineError, 'duplicate'): pipeline.check_plan(self.root)
        self.plan['claims'][0].update(status='hypothesis', caveat='')
        self.write('plan.json', self.plan)
        with self.assertRaisesRegex(pipeline.PipelineError, 'caveat'): pipeline.check_plan(self.root)

    def test_source_cannot_overwrite_frozen_operator_input(self):
        self.plan['sources'][0].update(path='brief.json', sha256=pipeline.digest(self.root / 'brief.json'))
        self.write('plan.json', self.plan)
        with self.assertRaisesRegex(pipeline.PipelineError, 'sources/'): pipeline.check_plan(self.root)

    def test_nonfinite_json_and_oversized_inputs_are_rejected(self):
        self.write('bad.json', '{"score": NaN}')
        with self.assertRaises(pipeline.PipelineError): pipeline.read_json(self.root / 'bad.json')
        with patch.object(pipeline, 'MAX_JSON', 1):
            with self.assertRaisesRegex(pipeline.PipelineError, 'large'): pipeline.read_json(self.root / 'brief.json')

    def test_subprocess_failure_and_timeout_retain_logs(self):
        self.assertIn('ready', pipeline.run([sys.executable, '-c', 'print("ready")'], self.root, self.root / 'ok.log'))
        with self.assertRaisesRegex(pipeline.PipelineError, 'cannot run'):
            pipeline.run(['missing-infographic-test-executable'], self.root, self.root / 'missing.log')
        with self.assertRaisesRegex(pipeline.PipelineError, 'timed out'):
            pipeline.run([sys.executable, '-c', 'import time; time.sleep(30)'], self.root, self.root / 'timeout.log', timeout=0)
        self.assertTrue((self.root / 'timeout.log').exists())



    def scene(self, **changes):
        attrs = dict(width='3840', height='2160', fontPolicy='pinned', safeArea='editorial')
        attrs.update(changes)
        from xml.etree.ElementTree import Element, SubElement, tostring
        root = Element('scene')
        SubElement(root, 'project', attrs)
        safe = SubElement(root, 'safeAreas')
        SubElement(safe, 'safeArea', dict(id='editorial', enforce='error', top='.02', right='.02', bottom='.02', left='.02'))
        assets = SubElement(root, 'assets')
        SubElement(assets, 'text', dict(id='title', size='40', fontAsset='bundled'))
        self.write('scene.xml', tostring(root, encoding='unicode'))
        return root

    def sdk_boundary(self):
        # Only the dependency's parser is replaced. The lane reads real scene XML,
        # enforcing its own still, portability and typography contract below.
        return patch.dict(sys.modules, {'sr_core.scene': SimpleNamespace(read=lambda p: SimpleNamespace(check=lambda **k: []))})

    def test_scene_dimensions_fonts_and_margins_are_enforced(self):
        from xml.etree.ElementTree import tostring
        with self.sdk_boundary():
            self.scene()
            pipeline.check_scene(self.root, (3840, 2160))
            for attrs, message in [(dict(width='2160', height='3840'), 'dimensions'),
                                   (dict(fontPolicy='system'), 'pin'), (dict(safeArea='absent'), 'safe area')]:
                self.scene(**attrs)
                with self.assertRaisesRegex(pipeline.PipelineError, message): pipeline.check_scene(self.root, (3840, 2160))
            for kind in ['margin', 'bypass', 'size', 'font', 'asset']:
                xml = self.scene()
                if kind == 'margin': xml.find('safeAreas/safeArea').set('left', '.01')
                if kind == 'bypass': xml.find('project').set('safeAreaForce', 'true')
                if kind == 'size': xml.find('assets/text').set('size', '23')
                if kind == 'font': del xml.find('assets/text').attrib['fontAsset']
                if kind == 'asset': xml.find('assets/text').set('src', 'missing.png')
                self.write('scene.xml', tostring(xml, encoding='unicode'))
                with self.subTest(kind=kind), self.assertRaises(pipeline.PipelineError): pipeline.check_scene(self.root, (3840, 2160))

    def test_candidate_inputs_pointer_and_manifest_cannot_be_stale(self):
        m, dest = self.freeze()
        changed = dict(m, candidateSha256='0'*64)
        self.write('generated/infographic/candidate.json', changed)
        with self.assertRaisesRegex(pipeline.PipelineError, 'fingerprint'): pipeline.candidate(self.root)
        self.write('generated/infographic/candidate.json', m)
        self.write('generated/infographic/r001/candidate.json', changed)
        with self.assertRaisesRegex(pipeline.PipelineError, 'pointer'): pipeline.candidate(self.root)
        self.write('generated/infographic/r001/candidate.json', m)
        self.brief['title'] = 'New title'
        self.write('brief.json', self.brief)
        with self.assertRaisesRegex(pipeline.PipelineError, 'stale'): pipeline.candidate(self.root)

    def test_invalid_engine_reports_never_become_candidates(self):
        self.write('source/build.py', '# dependency-boundary test')
        for report in [[], {'format': 'unknown', 'ok': True}, {'format': 'scene-render-cli/1', 'ok': True, 'result': []},
                       {'format': 'scene-render-cli/1', 'ok': True, 'result': {'rendered': 2}}]:
            def external(argv, cwd, log, timeout=120):
                log.write_text(json.dumps(report) if log.name == 'render.log' else 'ok')
                return log.read_text()
            with patch.object(pipeline, 'run', side_effect=external), patch.object(pipeline, 'check_scene'):
                with self.assertRaises(pipeline.PipelineError): pipeline.render(self.root, 'engine-fixture')
            self.assertFalse((self.root / 'generated/infographic/candidate.json').exists())

    def test_source_limits_blank_input_and_cli_errors(self):
        with self.assertRaisesRegex(pipeline.PipelineError, 'empty'): pipeline.source_files(self.root / 'empty')
        self.write('brief.json', {**self.brief, 'content': '   '})
        with self.assertRaisesRegex(pipeline.PipelineError, 'blank'): pipeline.check_input(self.root)
        with patch.object(sys, 'argv', ['pipeline', 'input', str(self.root)]):
            self.assertEqual(pipeline.main(), 1)
        self.write('brief.json', self.brief)
        with patch.object(sys, 'argv', ['pipeline', 'input', str(self.root)]):
            self.assertEqual(pipeline.main(), 0)


if __name__ == '__main__': unittest.main()
