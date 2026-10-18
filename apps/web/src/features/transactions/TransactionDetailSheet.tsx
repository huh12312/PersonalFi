// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, SplitSquareHorizontal, Tags } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  getTransactionOptions,
  rejectTransferMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { RuleFromTransactionDialog } from '../rules/RuleFromTransactionDialog.tsx';
import { CategoryPicker } from './CategoryPicker.tsx';
import { SplitEditor } from './SplitEditor.tsx';
import { TransferPairDialog } from './TransferPairDialog.tsx';
import { useTransactionOverlayMutation } from './useTransactionOverlay.ts';

export interface TransactionDetailSheetProps {
  transactionId: string | null;
  accountName: (accountId: string) => string;
  onOpenChange: (open: boolean) => void;
}

/**
 * The detail panel (deliverable 1): inline note/category edit via the
 * overlay endpoint (`PATCH /transactions/{id}`), pending vs posted, and a
 * transfer pair shown as such (with a "Not a transfer" unpair action —
 * `POST /transfers/{id}/reject`). Splits and rule-from-transaction are out of
 * scope for this pass (see docs/evidence/phase-1/wp1.6-ui.md).
 */
export function TransactionDetailSheet({
  transactionId,
  accountName,
  onOpenChange,
}: TransactionDetailSheetProps) {
  const open = transactionId !== null;
  const detailQuery = useQuery({
    ...getTransactionOptions({ path: { transactionId: transactionId ?? '' } }),
    enabled: open,
  });
  const overlay = useTransactionOverlayMutation();
  const queryClient = useQueryClient();
  const rejectTransfer = useMutation(rejectTransferMutation());

  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [splitEditorOpen, setSplitEditorOpen] = useState(false);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [pairDialogOpen, setPairDialogOpen] = useState(false);

  useEffect(() => {
    // Re-seeds the editable draft whenever a *different* transaction's data
    // arrives (opening a new row, or this row's own fetch resolving) — an
    // external-data sync, not a derived-during-render value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNote(detailQuery.data?.note ?? '');
    setSavedNote('idle');
  }, [detailQuery.data?.id, detailQuery.data?.note]);

  const transaction = detailQuery.data;

  function commitNote(): void {
    if (transaction === undefined || note === (transaction.note ?? '')) return;
    setSavedNote('saving');
    overlay.mutate(
      { path: { transactionId: transaction.id }, body: { note: note === '' ? null : note } },
      { onSettled: () => setSavedNote('saved') },
    );
  }

  function handleCategoryChange(categoryId: string | null): void {
    if (transaction === undefined) return;
    overlay.mutate({ path: { transactionId: transaction.id }, body: { categoryId } });
  }

  function handleRejectTransfer(): void {
    if (transaction === undefined) return;
    rejectTransfer.mutate(
      { path: { transactionId: transaction.id }, body: {} },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: getTransactionOptions({ path: { transactionId: transaction.id } }).queryKey,
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet" aria-describedby={undefined}>
        {transaction === undefined ? (
          <DialogTitle>Loading…</DialogTitle>
        ) : (
          <>
            <DialogTitle>{transaction.merchantName ?? transaction.name}</DialogTitle>
            <DialogDescription>{accountName(transaction.accountId)}</DialogDescription>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-small text-text-muted">{formatDateOnly(transaction.date)}</span>
              <Money value={transaction.amount} className="text-h2" />
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              {transaction.pending && <Badge variant="neutral">Pending</Badge>}
              {!transaction.pending && <Badge variant="success">Posted</Badge>}
              {transaction.excluded && <Badge variant="warning">Excluded from totals</Badge>}
              {transaction.isTransfer && (
                <Badge variant="accent" icon={<ArrowLeftRight size={11} aria-hidden="true" />}>
                  Transfer
                </Badge>
              )}
            </div>

            {transaction.transfer !== null && (
              <div className="mt-4 rounded-md bg-bg-subtle p-3 text-small text-text-secondary">
                <p>
                  Paired {transaction.transfer.direction === 'outflow' ? 'to' : 'from'} another
                  account,{' '}
                  {transaction.transfer.dayGap === 0
                    ? 'same day'
                    : `${transaction.transfer.dayGap} day${transaction.transfer.dayGap === 1 ? '' : 's'} apart`}
                  .
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1"
                  onClick={handleRejectTransfer}
                  disabled={rejectTransfer.isPending}
                >
                  Not a transfer
                </Button>
              </div>
            )}

            {transaction.transfer === null && !transaction.isTransfer && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 gap-1.5"
                onClick={() => setPairDialogOpen(true)}
              >
                <ArrowLeftRight size={14} aria-hidden="true" />
                Pair as transfer
              </Button>
            )}

            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor="transaction-category">Category</Label>
              <CategoryPicker
                id="transaction-category"
                value={transaction.categoryId}
                onChange={handleCategoryChange}
                disabled={overlay.isPending}
                className="w-full"
              />
              <Button
                variant="link"
                size="sm"
                className="w-fit gap-1.5 px-0"
                onClick={() => setRuleDialogOpen(true)}
              >
                <Tags size={14} aria-hidden="true" />
                Always categorize like this
              </Button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => setSplitEditorOpen(true)}
              >
                <SplitSquareHorizontal size={14} aria-hidden="true" />
                {transaction.splits.length > 0
                  ? `${String(transaction.splits.length)} splits`
                  : 'Split'}
              </Button>
            </div>

            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor="transaction-note">Note</Label>
              <textarea
                id="transaction-note"
                className="min-h-20 rounded-md border border-border-strong bg-bg-surface p-2 text-body text-text-primary focus-visible:outline-none"
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  setSavedNote('idle');
                }}
                onBlur={commitNote}
              />
              <span className="text-caption text-text-muted" aria-live="polite">
                {savedNote === 'saving' ? 'Saving…' : savedNote === 'saved' ? 'Saved' : ''}
              </span>
            </div>

            <SplitEditor
              transaction={transaction}
              open={splitEditorOpen}
              onOpenChange={setSplitEditorOpen}
            />
            <RuleFromTransactionDialog
              transaction={transaction}
              open={ruleDialogOpen}
              onOpenChange={setRuleDialogOpen}
            />
            <TransferPairDialog
              transaction={transaction}
              accountName={accountName}
              open={pairDialogOpen}
              onOpenChange={setPairDialogOpen}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
