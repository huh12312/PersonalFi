// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';
import { Label } from '../../components/ui/label.tsx';
import { ProviderAttribution } from '../market-data/Attribution.tsx';
import type {
  Attribution,
  GetPerformanceByManagementResponse,
  GetPerformanceResponse,
  PeriodSummary,
  TimeWeightedReturn,
} from '../../api/generated/types.gen.ts';
import { MoneyOrUnavailable, Unavailable } from './UnavailableValue.tsx';
import { managementLabel, ratioToNumber } from './labels.ts';
import type { PerformanceScopeKind } from './search.ts';

export interface PerformancePanelProps {
  /** The scoped answer: the whole portfolio, or one account. */
  readonly data: GetPerformanceResponse | undefined;
  readonly isLoading: boolean;
  /** WP 10.3. */
  readonly scope?: PerformanceScopeKind;
  readonly scopeAccount?: string | undefined;
  readonly onScopeChange?: (scope: PerformanceScopeKind, accountId?: string) => void;
  readonly accounts?: readonly { readonly id: string; readonly name: string }[];
  readonly byManagement?: GetPerformanceByManagementResponse | undefined;
  readonly byManagementLoading?: boolean;
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

const SCOPE_OPTIONS: readonly { value: PerformanceScopeKind; label: string }[] = [
  { value: 'portfolio', label: 'Whole portfolio' },
  { value: 'management', label: 'By management' },
  { value: 'account', label: 'One account' },
];

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
 * WP 10.3 adds three things, under the same rule:
 *
 *   * **The health snapshot** — the period's dollars (value, net
 *     contributions, dividends and interest, fees, gain) in one block that
 *     holds no rate, and the TWR with its annualization status in a
 *     *separate* block beside it.
 *   * **The scope selector** — whole portfolio, by management, one account.
 *   * **The by-management comparison** — three tables, never one: the TWRs
 *     side by side (the one metric 07 §4.2 allows to be compared), the MWRs
 *     apart (each class's own rate, not comparable), and the dollars apart.
 *     No row of any table carries a rate and a dollar figure together.
 */
export function PerformancePanel({
  data,
  isLoading,
  scope = 'portfolio',
  scopeAccount,
  onScopeChange,
  accounts = [],
  byManagement,
  byManagementLoading = false,
  hasCoinGeckoCryptoHolding = false,
  coinGeckoAttribution,
}: PerformancePanelProps) {
  if (isLoading) return <Skeleton variant="block" height={200} />;
  if (data === undefined) return null;

  const scopeLabel =
    scope === 'account'
      ? (accounts.find((account) => account.id === scopeAccount)?.name ?? 'One account')
      : 'Whole portfolio';

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

      <HealthSnapshot
        summary={data.summary}
        timeWeighted={data.timeWeighted}
        scopeLabel={scopeLabel}
      />

      {onScopeChange !== undefined && (
        <ScopeSelector
          scope={scope}
          scopeAccount={scopeAccount}
          accounts={accounts}
          onScopeChange={onScopeChange}
        />
      )}

      {scope === 'management' ? (
        byManagementLoading ? (
          <Skeleton variant="block" height={200} />
        ) : (
          <ManagementComparison data={byManagement} />
        )
      ) : (
        <ScopedPerformance data={data} />
      )}

      {hasCoinGeckoCryptoHolding && coinGeckoAttribution !== undefined && (
        <ProviderAttribution attribution={coinGeckoAttribution} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The health snapshot
// ---------------------------------------------------------------------------

function HealthSnapshot({
  summary,
  timeWeighted,
  scopeLabel,
}: {
  summary: PeriodSummary;
  timeWeighted: TimeWeightedReturn;
  scopeLabel: string;
}) {
  const zero = (value: { minor: string }) => value.minor === '0';
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]" data-testid="health-snapshot">
      {/* Dollars only. No rate appears in this block (07 §4.2). */}
      <section
        aria-labelledby="health-dollars-heading"
        className="rounded-lg border border-border-hairline p-4"
        data-testid="health-dollars"
      >
        <h3 id="health-dollars-heading" className="text-small font-medium text-text-secondary">
          Health snapshot · {scopeLabel}
        </h3>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-3">
          <SnapshotFigure label={`Value on ${summary.to}`}>
            <Money value={summary.closingValue} signDisplay="auto" colorBySign={false} />
          </SnapshotFigure>
          <SnapshotFigure label="Net contributions">
            <Money value={summary.netContributions} signDisplay="exceptZero" colorBySign={false} />
          </SnapshotFigure>
          <SnapshotFigure label="Dividends and interest">
            <Money value={summary.dividendsAndInterest} signDisplay="auto" colorBySign={false} />
          </SnapshotFigure>
          <SnapshotFigure label="Fees paid">
            <Money value={summary.feesPaid} signDisplay="auto" colorBySign={false} />
          </SnapshotFigure>
          <SnapshotFigure label="Gain over the period">
            <Money value={summary.periodGain} signDisplay="exceptZero" />
          </SnapshotFigure>
          {!zero(summary.reinvestedDividends) && (
            <SnapshotFigure label="Reinvested dividends">
              <Money value={summary.reinvestedDividends} signDisplay="auto" colorBySign={false} />
            </SnapshotFigure>
          )}
          {!zero(summary.taxesWithheld) && (
            <SnapshotFigure label="Taxes withheld">
              <Money value={summary.taxesWithheld} signDisplay="auto" colorBySign={false} />
            </SnapshotFigure>
          )}
        </dl>
        <p className="mt-2 text-caption text-text-muted">
          Gain over the period is the change in value that did not come from your own contributions
          or withdrawals.
        </p>
        <Exclusions summary={summary} />
      </section>

      {/* The rate, in its own block — never beside a dollar figure. */}
      <section
        aria-labelledby="health-twr-heading"
        className="rounded-lg border border-border-hairline p-4"
        data-testid="health-twr"
      >
        <h3 id="health-twr-heading" className="text-small font-medium text-text-secondary">
          Time-weighted return
        </h3>
        <p className="mt-1 text-h2 tabular-nums text-text-primary">
          <Percent value={ratioToNumber(timeWeighted.periodReturn)} signDisplay="exceptZero" />
        </p>
        <p className="mt-1 text-caption text-text-muted" data-testid="health-twr-annualized">
          {timeWeighted.annualized === null ? (
            <>Not annualized: {timeWeighted.annualizationWithheld ?? 'withheld'}</>
          ) : (
            <>
              Annualized{' '}
              <Percent value={ratioToNumber(timeWeighted.annualized)} signDisplay="exceptZero" />
            </>
          )}
          {timeWeighted.approximate ? ' · approximate (modified Dietz)' : ''}
        </p>
      </section>
    </div>
  );
}

function SnapshotFigure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-h3 tabular-nums text-text-primary">{children}</dd>
    </div>
  );
}

