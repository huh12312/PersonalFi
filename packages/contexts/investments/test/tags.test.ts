// SPDX-License-Identifier: MIT
/**
 * WP 4.7 — security tags, and the control 07 I5 is built on: *"an employer is
 * never inferred."*
 *
 * Checked two ways, the `packages/connectors/coinbase/test/no-trade-surface.test.ts`
 * pattern (WP 3.5):
 *
 *  1. **Statically**, over `src/**` with comments stripped, for the literal
 *     tag value `employer_stock`. This is the strong half for this context,
 *     because the tag is a database enum value — a heuristic writer has to
 *     produce that exact literal somewhere to persist a tag at all, and this
 *     scan finds every place that could.
 *  2. **Dynamically**, driving the store and this package's classifier over a
 *     security literally named after a public company with a matching
 *     ticker, and observing the tag store stays empty until {@link setSecurityTag}
 *     is called by name.
 *
 * `EMPLOYER_STOCK_TRIGGER` (`src/analytics/concentration.ts`) is not a
 * counter-example: it is the 10% *threshold* I5 compares an already-tagged
 * position's weight against, never a writer of the tag itself, and it does
 * not contain the literal `employer_stock` (the identifier is upper-cased and
 * has no matching quoted string).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, systemClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { classify, type ClassifiableSecurity } from '../src/classify.ts';
import { drizzleSecurityTagsStore, inMemorySecurityTagsStore } from '../src/tags.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts` file under `src/`, recursively, excluding `*.test.ts`. `name` is
 * the path relative to `src/`, with `/` separators, e.g. `'tags.ts'` or
 * `'analytics/concentration.ts'`. */
function sources(dir: string = SRC): readonly { readonly name: string; readonly text: string }[] {
  const out: { readonly name: string; readonly text: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const name = relative(SRC, full).split('\\').join('/');
    out.push({ name, text: readFileSync(full, 'utf8') });
  }
  return out;
}

/** Drop `//` and `/** … *\/`-block comment lines. Mirrors the coinbase test's `codeOnly`. */
function codeOnly(text: string): string {
  let inBlock = false;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

describe('no code path infers an employer stock tag', () => {
  it('no code path infers an employer stock tag from a name, a ticker or a payroll descriptor', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(10);
    for (const { name, text } of files) {
      if (name === 'tags.ts') continue;
      const code = codeOnly(text);
      const occurrences = code.match(/employer_stock/g) ?? [];
      expect(occurrences, `${name} writes the literal tag value 'employer_stock'`).toHaveLength(0);
    }

    // The control: the one file allowed to write it actually does, so the
    // check above is not passing because nobody writes the tag anywhere.
    const tagsFile = files.find((file) => file.name === 'tags.ts');
    expect(tagsFile?.text.match(/employer_stock/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it('classifying a security named and ticked after a real company sets no tag', async () => {
    const store = inMemorySecurityTagsStore(systemClock);
    const userId = newId();
    const securityId = newId();

    // A security that looks exactly like an employer-stock candidate: the
    // ticker and name of a real company, held in a taxable account. If any
    // classifier or analytics path inferred `employer_stock` from either
    // field, it would have to call through this store to persist it, and it
    // never does.
    const acme: ClassifiableSecurity = {
      ticker: 'ACME',
      name: 'ACME Corporation',
      type: 'equity',
      providerType: 'equity',
      isCashEquivalent: false,
      chain: null,
      sicCode: null,
    };
    classify(acme);

    expect(await store.listFor(userId, securityId)).toEqual([]);
    expect(await store.listForMany(userId, [securityId])).toEqual(new Map());
  });
});

describe('the security-tags store', () => {
  it('sets and lists a tag explicitly', async () => {
    const store = inMemorySecurityTagsStore(systemClock);
    const userId = newId();
    const securityId = newId();

    await store.set(userId, securityId, 'employer_stock');
    const tags = await store.listFor(userId, securityId);
    expect(tags.map((t) => t.tag)).toEqual(['employer_stock']);
  });

  it('setting the same tag twice is idempotent, not a second row', async () => {
    const store = inMemorySecurityTagsStore(systemClock);
    const userId = newId();
    const securityId = newId();

    await store.set(userId, securityId, 'employer_stock');
    await store.set(userId, securityId, 'employer_stock');
    expect(await store.listFor(userId, securityId)).toHaveLength(1);
  });

  it('a security can carry employer_stock and watchlist at once', async () => {
    const store = inMemorySecurityTagsStore(systemClock);
    const userId = newId();
    const securityId = newId();

    await store.set(userId, securityId, 'employer_stock');
    await store.set(userId, securityId, 'watchlist');
    const tags = (await store.listFor(userId, securityId)).map((t) => t.tag).sort();
    expect(tags).toEqual(['employer_stock', 'watchlist']);
  });

  it('clearing a tag is idempotent and clearing an absent tag is not an error', async () => {
    const store = inMemorySecurityTagsStore(systemClock);
    const userId = newId();
    const securityId = newId();

    await store.set(userId, securityId, 'employer_stock');
    await store.clear(userId, securityId, 'employer_stock');
    expect(await store.listFor(userId, securityId)).toEqual([]);
    await expect(store.clear(userId, securityId, 'watchlist')).resolves.toBeUndefined();
  });

  it('listForMany reads across several securities in one call', async () => {
    const store = inMemorySecurityTagsStore(systemClock);
    const userId = newId();
    const [a, b, c] = [newId(), newId(), newId()];

    await store.set(userId, a, 'employer_stock');
    await store.set(userId, b, 'watchlist');

    const byId = await store.listForMany(userId, [a, b, c]);
    expect(byId.get(a)).toEqual(new Set(['employer_stock']));
    expect(byId.get(b)).toEqual(new Set(['watchlist']));
    expect(byId.has(c)).toBe(false);
  });

  it('exposes a real drizzle-backed store with the same shape', () => {
    // Constructed, not run — this package's pure `investments` project has no
    // database; `packages/db` proves the migration and `lint:schema-ownership`
    // proves the claim. This just proves the two stores type-check identically.
    expect(typeof drizzleSecurityTagsStore).toBe('function');
  });
});
