// SPDX-License-Identifier: MIT
import { BLOCK_FIXTURES, BLOCK_KINDS } from '@core/kernel';
import { describe, expect, it } from 'vitest';

import { blockSchema, parseBlock } from './schema.ts';

/**
 * WP 10.15: the web's block schema against the kernel's fixture corpus — the same corpus the API's contract test runs
 * (`apps/api/test/blocks-contract.test.ts`), so the two sides cannot disagree on what a block is.
 */
describe('the web block schema', () => {
  it('accepts every valid fixture, one of every kind', () => {
    const kinds = new Set(BLOCK_FIXTURES.valid.map((block) => block.kind));
    expect([...kinds].sort()).toEqual([...BLOCK_KINDS].sort());
    for (const block of BLOCK_FIXTURES.valid) {
      const result = blockSchema.safeParse(block);
      expect(result.success, `${block.kind}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it.each(BLOCK_FIXTURES.invalid.map((entry) => [entry.why, entry.block] as const))(
    'refuses %s',
    (_why, block) => {
      expect(blockSchema.safeParse(block).success).toBe(false);
    },
  );

  it('parseBlock sorts an unknown kind as unsupported and a broken known kind as invalid', () => {
    expect(parseBlock({ kind: 'merchants-list' })).toMatchObject({
      ok: false,
      kind: 'merchants-list',
      reason: 'unsupported',
    });
    expect(parseBlock({ nope: true })).toMatchObject({
      ok: false,
      kind: null,
      reason: 'unsupported',
    });
    expect(
      parseBlock({
        kind: 'pie',
        currency: null,
        slices: [{ label: 'A', value: '1', hue: '#ff0000' }],
      }),
    ).toMatchObject({ ok: false, kind: 'pie', reason: 'invalid' });
    expect(parseBlock({ kind: 'divider' })).toEqual({ ok: true, block: { kind: 'divider' } });
  });
});
