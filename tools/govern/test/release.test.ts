// Exercise the real CLI and archive; package metadata is the version authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import './helpers.ts'; // every test file runs in the sandbox

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(home, '../..');
const pkg = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8'));
const run = (cmd: string, args: string[], cwd = home, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
};
const cli = (...args: string[]) => run(process.execPath, ['--disable-warning=ExperimentalWarning', join(home, 'govern.ts'), ...args]);

test('package version is semver and requires Node 24', () => {
  assert.equal(typeof pkg.version, 'string');
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  assert.equal(pkg.engines.node, '>=24');
});

test('version and --version print package.json version, including parseable JSON', () => {
  for (const command of ['version', '--version']) {
    const plain = cli(command);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, `govern ${pkg.version}\n`);
    const json = cli(command, '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { name: 'govern', version: pkg.version });
  }
});

test('changelog contains the current package version', () => {
  const text = readFileSync(join(home, 'CHANGELOG.md'), 'utf8');
  assert.ok(text.split('\n').some(line => line.startsWith(`## [${pkg.version}] - `)));
});

test('package builds reproducibly with private artifacts, excludes non-runtime files, and runs alone', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'govern-release-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const output = join(scratch, 'out');
  const build = (tag?: string) => run('npm', ['run', '-s', 'package', '--', '--out', output, ...(tag ? ['--check', tag] : [])]);
  const first = build(`govern-v${pkg.version}`);
  assert.equal(first.status, 0, first.stderr);
  const archive = join(output, `govern-${pkg.version}.tar.gz`);
  const hash = () => createHash('sha256').update(readFileSync(archive)).digest('hex');
  const original = hash();
  assert.equal(statSync(output).mode & 0o777, 0o700);
  for (const name of [archive, join(output, 'SHA256SUMS')]) assert.equal(statSync(name).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), `${original}  govern-${pkg.version}.tar.gz\n`);
  const listed = run('tar', ['-tzf', archive]);
  assert.equal(listed.status, 0, listed.stderr);
  const prefix = `govern-${pkg.version}/`;
  const entries = listed.stdout.trim().split('\n');
  assert.ok(entries.every(entry => entry.startsWith(prefix)));
  const top = [...new Set(entries.map(entry => entry.slice(prefix.length).split('/')[0]).filter(Boolean))].sort();
  assert.deepEqual(top, [...['bin', 'tools', 'README.md'], ...(existsSync(join(root, 'LICENSE')) ? ['LICENSE'] : [])].sort());
  for (const name of ['bin/govern', 'tools/govern/govern.ts', 'tools/govern/package.json']) assert.ok(entries.includes(prefix + name));
  assert.ok(!entries.some(entry => /\/(test|node_modules|android|coverage|dist)\//.test(entry)));
  const sourceFiles = entries.filter(entry => entry.startsWith(`${prefix}tools/govern/`) && !entry.endsWith('/')).map(entry => entry.slice(prefix.length));
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: root, input: sourceFiles.join('\0') + '\0', encoding: 'utf8',
  });
  assert.ifError(ignored.error);
  assert.equal(ignored.status, 1, `ignored files in archive: ${ignored.stdout} ${ignored.stderr}`);
  assert.equal(build().status, 0);
  assert.equal(hash(), original);
  const badTag = 'govern-v9.9.9';
  const bad = build(badTag);
  assert.notEqual(bad.status, 0);
  assert.ok(bad.stderr.includes(badTag) && bad.stderr.includes(`govern-v${pkg.version}`), bad.stderr);
  const extracted = mkdtempSync(join(scratch, 'extracted-'));
  const unpack = run('tar', ['-xzf', archive, '-C', extracted]);
  assert.equal(unpack.status, 0, unpack.stderr);
  const packageRoot = join(extracted, `govern-${pkg.version}`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GOVERN_') || key.startsWith('GIT_')) delete env[key];
  const version = run(join(packageRoot, 'bin/govern'), ['version'], packageRoot, env);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `govern ${pkg.version}\n`);
  const help = run(join(packageRoot, 'bin/govern'), ['-h'], packageRoot, env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /version/);
});

test('release notes select only the current section and reject missing or empty sections', async () => {
  const { releaseNotes } = await import('../scripts/release-notes.ts');
  const text = `# Changelog\n\n## [Unreleased]\n\nNext\n\n## [${pkg.version}] - 2026-10-15\n\n### Added\n\n- This release.\n\n## [older] - 2026-01-01\n\n- Old release.\n`;
  assert.equal(releaseNotes(text, pkg.version), '### Added\n\n- This release.\n');
  assert.throws(() => releaseNotes(text, 'missing'), /missing/i);
  assert.throws(() => releaseNotes(`## [${pkg.version}] - 2026-10-15\n\n`, pkg.version), /empty/i);
});
