// SPDX-License-Identifier: MIT
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import type { SnapshotFxFailure } from '../../api/generated/types.gen.ts';
import { NetWorthAreaChart } from '../../charts/NetWorthAreaChart.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { UnvaluedAccountsNotice } from '../accounts/UnvaluedAccountsNotice.tsx';
import { useNetWorthSeriesQuery, useSetManualFxRateMutation } from './api.ts';
import { groupByCurrency, interpolatedCount, missingCount, type RawSeriesPoint } from './series.ts';
import {
  DEFAULT_NET_WORTH_RANGE,
  NET_WORTH_RANGES,
  NET_WORTH_RANGE_LABELS,
  type NetWorthRange,
} from './search.ts';

export interface NetWorthFullViewProps {
  range: NetWorthRange;
  onRangeChange?: (range: NetWorthRange) => void;
}

/**
 * The net worth "full view" (dispatch §3, WP 3.12: "the chart on
 * `_app.index.tsx` (compact) and a full view"). Rendered inside
 * `NetWorthChart.tsx`'s dialog. `range` is owned by the caller so it can
 * live in the URL (`_app.index.tsx`'s `netWorthRange` search param) —
 * "URL state (range) round-trips" is this prop, reloaded from the address
 * bar rather than component state.
 */
export function NetWorthFullView({ range, onRangeChange }: NetWorthFullViewProps) {
  const effectiveRange = range ?? DEFAULT_NET_WORTH_RANGE;
  const seriesQuery = useNetWorthSeriesQuery(effectiveRange);
  // Depends on `seriesQuery.data`, not the derived `points` below —
  // `?? []` mints a fresh array reference every render, which would defeat
  // this memo entirely (`react-hooks/exhaustive-deps` flags exactly that).
  const points = useMemo(() => seriesQuery.data?.points ?? [], [seriesQuery.data]);
  const currencySeries = useMemo(() => groupByCurrency(points), [points]);
  const interpolated = interpolatedCount(points);
  const missing = missingCount(points);
  const hasMultipleCurrencies = currencySeries.length > 1;
  const snapshotFailure = seriesQuery.data?.lastSnapshotFailure ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* C-9, G3-15: this figure is the *planning* net worth (holdings ×
          market price, converted to one currency where possible) — a
          different number, by design, from the ledger figure `/accounts`
          shows (balances only, no valuation). Every label on this view says
          "planning" for that reason; `/accounts`' own label is the other
          half of this fix and is outside this component's files — see
          `docs/evidence/phase-4/wp4.12c-gate-conditions.md` §3 "For the
          orchestrator". */}
      <p className="text-caption text-text-muted">
        Planning net worth — holdings valued at market price. The Accounts screen’s figure is your
        ledger balances only; the two are not meant to match.
      </p>

      <UnvaluedAccountsNotice />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Date range" className="flex gap-1">
          {NET_WORTH_RANGES.map((option) => (
            <Button
              key={option}
              type="button"
              variant={option === effectiveRange ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={option === effectiveRange}
              onClick={() => onRangeChange?.(option)}
            >
              {NET_WORTH_RANGE_LABELS[option]}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={seriesQuery.isFetching}
          onClick={() => void seriesQuery.refetch()}
        >
          {seriesQuery.isFetching ? 'Checking…' : 'Refresh'}
        </Button>
      </div>

      {hasMultipleCurrencies && (
        <p className="text-caption text-text-muted">
          This window spans more than one currency. Each currency is drawn as its own line — never
          summed into one total, because no FX rate has been recorded to combine them.
        </p>
      )}

      {snapshotFailure !== null && <SnapshotFxFailureBanner failure={snapshotFailure} />}

      {seriesQuery.isLoading && <Skeleton height={280} variant="block" />}

      {seriesQuery.isError && (
        <p className="text-small text-text-muted">Net worth history isn't available right now.</p>
      )}

      {seriesQuery.isSuccess && currencySeries.length === 0 && (
        <p className="text-small text-text-muted">No net worth history in this window yet.</p>
      )}

      {seriesQuery.isSuccess &&
        currencySeries.map((series) => (
          <NetWorthAreaChart
            key={series.currency}
            data={series.points}
            color={series.color}
            seriesLabel={hasMultipleCurrencies ? series.currency : undefined}
            height={280}
            showSealedLegend
          />
        ))}

      {seriesQuery.isSuccess && (
        <p className="text-caption text-text-muted">
          {/* C-9, G3-12: this used to be derived from `interpolated` alone,
              which counts only `source: 'interpolated'` days — a day with no
              row at all (e.g. the snapshot job failed on a missing FX rate,
              `source` stays null) counted as zero "interpolated" days while
              the table below still showed '—' for it, so the caption claimed
              full coverage above visible gaps. `missing` is every day with
              no value at all, whatever the reason. */}
          {missing > 0
            ? `${String(missing)} day${missing === 1 ? ' has' : 's have'} no recorded value in this window.`
            : 'Every day in this window has a value.'}
          {interpolated > 0 &&
            ` ${String(interpolated)} ${interpolated === 1 ? 'day is' : 'days are'} interpolated from neighbouring days rather than observed or corrected.`}
        </p>
      )}

      {seriesQuery.isSuccess && <RecentDayDetail points={points.slice(-5)} />}
    </div>
  );
}

function RecentDayDetail({ points }: { points: readonly RawSeriesPoint[] }) {
  if (points.length === 0) return null;
  return (
    <div className="rounded-md border border-border-hairline">
      <table className="w-full text-small">
        <caption className="sr-only">Recent days in this window, with their seal status</caption>
        <thead>
          <tr className="border-b border-border-hairline text-caption text-text-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Date
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Value
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Note
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr
              key={point.asOfDate}
              className="border-b border-border-hairline last:border-0"
              data-testid={`net-worth-day-${point.asOfDate}`}
            >
              <td className="px-3 py-2 text-text-primary">
                {formatDateOnly(point.asOfDate, 'MMM d')}
              </td>
              <td
                className="px-3 py-2 text-text-primary"
                data-testid={`net-worth-value-${point.asOfDate}`}
              >
                {point.netWorth !== null ? (
                  <Money
                    value={point.netWorth}
                    signDisplay="never"
                    colorBySign={false}
                    sensitive={false}
                  />
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 text-text-secondary">
                {point.sealed ? 'Sealed' : 'Live (unsealed)'}
                {point.source === 'interpolated' ? ' · interpolated' : ''}
                {point.source === 'corrected' ? ' · corrected' : ''}
              </td>
              <td className="px-3 py-2 text-text-muted">{point.correctionReason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `FxRateUnavailable`'s own message shape (`@ctx/investments`' `fx.ts`): "no FX rate for BASE/QUOTE on or before YYYY-MM-DD (consulted …)". */
const FX_FAILURE_MESSAGE_PATTERN =
  /no FX rate for ([A-Z]{3})\/([A-Z]{3}) on or before (\d{4}-\d{2}-\d{2})/;

interface ParsedFxFailure {
  readonly base: string;
  readonly quote: string;
  readonly date: string;
}

/**
 * Best-effort extraction of the pair and date from the error message, so the
 * manual-entry form can pre-fill instead of asking the user to retype
 * something the app already knows. Coupled to `fx.ts`'s exact wording by
 * necessity (`last_error` carries only `name`/`message`/`code` — see
 * `apps/api/src/routes/net-worth.ts`'s own comment on why); a message that
 * does not match degrades to an empty, freely-editable form rather than
 * throwing, so a future wording change cannot break the affordance, only
 * its pre-fill.
 */
function parseFxFailure(message: string): ParsedFxFailure | null {
  const match = FX_FAILURE_MESSAGE_PATTERN.exec(message);
  if (match === null) return null;
  const [, base, quote, date] = match;
  if (base === undefined || quote === undefined || date === undefined) return null;
  return { base, quote, date };
}

/**
 * C-9 (gate-security-review.md G3-12): the failing snapshot job's
 * `FxRateUnavailable` reaches the screen here, with 08 §6.6's manual-entry
 * affordance right beside it — before this, a missing rate refused correctly
 * at write time and then vanished into a silent nightly retry.
 */
function SnapshotFxFailureBanner({ failure }: { failure: SnapshotFxFailure }) {
  const parsed = parseFxFailure(failure.message);
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3">
      <p className="text-small text-text-primary">
        Last night’s net worth snapshot could not run: {failure.message}
      </p>
      {!open ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => setOpen(true)}
        >
          Enter this rate manually
        </Button>
      ) : (
        <ManualFxRateForm initial={parsed} onDone={() => setOpen(false)} />
      )}
    </div>
  );
}

function ManualFxRateForm({
  initial,
  onDone,
}: {
  initial: ParsedFxFailure | null;
  onDone: () => void;
}) {
  const [base, setBase] = useState(initial?.base ?? '');
  const [quote, setQuote] = useState(initial?.quote ?? '');
  const [rateDate, setRateDate] = useState(initial?.date ?? '');
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stepUp = useStepUpRetry();
  const setManualFxRate = useSetManualFxRateMutation();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await stepUp.run(() =>
        setManualFxRate.mutateAsync({
          body: {
            base: base.trim().toUpperCase(),
            quote: quote.trim().toUpperCase(),
            rateDate,
            rate: rate.trim(),
          },
        }),
      );
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this rate.');
    }
  }

  const busy = setManualFxRate.isPending || stepUp.busy;

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-fx-base">Base</Label>
        <Input
          id="manual-fx-base"
          className="w-20"
          maxLength={3}
          required
          value={base}
          onChange={(event) => setBase(event.target.value.toUpperCase())}
          placeholder="CAD"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-fx-quote">Quote</Label>
        <Input
          id="manual-fx-quote"
          className="w-20"
          maxLength={3}
          required
          value={quote}
          onChange={(event) => setQuote(event.target.value.toUpperCase())}
          placeholder="USD"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-fx-date">Date</Label>
        <Input
          id="manual-fx-date"
          type="date"
          required
          value={rateDate}
          onChange={(event) => setRateDate(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-fx-rate">1 {base || 'base'} =</Label>
        <Input
          id="manual-fx-rate"
          inputMode="decimal"
          required
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          placeholder="1.3421"
        />
      </div>
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? 'Saving…' : 'Save rate'}
      </Button>
      {error !== null && (
        <p className="w-full text-small text-status-critical" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
