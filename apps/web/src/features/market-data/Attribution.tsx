// SPDX-License-Identifier: MIT
import { Coins } from 'lucide-react';

import type { Attribution } from '../../api/generated/types.gen.ts';

export interface ProviderAttributionProps {
  attribution: Attribution;
  className?: string;
}

/**
 * A provider's licence-mandated attribution — exact text, a logo when the
 * licence requires one, and a hyperlink — rendered verbatim, never
 * paraphrased. `docs/evidence/phase-3/wp3.4-market-data.md` §4: "a paraphrase
 * of a licence condition is a new licence condition"; the API already
 * carries the exact strings (`ATTRIBUTIONS` in `@ctx/integrations`), so this
 * component's only job is to put `attribution.text` on screen unmodified.
 *
 * **Exported for WP 3.11 to use** on `features/investments/**` (holdings and
 * allocation can show a CoinGecko-priced crypto position) — this work
 * package owns `features/market-data/**` but not investments, and cannot
 * edit those files itself; importing this component is how that screen gets
 * the same attribution without a second implementation.
 *
 * Renders nothing when the licence requires no badge (Tiingo, OpenFIGI,
 * yfinance) — callers don't need to check `attribution.required` themselves
 * before rendering this.
 *
 * The logo is a generic, monochrome coin glyph (`lucide-react`'s `Coins`,
 * already a dependency), not CoinGecko's actual trademarked mark: this
 * deployment has no licence to redistribute that asset, and fetching it from
 * CoinGecko's own host would need a new `img-src` CSP entry — D26 says no
 * new directive, so that trade was never available. Recorded here rather
 * than silently approximated as "the real logo."
 */
export function ProviderAttribution({ attribution, className }: ProviderAttributionProps) {
  if (!attribution.required) return null;

  const content = (
    <span className="inline-flex items-center gap-1.5">
      {attribution.logoRequired && <Coins size={14} aria-hidden="true" />}
      <span>{attribution.text}</span>
    </span>
  );

  return (
    <p className={className} data-testid={`attribution-${attribution.provider}`}>
      {attribution.linkUrl !== null ? (
        <a
          href={attribution.linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-text-secondary underline-offset-4 hover:underline"
        >
          {content}
        </a>
      ) : (
        <span className="text-text-secondary">{content}</span>
      )}
    </p>
  );
}
