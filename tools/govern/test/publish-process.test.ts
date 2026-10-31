// Publishing belongs to a process; core only checks gates/files and renders its instructions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeEnv, govern, write } from './helpers.ts';
import { parseProcess } from '../lib/process.ts';

const definition = { version: 1, name: 'report', stages: [{ name: 'draft' }], gates: [{ name: 'release' }],
  publish: { gates: ['release'], files: { report: {} }, commands: ['upload {files.report} as {basenames.report} for {slug}'] } };
test('a custom process declares publishing without core code', () => {
  const e = makeEnv();
  write(join(e.root, 'PALS-Notes/processes/report.json'), JSON.stringify(definition));
  assert.equal(govern(e, ['new', 'annual', '--process', 'report']).code, 0);
  assert.match(govern(e, ['publish', 'annual']).err, /no owner approval recorded for: release/);
  assert.equal(govern(e, ['approve', 'annual', 'release', '--quote', 'release it']).code, 0);
  assert.match(govern(e, ['publish', 'annual']).err, /name the report file/);
  write(join(e.projects, 'annual/report.txt'), 'Annual report');
  govern(e, ['file', 'annual', 'report', 'report.txt']);
  const r = govern(e, ['publish', 'annual']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /upload .*report.txt as report.txt for annual/);
  assert.doesNotMatch(r.out, /youtube|smm|final/);
});
test('publish schema rejects bad gate references, unknown keys and placeholders', () => {
  for (const publish of [
    { gates: ['missing'], commands: ['upload'] },
    { gates: [], commands: ['upload'], typo: true },
    { gates: [], commands: ['upload {unknown}'] },
    { gates: [], commands: ['upload {files.missing}'] },
    { gates: [], commands: [] },
  ]) assert.throws(() => parseProcess('report.json', JSON.stringify({ ...definition, publish })), /publish/);
});

test('publish command preserves video output and validates files in process', async (t) => {
  const { COMMANDS } = await import('../govern.ts');
  const { create, save } = await import('../lib/project.ts');
  const { createHash } = await import('node:crypto');
  const e = makeEnv();
  const previous = process.env;
  process.env = { ...previous, ...e.env };
  try {
    const command = COMMANDS.find((c) => c.name === 'publish')!.run!;
    const args = { _: ['publish', 'film'], opts: {}, multi: {}, spec: {}, label: 'publish' };
    const p = create('film', { kind: 'short' });
    assert.throws(() => command(args), /no owner approval recorded for: final, publish/);
    for (const gate of ['script', 'final', 'publish']) p.approvals[gate] = { at: '2026-10-31T00:00:00.000Z', quote: 'approved' };
    save(p);
    assert.throws(() => command(args), /name the filed package/);
    write(join(e.root, 'PALS-Notes/packages/film.vpkg.zip'), 'zipbytes');
    p.files.vpkg = '../../packages/film.vpkg.zip';
    save(p);
    assert.throws(() => command(args), /name the release manifest/);
    write(join(e.projects, 'film/release.json'), '{}');
    p.files.release = 'release.json';
    save(p);
    write(join(e.projects, 'film/unfiled.vpkg.zip'), 'zipbytes');
    p.files.vpkg = 'unfiled.vpkg.zip';
    save(p);
    assert.throws(() => command(args), /not filed in the required folder/);
    p.files.vpkg = '../../packages/film.vpkg.zip';
    save(p);
    assert.throws(() => command(args), /sha256 not in any channel-vpkg-SHA256SUMS/);
    const sha = createHash('sha256').update('zipbytes').digest('hex');
    write(join(e.root, 'PALS-Notes/packages/channel-vpkg-SHA256SUMS-test.txt'), `${sha}  film.vpkg.zip\n`);
    const lines: string[] = [];
    const output = t.mock.method(process.stdout, 'write', (s: string) => { lines.push(s); return true; });
    command(args);
    output.mock.restore();
    assert.equal(lines.join(''), 'film: approvals ✓ (final, publish) · package filed ✓ film.vpkg.zip\n' +
      'On the publishing host (smm), with the release manifest PALS-Notes/projects/film/release.json copied there:\n' +
      '  1. plan:  smm youtube publish release.json --upload\n' +
      '  2. apply: PACKAGE_FILED=film.vpkg.zip smm youtube publish release.json --upload --apply\n' +
      'Then read the result back, and run: govern note film "published <videoId> at <time>"\n');
    create('software', { process: 'dev' });
    assert.throws(() => command({ ...args, _: ['publish', 'software'] }), /process "dev" has no publish step/);
  } finally { process.env = previous; }
});

test('a new domain publishes through its own gate and templates in process', async (t) => {
  const { COMMANDS } = await import('../govern.ts');
  const { create, save } = await import('../lib/project.ts');
  const e = makeEnv();
  write(join(e.root, 'PALS-Notes/processes/report.json'), JSON.stringify(definition));
  const previous = process.env;
  process.env = { ...previous, ...e.env };
  try {
    const command = COMMANDS.find((c) => c.name === 'publish')!.run!;
    const args = { _: ['publish', 'annual'], opts: {}, multi: {}, spec: {}, label: 'publish' };
    const p = create('annual', { process: 'report' });
    assert.throws(() => command(args), /no owner approval recorded for: release/);
    p.approvals.release = { at: '2026-10-31T00:00:00.000Z', quote: 'release it' };
    save(p);
    assert.throws(() => command(args), /name the report file/);
    write(join(e.projects, 'annual/report.txt'), 'Annual report');
    p.files.report = 'report.txt';
    save(p);
    const lines: string[] = [];
    const output = t.mock.method(process.stdout, 'write', (s: string) => { lines.push(s); return true; });
    command(args);
    output.mock.restore();
    assert.equal(lines.join(''), 'upload PALS-Notes/projects/annual/report.txt as report.txt for annual\n');
  } finally { process.env = previous; }
});
