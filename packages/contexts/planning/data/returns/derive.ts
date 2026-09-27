// SPDX-License-Identifier: MIT
/**
 * Shiller's `ie_data.xls` → the engine's real monthly return series, as
 * canonical CSV text. Pure: bytes in, text out. Used by `fetch.ts` (the
 * operator's command) and by `series.ts#ensureReturnSeries` (fetch-on-first-run).
 *
 * ## The derivation, per month t (the row labelled t covers t−1 → t)
 *
 *     equity_real_t = (P_t + D_t / 12) / P_{t−1} × CPI_{t−1} / CPI_t − 1
 *     bond_real_t   = G_{t−1}                  × CPI_{t−1} / CPI_t − 1
 *     inflation_t   = CPI_t / CPI_{t−1} − 1
 *
 * `P` is the S&P Composite (monthly average of daily closes), `D` the dividend
 * at an annual rate (so a month earns D/12), `CPI` CPI-U spliced to Warren &
 * Pearson before 1913, and `G` Shiller's "Monthly Total Bond Returns" — the
 * gross return over month t−1 → t of a 10-year Treasury bought at GS10, which
 * he tabulates in the row of the month it starts. All three are Shiller's own
 * columns, read by header, not by position.
 *
 * ## The cross-check that makes this more than arithmetic
 *
 * Shiller also publishes "Real Total Return Price" (dividends reinvested, in
 * real terms) and "Real Total Bond Returns" as *index levels*. Each month's
 * ratio of those levels must equal the derived real return; the maximum
 * difference over the whole window is returned, and anything above 1e-9 is
 * refused — a moved column, a changed convention or an off-by-one month would
 * all show up here rather than in a projection.
 *
 * ## The window is pinned
 *
 * `FIRST_MONTH`..`LAST_MONTH` (1871-02..2024-12). Shiller updates the file
 * monthly and the most recent dividends and CPI are estimates he later
 * revises; ending at December 2024 keeps the derived bytes — and therefore
 * the pinned SHA-256 in `SHA256SUMS` — stable across his updates. Moving the
 * window is a deliberate re-pin, reviewed like any data change.
 */
import { readWorkbook, type XlsCell, type XlsSheet } from './xls.ts';

export const SERIES_ID = 'shiller-ie_data/1871-02..2024-12';
export const FIRST_MONTH = '1871-02';
export const LAST_MONTH = '2024-12';
export const CSV_HEADER = 'month,equity_real,bond_real,inflation';
/** Twelve places: 1e-12 on a monthly return is far below anything the engine can resolve. */
export const CSV_PLACES = 12;
/** The cross-check's tolerance against Shiller's own index columns. */
export const CROSS_CHECK_TOLERANCE = 1e-9;

/** The header cells that identify each column, in Shiller's multi-row header (rows 4–7 of `Data`). */
const COLUMNS = {
  date: ['Date'],
  composite: ['S&P', 'Comp.', 'P'],
  dividend: ['Dividend', 'D'],
  cpi: ['Index', 'CPI'],
  realTotalReturnIndex: ['Total', 'Return', 'Price'],
  bondGross: ['Monthly', 'Total', 'Bond', 'Returns'],
  realBondIndex: ['Real', 'Total', 'Bond', 'Returns'],
} as const;

export interface ShillerRow {
  readonly month: string;
  readonly composite: number;
  readonly dividend: number;
  readonly cpi: number;
  readonly realTotalReturnIndex: number;
  readonly bondGross: number;
  readonly realBondIndex: number;
}

export interface DerivedSeries {
  readonly csv: string;
  readonly rows: number;
  readonly firstMonth: string;
  readonly lastMonth: string;
  /** Max |derived − Shiller's index ratio|, per column. */
  readonly equityCrossCheck: number;
  readonly bondCrossCheck: number;
  /** Shiller's own "Date" of the last row in the file, e.g. `2026.09` — what the upstream held when fetched. */
  readonly upstreamLastDate: string;
}

function text(cell: XlsCell | undefined): string {
  return typeof cell === 'string' ? cell.trim() : '';
}

/** Find the column whose header cells (reading down rows 0..headerRow) end with `labels`. */
function columnOf(sheet: XlsSheet, headerRow: number, labels: readonly string[]): number {
  const candidates = new Set<number>();
  for (const [row, line] of sheet.cells) {
    if (row > headerRow) continue;
    for (const col of line.keys()) candidates.add(col);
  }
  for (const col of [...candidates].sort((a, b) => a - b)) {
    const stack: string[] = [];
    for (let row = 0; row <= headerRow; row += 1) {
      const label = text(sheet.cells.get(row)?.get(col));
      if (label !== '') stack.push(label);
    }
    const tail = stack.slice(-labels.length);
    if (tail.length === labels.length && tail.every((label, i) => label === labels[i])) return col;
  }
  throw new Error(`ie_data.xls: no column headed ${labels.join(' / ')} — the layout has changed`);
}

