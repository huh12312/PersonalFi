// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { createManualTransactionsMutation } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Account } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';

export interface AddManualTransactionDialogProps {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * `POST /accounts/{id}/transactions` (wp1.6-ui.md §7's carried-over "manual
 * transaction entry has no route" item, closed by WP 2.5). Amounts are
 * signed — negative is an outflow, same convention as every other amount in
 * the app (`docs/CONVENTIONS.md` "Money") — entered directly rather than
 * inferred from a "type" toggle, so the field the user edits is the field
 * that travels on the wire. Step-up gated, same policy as `RecordBalanceDialog`.
 */
export function AddManualTransactionDialog({
  account,
  open,
  onOpenChange,
}: AddManualTransactionDialogProps) {
  const [amountText, setAmountText] = useState('');
  const [name, setName] = useState('');
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const stepUp = useStepUpRetry();
  const queryClient = useQueryClient();
  const createTransactions = useMutation({
    ...createManualTransactionsMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const head = query.queryKey[0] as { _id?: string } | undefined;
          return head?._id === 'listTransactions';
        },
      });
    },
  });

  function reset(): void {
    setAmountText('');
    setName('');
    setDate(today());
    setError(null);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    let amount;
    try {
      amount = Money.toJSON(Money.parseAmount(amountText, account.currency));
    } catch {
      setError('Enter a valid amount — negative for money out, positive for money in.');
      return;
    }
    try {
      await stepUp.run(() =>
        createTransactions.mutateAsync({
          path: { accountId: account.id },
          body: { transactions: [{ amount, postedDate: date, name }] },
        }),
      );
      reset();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add this transaction.');
    }
  }

  const busy = createTransactions.isPending || stepUp.busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Add a transaction</DialogTitle>
        <DialogDescription>
          For {account.name}. Negative is money out, positive is money in — the same convention as
          everywhere else in the app.
        </DialogDescription>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-txn-name">Description</Label>
            <Input
              id="manual-txn-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Cash tip, Rent from tenant"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-txn-amount">Amount ({account.currency})</Label>
              <Input
                id="manual-txn-amount"
                inputMode="decimal"
                required
                value={amountText}
                onChange={(event) => setAmountText(event.target.value)}
                placeholder="-12.50"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-txn-date">Date</Label>
              <Input
                id="manual-txn-date"
                type="date"
                required
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
          </div>
          {(error !== null || stepUp.error !== null) && (
            <p className="text-small text-status-danger-text">{error ?? stepUp.error}</p>
          )}
          <Button type="submit" disabled={busy || name.trim() === '' || amountText.trim() === ''}>
            {busy ? 'Adding…' : 'Add transaction'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
