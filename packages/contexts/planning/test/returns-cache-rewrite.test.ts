// SPDX-License-Identifier: MIT
/**
 * C-1 (G4-1(c)) / `docs/evidence/phase-4/gate-security-review.md` §3.5, §6
 * row **C-1**: "a successful fetch is picked up without a restart (re-read on
 * a miss, or a documented restart step)."
 *
 * `loadReturnSeries` is what `createMonteCarloRunnerFromCache`
 * (`apps/api/src/domain.ts`) calls on every one of its own calls — it caches
 * nothing itself, so the property C-1(c)'s exit test needs ("starts empty,
 * drops the series in, and sees the next call succeed") is provable directly
 * against it, with a throwaway `checksumFile` (`loadReturnSeries`'s own
 * second, already-optional parameter — no change to any production file was
 * needed to write this suite) standing in for the committed pin so a
 * synthetic series (WP 4.5's own fixture, never the real, git-ignored,
 * licence-restricted Shiller download) can match it.
 *
 * `apps/api/test/carry-c1-monte-carlo-retry.test.ts` covers the half this
 * file cannot: `createMonteCarloRunnerFromCache`'s own wrapping (the `null`
 * return and the exact log line) against the miss case, where no throwaway
 * pin is available because that function always checks the committed one.
 * Together the two suites cover both functions the fix touches.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syntheticCsv } from './engine/fixtures/synthetic-series.ts';
import {
  SERIES_FILE,
  loadReturnSeries,
  sha256Hex,
  ReturnSeriesRefused,
} from '../data/returns/series.ts';

describe('loadReturnSeries: starts empty, the series is dropped in, the next call succeeds (carry-c1)', () => {
  it('a cache miss refuses by name; writing the pinned bytes makes the very next call succeed', () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-carry-c1-cache-rewrite-'));
    const cacheDir = join(root, 'cache');
    const checksumFile = join(root, 'SHA256SUMS');
    const csv = syntheticCsv();
    writeFileSync(checksumFile, `${sha256Hex(csv)}  ${SERIES_FILE}\n`);

    try {
      // --- starts empty: no directory, no file ---------------------------
      expect(existsSync(cacheDir)).toBe(false);
      let firstError: unknown;
      try {
        loadReturnSeries(cacheDir, checksumFile);
      } catch (error) {
        firstError = error;
      }
      expect(firstError).toBeInstanceOf(ReturnSeriesRefused);
      expect((firstError as ReturnSeriesRefused).code).toBe('planning.returns_series_unavailable');

      // --- the series is dropped in (the operator's documented fetch) ----
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, SERIES_FILE), csv);

      // --- the next call succeeds — no restart, no second process --------
      const series = loadReturnSeries(cacheDir, checksumFile);
      expect(series.sha256).toBe(sha256Hex(csv));
      expect(series.equityReal.length).toBeGreaterThan(0);

      // Calling again, now that the file is there, is stable (not a
      // one-shot fluke of ordering).
      const again = loadReturnSeries(cacheDir, checksumFile);
      expect(again.sha256).toBe(series.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a miss is retried on the next call, not remembered as a permanent refusal', () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-carry-c1-cache-rewrite-retry-'));
    const cacheDir = join(root, 'cache');
    const checksumFile = join(root, 'SHA256SUMS');
    const csv = syntheticCsv();
    writeFileSync(checksumFile, `${sha256Hex(csv)}  ${SERIES_FILE}\n`);

    try {
      expect(() => loadReturnSeries(cacheDir, checksumFile)).toThrow(ReturnSeriesRefused);
      expect(() => loadReturnSeries(cacheDir, checksumFile)).toThrow(ReturnSeriesRefused);

      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, SERIES_FILE), csv);
      expect(() => loadReturnSeries(cacheDir, checksumFile)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
