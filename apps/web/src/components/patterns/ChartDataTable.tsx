// SPDX-License-Identifier: MIT
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';
import { ScrollRegion } from './ScrollRegion.tsx';

export interface ChartDataTableProps {
  /** What the table holds, as a phrase: "Net worth over time". It names the table and the disclosure. */
  readonly caption: string;
  readonly columns: readonly string[];
  /** One entry per row; the first cell is the row's header (a date, a month, a source). */
  readonly rows: readonly (readonly ReactNode[])[];
  readonly className?: string;
}

/**
 * The data behind a chart, as a table (09 §5.6: every chart has a data-table equivalent, and colour is never the
 * only signal; WCAG 1.1.1, 1.4.1, 1.3.1). A chart is a picture of numbers: its tooltip needs a pointer, its colours
 * need sight, its drill-through needs a click. This is the same figures for everyone else — closed by default so the
 * screen is as it was, one disclosure button away from a table a screen reader walks cell by cell and a keyboard
 * user scrolls (the region is a tab stop, `ScrollRegion`).
 */
export function ChartDataTable({ caption, columns, rows, className }: ChartDataTableProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-6 items-center text-caption text-accent-text underline-offset-4 hover:underline"
      >
        {open ? 'Hide table' : 'View as table'}
        <span className="sr-only"> — {caption}</span>
      </button>
      <div id={panelId}>
        {open && (
          <ScrollRegion label={caption} className="mt-2 max-h-80 overflow-y-auto">
            <table className="w-full text-caption">
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th
                      key={column}
                      scope="col"
                      className={cn(
                        'px-2 py-1 font-medium',
                        index === 0 ? 'text-left' : 'text-right',
                      )}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((cells, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-border-hairline">
                    {cells.map((cell, cellIndex) =>
                      cellIndex === 0 ? (
                        <th key={cellIndex} scope="row" className="px-2 py-1 text-left font-normal">
                          {cell}
                        </th>
                      ) : (
                        <td key={cellIndex} className="px-2 py-1 text-right tabular-nums">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </div>
    </div>
  );
}
