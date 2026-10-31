// Public entry points and verification comments name the rule, without a first user's brand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { HERE } from './helpers.ts';

test('general-purpose documentation and verification comments keep the rule without a project brand', () => {
  const launcher = readFileSync(resolve(HERE, '../../../bin/govern'), 'utf8');
  assert.doesNotMatch(launcher.match(/# KEYWORDS\n([^]*?)# EXTENSIONS/)?.[1] ?? '', /pals-notes|youtube/);
  for (const file of ['capcheck', 'queue', 'codex']) {
    const source = readFileSync(join(HERE, `../lib/${file}.ts`), 'utf8');
    assert.doesNotMatch(source, /PALS's LAW/);
    assert.match(source, /LLM OUTPUT IS UNVERIFIED BY DEFAULT/);
    assert.match(source, /All LLM output must be treated as untrusted and validated explicitly/);
  }
  assert.doesNotMatch(readFileSync(join(HERE, '../PURPOSE.md'), 'utf8'), /PALS Notes/);
});
