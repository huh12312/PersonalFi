// SPDX-License-Identifier: MIT
import { CalendarClock, ListChecks } from 'lucide-react';

import type {
  InvestmentActivity,
  InvestmentActivityAccount,
} from '../../api/generated/types.gen.ts';
import { DateOnlyText } from '../../components/finance/DateOnlyText.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import type { ActivityFilters } from './api.ts';
import { ACTIVITY_KIND_LABELS, activityKindLabel, activitySourceLabel } from './labels.ts';
import { UnresolvedMarker } from './UnresolvedMarker.tsx';
import type { ActivityKind } from './search.ts';

const CONTROL_CLASS =
  'h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary';

export interface ActivityPanelProps {
  readonly filters: ActivityFilters;
  readonly onFiltersChange: (patch: Partial<ActivityFilters>) => void;
  /** The holder's investment accounts, for the account filter. */
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
  readonly accountNameOf: (accountId: string) => string;
  readonly items: readonly InvestmentActivity[];
  /** The first page's sync states and total; `undefined` until it arrives. */
  readonly syncStates: readonly InvestmentActivityAccount[] | undefined;
  readonly total: number | undefined;
  readonly isLoading: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
}

/**
 * A decimal string from the server, without the trailing zeros `NUMERIC`
 * pads it with — `5.000000000000000000` reads as `5`. Never parsed into a
 * float: this trims characters, it does not round.
 */
export function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * The Investments screen's Activity tab (WP 10.3): every buy, sell, dividend,
 * contribution and fee `GET /investments/transactions` returns, newest first.
 *
 * `Type` is the server's `kind` — the same classification the performance
 * route uses to decide what is an external flow — so "Contribution" here is
 * exactly what the return was measured against, and the screen does not
 * re-derive it from the provider's words.
 *
 * Two empty states, deliberately different: an account whose investment
 * activity has never synced says a sync is **pending** — it does not say
 * "no activity", because nothing has been asked yet. Only when every account
 * in view has synced does an empty list mean "No investment activity in this
 * period".
 *
 * Every numeric column is right-aligned with tabular, lining figures: the
 * `table` rule in `styles/base.css` (WP 10.2) sets them for the whole table,
 * and the cells carry `tabular-nums` as well for the slashed zero.
 */
