// SPDX-License-Identifier: MIT
import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { ProviderAttribution } from '../market-data/Attribution.tsx';
import type { Attribution, GetPerformanceResponse } from '../../api/generated/types.gen.ts';
import { MoneyOrUnavailable, Unavailable } from './UnavailableValue.tsx';
import { ratioToNumber } from './labels.ts';

export interface PerformancePanelProps {
  readonly data: GetPerformanceResponse | undefined;
  readonly isLoading: boolean;
  /**
   * Whether the portfolio holds at least one CoinGecko-priced crypto
   * position. `GET /investments/performance` returns only aggregate TWR/MWR/
   * dollar-gain figures with no per-security `source` (`wp3.9-routes.md`), so
   * this is derived once, from `GET /holdings`, by the parent screen — those
   * aggregates are computed over the same priced positions, so the
   * obligation travels with them (`wp3.14-carryovers.md` item 1).
   */
  readonly hasCoinGeckoCryptoHolding?: boolean;
  readonly coinGeckoAttribution?: Attribution;
}

/**
 * Performance.
 *
 * 07 §4.2, quoted in `wp3.9-routes.md` §3: *"Never put a TWR next to a dollar
 * gain, and never benchmark an MWR. That's the whole rule."* The API enforces
 * it on the wire with `?: never` members; this screen enforces the visual
 * half. The two **rate** answers sit together in one labelled group, each
 * naming its own method and whether it is benchmark-comparable; the **dollar
 * gain** is a separate `<section>` below a rule, with its own heading and its
 * own market-value/cost-basis pair. There is no layout in this file in which
 * a percentage return and a dollar gain share a row.
 *
 * Each figure is labeled with what it actually is — "Time-weighted return
 * (TWR)" and "Money-weighted return (MWR)" — rather than an unqualified
 * "Return", because the whole point of showing both is that they answer
 * different questions.
 */
