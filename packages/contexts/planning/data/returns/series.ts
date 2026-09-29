// SPDX-License-Identifier: MIT
/**
 * The historical return series the bootstrap engine resamples — loaded,
 * checksum-verified, parsed. **Not vendored in the repository; fetched on
 * first run** (see `PROVENANCE.md` and the WP 4.5 evidence §6 for why).
 *
 * The committed half is this loader, the derivation (`derive.ts`), the fetch
 * command (`fetch.ts`) and the pinned SHA-256 (`SHA256SUMS`). The derived CSV
 * lives in a cache directory (default `data/returns/cache/`, git-ignored) and
 * is **refused unless its bytes hash to the pinned value** — a stale, edited
 * or truncated cache is a typed error, never a silently different Monte Carlo.
 *
 * `ensureReturnSeries` is the fetch-on-first-run entry point: when the cache is
 * absent and a downloader is supplied, it downloads Shiller's workbook,
 * derives, verifies against the pin, writes the cache and loads it. With no
 * downloader it refuses, naming the command that fills the cache — which is
 * the offline guarantee this design gives up, stated where it is given up.
 */
// eslint-disable-next-line no-restricted-imports -- SHA-256 as a data-file checksum, not cryptography (the config-snapshot precedent)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReturnSeries } from '../../src/engine/bootstrap.ts';
import { CSV_HEADER, SERIES_ID, deriveShillerMonthly } from './derive.ts';

export const SERIES_FILE = 'shiller-monthly.csv';
export const DEFAULT_CACHE_DIR = join(import.meta.dirname, 'cache');
export const CHECKSUM_FILE = join(import.meta.dirname, 'SHA256SUMS');
export const FETCH_COMMAND = 'node packages/contexts/planning/data/returns/fetch.ts';

export type ReturnSeriesRefusalCode =
  | 'planning.returns_series_unavailable'
  | 'planning.returns_series_checksum_mismatch'
  | 'planning.returns_series_malformed';

/** The series cannot be used. `infrastructure` — an operator action, not a user's. */
export class ReturnSeriesRefused extends Error {
  override readonly name = 'ReturnSeriesRefused';
  readonly code: ReturnSeriesRefusalCode;

  constructor(code: ReturnSeriesRefusalCode, detail: string) {
    super(detail);
    this.code = code;
  }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The pinned digest for `SERIES_FILE`, from the committed `SHA256SUMS`. */
export function pinnedSha256(checksumFile = CHECKSUM_FILE): string {
  for (const line of readFileSync(checksumFile, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match?.[2] === SERIES_FILE && match[1] !== undefined) return match[1];
  }
  throw new ReturnSeriesRefused(
    'planning.returns_series_malformed',
    `${checksumFile} pins no ${SERIES_FILE}`,
  );
}

const ROW = /^(\d{4}-\d{2}),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)$/;

/** Parse the canonical CSV. Refuses anything that is not exactly the derived shape. */
export function parseReturnSeries(csv: string, sha256: string, id = SERIES_ID): ReturnSeries {
  const lines = csv.split('\n');
  if (lines[0] !== CSV_HEADER || lines[lines.length - 1] !== '') {
    throw new ReturnSeriesRefused(
      'planning.returns_series_malformed',
      'not a canonical return-series CSV',
    );
  }
  const body = lines.slice(1, -1);
  const equityReal = new Float64Array(body.length);
  const bondReal = new Float64Array(body.length);
  const inflation = new Float64Array(body.length);
  let firstMonth = '';
  body.forEach((line, i) => {
    const match = ROW.exec(line);
    if (match === null) {
      throw new ReturnSeriesRefused(
        'planning.returns_series_malformed',
        `row ${String(i + 2)}: ${line}`,
      );
    }
    if (i === 0) firstMonth = match[1] ?? '';
    equityReal[i] = Number(match[2]);
    bondReal[i] = Number(match[3]);
    inflation[i] = Number(match[4]);
  });
  return { id, sha256, firstMonth, equityReal, bondReal, inflation };
}

/** Load the cached series, verifying its bytes against the pin first. */
export function loadReturnSeries(
  cacheDir = DEFAULT_CACHE_DIR,
  checksumFile = CHECKSUM_FILE,
): ReturnSeries {
  const path = join(cacheDir, SERIES_FILE);
  if (!existsSync(path)) {
    throw new ReturnSeriesRefused(
      'planning.returns_series_unavailable',
      `${path} is absent: the historical return series is fetched, not vendored — run \`${FETCH_COMMAND}\` ` +
        '(network required once), or choose the lognormal engine',
    );
  }
  const bytes = readFileSync(path);
  const actual = sha256Hex(bytes);
  const pinned = pinnedSha256(checksumFile);
  if (actual !== pinned) {
    throw new ReturnSeriesRefused(
      'planning.returns_series_checksum_mismatch',
      `${path} hashes to ${actual}, not the pinned ${pinned}: refusing a series that is not the reviewed one`,
    );
  }
  return parseReturnSeries(bytes.toString('utf8'), actual);
}

export interface EnsureOptions {
  readonly cacheDir?: string;
  readonly checksumFile?: string;
  /**
   * Fetches Shiller's `ie_data.xls` bytes. Injected so the composition root
   * decides whether this process may reach the network at all (and through
   * which egress policy); omitted, a missing cache is a refusal.
   */
  readonly download?: () => Promise<Uint8Array>;
  /**
   * The derivation step, injected for the same reason `download` is: a test
   * proving CK2's fetch-side pin refusal (`returns-fetch-checksum.test.ts`,
   * `docs/evidence/phase-5/wp5.13-carry-overs.md` §1) needs a download that
   * **parses and derives successfully to the wrong bytes**, not one that
   * fails to parse at all — building a real BIFF8 workbook is out of
   * proportion to that one branch. Omitted, the real `deriveShillerMonthly`
   * runs, exactly as production always calls it.
   */
  readonly derive?: (file: Uint8Array) => { readonly csv: string };
}

/** Fetch-on-first-run: load the cache, or fill it from the downloader and verify against the pin. */
export async function ensureReturnSeries(options: EnsureOptions = {}): Promise<ReturnSeries> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const checksumFile = options.checksumFile ?? CHECKSUM_FILE;
  if (existsSync(join(cacheDir, SERIES_FILE)) || options.download === undefined) {
    return loadReturnSeries(cacheDir, checksumFile);
  }
  const derive = options.derive ?? deriveShillerMonthly;
  const derived = derive(await options.download());
  const actual = sha256Hex(derived.csv);
  const pinned = pinnedSha256(checksumFile);
  if (actual !== pinned) {
    throw new ReturnSeriesRefused(
      'planning.returns_series_checksum_mismatch',
      `the upstream workbook now derives to ${actual}, not the pinned ${pinned}; the cache was not written`,
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  const temporary = join(cacheDir, `${SERIES_FILE}.partial`);
  writeFileSync(temporary, derived.csv);
  renameSync(temporary, join(cacheDir, SERIES_FILE));
  return loadReturnSeries(cacheDir, checksumFile);
}