export function ActivityPanel({
  filters,
  onFiltersChange,
  accounts,
  accountNameOf,
  items,
  syncStates,
  total,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: ActivityPanelProps) {
  const pending = (syncStates ?? []).filter((state) => state.activitySync === 'pending');
  const failed = (syncStates ?? []).filter((state) => state.activitySync === 'failed');
  const everyAccountPending =
    syncStates !== undefined &&
    syncStates.length > 0 &&
    syncStates.every(
      (state) => state.activitySync === 'pending' || state.activitySync === 'failed',
    );

  return (
    <section aria-labelledby="activity-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="activity-heading" className="text-h3 text-text-primary">
          Activity
        </h2>
        <p className="text-small text-text-secondary">
          Buys, sells, dividends, contributions and fees in your investment accounts,{' '}
          <DateOnlyText value={filters.from} /> to <DateOnlyText value={filters.to} />.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter activity"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="activity-account">Account</Label>
          <select
            id="activity-account"
            className={CONTROL_CLASS}
            value={filters.account ?? ''}
            onChange={(event) =>
              onFiltersChange({
                account: event.target.value === '' ? undefined : event.target.value,
              })
            }
          >
            <option value="">All investment accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="activity-kind">Type</Label>
          <select
            id="activity-kind"
            className={CONTROL_CLASS}
            value={filters.kind ?? ''}
            onChange={(event) =>
              onFiltersChange({
                kind: event.target.value === '' ? undefined : (event.target.value as ActivityKind),
              })
            }
          >
            <option value="">All types</option>
            {Object.entries(ACTIVITY_KIND_LABELS).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="activity-from">From</Label>
          <input
            id="activity-from"
            type="date"
            className={`${CONTROL_CLASS} tabular-nums`}
            value={filters.from}
            max={filters.to}
            onChange={(event) => {
              if (event.target.value !== '') onFiltersChange({ from: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="activity-to">To</Label>
          <input
            id="activity-to"
            type="date"
            className={`${CONTROL_CLASS} tabular-nums`}
            value={filters.to}
            min={filters.from}
            onChange={(event) => {
              if (event.target.value !== '') onFiltersChange({ to: event.target.value });
            }}
          />
        </div>
      </form>

      {pending.length > 0 && !everyAccountPending && (
        <p className="text-small text-text-secondary" role="status" data-testid="activity-pending">
          Investment activity for {pending.map((state) => state.name).join(', ')} has not synced yet
          — a sync is pending. It appears here after the next sync.
        </p>
      )}
      {failed.length > 0 && (
        <p className="text-small text-status-warning" role="status" data-testid="activity-failed">
          The last attempt to sync investment activity for{' '}
          {failed.map((state) => state.name).join(', ')} did not complete; what is shown may be
          incomplete.
        </p>
      )}

      {isLoading ? (
        <Skeleton variant="block" height={240} />
      ) : items.length === 0 ? (
        everyAccountPending ? (
          <EmptyState
            icon={CalendarClock}
            headline="Investment activity has not synced yet"
            description={`A sync is pending for ${pending
              .concat(failed)
              .map((state) => state.name)
              .join(
                ', ',
              )}. Its buys, sells, dividends and contributions appear here once it has run — this is not "no activity".`}
          />
        ) : (
          <EmptyState
            icon={ListChecks}
            headline="No investment activity in this period"
            description="Try a wider date range, another account or all types."
          />
        )
      ) : (
        <>
          <ScrollRegion label="Investment activity">
            <table className="w-full text-small" data-testid="activity-table">
              <caption className="sr-only">
                Investment activity, newest first. Amounts are signed: negative is cash that left
                the account; for a contribution or withdrawal, the money that came in or went out.
              </caption>
              <thead>
                <tr className="border-b border-border-hairline text-left text-text-secondary">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Account
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Type
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Security
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Price
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border-hairline"
                    data-testid="activity-row"
                    data-kind={item.kind}
                  >
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <DateOnlyText value={item.tradeDate} />
                    </td>
                    <td className="py-2 pr-3">{accountNameOf(item.accountId)}</td>
                    <td className="py-2 pr-3">
                      {activityKindLabel(item.kind)}
                      {item.subtype !== null &&
                        item.subtype.toLowerCase() !== item.kind.replace('_', ' ') && (
                          <span className="block text-caption text-text-muted">{item.subtype}</span>
                        )}
                    </td>
                    <td className="py-2 pr-3">
                      {item.unresolvedSecurity != null ? (
                        // WP 10.4: a movement in a security nobody could identify, under the
                        // provider's own name and ticker. Listed here; left out of lots and
                        // performance (the Performance tab names it among the exclusions).
                        <>
                          <span className="font-medium text-text-primary">
                            {item.unresolvedSecurity.symbol ??
                              item.unresolvedSecurity.name ??
                              item.name ??
                              'An unnamed security'}
                          </span>
                          {item.unresolvedSecurity.symbol !== null &&
                            item.unresolvedSecurity.name !== null && (
                              <span className="block text-caption text-text-muted">
                                {item.unresolvedSecurity.name}
                              </span>
                            )}
                          <UnresolvedMarker className="mt-1 flex w-fit" />
                        </>
                      ) : item.security === null ? (
                        <span className="text-text-muted">{item.name ?? '—'}</span>
                      ) : item.security.symbol !== null ? (
                        <>
                          <span className="font-medium text-text-primary">
                            {item.security.symbol}
                          </span>
                          {item.security.name !== null && (
                            <span className="block text-caption text-text-muted">
                              {item.security.name}
                            </span>
                          )}
                        </>
                      ) : (
                        <span>{item.security.name ?? item.name ?? '—'}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {trimDecimal(item.quantity) === '0' ? (
                        <span aria-label="no quantity">—</span>
                      ) : (
                        trimDecimal(item.quantity)
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {item.price === null || trimDecimal(item.price) === '0' ? (
                        <span aria-label="no price">—</span>
                      ) : (
                        trimDecimal(item.price)
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {/* A contribution or withdrawal shows the money that crossed the
                          account boundary (`flow`); a 401(k) contribution-buy's own
                          `amount` is the cash the buy spent, which reads backwards. */}
                      <Money value={item.flow ?? item.amount} signDisplay="exceptZero" />
                    </td>
                    <td className="py-2 text-text-secondary">{activitySourceLabel(item.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-caption text-text-muted" data-testid="activity-count">
              Showing {items.length}
              {total !== undefined ? ` of ${String(total)}` : ''}
            </p>
            {hasNextPage && (
              <Button
                variant="secondary"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={onLoadMore}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
