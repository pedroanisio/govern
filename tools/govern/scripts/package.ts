// A standalone runtime archive: no npm install and no dependency on repository tooling.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(home, '../..');
function command(name: string, args: string[], input?: string | Buffer): Buffer {
  const result = spawnSync(name, args, { cwd: root, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name}: ${result.stderr.toString().trim() || `exit ${result.status}`}`);
  return result.stdout;
}

let stage: string | undefined;
try {
  const { version } = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')) as { version: string };
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error('package.json version must be semver');
  const usage = 'usage: npm run package -- [--check TAG] [--out DIR]';
  const options = new Map<string, string>(), args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if ((key !== '--check' && key !== '--out') || !value || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  const tag = options.get('--check');
  if (tag !== undefined && tag !== `govern-v${version}`) throw new Error(`tag ${tag} does not match package version ${version}: expected govern-v${version}`);
  const epoch = process.env.SOURCE_DATE_EPOCH ?? command('git', ['log', '-1', '--format=%ct']).toString().trim();
  if (!/^\d+$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  process.umask(0o077);
  const output = resolve(options.get('--out') ?? join(root, 'generated/govern-package'));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const staged = mkdtempSync(join(tmpdir(), 'govern-package-'));
  stage = staged;
  const folder = `govern-${version}`;
  // Tracked files only: the package is the commit, never whatever else sits in the checkout.
  const files = command('git', ['ls-files', '--cached', '-z', '--', 'tools/govern']).toString().split('\0').filter(Boolean);
  const ignoredResult = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, input: files.join('\0') + '\0', encoding: 'utf8' });
  if (ignoredResult.error) throw ignoredResult.error;
  if (ignoredResult.status !== 0 && ignoredResult.status !== 1) throw new Error(`git check-ignore: ${ignoredResult.stderr}`);
  const ignored = new Set(ignoredResult.stdout.split('\0'));
  const excluded = new Set(['node_modules', 'test', 'android', 'coverage', '.nyc_output', 'dist']);
  function copy(source: string, destination = source): void {
    const target = join(staged, folder, destination);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(join(root, source), target);
    chmodSync(target, source === 'bin/govern' ? 0o755 : 0o644);
  }
  copy('bin/govern');
  for (const path of [...new Set(files)].sort()) {
    if (ignored.has(path) || path.split('/').some(part => excluded.has(part))) continue;
    if (existsSync(join(root, path))) copy(path);
  }
  if (existsSync(join(root, 'LICENSE'))) copy('LICENSE');
  if (existsSync(join(home, 'README.md'))) copy('tools/govern/README.md', 'README.md');
  // Normalize directory modes independently of the builder's umask.
  const tar = command('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w', '-cf', '-', '-C', staged, folder]);
  const archiveName = `${folder}.tar.gz`;
  const archive = join(output, archiveName);
  writeFileSync(archive, command('gzip', ['-n', '-c'], tar), { mode: 0o600 });
  chmodSync(archive, 0o600);
  const digest = command('sha256sum', [archive]).toString().split(/\s+/)[0];
  const sums = join(output, 'SHA256SUMS');
  writeFileSync(sums, `${digest}  ${archiveName}\n`, { mode: 0o600 });
  chmodSync(sums, 0o600);
  console.log(archive);
} catch (error) {
  console.error(`govern package: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true });
}
