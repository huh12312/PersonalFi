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
 * ## The CoinGecko logo (WP 4.12c, C-15; G3-8)
 *
 * `public/icons/coingecko-symbol.png` is CoinGecko's own gecko mark,
 * self-hosted — served from this origin, so `img-src 'self'` (already the
 * policy, `docker/Caddyfile`) covers it with **no CSP change**, refuting the
 * reason a generic glyph was used instead (`gate-security-review.md` G3-8:
 * "justified by a CSP reason that does not apply to a self-hosted asset").
 * Sourced from CoinGecko's own published brand microsite
 * (`brand.coingecko.com`'s "Symbol" page — the icon-only mark, not the full
 * wordmark or lockup) and cropped from that page's auto-generated cover
 * image down to the circular mark itself, then alpha-masked to the same
 * circle so it composites cleanly against any background — no colour,
 * proportion, or content change from the source. The brand site's own
 * downloadable "Brand Kit" zip is the pristine original of the same asset,
 * gated behind an interactive JS download flow this host could not
 * complete; the crop is the closest reachable equivalent, not a redraw.
 * Every other provider keeps the generic `Coins` glyph unless it publishes
 * its own attribution asset the same way.
 */
export function ProviderAttribution({ attribution, className }: ProviderAttributionProps) {
  if (!attribution.required) return null;

  const logo = !attribution.logoRequired ? null : attribution.provider === 'coingecko' ? (
    <img src="/icons/coingecko-symbol.png" alt="" width={14} height={14} className="rounded-full" />
  ) : (
    <Coins size={14} aria-hidden="true" />
  );

  const content = (
    <span className="inline-flex items-center gap-1.5">
      {logo}
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
