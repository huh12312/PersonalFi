// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { ENGINE_READ_PATHS } from './engine-read-paths.ts';

/**
 * O-5, kept honest against the engine itself: the paths the engine reads are extracted from
 * `engine/boundary.ts` (`market.<node>.<leaf>…` inside `toEnginePlan` and `monteCarloMarketFrom`) and the
 * overridable list from `assumptions.ts`. If the engine starts reading `tips`, or stops reading `crypto`,
 * this fails and the table is the thing that gets corrected.
 */
const SOURCES = import.meta.glob(
  [
    '../../../../../packages/contexts/planning/src/engine/boundary.ts',
    '../../../../../packages/contexts/planning/src/assumptions.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

function text(suffix: string): string {
  const entry = Object.entries(SOURCES).find(([path]) => path.endsWith(suffix));
  if (entry === undefined) throw new Error(`${suffix} not found — the glob is stale`);
  return entry[1];
}

const overridable = [
  ...(
    /OVERRIDABLE_PATHS[^=]*=\s*\[([^\]]+)\]/.exec(text('planning/src/assumptions.ts'))?.[1] ?? ''
  ).matchAll(/'(capitalMarket\.[A-Za-z.]+)'/g),
].map((m) => m[1] as string);

const read = new Set(
  [...text('engine/boundary.ts').matchAll(/market\.([A-Za-z]+)\.([A-Za-z]+)\.value/g)].map(
    (m) => `capitalMarket.${m[1]}.${m[2]}`,
  ),
);

describe('ENGINE_READ_PATHS', () => {
  it('sees the whole overridable list and a real read set', () => {
    expect(overridable).toHaveLength(17);
    expect(read.size).toBeGreaterThanOrEqual(9);
  });

  it('is exactly the overridable paths the engine reads', () => {
    const expected = overridable.filter((path) => read.has(path)).sort();
    expect(Object.keys(ENGINE_READ_PATHS).sort()).toEqual(expected);
  });

  it('leaves out the eight paths nothing reads', () => {
    const unread = overridable.filter((path) => ENGINE_READ_PATHS[path] === undefined);
    expect(unread).toHaveLength(8);
    for (const path of unread) {
      expect(path).toMatch(/intlDevelopedEquity|emergingEquity|tips|cash/);
    }
  });
});
