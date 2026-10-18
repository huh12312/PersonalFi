// SPDX-License-Identifier: MIT
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { useRefreshPrices, type PriceRefresh } from './refresh-api.ts';

/**
 * **Refresh prices** (WP 10.5): fetches prices for everything held, now, rather than at the nightly run. The
 * api accepts it once every ten minutes per holder; a second press inside that says when to try again.
 *
 * Disabled and `aria-busy` while it runs. A disabled button that had focus drops it to the document body, so
 * focus is put back on the button when the run ends (2.4.3).
 */
export function RefreshPricesButton({ refresh }: { readonly refresh: PriceRefresh }) {
  const ref = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !refresh.pending) {
      const active = document.activeElement;
      if (active === null || active === document.body) ref.current?.focus();
    }
    wasPending.current = refresh.pending;
  }, [refresh.pending]);

  return (
    <Button
      ref={ref}
      type="button"
      variant="secondary"
      disabled={refresh.pending}
      aria-busy={refresh.pending}
      onClick={refresh.run}
    >
      <RefreshCw size={16} aria-hidden="true" className={refresh.pending ? 'animate-spin' : ''} />
      {refresh.pending ? 'Refreshing prices…' : 'Refresh prices'}
    </Button>
  );
}

/**
 * What the refresh did, in words, in a polite live region that is always in the page (a region that appears
 * together with its text is not reliably announced), and below it a disclosure naming each unpriced holding.
 * The disclosure sits outside the live region so opening it is not announced as news.
 */
export function RefreshPricesResult({
  refresh,
  className,
}: {
  readonly refresh: PriceRefresh;
  readonly className?: string;
}) {
  const { outcome } = refresh;
  let words = '';
  if (outcome.kind === 'pending') words = 'Refreshing prices…';
  else if (outcome.kind === 'done') words = outcome.description.text;
  else if (outcome.kind === 'too_soon') words = outcome.text;

  return (
    <div className={className} data-testid="refresh-prices-result">
      <p role="status" aria-live="polite" className="text-small text-text-secondary">
        {words}
      </p>
      {outcome.kind === 'error' && (
        <p role="alert" className="text-small text-status-danger-text">
          {outcome.text}
        </p>
      )}
      {outcome.kind === 'done' && outcome.description.unpriced.length > 0 && (
        <details className="mt-1 text-caption text-text-secondary">
          <summary className="inline-flex min-h-6 cursor-pointer items-center underline underline-offset-2">
            Which holdings were not priced ({outcome.description.unpriced.length})
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {outcome.description.unpriced.map((line) => (
              <li key={line.securityId}>
                <span className="font-medium text-text-primary">{line.label}</span>: {line.words}
                {line.detail !== null && <> — {line.detail}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The button with its result under it, for a place with room (Settings). */
export function RefreshPrices({ className }: { readonly className?: string }) {
  const refresh = useRefreshPrices();
  return (
    <div className={`flex flex-col items-start gap-2 ${className ?? ''}`}>
      <RefreshPricesButton refresh={refresh} />
      <RefreshPricesResult refresh={refresh} />
    </div>
  );
}
