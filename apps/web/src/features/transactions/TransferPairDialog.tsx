// SPDX-License-Identifier: MIT
import { DateOnly, Money } from '@core/kernel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  listTransactionsOptions,
  pairTransferMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Transaction, TransactionDetail } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Money as MoneyText } from '../../components/finance/Money.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { invalidateTransactionQueries } from './useTransactionOverlay.ts';
import { findTransferCandidates, orientPair } from './transfer-candidates.ts';

const WINDOW_DAYS = 5;

export interface TransferPairDialogProps {
  transaction: TransactionDetail;
  accountName: (accountId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Transfer-pair creation from the detail sheet (wp1.6-ui.md §7's carried-over
 * item): candidates are same-amount, opposite-sign rows in a ±5-day window,
 * queried narrowly server-side (`amountMin`/`amountMax`/`from`/`to` on the
 * existing `GET /transactions`) and finished client-side by
 * `findTransferCandidates` — there is no candidate-suggestion endpoint, and
 * 05 §5's own description of this feature is exactly this client-side
 * filter. Confirming calls the existing `POST /transfers/pair`.
 */
export function TransferPairDialog({
  transaction,
  accountName,
  open,
  onOpenChange,
}: TransferPairDialogProps) {
  const targetAmount = Money.fromJSON(transaction.amount);
  const targetDate = DateOnly.parse(transaction.date);
  const from = DateOnly.addDays(targetDate, -WINDOW_DAYS);
  const to = DateOnly.addDays(targetDate, WINDOW_DAYS);
  // `amountMin`/`amountMax` are minor-unit integer strings on the wire
  // (docs/CONVENTIONS.md "Money"), never a decimal — the counterpart's
  // magnitude is the same number of minor units as this transaction, with
  // the opposite sign.
  const counterpartMagnitude = Money.absolute(targetAmount).minor.toString();
  const queryClient = useQueryClient();

  const poolQuery = useQuery({
    ...listTransactionsOptions({
      query: {
        from,
        to,
        amountMin: counterpartMagnitude,
        amountMax: counterpartMagnitude,
        limit: 50,
      },
    }),
    enabled: open,
  });

  const candidates = useMemo<Transaction[]>(() => {
    if (poolQuery.data === undefined) return [];
    return findTransferCandidates(transaction, poolQuery.data.items, { windowDays: WINDOW_DAYS });
  }, [poolQuery.data, transaction]);

  const pair = useMutation({
    ...pairTransferMutation(),
    onSuccess: (_data, variables) => {
      invalidateTransactionQueries(queryClient, variables.body.outflowTransactionId);
      invalidateTransactionQueries(queryClient, variables.body.inflowTransactionId);
      void queryClient.invalidateQueries({ queryKey: listTransactionsOptions().queryKey });
      onOpenChange(false);
    },
  });

  function pairWith(candidate: Transaction): void {
    pair.mutate({ body: orientPair(transaction, candidate) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Pair as a transfer</DialogTitle>
        <DialogDescription>
          Same amount, opposite direction, within {WINDOW_DAYS} days of{' '}
          {formatDateOnly(transaction.date)}.
        </DialogDescription>

        {poolQuery.isLoading && <p className="mt-4 text-small text-text-muted">Looking…</p>}

        {!poolQuery.isLoading && candidates.length === 0 && (
          <p className="mt-4 text-small text-text-muted">
            No matching transaction found in that window.
          </p>
        )}

        {candidates.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-border-strong px-3 py-2 text-left hover:bg-bg-subtle focus-visible:outline-none"
                  disabled={pair.isPending}
                  onClick={() => pairWith(candidate)}
                >
                  <span>
                    <span className="block text-small font-medium text-text-primary">
                      {candidate.merchantName ?? candidate.name}
                    </span>
                    <span className="block text-caption text-text-muted">
                      {accountName(candidate.accountId)} · {formatDateOnly(candidate.date)}
                    </span>
                  </span>
                  <MoneyText value={candidate.amount} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {pair.isError && (
          <p className="mt-3 text-small text-status-critical">
            {pair.error instanceof Error
              ? pair.error.message
              : 'Could not pair these transactions.'}
          </p>
        )}

        <Button variant="ghost" className="mt-4 w-full" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