/** Everything left out of the figures, by name. A missing value is not a zero (O-2). */
function Exclusions({ summary }: { summary: PeriodSummary }) {
  if (summary.complete) return null;
  const { unpricedSecurities, foreignCurrencyMovements, unvaluedTransfers, unclassifiedMovements } =
    summary.exclusions;
  return (
    <ul
      className="mt-2 space-y-0.5 text-caption text-status-warning"
      data-testid="health-exclusions"
    >
      {unpricedSecurities.length > 0 && (
        <li>
          Left out, no price:{' '}
          {unpricedSecurities
            .map((security) => security.symbol ?? security.name ?? security.securityId)
            .join(', ')}
          .
        </li>
      )}
      {foreignCurrencyMovements.length > 0 && (
        <li>
          {foreignCurrencyMovements.length} movement(s) in another currency left out (no rate was
          read).
        </li>
      )}
      {unvaluedTransfers.length > 0 && (
        <li>
          {unvaluedTransfers.length} transfer(s) could not be valued and were not counted as zero.
        </li>
      )}
      {unclassifiedMovements.length > 0 && (
        <li>
          {unclassifiedMovements.length} cash movement(s) could not be classified as a contribution
          or as income, and were left out.
        </li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The scope selector
// ---------------------------------------------------------------------------

function ScopeSelector({
  scope,
  scopeAccount,
  accounts,
  onScopeChange,
}: {
  scope: PerformanceScopeKind;
  scopeAccount: string | undefined;
  accounts: readonly { readonly id: string; readonly name: string }[];
  onScopeChange: (scope: PerformanceScopeKind, accountId?: string) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-end gap-4" data-testid="performance-scope">
      <legend className="mb-2 text-small font-medium text-text-secondary">Measure</legend>
      <div className="flex flex-wrap gap-3">
        {SCOPE_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-1.5 text-small">
            <input
              type="radio"
              name="performance-scope"
              value={option.value}
              checked={scope === option.value}
              disabled={option.value === 'account' && accounts.length === 0}
              onChange={() =>
                onScopeChange(
                  option.value,
                  option.value === 'account' ? (scopeAccount ?? accounts[0]?.id) : undefined,
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
      {scope === 'account' && accounts.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="performance-account">Account</Label>
          <select
            id="performance-account"
            className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary"
            value={scopeAccount ?? accounts[0]?.id ?? ''}
            onChange={(event) => onScopeChange('account', event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// One scope: the rates, then the dollar gain (unchanged from WP 3.11)
// ---------------------------------------------------------------------------

function ScopedPerformance({ data }: { data: GetPerformanceResponse }) {
  const { timeWeighted, moneyWeighted, dollarGain } = data;
  return (
    <>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// By management: three tables, never one
// ---------------------------------------------------------------------------

function ManagementComparison({ data }: { data: GetPerformanceByManagementResponse | undefined }) {
  if (data === undefined) return null;
  if (data.rows.length === 0) {
    return (
      <p className="text-small text-text-secondary">
        No investment accounts to compare yet. Classify an account as advisor, robo-advisor or
        self-directed on its account page.
      </p>
    );
  }
  const head = 'border-b border-border-hairline text-left text-text-secondary';
  return (
    <div className="flex flex-col gap-6" data-testid="management-comparison">
      <section aria-labelledby="management-twr-heading">
        <h3 id="management-twr-heading" className="text-small font-medium text-text-primary">
          Time-weighted return by who manages it
        </h3>
        <p className="text-caption text-text-muted">
          The one rate you can compare across rows: it removes the effect of when you added or took
          out money.
        </p>
        <ScrollRegion label="Time-weighted return by who manages it">
          <table className="mt-2 w-full text-small" data-testid="management-twr-table">
            <caption className="sr-only">
              Time-weighted return for each management class over {data.from} to {data.to}.
            </caption>
            <thead>
              <tr className={head}>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Managed by
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Accounts
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  TWR
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Annualized
                </th>
                <th scope="col" className="py-2 font-medium">
                  Method
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.management} className="border-b border-border-hairline">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {managementLabel(row.management)}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.accountIds.length}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <Percent
                      value={ratioToNumber(row.timeWeighted.periodReturn)}
                      signDisplay="exceptZero"
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {row.timeWeighted.annualized === null ? (
                      <span className="text-text-muted">
                        {row.timeWeighted.annualizationWithheld ?? 'withheld'}
                      </span>
                    ) : (
                      <Percent
                        value={ratioToNumber(row.timeWeighted.annualized)}
                        signDisplay="exceptZero"
                      />
                    )}
                  </td>
                  <td className="py-2 text-text-secondary">
                    {row.timeWeighted.method === 'sub_period_linking'
                      ? 'sub-period linking'
                      : 'modified Dietz (approximate)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="management-mwr-heading">
        <h3 id="management-mwr-heading" className="text-small font-medium text-text-primary">
          Money-weighted return
        </h3>
        <p className="text-caption text-text-muted">
          Each class&rsquo;s own rate, including when money went in. Not comparable across rows or
          to a benchmark.
        </p>
        <ScrollRegion label="Money-weighted return by who manages it">
          <table className="mt-2 w-full text-small" data-testid="management-mwr-table">
            <caption className="sr-only">Money-weighted return for each management class.</caption>
            <thead>
              <tr className={head}>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Managed by
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  MWR
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Annualized
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.management} className="border-b border-border-hairline">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {managementLabel(row.management)}
                  </th>
                  {row.moneyWeighted.status === 'unavailable' ? (
                    <td colSpan={2} className="py-2 text-right">
                      <Unavailable reason={row.moneyWeighted.reason} />
                    </td>
                  ) : (
                    <>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <Percent
                          value={ratioToNumber(row.moneyWeighted.periodReturn)}
                          signDisplay="exceptZero"
                        />
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {row.moneyWeighted.annualized === null ? (
                          <span className="text-text-muted">
                            {row.moneyWeighted.annualizationWithheld ?? 'withheld'}
                          </span>
                        ) : (
                          <Percent
                            value={ratioToNumber(row.moneyWeighted.annualized)}
                            signDisplay="exceptZero"
                          />
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="management-dollars-heading">
        <h3 id="management-dollars-heading" className="text-small font-medium text-text-primary">
          In dollars
        </h3>
        <ScrollRegion label="Dollars by who manages it">
          <table className="mt-2 w-full text-small" data-testid="management-dollars-table">
            <caption className="sr-only">
              Value, contributions, income, fees and gain for each management class.
            </caption>
            <thead>
              <tr className={head}>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Managed by
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Value on {data.to}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Net contributions
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Dividends and interest
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Fees paid
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Gain over the period
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Unrealized gain
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.management} className="border-b border-border-hairline">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {managementLabel(row.management)}
                    {!row.summary.complete && (
                      <span className="block text-caption text-status-warning">
                        incomplete — see exclusions
                      </span>
                    )}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <Money
                      value={row.summary.closingValue}
                      signDisplay="auto"
                      colorBySign={false}
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <Money
                      value={row.summary.netContributions}
                      signDisplay="exceptZero"
                      colorBySign={false}
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <Money
                      value={row.summary.dividendsAndInterest}
                      signDisplay="auto"
                      colorBySign={false}
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <Money value={row.summary.feesPaid} signDisplay="auto" colorBySign={false} />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <Money value={row.summary.periodGain} signDisplay="exceptZero" />
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.dollarGain.status === 'available' ? (
                      <Money value={row.dollarGain.gain} signDisplay="exceptZero" />
                    ) : (
                      <Unavailable reason={row.dollarGain.reason} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>
    </div>
  );
}
