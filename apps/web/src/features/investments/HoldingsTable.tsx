// SPDX-License-Identifier: MIT
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { ProviderAttribution } from '../market-data/Attribution.tsx';
import type {
  AggregatedHolding,
  Attribution,
  ListAccountHoldingsResponse,
  UnresolvedSecurity,
} from '../../api/generated/types.gen.ts';
import { StaleBadge } from './StaleBadge.tsx';
import { UnresolvedHoldingRows } from './UnresolvedSecuritiesNotice.tsx';
import { MoneyOrUnavailable, UnrealizedCell } from './UnavailableValue.tsx';
import { assetClassLabel, ratioToNumber, securityTypeLabel } from './labels.ts';
import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';

type AccountPosition = ListAccountHoldingsResponse['positions'][number];

export interface HoldingsTableProps {
  readonly holdings: readonly AggregatedHolding[];
  /**
   * WP 10.4: `GET /holdings`'s `unresolved` - positions whose security nobody could identify. Each is a named
   * row under the identified ones (its own name and ticker, quantity, the institution's figure), so an
   * account whose every position is unidentified still shows its positions instead of "No holdings yet".
   */
  readonly unresolved?: readonly UnresolvedSecurity[];
  /** `accountId -> GET /accounts/{id}/holdings`, for the per-account expansion. */
  readonly accountHoldings: ReadonlyMap<string, ListAccountHoldingsResponse>;
  readonly accountNameOf: (accountId: string) => string;
  readonly onOpenAccount: (accountId: string) => void;
  /**
   * CoinGecko's licence-mandated attribution (`useCoinGeckoAttribution`,
   * `features/market-data/api.ts`). `GET /holdings` carries no `attribution`
   * field of its own — `wp3.9-routes.md` confirms the wire shape stops at
   * `price.source` — so this table derives the obligation itself from
   * `price.source === 'coingecko'` on each row and renders the block once,
   * below the table, only when at least one row needs it
   * (`wp3.14-carryovers.md` item 1).
   */
  readonly coinGeckoAttribution?: Attribution;
}

interface AccountRow {
  readonly accountId: string;
  readonly position: AccountPosition;
}

/**
 * Holdings aggregated by ticker across accounts, each row expandable into the
 * accounts that hold it.
 *
 * Every figure is a field: `quantity`, `marketValue`, `costBasis`,
 * `unrealized`, `weight`, `price.close` and `stale` all come from
 * `GET /holdings` exactly as the server computed them. Nothing here
 * multiplies a quantity by a price, and nothing sums a column — the total
 * lives in the header above this table and is the server's `total`.
 *
 * The expander is a real `<button>` with `aria-expanded`, and each expanded
 * group is a `<tr>` inside the same table so the row relationship survives
 * for a screen reader.
 */
