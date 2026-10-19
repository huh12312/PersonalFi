// SPDX-License-Identifier: MIT
import type { BlockLabel } from '../../api/generated/types.gen.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import { Money } from '../finance/Money.tsx';

/**
 * A block label: words as they are, money through `Money` (the one formatter; a block never carries a pre-formatted
 * amount). Tabular figures either way, so a column of labels lines up.
 */
export function BlockLabelText({
  value,
  className,
}: {
  readonly value: BlockLabel;
  readonly className?: string;
}) {
  if (typeof value === 'string') {
    return <span className={className ?? 'tabular-nums'}>{value}</span>;
  }
  return (
    <Money
      value={{ minor: value.amountMinor, currency: value.currency }}
      signDisplay="auto"
      colorBySign={false}
      className={className ?? 'tabular-nums'}
    />
  );
}

/** A label as plain words, for an `aria-label` or a sentence. */
export function blockLabelWords(value: BlockLabel): string {
  return typeof value === 'string' ? value : moneyWords(value.amountMinor, value.currency);
}

export function moneyWords(minor: string, currency: string): string {
  return formatMoney(parseWireMoney({ minor, currency }), { signDisplay: 'auto' });
}
