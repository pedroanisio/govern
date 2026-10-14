import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeEnv, govern, setConfig, write, HERE } from './helpers.ts';

const folder = resolve(HERE, '../processes/infographic');
const venv = resolve(HERE, '../../../.venv/bin/python');
const python = process.env.GOVERN_TEST_PYTHON ?? (existsSync(venv) ? venv : 'python3');

test('infographic installs its process, commands, manual and prompts', () => {
  const e = makeEnv('infographic');
  e.env.GOVERN_PYTHON = python;
  setConfig(e, { paths: { infographicPipeline: join(folder, 'pipeline.py') } });
  const created = govern(e, ['new', 'graphics/topic', '--process', 'infographic', '--lang', 'pt-BR']);
  assert.equal(created.code, 0, created.err);
  const state = JSON.parse(readFileSync(join(e.projects, 'graphics/topic/govern.json'), 'utf8'));
  assert.equal(state.stage, 'intake');
  assert.ok(state.commands.render);
  assert.ok(state.processSnapshot);
  assert.match(govern(e, ['manual', 'infographic']).out, /3840 × 2160/);
  assert.match(govern(e, ['prompts', 'infographic']).out, /infographic-review/);
});

test('infographic native stage checks reject missing input and advance valid input', () => {
  const e = makeEnv('infographic-stages');
  e.env.GOVERN_PYTHON = python;
  setConfig(e, { paths: { infographicPipeline: join(folder, 'pipeline.py') } });
  assert.equal(govern(e, ['new', 'graphics/topic', '--process', 'infographic']).code, 0);
  const blocked = govern(e, ['advance', 'graphics/topic', '--note', 'skip missing brief']);
  assert.match(blocked.err, /check input failed/, blocked.err);
  assert.match(blocked.err, /cannot read.*brief\.json/, 'the brief check must actually execute');
  assert.notEqual(govern(e, ['work', 'graphics/topic', 'deliver']).code, 0);
  write(join(e.projects, 'graphics/topic/brief.json'), JSON.stringify({ version: 1, title: 'Subject', content: 'Operator material', audience: 'General', language: 'pt-BR', orientation: 'portrait' }));
  const advance = govern(e, ['advance', 'graphics/topic']);
  assert.equal(advance.code, 0, advance.err + advance.out);
  assert.match(advance.out, /intake → design/);
  assert.notEqual(govern(e, ['advance', 'graphics/topic']).code, 0, 'an absent provenance plan blocks design');
  assert.match(govern(e, ['manual', 'infographic']).out, /3840 × 2160/);
  assert.match(govern(e, ['prompts', 'infographic']).out, /infographic-review/);
});

test('infographic Python contracts and adversarial output tests are part of the Govern suite', () => {
  const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', folder, '-p', 'test_*.py'], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