export function HoldingsTable({
  holdings,
  unresolved = [],
  accountHoldings,
  accountNameOf,
  onOpenAccount,
  coinGeckoAttribution,
}: HoldingsTableProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (holdings.length === 0 && unresolved.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        headline="No holdings yet"
        description="Connect a brokerage or crypto exchange and its positions will appear here, aggregated by ticker across every account."
      />
    );
  }

  const hasCoinGeckoPrice = holdings.some((holding) => holding.price?.source === 'coingecko');

  function accountRowsFor(securityId: string): AccountRow[] {
    const rows: AccountRow[] = [];
    for (const [accountId, response] of accountHoldings) {
      for (const position of response.positions) {
        if (position.securityId === securityId) rows.push({ accountId, position });
      }
    }
    return rows;
  }

  function toggle(securityId: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(securityId)) next.delete(securityId);
      else next.add(securityId);
      return next;
    });
  }

  return (
    <>
      <ScrollRegion label="Holdings by security">
        <table className="w-full text-small" data-testid="holdings-table">
          <caption className="sr-only">
            Holdings aggregated by security across every account. Expand a row to see the accounts
            that hold it. Positions that could not be identified are listed last, with the
            institution&apos;s own figure, and are not in any total.
          </caption>
          <thead>
            <tr className="border-b border-border-hairline text-left text-text-secondary">
              <th scope="col" className="py-2 font-medium">
                Security
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Quantity
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Price
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Market value
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Cost basis
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Unrealized
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Weight
              </th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => {
              const isOpen = expanded.has(holding.securityId);
              const rows = accountRowsFor(holding.securityId);
              return [
                <tr
                  key={holding.securityId}
                  className="border-b border-border-hairline"
                  data-testid={`holding-row-${holding.symbol ?? holding.securityId}`}
                >
                  <th scope="row" className="py-2 text-left font-normal">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-left"
                      aria-expanded={isOpen}
                      onClick={() => toggle(holding.securityId)}
                    >
                      {isOpen ? (
                        <ChevronDown size={14} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={14} aria-hidden="true" />
                      )}
                      <span className="font-medium text-text-primary">
                        {holding.symbol ?? holding.name ?? holding.securityId}
                      </span>
                      <span className="sr-only">
                        , {holding.accountCount} account(s); expand to list them
                      </span>
                    </button>
                    <span className="ml-5 block text-caption text-text-muted">
                      {holding.name ?? securityTypeLabel(holding.securityType)} ·{' '}
                      {assetClassLabel(holding.assetClass)} · {holding.accountCount} account
                      {holding.accountCount === 1 ? '' : 's'}
                    </span>
                  </th>
                  <td className="py-2 text-right tabular-nums">{holding.quantity}</td>
                  <td className="py-2 text-right">
                    {holding.price === null ? (
                      <span className="text-text-muted italic">unavailable</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="tabular-nums">
                          {holding.price.close} {holding.price.currency}
                        </span>
                        <StaleBadge price={holding.price} />
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <MoneyOrUnavailable value={holding.marketValue} reason="price_unknown" />
                  </td>
                  <td className="py-2 text-right">
                    <MoneyOrUnavailable value={holding.costBasis} reason="basis_unknown" />
                  </td>
                  <td className="py-2 text-right">
                    <UnrealizedCell unrealized={holding.unrealized} />
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {holding.weight === null ? (
                      <span className="text-text-muted italic">unavailable</span>
                    ) : (
                      <Percent value={ratioToNumber(holding.weight)} />
                    )}
                  </td>
                </tr>,
                isOpen && (
                  <tr
                    key={`${holding.securityId}-accounts`}
                    className="border-b border-border-hairline bg-bg-subtle"
                    data-testid={`holding-accounts-${holding.symbol ?? holding.securityId}`}
                  >
                    <td colSpan={7} className="px-3 py-2">
                      {rows.length === 0 ? (
                        <p className="text-caption text-text-muted">
                          Per-account detail is still loading for this security.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {rows.map(({ accountId, position }) => (
                            <li
                              key={position.holdingId}
                              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption"
                            >
                              <button
                                type="button"
                                // `text-text-primary`, not `text-accent-text`:
                                // `--accent-text` on `--bg-subtle` measures 4.33:1
                                // in dark mode, which axe fails at this size.
                                // The underline carries "this is a link" without
                                // relying on the accent hue at all. `min-h-6`: a
                                // 24 px target (WCAG 2.5.8), which the 16 px line
                                // box alone was not (WP 10.3 found it red in axe).
                                className="inline-flex min-h-6 items-center text-text-primary underline underline-offset-2"
                                onClick={() => onOpenAccount(accountId)}
                              >
                                {accountNameOf(accountId)}
                              </button>
                              <span className="tabular-nums text-text-secondary">
                                {position.quantity} units
                              </span>
                              <span className="tabular-nums">
                                <MoneyOrUnavailable
                                  value={position.marketValue}
                                  reason="price_unknown"
                                />
                              </span>
                              <span className="text-text-muted">
                                basis:{' '}
                                <MoneyOrUnavailable
                                  value={position.costBasis}
                                  reason="basis_unknown"
                                />
                                {position.costBasisSource !== null &&
                                  ` (${position.costBasisSource})`}
                              </span>
                              <StaleBadge price={position.price} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
            <UnresolvedHoldingRows unresolved={unresolved} accountNameOf={accountNameOf} />
          </tbody>
        </table>
      </ScrollRegion>
      {hasCoinGeckoPrice && coinGeckoAttribution !== undefined && (
        <ProviderAttribution attribution={coinGeckoAttribution} className="mt-3" />
      )}
    </>
  );
}