function monthOf(shillerDate: number): string {
  const year = Math.floor(shillerDate);
  const month = Math.round((shillerDate - year) * 100);
  if (month < 1 || month > 12)
    throw new Error(`ie_data.xls: ${String(shillerDate)} is not a Shiller month`);
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

/** The `Data` sheet's rows, keyed by month. */
export function readShillerRows(file: Uint8Array): {
  readonly rows: ShillerRow[];
  readonly upstreamLastDate: string;
} {
  const sheet = readWorkbook(file).find((candidate) => candidate.name === 'Data');
  if (sheet === undefined) throw new Error('ie_data.xls: no Data sheet');
  let headerRow = -1;
  for (const [row, line] of sheet.cells) {
    if (text(line.get(0)) === 'Date' && text(line.get(1)) === 'P') headerRow = row;
  }
  if (headerRow < 0) throw new Error('ie_data.xls: no Date / P header row');
  const at = {
    date: columnOf(sheet, headerRow, COLUMNS.date),
    composite: columnOf(sheet, headerRow, COLUMNS.composite),
    dividend: columnOf(sheet, headerRow, COLUMNS.dividend),
    cpi: columnOf(sheet, headerRow, COLUMNS.cpi),
    realTotalReturnIndex: columnOf(sheet, headerRow, COLUMNS.realTotalReturnIndex),
    bondGross: columnOf(sheet, headerRow, COLUMNS.bondGross),
    realBondIndex: columnOf(sheet, headerRow, COLUMNS.realBondIndex),
  };
  const rows: ShillerRow[] = [];
  let upstreamLastDate = '';
  const numberAt = (line: ReadonlyMap<number, XlsCell>, col: number): number => {
    const cell = line.get(col);
    return typeof cell === 'number' ? cell : Number.NaN;
  };
  for (const row of [...sheet.cells.keys()].sort((a, b) => a - b)) {
    if (row <= headerRow) continue;
    const line = sheet.cells.get(row);
    if (line === undefined) continue;
    const date = line.get(at.date);
    if (typeof date !== 'number') continue;
    upstreamLastDate = date.toFixed(2);
    rows.push({
      month: monthOf(date),
      composite: numberAt(line, at.composite),
      dividend: numberAt(line, at.dividend),
      cpi: numberAt(line, at.cpi),
      realTotalReturnIndex: numberAt(line, at.realTotalReturnIndex),
      bondGross: numberAt(line, at.bondGross),
      realBondIndex: numberAt(line, at.realBondIndex),
    });
  }
  return { rows, upstreamLastDate };
}

/** A return as fixed-point text; the only float → text step, and it is in the derivation, not the engine. */
function fixed(ratio: number): string {
  if (!Number.isFinite(ratio)) throw new Error(`derived a non-finite return: ${String(ratio)}`);
  const out = ratio.toFixed(CSV_PLACES);
  return out === `-${(0).toFixed(CSV_PLACES)}` ? (0).toFixed(CSV_PLACES) : out;
}

export function deriveShillerMonthly(file: Uint8Array): DerivedSeries {
  const { rows, upstreamLastDate } = readShillerRows(file);
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const lines = [CSV_HEADER];
  let equityCrossCheck = 0;
  let bondCrossCheck = 0;
  let [year, month] = FIRST_MONTH.split('-').map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
  ];
  let label = FIRST_MONTH;
  let previous = byMonth.get(
    `${String(month === 1 ? year - 1 : year)}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}`,
  );
  for (;;) {
    const current = byMonth.get(label);
    if (current === undefined || previous === undefined) {
      throw new Error(`ie_data.xls: month ${label} or the month before it is missing`);
    }
    const deflator = previous.cpi / current.cpi;
    const equityReal =
      ((current.composite + current.dividend / 12) / previous.composite) * deflator - 1;
    const bondReal = previous.bondGross * deflator - 1;
    const inflation = current.cpi / previous.cpi - 1;
    for (const [name, ratio] of [
      ['equity', equityReal],
      ['bond', bondReal],
      ['inflation', inflation],
    ] as const) {
      if (!Number.isFinite(ratio)) throw new Error(`ie_data.xls: ${label} has no ${name} return`);
    }
    equityCrossCheck = Math.max(
      equityCrossCheck,
      Math.abs(current.realTotalReturnIndex / previous.realTotalReturnIndex - 1 - equityReal),
    );
    bondCrossCheck = Math.max(
      bondCrossCheck,
      Math.abs(current.realBondIndex / previous.realBondIndex - 1 - bondReal),
    );
    lines.push(`${label},${fixed(equityReal)},${fixed(bondReal)},${fixed(inflation)}`);
    if (label === LAST_MONTH) break;
    previous = current;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
    label = `${String(year)}-${String(month).padStart(2, '0')}`;
  }
  if (equityCrossCheck > CROSS_CHECK_TOLERANCE || bondCrossCheck > CROSS_CHECK_TOLERANCE) {
    throw new Error(
      `ie_data.xls: derived returns disagree with Shiller's own index columns ` +
        `(equity ${String(equityCrossCheck)}, bond ${String(bondCrossCheck)}) — refusing to pin`,
    );
  }
  return {
    csv: `${lines.join('\n')}\n`,
    rows: lines.length - 1,
    firstMonth: FIRST_MONTH,
    lastMonth: LAST_MONTH,
    equityCrossCheck,
    bondCrossCheck,
    upstreamLastDate,
  };
}
