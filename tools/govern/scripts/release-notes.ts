// Extract a version's Keep a Changelog section; release publication requires nonempty notes.
import { readFileSync } from 'node:fs';

export function releaseNotes(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## [${version}] - `));
  if (start === -1) throw new Error(`CHANGELOG section missing for version ${version}`);
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex(line => line.startsWith('## '));
  const notes = remaining.slice(0, end === -1 ? undefined : end).join('\n').trim();
  if (!notes) throw new Error(`CHANGELOG section empty for version ${version}`);
  return notes + '\n';
}

if (import.meta.main) {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
