// SPDX-License-Identifier: MIT
import { cn } from '../../lib/cn.ts';
import { ScrollRegion } from '../patterns/ScrollRegion.tsx';
import { Badge } from '../ui/badge.tsx';
import { BlockLabelText } from './BlockLabelText.tsx';
import { BlockLink } from './BlockLink.tsx';
import type { Block } from './schema.ts';

type TableBlock = Extract<Block, { kind: 'table' }>;
type Cell = TableBlock['rows'][number]['cells'][number];

function CellContent({ cell }: { readonly cell: Cell }) {
  const value =
    cell.value === null ? null : <BlockLabelText value={cell.value} className="tabular-nums" />;
  return (
    <>
      {value !== null &&
        (cell.href === undefined ? (
          value
        ) : (
          <BlockLink
            href={cell.href}
            {...(cell.hrefLabel === undefined ? {} : { srLabel: cell.hrefLabel })}
          >
            {value}
          </BlockLink>
        ))}
      {cell.badges !== undefined && cell.badges.length > 0 && (
        <span className="inline-flex flex-wrap justify-end gap-1">
          {cell.badges.map((badge) => (
            <Badge key={badge.label} variant={badge.variant}>
              {badge.label}
            </Badge>
          ))}
        </span>
      )}
      {value === null && (cell.badges === undefined || cell.badges.length === 0) && (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">none</span>
        </>
      )}
    </>
  );
}

/**
 * `table`: a real table — its caption, column headers, the first cell of every row its row header — scrolling in
 * its own region at narrow widths. Money through `Money`, badges through `Badge`, links through `BlockLink` with
 * the cell's extra words for a screen reader. An empty cell is "—", stated, never a zero.
 */
export function TableBlockView({ block }: { readonly block: TableBlock }) {
  return (
    <ScrollRegion label={block.caption}>
      <table className="w-full border-collapse text-small" data-block-table={block.id ?? ''}>
        <caption className="sr-only">{block.caption}</caption>
        <thead>
          <tr className="border-b border-border-hairline text-left text-caption text-text-muted">
            {block.columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'py-2 pr-2 last:pr-0',
                  column.align === 'end' || (column.align === undefined && index > 0)
                    ? 'text-right'
                    : 'text-left',
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.key} className="border-b border-border-hairline last:border-0">
              {row.cells.map((cell, index) => {
                const align = block.columns[index]?.align;
                const end = align === 'end' || (align === undefined && index > 0);
                const className = cn('py-2 pr-2 last:pr-0', end ? 'text-right' : 'text-left');
                return index === 0 ? (
                  <th
                    key={block.columns[index]?.key ?? String(index)}
                    scope="row"
                    className={cn(className, 'font-medium text-text-primary')}
                  >
                    <CellContent cell={cell} />
                  </th>
                ) : (
                  <td
                    key={block.columns[index]?.key ?? String(index)}
                    className={cn(className, 'tabular-nums')}
                  >
                    <CellContent cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
