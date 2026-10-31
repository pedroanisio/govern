// New lanes guide newcomers toward workspace processes; existing lane fallback stays in processName.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeEnv, govern, write } from './helpers.ts';

test('new without a process lists workspace processes with dev first', () => {
  const e = makeEnv();
  write(join(e.root, 'PALS-Notes/processes/research.json'), JSON.stringify({ version: 1, name: 'research', stages: [{ name: 'gather' }] }));
  const r = govern(e, ['new', 'first']);
  assert.equal(r.code, 2);
  assert.match(r.err, /choose a process: --process dev, /);
  for (const name of ['ops', 'video', 'research']) assert.ok(r.err.includes(`--process ${name}`), r.err);
  assert.doesNotMatch(r.err, /--kind must/);
});

test('create reports actual processes and preserves legacy lane reads', async () => {
  const { create, load } = await import('../lib/project.ts');
  const { processName } = await import('../lib/process.ts');
  const { writeFileSync } = await import('node:fs');
  const e = makeEnv();
  const previous = process.env;
  process.env = { ...previous, ...e.env };
  try {
    write(join(e.root, 'PALS-Notes/processes/research.json'), JSON.stringify({ version: 1, name: 'research', stages: [{ name: 'gather' }] }));
    assert.throws(() => create('newcomer', {}), /choose a process: --process dev, .*--process research/);
    const lane = create('legacy', { kind: 'short' });
    const { process: _, ...legacy } = lane;
    writeFileSync(join(e.projects, 'legacy/govern.json'), JSON.stringify(legacy));
    assert.equal(processName(load('legacy')), 'video');
  } finally { process.env = previous; }
});
