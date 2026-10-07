// SPDX-License-Identifier: MIT
/**
 * The docs drift check's own suite (WP 9.12 exit tests).
 *
 * Fixtures first: a doc that names a recipe, a variable or a secret the tree
 * lacks must be seen to fail, and only then is the real tree run through the
 * check — where README.md, RUNBOOK.md and docs/RELEASE-NOTES.md must pass.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDoc, checkTree, loadFacts, memoryFs, runSelfTest, type Facts } from './check-docs.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

const FACTS: Facts = {
  recipes: new Set(['up', 'backup', 'upgrade']),
  envExample: new Set(['PUBLIC_HOST', 'BIND_ADDRESS']),
  schemaKeys: new Set(['PUBLIC_HOST', 'BIND_ADDRESS', 'WORKER_CONCURRENCY']),
  operatorTokens: new Set(['FORCE_RESTORE', 'PUBLIC_HOST', 'BIND_ADDRESS']),
  composeSecrets: new Set(['database_url', 'master_key', 'age_recipient']),
};
const FS = memoryFs({ 'docs/there.md': '# There\n\n## A section\n', 'README.md': '# R\n' });

function kinds(text: string): string[] {
  return checkDoc('README.md', text, FACTS, FS).problems.map((p) => p.kind);
}

describe('check-docs, against fixtures', () => {
  it('a recipe, variable or secret the docs name but the tree lacks fails the check', () => {
    expect(kinds('Run `just no-such-recipe` now.\n')).toEqual(['recipe']);
    expect(kinds('Set `NO_SUCH_VARIABLE=1` in `.env`.\n')).toEqual(['env']);
    expect(kinds('Write it to `secrets/no_such_secret`.\n')).toEqual(['secret']);
    const all = kinds(
      [
        '```bash',
        'just no-such-recipe',
        'NO_SUCH_VARIABLE=1 just up',
        '```',
        '`secrets/nope`',
      ].join('\n'),
    );
    expect(all.sort()).toEqual(['env', 'recipe', 'secret']);
  });

  it('a doc naming only things the tree has passes', () => {
    const text = [
      'Run `just up`, then:',
      '',
      '```bash',
      'PUBLIC_HOST=example.lan just upgrade',
      'FORCE_RESTORE=1 just backup',
      '```',
      '',
      'The file is `secrets/master_key` and `/run/secrets/database_url`.',
      'See [there](docs/there.md#a-section).',
    ].join('\n');
    expect(checkDoc('README.md', text, FACTS, FS).problems).toEqual([]);
  });

  it('a variable the schema reads but .env.example never documents fails', () => {
    expect(kinds('Tune `WORKER_CONCURRENCY=8`.\n')).toEqual(['env']);
  });

  it('an unclosed code fence fails', () => {
    expect(kinds('```bash\njust up\n')).toContain('fence');
  });

  it('a fence closed by a line with trailing text fails, even when a later fence balances the count', () => {
    const text = ['````', 'one', '``` It needs the stack up', 'two', '````'].join('\n');
    expect(kinds(text)).toContain('fence');
  });

  it('a relative link to a file that does not exist fails; one that resolves passes', () => {
    expect(kinds('See [x](docs/missing.md).\n')).toEqual(['link']);
    expect(kinds('See [x](docs/there.md).\n')).toEqual([]);
    expect(kinds('See [x](docs/there.md#no-such-heading).\n')).toEqual(['link']);
    expect(kinds('See [x](https://example.com/a) and [mail](mailto:a@b.c).\n')).toEqual([]);
  });

  it('a path in code that does not exist fails', () => {
    expect(kinds('Read `docs/never-written.md`.\n')).toEqual(['path']);
    expect(kinds('Read `scripts/also-never-written.sh`.\n')).toEqual(['path']);
  });

  it('prose that merely uses the word "just" is not a recipe reference', () => {
    expect(kinds('Just wait; it is just a moment, just before the restart.\n')).toEqual([]);
  });

  it('the checker runs its own fixtures (--self-test)', () => {
    const result = runSelfTest();
    expect(result.failures).toEqual([]);
  });
});

describe('check-docs, against the real tree', () => {
  it('a doc that names a recipe the justfile lacks fails against the real facts', () => {
    const facts = loadFacts(REPO_ROOT);
    const result = checkDoc(
      'README.md',
      'Run `just definitely-not-a-recipe` and set `NOT_A_REAL_VARIABLE=1`; see `secrets/not_declared`.\n',
      facts,
      memoryFs({}),
    );
    expect(result.problems.map((p) => p.kind).sort()).toEqual(['env', 'recipe', 'secret']);
  }, 60_000);

  it('the real justfile, .env.example, schema and compose.yml are read (not an empty tree)', () => {
    const facts = loadFacts(REPO_ROOT);
    expect(facts.recipes.has('upgrade')).toBe(true); // an imported recipe
    expect(facts.recipes.has('restore-drill')).toBe(true);
    expect(facts.envExample.has('PUBLIC_HOST')).toBe(true);
    expect(facts.schemaKeys.has('TRUST_PROXY')).toBe(true);
    expect(facts.composeSecrets.has('master_key')).toBe(true);
    expect(facts.operatorTokens.has('FORCE_RESTORE')).toBe(true);
  }, 60_000);

  it('removing a recipe the README and RUNBOOK rely on makes the real docs fail', () => {
    const facts = loadFacts(REPO_ROOT);
    const without: Facts = {
      ...facts,
      recipes: new Set([...facts.recipes].filter((r) => r !== 'backup')),
    };
    const sabotaged = checkTree(REPO_ROOT, without);
    expect(
      sabotaged.problems.some((p) => p.kind === 'recipe' && p.message.includes('backup')),
    ).toBe(true);
  }, 60_000);

  it('the real tree passes: README.md, RUNBOOK.md and docs/RELEASE-NOTES.md say nothing the tree contradicts', () => {
    const result = checkTree(REPO_ROOT);
    expect(result.problems.map((p) => `${p.file}:${p.line}: ${p.kind}: ${p.message}`)).toEqual([]);
    expect(result.docs).toEqual(['README.md', 'RUNBOOK.md', 'docs/RELEASE-NOTES.md']);
    expect(result.counts.recipes).toBeGreaterThan(10);
  }, 60_000);
});
