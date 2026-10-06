// SPDX-License-Identifier: MIT
/**
 * G5-4 (Phase 5 gate, C5-9): the web's hand-kept `CATALOGUE_GAPS` mirror named S1
 * and S5 as "not yet available" long after WP 5.7 released them. The mirror
 * cannot be imported from here (no browser build, and the layer rule forbids a
 * relative path out of this package), so the check reads its source text and
 * compares the id set with the catalogue's.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE, CATALOGUE_GAPS } from '../src/advisors/catalogue.ts';

const MIRROR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/web/src/features/insights/catalogue-gaps.ts',
);

function webGapIds(): string[] {
  const source = readFileSync(MIRROR, 'utf8');
  return [...source.matchAll(/\{\s*id:\s*'([A-Z]+\d+)'\s*,\s*needs:/g)].map(
    (match) => match[1] ?? '',
  );
}

describe("the web advisor screen's 'Not yet available' list", () => {
  it('names exactly the rules the catalogue still cannot run', () => {
    const server = CATALOGUE_GAPS.map((gap) => gap.ruleId).sort();
    expect(webGapIds().sort()).toEqual(server);
  }, 30_000);

  it('names no rule that is registered (S1 and S5 are, since WP 5.7)', () => {
    const registered = new Set(BUILTIN_CATALOGUE.map((entry) => entry.ruleId));
    expect(registered.has('S1')).toBe(true);
    expect(registered.has('S5')).toBe(true);
    expect(webGapIds().filter((id) => registered.has(id))).toEqual([]);
  }, 30_000);
});
