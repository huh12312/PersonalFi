// SPDX-License-Identifier: MIT
import type {
  GetRecurringForecastResponse,
  GetSafeToSpendResponse,
} from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Card, CardDescription } from '../../components/ui/card.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { formatCadenceLabel } from './cadence-format.ts';
import {
  buildChargeMarks,
  buildForecastBand,
  describeEmptyWindow,
  enumerateDays,
  forecastShape,
  streamsOutsideWindow,
  type StreamInput,
} from './forecast-series.ts';
import { ForecastBandChart } from './ForecastBandChart.tsx';

export interface ForwardCashFlowCardProps {
  readonly forecast: GetRecurringForecastResponse | undefined;
  readonly safeToSpend: GetSafeToSpendResponse | undefined;
  readonly series: readonly StreamInput[];
  readonly nameOf: (merchantId: string) => string;
}

/**
 * The Recurring screen's "Forward cash flow" card (WP 2.10; redesigned in WP 10.7 after the three figures were
 * drawn on top of one another and the chart was a flat $0 line).
 *
 * **The stat strip** is a grid, not a flex row: one column on a narrow card, the hero across two columns and the
 * other two side by side on a medium one, three columns (the hero wider) on a wide one — sized by the card
 * (`@container`), so a sidebar or a zoom changes it the same way a phone does. Safe to spend is the one hero
 * figure; the expected net and the worst case are subordinate (`size="standard"`), each with a line saying what
 * it means.
 *
 * **The chart** (`ForecastBandChart`) draws only what the window holds (`forecastShape`): nothing due means no
 * line at all and a sentence saying why, naming the streams that have no due date in the window; every charge
 * fixed means no band, and a note saying the band is missing because nothing is uncertain.
 */
export function ForwardCashFlowCard({
  forecast,
  safeToSpend,
  series,
  nameOf,
}: ForwardCashFlowCardProps) {
  return (
    <Card padding="default" data-testid="forward-cash-flow">
      {/* A raw `<h2>` rather than `CardTitle` (which renders an `<h3>`):
          when there are no candidates, "Needs your confirmation" above
          does not render, and this would be the first heading under the
          route's own `<h1>` — an h3 there would skip a level. */}
      <h2 className="text-h2 text-text-primary">Forward cash flow</h2>
      <CardDescription className="mb-4">
        The next 30 days, projected from your confirmed and detected streams. The shaded band is the
        detector's own uncertainty, not a guess drawn for effect.
      </CardDescription>
      {forecast === undefined ? (
        <SkeletonText lines={3} />
      ) : (
        <ForecastBody
          forecast={forecast}
          safeToSpend={safeToSpend}
          series={series}
          nameOf={nameOf}
        />
      )}
    </Card>
  );
}

function ForecastBody({
  forecast,
  safeToSpend,
  series,
  nameOf,
}: ForwardCashFlowCardProps & { readonly forecast: GetRecurringForecastResponse }) {
  const days = enumerateDays(forecast.from, forecast.to);
  const windowDays = Math.max(days.length - 1, 1);
  const points = buildForecastBand(forecast.from, forecast.to, forecast.charges);
  const marks = buildChargeMarks(forecast.from, forecast.to, forecast.charges, nameOf);
  const shape = forecastShape(points, marks);

  return (
    <>
      <div className="@container">
        <div
          className="grid grid-cols-1 gap-x-8 gap-y-5 @md:grid-cols-2 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]"
          data-testid="forecast-stat-strip"
        >
          <StatTile
            label="Safe to spend"
            size="hero"
            className="@md:col-span-2 @3xl:col-span-1"
            value={
              safeToSpend === undefined ? (
                <SkeletonText lines={1} />
              ) : (
                <Money value={safeToSpend.safe} colorBySign />
              )
            }
            hint="Cash on hand, less the worst case of every charge due"
          />
          <StatTile
            label={`Expected net (${String(windowDays)} days)`}
            size="standard"
            className="@3xl:border-l @3xl:border-border-hairline @3xl:pl-6"
            value={<Money value={forecast.net} />}
            hint="After every expected charge"
          />
          <StatTile
            label="Worst case"
            size="standard"
            className="@3xl:border-l @3xl:border-border-hairline @3xl:pl-6"
            value={<Money value={forecast.netLow} colorBySign={false} />}
            hint="If every uncertain charge lands at its worst"
          />
        </div>
      </div>

      {shape === 'empty' ? (
        <div
          data-testid="forecast-empty"
          className="mt-6 flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-border-hairline bg-bg-subtle px-6 py-8 text-center"
        >
          <p className="max-w-prose text-body text-text-secondary">
            {describeEmptyWindow(
              windowDays,
              streamsOutsideWindow(series, marks),
              nameOf,
              formatCadenceLabel,
            )}
          </p>
          <p className="text-caption text-text-muted">
            {formatDateOnly(forecast.from, 'MMM d')} – {formatDateOnly(forecast.to, 'MMM d')}
          </p>
        </div>
      ) : (
        <>
          <ForecastBandChart
            className="mt-6"
            data={points}
            marks={marks}
            currency={forecast.currency}
            banded={shape === 'banded'}
          />
          {shape === 'certain' && (
            <p data-testid="forecast-band-note" className="mt-2 text-caption text-text-muted">
              No band is shaded: every charge in this window has a fixed amount, so nothing is
              uncertain.
            </p>
          )}
        </>
      )}
    </>
  );
}
