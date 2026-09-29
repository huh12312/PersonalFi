// SPDX-License-Identifier: MIT
/**
 * C-1 (G4-1) / gate-security-review.md §2.1 **CK2**: "the return series is
 * refused unless it hashes to the pin (fetch side)" was sabotaged green with
 * no test — `series.ts#ensureReturnSeries`'s post-derive `actual !== pinned`
 * refusal never went red because the sabotage harness's own "bad download" is
 * one `deriveShillerMonthly` fails to *parse* (`src/engine/reproducible.test.ts`
 * line ~244's `new Uint8Array(512)`), never one that parses and derives
 * successfully to bytes that simply hash to something other than the pin. The
 * load-side pin (CK1, same test file) is proven; the fetch side's own check —
 * "the upstream workbook now derives to X, not the pinned Y" — was not.
 *
 * Building a real BIFF8/OLE2 `ie_data.xls` fixture only to prove this one
 * `if (actual !== pinned)` branch is out of proportion to what the branch
 * does, so `series.ts`'s `EnsureOptions.derive` (added by this WP, injected
 * for exactly the reason `download` already is) stands in for
 * `deriveShillerMonthly`: the download step still runs and its bytes still
 * reach the derivation step, but the derivation itself is a stub that always
 * succeeds — proving the checksum check is reached and *does* refuse, and
 * that nothing lands on disk when it does, which is the property WP 4.5 §6
 * ("a bad download → nothing cached") names.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SERIES_FILE,
  ensureReturnSeries,
  pinnedSha256,
  sha256Hex,
} from '../data/returns/series.ts';

describe('CK2 — the fetch-side pin refusal, on a download that parses (carry-c1)', () => {
  it('a download that derives successfully to the wrong bytes is refused, and nothing is cached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-returns-fetch-'));
    try {
      const cache = join(root, 'cache');
      const sums = join(root, 'SHA256SUMS');
      // A checksum file pinning something this "derivation" will never produce.
      writeFileSync(sums, `${'0'.repeat(64)}  ${SERIES_FILE}\n`);
      expect(pinnedSha256(sums)).toBe('0'.repeat(64));

      const wrongCsv =
        'month,equity_real,bond_real,inflation\n1871-02,0.010000000000,0.000000000000,0.000000000000\n';
      let derivedFrom: Uint8Array | undefined;

      await expect(
        ensureReturnSeries({
          cacheDir: cache,
          checksumFile: sums,
          // A "download" that succeeds and produces bytes distinguishable
          // from garbage — the parse step is not what refuses here.
          download: () =>
            Promise.resolve(new TextEncoder().encode('a workbook the derivation accepts')),
          // Stands in for `deriveShillerMonthly`: parses without throwing,
          // derives to `wrongCsv`, whose hash is not the pin above.
          derive: (file) => {
            derivedFrom = file;
            return { csv: wrongCsv };
          },
        }),
      ).rejects.toMatchObject({
        code: 'planning.returns_series_checksum_mismatch',
        message: expect.stringContaining(sha256Hex(wrongCsv)) as unknown,
      });

      expect(derivedFrom).toBeDefined();
      // The property WP 4.5 §6 names: a bad download caches nothing.
      expect(existsSync(join(cache, SERIES_FILE))).toBe(false);
      expect(existsSync(join(cache, `${SERIES_FILE}.partial`))).toBe(false);
      expect(existsSync(cache)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
