// SPDX-License-Identifier: MIT
import { Clock } from 'lucide-react';

import { Badge } from '../../components/ui/badge.tsx';
import type { PriceQuote } from '../../api/generated/types.gen.ts';

export interface StaleBadgeProps {
  /** The quote whose `staleness` field decides this — never a client-side age calculation. */
  price: PriceQuote | null;
}

/**
 * `STALE`, rendered whenever `PriceQuote.staleness === 'STALE'`.
 *
 * The badge is a **word plus a glyph**, never a colour: 05
 * §2.2's "always ship with a Lucide glyph and a text label", and the reason
 * WP 3.11's brief says staleness must be *visibly labeled*. The observation
 * date sits in the accessible name so a screen reader hears *why* it is
 * stale rather than only that it is, and `title` gives the same to a
 * sighted pointer user.
 *
 * `staleness` is a field on the wire, not an inference (`routes/investments.ts`
 * header: "`unclassifiedPct` and `stale` are fields, never inferences"), so
 * nothing here compares dates.
 */
export function StaleBadge({ price }: StaleBadgeProps) {
  if (price === null || price.staleness !== 'STALE') return null;
  const observed = `Price last observed ${price.priceDate}`;
  return (
    <Badge
      variant="serious"
      icon={<Clock size={12} aria-hidden="true" />}
      title={observed}
      data-testid="stale-badge"
    >
      STALE
      <span className="sr-only"> — {observed}</span>
    </Badge>
  );
}
