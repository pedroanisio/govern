// Exercise the POSIX launcher with an isolated PATH and fake Node runtimes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { HERE, tempDir } from './helpers.ts';

const launcher = resolve(HERE, '../../../bin/govern');
for (const version of [undefined, 'v22.1.0', 'unexpected']) {
  test(`launcher explains unsupported runtime ${version}`, () => {
    const path = tempDir('node-path');
    if (version) writeFileSync(join(path, 'node'), `#!/bin/sh\necho '${version}'\n`, { mode: 0o755 });
    const r = spawnSync('/bin/sh', [launcher, 'version'], { env: { PATH: path }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `govern needs Node 24 or later, found ${version ?? 'no node'}\n`);
  });
}
for (const version of ['v24.0.0', 'v26.1.0']) {
  test(`launcher accepts ${version} and forwards arguments`, () => {
    const path = tempDir('node-path');
    writeFileSync(join(path, 'node'), `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version}'; else printf '%s\\n' "$@"; fi\n`, { mode: 0o755 });
    writeFileSync(join(path, 'dirname'), '#!/bin/sh\nexec /usr/bin/dirname "$@"\n', { mode: 0o755 });
    const r = spawnSync('/bin/sh', [launcher, 'version', '--json'], { env: { PATH: path }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /govern\.ts\nversion\n--json\n$/);
  });
}

test('leading --help remains available without a Node runtime', () => {
  const path = tempDir('help-without-node');
  writeFileSync(join(path, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const r = spawnSync('/bin/sh', [launcher, '--help'], {
    env: { ...process.env, PATH: `${path}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NAME\n.*govern/);
});
