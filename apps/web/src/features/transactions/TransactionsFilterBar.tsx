// SPDX-License-Identifier: MIT
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { Account } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useMerchantNames } from '../recurring/useMerchantNames.ts';
import { CategoryFilterControl } from './CategoryFilterControl.tsx';
import { hasActiveFilters, type TransactionsSearch } from './filters.ts';

export interface TransactionsFilterBarProps {
  search: TransactionsSearch;
  accounts: readonly Account[];
  onChange: (patch: Partial<TransactionsSearch>) => void;
  onClear: () => void;
}

/**
 * Search + date/account/category filters (deliverable 1; WP 2.11 adds the
 * category filter itself). `GET /transactions` has always accepted
 * `categoryIds` (plural — closeout-architecture.md §4's "no categoryId
 * parameter" bullet was stale, corrected by WP 2.5); what was missing was
 * this control, `CategoryFilterControl`.
 *
 * Search is debounced locally (250ms) so every keystroke doesn't re-fire the
 * keyset query; every other control commits immediately, since a `<select>`
 * or a date picker already fires far less often than a keystroke.
 */
export function TransactionsFilterBar({
  search,
  accounts,
  onChange,
  onClear,
}: TransactionsFilterBarProps) {
  const [queryDraft, setQueryDraft] = useState(search.q ?? '');

  useEffect(() => {
    // Re-syncs the local draft when `search.q` changes from *outside* this
    // input (URL navigation, "Clear filters", browser back/forward) — the
    // debounce below is what makes this a draft rather than a direct binding.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueryDraft(search.q ?? '');
  }, [search.q]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (queryDraft !== (search.q ?? ''))
        onChange({ q: queryDraft === '' ? undefined : queryDraft });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the draft should retrigger debounce; `search.q`/`onChange` changing shouldn't restart the timer
  }, [queryDraft]);

  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
      <div className="min-w-[220px] flex-1">
        <Label htmlFor="transactions-search">Search</Label>
        <div className="relative mt-1">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            id="transactions-search"
            type="search"
            placeholder="Payee, merchant, note…"
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="transactions-from">From</Label>
        <Input
          id="transactions-from"
          type="date"
          className="mt-1 w-40"
          value={search.from ?? ''}
          onChange={(event) =>
            onChange({ from: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </div>

      <div>
        <Label htmlFor="transactions-to">To</Label>
        <Input
          id="transactions-to"
          type="date"
          className="mt-1 w-40"
          value={search.to ?? ''}
          onChange={(event) =>
            onChange({ to: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </div>

      <div>
        <Label htmlFor="transactions-accounts">Accounts</Label>
        <select
          id="transactions-accounts"
          multiple
          className="mt-1 h-10 min-w-[160px] rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary focus-visible:outline-none"
          value={search.accounts ?? []}
          onChange={(event) =>
            onChange({
              accounts: Array.from(event.target.selectedOptions, (option) => option.value),
            })
          }
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <Label id="transactions-category-label">Category</Label>
        <div className="mt-1">
          <CategoryFilterControl
            value={search.categoryIds ?? []}
            onChange={(categoryIds) => onChange({ categoryIds })}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="transactions-transfers">Transfers</Label>
        <select
          id="transactions-transfers"
          className="mt-1 h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary focus-visible:outline-none"
          value={search.transfers ?? 'include'}
          onChange={(event) => {
            const value = event.target.value as TransactionsSearch['transfers'];
            onChange({ transfers: value === 'include' ? undefined : value });
          }}
        >
          <option value="include">Include</option>
          <option value="exclude">Exclude</option>
          <option value="only">Only</option>
        </select>
      </div>

      <div className="flex items-center gap-4 pb-2">
        <label className="flex items-center gap-1.5 text-small text-text-secondary">
          <input
            type="checkbox"
            checked={search.pending === true}
            onChange={(event) => onChange({ pending: event.target.checked ? true : undefined })}
          />
          Pending only
        </label>
        <label className="flex items-center gap-1.5 text-small text-text-secondary">
          <input
            type="checkbox"
            checked={search.excluded === true}
            onChange={(event) => onChange({ excluded: event.target.checked ? true : undefined })}
          />
          Excluded only
        </label>
        <label className="flex items-center gap-1.5 text-small text-text-secondary">
          <input
            type="checkbox"
            checked={search.uncategorized === true}
            onChange={(event) =>
              onChange({ uncategorized: event.target.checked ? true : undefined })
            }
          />
          Uncategorized only
        </label>
      </div>

      {(search.merchantIds?.length ?? 0) > 0 && (
        <MerchantFilterChip
          merchantIds={search.merchantIds ?? []}
          onRemove={() => onChange({ merchantIds: undefined })}
        />
      )}

      {hasActiveFilters(search) && (
        <Button variant="ghost" size="sm" onClick={onClear} className="gap-1.5">
          <X size={14} aria-hidden="true" />
          Clear filters
        </Button>
      )}
    </div>
  );
}

/**
 * The merchant filter a Cash Flow merchant row (or a Sankey merchant band) drills in with (WP 10.10). There is no
 * merchant picker on this bar; the chip says which merchant the list is narrowed to and takes it off.
 */
function MerchantFilterChip({
  merchantIds,
  onRemove,
}: {
  readonly merchantIds: readonly string[];
  readonly onRemove: () => void;
}) {
  const { nameOf } = useMerchantNames(merchantIds);
  const names = merchantIds.map(nameOf).join(', ');
  return (
    <div className="flex items-center gap-1.5 pb-2 text-small text-text-secondary">
      <span>
        Merchant: <span className="font-medium text-text-primary">{names}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onRemove} className="gap-1">
        <X size={14} aria-hidden="true" />
        Remove merchant filter
      </Button>
    </div>
  );
}
