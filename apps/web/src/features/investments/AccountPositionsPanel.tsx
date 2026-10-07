// SPDX-License-Identifier: MIT
import { ArrowLeft, Layers } from 'lucide-react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { ProviderAttribution } from '../market-data/Attribution.tsx';
import type {
  AggregatedHolding,
  Attribution,
  ListAccountHoldingsResponse,
} from '../../api/generated/types.gen.ts';
import { BasisMethodControl } from './BasisMethodControl.tsx';
import { StaleBadge } from './StaleBadge.tsx';
import { UnresolvedSecuritiesNotice } from './UnresolvedSecuritiesNotice.tsx';
import { MoneyOrUnavailable, Unavailable, UnrealizedCell } from './UnavailableValue.tsx';
import { assetClassLabel, exclusionReasonLabel, ratioToNumber } from './labels.ts';
import type { BasisMethodElection } from './api.ts';
import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';

export interface AccountPositionsPanelProps {
  readonly accountName: string;
  readonly data: ListAccountHoldingsResponse | undefined;
  readonly isLoading: boolean;
  /** `securityId -> AggregatedHolding`, for the security *type* the per-account shape does not carry. */
  readonly securityTypeOf: (securityId: string) => AggregatedHolding['securityType'] | undefined;
  readonly election: BasisMethodElection;
  readonly onBack: () => void;
  /**
   * CoinGecko's licence-mandated attribution, rendered when at least one of
   * this account's positions is priced `price.source === 'coingecko'`
   * (`wp3.14-carryovers.md` item 1 — the wire shape carries no `attribution`
   * field, so the obligation is derived per row, scoped to this account).
   */
  readonly coinGeckoAttribution?: Attribution;
}

/**
 * One account's positions, each opened out into its cost-basis lots.
 *
 * The rule this panel exists to honour: **`unavailable` is never `$0.00`**.
 * A lot with no basis has `basis: null` and a `basisSource` saying where the
 * absence comes from; the wire type spells it out ("`null` whenever the
 * status is unavailable. Never a zero standing in for unknown"), and every
 * money cell here goes through `MoneyOrUnavailable` / `UnrealizedCell`, which
 * have no branch that can render a zero for an unknown.
 *
 * `basisSource` is shown per lot rather than per position because that is the
 * granularity at which it varies — a transferred-in lot can be
 * `provider_supplied` beside a `computed` one in the same position, and a
 * single position-level label would be a lie about one of them.
 */