export function PerformancePanel({
  data,
  isLoading,
  hasCoinGeckoCryptoHolding = false,
  coinGeckoAttribution,
}: PerformancePanelProps) {
  if (isLoading) return <Skeleton variant="block" height={200} />;
  if (data === undefined) return null;

  const { timeWeighted, moneyWeighted, dollarGain } = data;

  return (
    <section aria-labelledby="performance-heading" className="flex flex-col gap-5">
      <div>
        <h2 id="performance-heading" className="text-h3 text-text-primary">
          Performance
        </h2>
        <p className="text-small text-text-secondary">
          {data.from} to {data.to} · {data.currency}
        </p>
      </div>

      {/* Rate-of-return answers. No dollar amount appears in this group. */}
      <div
        className="grid gap-4 sm:grid-cols-2"
        role="group"
        aria-label="Rate of return"
        data-testid="performance-rates"
      >
        <article className="rounded-lg border border-border-hairline p-4" data-testid="twr-block">
          <h3 className="text-small font-medium text-text-secondary">Time-weighted return (TWR)</h3>
          <p className="mt-1 text-h2 tabular-nums text-text-primary" data-testid="twr-value">
            <Percent value={ratioToNumber(timeWeighted.periodReturn)} signDisplay="exceptZero" />
          </p>
          <dl className="mt-2 space-y-0.5 text-caption text-text-muted">
            <div className="flex gap-1">
              <dt>Annualized:</dt>
              <dd>
                {timeWeighted.annualized === null ? (
                  (timeWeighted.annualizationWithheld ?? 'withheld')
                ) : (
                  <Percent
                    value={ratioToNumber(timeWeighted.annualized)}
                    signDisplay="exceptZero"
                  />
                )}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Method:</dt>
              <dd>
                {timeWeighted.method === 'sub_period_linking'
                  ? 'sub-period linking'
                  : 'modified Dietz'}
                {timeWeighted.approximate ? ' (approximate)' : ''}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Span:</dt>
              <dd>{timeWeighted.spanDays} days</dd>
            </div>
          </dl>
          <p className="mt-2 text-caption text-text-muted">
            Strips out the effect of your deposits and withdrawals — comparable to a benchmark.
          </p>
          {timeWeighted.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-caption text-status-warning">
              {timeWeighted.warnings.map((warning) => (
                <li key={warning.code}>{warning.detail}</li>
              ))}
            </ul>
          )}
        </article>

        <article className="rounded-lg border border-border-hairline p-4" data-testid="mwr-block">
          <h3 className="text-small font-medium text-text-secondary">
            Money-weighted return (MWR)
          </h3>
          {moneyWeighted.status === 'unavailable' ? (
            <p className="mt-1 text-h3" data-testid="mwr-value">
              <Unavailable reason={moneyWeighted.reason} />
            </p>
          ) : (
            <>
              <p className="mt-1 text-h2 tabular-nums text-text-primary" data-testid="mwr-value">
                <Percent
                  value={ratioToNumber(moneyWeighted.periodReturn)}
                  signDisplay="exceptZero"
                />
              </p>
              <dl className="mt-2 space-y-0.5 text-caption text-text-muted">
                <div className="flex gap-1">
                  <dt>Annualized:</dt>
                  <dd>
                    {moneyWeighted.annualized === null ? (
                      (moneyWeighted.annualizationWithheld ?? 'withheld')
                    ) : (
                      <Percent
                        value={ratioToNumber(moneyWeighted.annualized)}
                        signDisplay="exceptZero"
                      />
                    )}
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt>Solver:</dt>
                  <dd>{moneyWeighted.solver}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>Span:</dt>
                  <dd>{moneyWeighted.spanDays} days</dd>
                </div>
              </dl>
            </>
          )}
          <p className="mt-2 text-caption text-text-muted">
            Your personal rate of return, including when you put money in. Not comparable to a
            benchmark.
          </p>
        </article>
      </div>

      <hr className="border-border-hairline" />

      {/* Dollar gain — its own section, deliberately not in the grid above. */}
      <section
        aria-labelledby="dollar-gain-heading"
        className="rounded-lg border border-border-hairline p-4"
        data-testid="dollar-gain-block"
      >
        <h3 id="dollar-gain-heading" className="text-small font-medium text-text-secondary">
          Unrealized dollar gain
        </h3>
        {dollarGain.status === 'unavailable' ? (
          <>
            <p className="mt-1 text-h3" data-testid="dollar-gain-value">
              <Unavailable reason={dollarGain.reason} />
            </p>
            <p className="mt-1 text-caption text-text-muted">{dollarGain.warning}</p>
            <p className="mt-1 text-caption text-text-muted">
              Market value:{' '}
              <MoneyOrUnavailable value={dollarGain.marketValue} reason={dollarGain.reason} />
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-h2 tabular-nums" data-testid="dollar-gain-value">
              <Money value={dollarGain.gain} signDisplay="exceptZero" />
            </p>
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-caption text-text-muted">
              <div className="flex gap-1">
                <dt>Market value:</dt>
                <dd>
                  <Money value={dollarGain.marketValue} signDisplay="auto" colorBySign={false} />
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>Cost basis:</dt>
                <dd>
                  <Money value={dollarGain.costBasis} signDisplay="auto" colorBySign={false} />
                </dd>
              </div>
            </dl>
          </>
        )}
        <p className="mt-2 text-caption text-text-muted">
          Measured over today&rsquo;s positions, not replayed as of {data.from} — the lot ledger
          holds lots, not dated basis snapshots.
        </p>
      </section>

      {data.unvaluedTransfers > 0 && (
        <p className="text-small text-status-warning" data-testid="unvalued-transfers">
          {data.unvaluedTransfers} transfer(s) in this window could not be valued and were not
          counted as zero flows.
        </p>
      )}

      {hasCoinGeckoCryptoHolding && coinGeckoAttribution !== undefined && (
        <ProviderAttribution attribution={coinGeckoAttribution} />
      )}
    </section>
  );
}
