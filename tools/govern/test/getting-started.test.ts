// Execute the published quickstart verbatim, from an arbitrary temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, tempDir, parentEnv } from './helpers.ts';

test('getting started reaches review using its own commands and generic check', () => {
  const page = readFileSync(join(HERE, '../site/content/docs/getting-started.md'), 'utf8');
  assert.doesNotMatch(page, /npm ci|ops\/govern|tools\/govern\/test/);
  assert.match(page, /Optional: Claude Code/);
  const blocks = [...page.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
  assert.ok(blocks.length >= 2);
  const install = resolve(HERE, '../../..');
  // HOME is isolated; the page explicitly permits nested workspaces.
  const root = tempDir('quickstart');
  const script = `set -eu\ncd "$GOVERN_INSTALL"\n${blocks.join('\n')}\ngovern status first-change\n`;
  const r = spawnSync('/bin/sh', ['-c', script], {
    cwd: root, env: { ...parentEnv(), GOVERN_INSTALL: install, GOVERN_START: root, HOME: root }, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /review/);
  const lane = JSON.parse(readFileSync(join(root, 'my-work/.govern/projects/first-change/govern.json'), 'utf8'));
  assert.equal(lane.process, 'dev');
  assert.equal(lane.stage, 'review');
});
