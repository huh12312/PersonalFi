#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Fetch Shiller's `ie_data.xls`, derive the real monthly return series, verify
 * it against the pinned SHA-256 and write it to the cache the Monte Carlo
 * reads (`series.ts`).
 *
 *     node packages/contexts/planning/data/returns/fetch.ts                   # download, derive, verify, cache
 *     node packages/contexts/planning/data/returns/fetch.ts --from ie_data.xls   # derive from a local copy
 *     node packages/contexts/planning/data/returns/fetch.ts --cache-dir /var/lib/personalfi/returns
 *     node packages/contexts/planning/data/returns/fetch.ts --pin             # re-pin SHA256SUMS (a reviewed change)
 *     node packages/contexts/planning/data/returns/fetch.ts --damodaran histretSP.xls  # print the annual cross-check
 *
 * The workbook's URL is discovered from https://shillerdata.com/ (it is a
 * versioned blob URL that changes with every monthly update), falling back to
 * the last URL seen. The raw file's own SHA-256 is printed but **not** pinned:
 * Shiller re-uploads monthly, and the pin is over the derived, window-bounded
 * CSV instead (`derive.ts`, "The window is pinned").
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deriveShillerMonthly, LAST_MONTH, FIRST_MONTH } from './derive.ts';
import { CHECKSUM_FILE, DEFAULT_CACHE_DIR, SERIES_FILE, parseReturnSeries, pinnedSha256, sha256Hex } from './series.ts';
import { readWorkbook } from './xls.ts';

const LANDING_PAGE = 'https://shillerdata.com/';
const LAST_SEEN_URL =
  'https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/downloads/70fec4f5-727f-4e53-b5f1-179af109c5fa/ie_data.xls?ver=1788371540009';

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function download(): Promise<{ readonly bytes: Uint8Array; readonly url: string; readonly lastModified: string }> {
  let url = LAST_SEEN_URL;
  try {
    const page = await (await fetch(LANDING_PAGE)).text();
    const found = /href="([^"]*ie_data\.xls[^"]*)"/.exec(page)?.[1];
    if (found !== undefined) url = found.startsWith('//') ? `https:${found}` : found;
  } catch {
    // The landing page is a convenience; the last-seen URL is tried next.
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} → ${String(response.status)}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    url,
    lastModified: response.headers.get('last-modified') ?? 'unknown',
  };
}

/** Calendar-year compounding of the derived monthly real equity return, against Damodaran's annual real S&P 500. */
function damodaranCrossCheck(csv: string, histret: Uint8Array): void {
  const series = parseReturnSeries(csv, sha256Hex(csv));
  const annual = new Map<number, number>();
  const firstYear = Number.parseInt(series.firstMonth.slice(0, 4), 10);
  const firstMonthIndex = Number.parseInt(series.firstMonth.slice(5, 7), 10) - 1;
  for (let i = 0; i < series.equityReal.length; i += 1) {
    const year = firstYear + Math.floor((firstMonthIndex + i) / 12);
    annual.set(year, (annual.get(year) ?? 1) * (1 + (series.equityReal[i] ?? 0)));
  }
  const sheet = readWorkbook(histret).find((candidate) => candidate.name === 'Returns by year');
  if (sheet === undefined) throw new Error('histretSP.xls: no "Returns by year" sheet');
  const rows: [number, number, number][] = [];
  for (const line of sheet.cells.values()) {
    const year = line.get(0);
    const real = line.get(21); // "Annual Real Returns" → "S&P 500 (includes dividends)"
    if (typeof year === 'number' && typeof real === 'number' && year >= 1928) {
      const shiller = annual.get(year);
      if (shiller !== undefined && year <= Number.parseInt(LAST_MONTH.slice(0, 4), 10)) {
        rows.push([year, shiller - 1, real]);
      }
    }
  }
  let sumAbs = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [, x, y] of rows) {
    sumAbs += Math.abs(x - y);
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const n = rows.length;
  const correlation = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  console.log(
    `damodaran cross-check: ${String(n)} calendar years 1928..${LAST_MONTH.slice(0, 4)}, ` +
      `mean |Shiller − Damodaran| real S&P = ${(sumAbs / n).toFixed(4)}, correlation = ${correlation.toFixed(4)}, ` +
      `mean Shiller = ${(sx / n).toFixed(4)}, mean Damodaran = ${(sy / n).toFixed(4)}`,
  );
}

async function main(): Promise<void> {
  const from = argument('--from');
  const cacheDir = argument('--cache-dir') ?? DEFAULT_CACHE_DIR;
  const pin = process.argv.includes('--pin');
  let source: { readonly bytes: Uint8Array; readonly url: string; readonly lastModified: string };
  if (from === undefined) {
    source = await download();
  } else {
    source = { bytes: new Uint8Array(readFileSync(from)), url: from, lastModified: 'local file' };
  }
  const derived = deriveShillerMonthly(source.bytes);
  const digest = sha256Hex(derived.csv);
  console.log(`source:              ${source.url}`);
  console.log(`source last-modified: ${source.lastModified}`);
  console.log(`source sha256:       ${sha256Hex(source.bytes)} (${String(source.bytes.length)} bytes; not pinned)`);
  console.log(`upstream last row:   ${derived.upstreamLastDate}`);
  console.log(`window:              ${FIRST_MONTH}..${LAST_MONTH}, ${String(derived.rows)} months`);
  console.log(`cross-check vs Shiller's index columns: equity ${String(derived.equityCrossCheck)}, bond ${String(derived.bondCrossCheck)}`);
  console.log(`derived sha256:      ${digest}`);

  if (pin) {
    writeFileSync(CHECKSUM_FILE, `${digest}  ${SERIES_FILE}\n`);
    console.log(`pinned in ${CHECKSUM_FILE}`);
  } else {
    const pinned = pinnedSha256();
    if (digest !== pinned) {
      console.error(`REFUSED: the derived series hashes to ${digest}, the pin is ${pinned}. Review, then --pin.`);
      process.exitCode = 1;
      return;
    }
    console.log('matches the pin');
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, SERIES_FILE), derived.csv);
  console.log(`wrote ${join(cacheDir, SERIES_FILE)}`);

  const damodaran = argument('--damodaran');
  if (damodaran !== undefined) damodaranCrossCheck(derived.csv, new Uint8Array(readFileSync(damodaran)));
}

await main();
