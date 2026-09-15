// SPDX-License-Identifier: MIT
import { Download } from 'lucide-react';
import { useState } from 'react';

import { useAccountsLookup } from '../accounts/useAccountsLookup.ts';
import { Button } from '../../components/ui/button.tsx';
import { BulkActionBar } from './BulkActionBar.tsx';
import { TransactionDetailSheet } from './TransactionDetailSheet.tsx';
import { TransactionsFilterBar } from './TransactionsFilterBar.tsx';
import { TransactionsList } from './TransactionsList.tsx';
import { DEFAULT_TRANSACTIONS_SEARCH, type TransactionsSearch } from './filters.ts';
import { useExportTransactions } from './useExportTransactions.ts';

export interface TransactionsScreenProps {
  search: TransactionsSearch;
  onSearchChange: (search: TransactionsSearch) => void;
}

/**
 * `/transactions` (deliverable 1): filter bar, virtualized list, bulk
 * actions, and a detail sheet for inline note/category edits. Filter state
 * lives in the URL (the route's `validateSearch`) so it survives a reload
 * and is shareable — this component only ever reads/writes it through props.
 */
export function TransactionsScreen({ search, onSearchChange }: TransactionsScreenProps) {
  const { accounts, nameOf } = useAccountsLookup();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openTransactionId, setOpenTransactionId] = useState<string | null>(null);
  const { exportCsv, isExporting, stepUpError } = useExportTransactions();

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function patchSearch(patch: Partial<TransactionsSearch>): void {
    onSearchChange({ ...search, ...patch });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <TransactionsFilterBar
          search={search}
          accounts={accounts}
          onChange={patchSearch}
          onClear={() => onSearchChange(DEFAULT_TRANSACTIONS_SEARCH)}
        />
        <Button
          variant="secondary"
          className="shrink-0 gap-1.5"
          onClick={() => void exportCsv(search)}
          disabled={isExporting}
        >
          <Download size={16} aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {stepUpError !== null && <p className="text-small text-status-critical">{stepUpError}</p>}

      <BulkActionBar selectedIds={[...selected]} onClear={() => setSelected(new Set())} />

      <TransactionsList
        search={search}
        accountName={nameOf}
        selected={selected}
        onToggleSelect={toggleSelect}
        onOpen={setOpenTransactionId}
        onClearFilters={() => onSearchChange(DEFAULT_TRANSACTIONS_SEARCH)}
      />

      <TransactionDetailSheet
        transactionId={openTransactionId}
        accountName={nameOf}
        onOpenChange={(open) => {
          if (!open) setOpenTransactionId(null);
        }}
      />
    </div>
  );
}