export function AccountPositionsPanel({
  accountName,
  data,
  isLoading,
  securityTypeOf,
  election,
  onBack,
  coinGeckoAttribution,
}: AccountPositionsPanelProps) {
  if (isLoading) return <Skeleton variant="block" height={280} />;
  if (data === undefined) return null;

  const hasCoinGeckoPrice = data.positions.some(
    (position) => position.price?.source === 'coingecko',
  );

  return (
    <section className="flex flex-col gap-4" aria-labelledby="account-holdings-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="account-holdings-heading" className="text-h3 text-text-primary">
            {accountName}
          </h2>
          <p className="text-small text-text-secondary">
            {data.positions.length} position{data.positions.length === 1 ? '' : 's'} ·{' '}
            <Money value={data.total} signDisplay="auto" colorBySign={false} /> · unclassified{' '}
            <Percent value={ratioToNumber(data.unclassifiedPct)} /> · as of {data.asOf}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft size={14} aria-hidden="true" />
          All accounts
        </Button>
      </div>

      {data.positions.length === 0 ? (
        <EmptyState
          icon={Layers}
          headline="No positions in this account"
          description="This account has no holdings on record for the selected valuation basis."
        />
      ) : (
        <ul className="space-y-4">
          {data.positions.map((position) => {
            const label = position.symbol ?? position.name ?? position.securityId;
            return (
              <li
                key={position.holdingId}
                className="rounded-lg border border-border-hairline p-4"
                data-testid={`position-${label}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-small font-medium text-text-primary">
                    {label}
                    <span className="ml-2 font-normal text-text-muted">
                      {position.name ?? ''} · {assetClassLabel(position.assetClass)}
                    </span>
                  </h3>
                  <div className="flex items-center gap-2 text-small">
                    <span className="tabular-nums text-text-secondary">
                      {position.quantity} units
                    </span>
                    {position.price !== null && (
                      <span className="tabular-nums text-text-secondary">
                        @ {position.price.close} {position.price.currency}
                      </span>
                    )}
                    <StaleBadge price={position.price} />
                  </div>
                </div>

                <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-caption">
                  <div className="flex gap-1">
                    <dt className="text-text-muted">Market value:</dt>
                    <dd>
                      <MoneyOrUnavailable value={position.marketValue} reason="price_unknown" />
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-text-muted">Cost basis:</dt>
                    <dd>
                      <MoneyOrUnavailable value={position.costBasis} reason="basis_unknown" />
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-text-muted">Basis source:</dt>
                    <dd>{position.costBasisSource ?? <Unavailable />}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-text-muted">Unrealized:</dt>
                    <dd>
                      <UnrealizedCell unrealized={position.unrealized} />
                    </dd>
                  </div>
                </dl>
                {position.unrealized.warning !== null && (
                  <p className="mt-1 text-caption text-status-warning">
                    {position.unrealized.warning}
                  </p>
                )}

                <ScrollRegion label={`Cost-basis lots for ${label}`}>
                  <table className="mt-3 w-full text-caption" data-testid={`lots-${label}`}>
                    <caption className="sr-only">Cost-basis lots for {label}</caption>
                    <thead>
                      <tr className="border-b border-border-hairline text-left text-text-secondary">
                        <th scope="col" className="py-1 font-medium">
                          Opened
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          Quantity
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          Basis
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          Basis source
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          Holding period
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {position.lots.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-2 text-text-muted">
                            No lots on record for this position.
                          </td>
                        </tr>
                      ) : (
                        position.lots.map((lot) => (
                          <tr
                            key={lot.lotId}
                            className="border-b border-border-hairline last:border-0"
                            data-testid={`lot-${lot.lotId}`}
                          >
                            <th scope="row" className="py-1 text-left font-normal">
                              {lot.openDate}
                            </th>
                            <td className="py-1 text-right tabular-nums">
                              {lot.quantityRemaining}
                            </td>
                            <td className="py-1 text-right" data-testid={`lot-basis-${lot.lotId}`}>
                              <MoneyOrUnavailable value={lot.basis} reason="basis_unknown" />
                            </td>
                            <td className="py-1">{lot.basisSource}</td>
                            <td className="py-1">
                              {lot.longTerm ? 'long term' : 'short term'} · {lot.ageDays} days
                              {lot.basisWarning !== null && (
                                <span className="block text-status-warning">
                                  {lot.basisWarning}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </ScrollRegion>

                <div className="mt-3">
                  <BasisMethodControl
                    accountId={data.accountId}
                    securityId={position.securityId}
                    securityLabel={label}
                    current={position.basisMethod}
                    securityType={securityTypeOf(position.securityId)}
                    election={election}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {data.excluded.length > 0 && (
        <div className="rounded-lg border border-border-hairline p-4">
          <h3 className="text-small font-medium text-text-primary">
            Left out of this account&rsquo;s total ({data.excluded.length})
          </h3>
          <ul className="mt-2 space-y-1 text-small text-text-muted">
            {data.excluded.map((item) => (
              <li key={item.holdingId}>
                {item.symbol ?? item.holdingId} — {exclusionReasonLabel(item.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <UnresolvedSecuritiesNotice unresolved={data.unresolved} />

      {hasCoinGeckoPrice && coinGeckoAttribution !== undefined && (
        <ProviderAttribution attribution={coinGeckoAttribution} />
      )}
    </section>
  );
}
