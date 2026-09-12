// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';
import { formatMoney, formatMoneyForScreenReader, parseWireMoney, signOf } from '../../lib/money.ts';
import type { WireMoney } from '../../lib/money.ts';
import { useHideAmounts } from '../../lib/privacy.ts';

export interface MoneyProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** The wire shape — `{ minor: "1234", currency: "USD" }` (docs/CONVENTIONS.md "Money"). */
  value: WireMoney;
  /** `'exceptZero'` (default, always shows `+`/`−`) or `'auto'` (negative only, e.g. a total row). */
  signDisplay?: 'exceptZero' | 'auto' | 'never';
  /** Axis ticks / hero-adjacent labels only ($12.4K) — never a table cell or transaction row (§2.7). */
  compact?: boolean;
  /** Colour by sign using the CVD-safe teal/vermilion pair. Off for neutral contexts (a plain total). */
  colorBySign?: boolean;
  /** Participates in the global "hide amounts" privacy blur (default true). */
  sensitive?: boolean;
}

/**
 * The one place `Money` gets formatted (05-frontend-architecture.md §2.7).
 *
 * Privacy mode deliberately does *not* use `aria-hidden`: a screen reader
 * reading the real amount aloud while it's visually blurred is exactly the
 * shoulder-surfing scenario privacy mode defends against. Instead, while
 * hidden, the accessible name is "Amount hidden" and the element becomes
 * focusable so the real value is announced only on the same
 * focus/hover that un-blurs it visually — the accessible and visual reveal
 * triggers are the same DOM events, on purpose.
 */
export function Money({
  value,
  signDisplay = 'exceptZero',
  compact = false,
  colorBySign = true,
  sensitive = true,
  className,
  ...props
}: MoneyProps) {
  const [hideAmounts] = useHideAmounts();
  const [revealed, setRevealed] = useState(false);

  const money = parseWireMoney(value);
  const sign = signOf(money);
  const formatted = formatMoney(money, { signDisplay, compact });
  const spokenForm = formatMoneyForScreenReader(money);
  const isHidden = sensitive && hideAmounts && !revealed;

  return (
    <span
      className={cn(
        'tabular-nums',
        sensitive && 'money-sensitive',
        colorBySign && sign === 'positive' && 'text-money-pos-text',
        colorBySign && sign === 'negative' && 'text-money-neg-text',
        colorBySign && sign === 'zero' && 'text-money-neutral',
        className,
      )}
      tabIndex={isHidden ? 0 : undefined}
      onFocus={() => setRevealed(true)}
      onBlur={() => setRevealed(false)}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={() => setRevealed(false)}
      {...props}
    >
      <span aria-hidden="true">{formatted}</span>
      <span className="sr-only">{isHidden ? 'Amount hidden' : spokenForm}</span>
    </span>
  );
}
