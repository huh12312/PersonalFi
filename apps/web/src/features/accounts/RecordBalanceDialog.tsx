// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';

import {
  getNetWorthOptions,
  listAccountsOptions,
  recordManualBalanceMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
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

export interface RecordBalanceDialogProps {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * `POST /accounts/{id}/balance` (wp1.6-ui.md §7's carried-over "manual
 * balance entry has no route" item, closed by WP 2.5). Only for
 * `provider: "manual"` accounts — the account detail screen only ever shows
 * this button for one. Step-up gated, the same policy `connections.ts` uses
 * for every write that moves net worth (wp2.5-rules-api.md §2).
 */
export function RecordBalanceDialog({ account, open, onOpenChange }: RecordBalanceDialogProps) {
  const [amountText, setAmountText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stepUp = useStepUpRetry();
  const queryClient = useQueryClient();
  const recordBalance = useMutation({
    ...recordManualBalanceMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listAccountsOptions().queryKey });
      void queryClient.invalidateQueries({ queryKey: getNetWorthOptions().queryKey });
    },
  });

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    let current;
    try {
      current = Money.toJSON(Money.parseAmount(amountText, account.currency));
    } catch {
      setError('Enter a valid amount.');
      return;
    }
    try {
      await stepUp.run(() =>
        recordBalance.mutateAsync({ path: { accountId: account.id }, body: { current } }),
      );
      setAmountText('');
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record this balance.');
    }
  }

  const busy = recordBalance.isPending || stepUp.busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Record a balance</DialogTitle>
        <DialogDescription>
          A new observation for {account.name}, as of now — it never edits a past reading.
        </DialogDescription>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-balance-amount">Current balance ({account.currency})</Label>
            <Input
              id="manual-balance-amount"
              inputMode="decimal"
              required
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              placeholder="0.00"
            />
          </div>
          {(error !== null || stepUp.error !== null) && (
            <p className="text-small text-status-danger-text">{error ?? stepUp.error}</p>
          )}
          <Button type="submit" disabled={busy || amountText.trim() === ''}>
            {busy ? 'Saving…' : 'Save balance'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
