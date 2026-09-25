// SPDX-License-Identifier: MIT
import { CircleHelp, PieChart } from 'lucide-react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { ProviderAttribution } from '../market-data/Attribution.tsx';
import type { Attribution, GetAllocationResponse } from '../../api/generated/types.gen.ts';
import { AllocationDonut } from './AllocationDonut.tsx';
import { DIMENSION_LABELS, exclusionReasonLabel, ratioToNumber } from './labels.ts';
import type { AllocationDimension } from './search.ts';

const DIMENSIONS: readonly AllocationDimension[] = ['asset_class', 'region', 'sector'];

function reportFor(
  response: GetAllocationResponse,
  dimension: AllocationDimension,
): GetAllocationResponse['byAssetClass'] {
  if (dimension === 'region') return response.byRegion;
  if (dimension === 'sector') return response.bySector;
  return response.byAssetClass;
}

export interface AllocationPanelProps {
  readonly data: GetAllocationResponse | undefined;
  readonly isLoading: boolean;
  readonly dimension: AllocationDimension;
  readonly onDimensionChange: (next: AllocationDimension) => void;
  /**
   * Whether the portfolio holds at least one CoinGecko-priced crypto
   * position. `GET /investments/allocation` has no per-slice `source` field
   * (`wp3.9-routes.md`), so this is derived once, from `GET /holdings`, by
   * the parent screen and passed down — the donut's CRYPTO slice is a sum
   * over exactly those prices, so the obligation travels with it
   * (`wp3.14-carryovers.md` item 1).
   */
  readonly hasCoinGeckoCryptoHolding?: boolean;
  readonly coinGeckoAttribution?: Attribution;
}

/**
 * Allocation by asset class / region / sector.
 *
 * Two rules from the dispatch are structural here rather than stylistic:
 *
 * 1. **`% unclassified` is rendered beside the donut and is never hidden.**
 *    It has its own block with its own heading, drawn before the donut's
 *    data is even inspected, and it renders at `0%` as readily as at `40%` —
 *    07 §4.3's "returned beside every number", and the reason the wire
 *    schema makes `unclassifiedPct` required rather than optional.
 * 2. **Excluded holdings are listed, not dropped.** A position kept out of
 *    the denominator for a stale price or an unknown one is named with the
 *    server's own reason code, so the total on screen is auditable.
 */
export function AllocationPanel({
  data,
  isLoading,
  dimension,
  onDimensionChange,
  hasCoinGeckoCryptoHolding = false,
  coinGeckoAttribution,
}: AllocationPanelProps) {
  if (isLoading) return <Skeleton variant="block" height={260} />;
  if (data === undefined) return null;

  const report = reportFor(data, dimension);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="allocation-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="allocation-heading" className="text-h3 text-text-primary">
          Allocation
        </h2>
        <div
          role="radiogroup"
          aria-label="Allocation dimension"
          className="inline-flex items-center gap-1 rounded-md bg-bg-subtle p-1"
        >
          {DIMENSIONS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === dimension}
              onClick={() => onDimensionChange(candidate)}
              className={
                candidate === dimension
                  ? 'rounded-[calc(var(--radius-md)-2px)] bg-bg-surface px-3 py-1.5 text-small font-medium text-text-primary shadow-[var(--shadow-elev-1)]'
                  : 'rounded-[calc(var(--radius-md)-2px)] px-3 py-1.5 text-small font-medium text-text-secondary'
              }
            >
              {DIMENSION_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>

      {report.slices.length === 0 ? (
        <EmptyState
          icon={PieChart}
          headline="Nothing to allocate yet"
          description="Once a holding has a price, its share of the portfolio appears here."
        />
      ) : (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <AllocationDonut dimension={dimension} report={report} />
          </div>

          {/* `% unclassified`, beside the donut, always. */}
          <aside
            className="shrink-0 rounded-lg border border-border-hairline bg-bg-subtle p-4 lg:w-60"
            aria-label="Unclassified share"
            data-testid="allocation-unclassified"
          >
            <div className="flex items-center gap-2 text-small text-text-secondary">
              <CircleHelp size={14} aria-hidden="true" />
              <span>% unclassified</span>
            </div>
            <p className="mt-1 text-h2 text-text-primary" data-testid="unclassified-pct">
              <Percent value={ratioToNumber(report.unclassifiedPct)} />
            </p>
            <p className="mt-1 text-small text-text-muted">
              <Money value={report.unclassifiedValue} signDisplay="auto" colorBySign={false} /> of{' '}
              <Money value={report.total} signDisplay="auto" colorBySign={false} /> has no{' '}
              {DIMENSION_LABELS[dimension].toLowerCase()} on record.
            </p>
            <p className="mt-3 text-caption text-text-muted">
              Basis: {report.basis === 'as_of_now' ? 'as of now' : 'last known'} · cash included ·
              fund-level look-through only.
            </p>
          </aside>
        </div>
      )}

      {report.excluded.length > 0 && (
        <div
          className="rounded-lg border border-border-hairline p-4"
          data-testid="allocation-excluded"
        >
          <h3 className="text-small font-medium text-text-primary">
            Left out of this total ({report.excluded.length})
          </h3>
          <ul className="mt-2 space-y-1 text-small text-text-muted">
            {report.excluded.map((item) => (
              <li key={item.holdingId}>
                {item.symbol ?? item.holdingId} — {exclusionReasonLabel(item.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasCoinGeckoCryptoHolding && coinGeckoAttribution !== undefined && (
        <ProviderAttribution attribution={coinGeckoAttribution} />
      )}
    </section>
  );
}
