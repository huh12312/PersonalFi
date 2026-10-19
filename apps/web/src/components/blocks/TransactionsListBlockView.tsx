// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { getTransactionOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { useAccountsLookup } from '../../features/accounts/useAccountsLookup.ts';
import { TransactionDetailSheet } from '../../features/transactions/TransactionDetailSheet.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { Money } from '../finance/Money.tsx';
import { BlockHeading } from './heading.tsx';
import type { Block } from './schema.ts';

type TransactionsListBlock = Extract<Block, { kind: 'transactions-list' }>;

/** The most rows the block draws before saying how many more there are. */
const SHOWN = 20;

function TransactionLine({
  transactionId,
  onOpen,
}: {
  readonly transactionId: string;
  readonly onOpen: (id: string) => void;
}) {
  const query = useQuery(getTransactionOptions({ path: { transactionId } }));
  const transaction = query.data;
  if (query.isLoading) return <span className="text-caption text-text-muted">Loading…</span>;
  if (transaction === undefined) {
    return (
      <span className="text-caption text-text-muted">This transaction could not be loaded.</span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(transactionId)}
      className="flex w-full min-h-6 items-baseline justify-between gap-3 rounded-sm text-left hover:bg-bg-subtle"
    >
      <span className="min-w-0 truncate text-small text-text-primary">
        <span className="text-caption text-text-muted tabular-nums">
          {formatDateOnly(transaction.date)}
        </span>{' '}
        {transaction.name}
      </span>
      <Money value={transaction.amount} className="shrink-0 text-small tabular-nums" />
    </button>
  );
}

/** The detail sheet, mounted only while open (so a closed list asks nothing of the accounts API). */
function Sheet({
  transactionId,
  onClose,
}: {
  readonly transactionId: string;
  readonly onClose: () => void;
}) {
  const accounts = useAccountsLookup();
  return (
    <TransactionDetailSheet
      transactionId={transactionId}
      accountName={accounts.nameOf}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    />
  );
}

/**
 * `transactions-list`: the ids a block names, resolved here through the transactions API (`GET
 * /transactions/{id}`), so a block never carries a transaction's figures. A row opens the existing detail sheet.
 */
export function TransactionsListBlockView({ block }: { readonly block: TransactionsListBlock }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = block.transactionIds.slice(0, SHOWN);
  const more = block.transactionIds.length - shown.length;
  return (
    <div role="group" aria-label={block.title ?? 'Transactions'}>
      {block.title !== undefined && <BlockHeading>{block.title}</BlockHeading>}
      {shown.length === 0 ? (
        <p className="mt-1 text-small text-text-muted">No transactions.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {shown.map((id) => (
            <li key={id}>
              <TransactionLine transactionId={id} onOpen={setOpen} />
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="mt-1 text-caption text-text-muted">and {String(more)} more</p>}
      {open !== null && <Sheet transactionId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
