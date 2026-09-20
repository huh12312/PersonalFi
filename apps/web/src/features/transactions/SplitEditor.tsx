// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import type { Money as MoneyType } from '@core/kernel';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import {
  clearTransactionSplitsMutation,
  getTransactionOptions,
  setTransactionSplitsMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { TransactionDetail } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Money as MoneyText } from '../../components/finance/Money.tsx';
import { formatMoney } from '../../lib/money.ts';
import { CategoryPicker } from './CategoryPicker.tsx';
import {
  applyDirection,
  isBalanced,
  parseSplitMagnitude,
  remainder,
  splitEvenly,
} from './split-math.ts';

interface DraftLine {
  key: string;
  amount: MoneyType;
  amountText: string;
  userCategoryId: string | null;
  note: string;
}

let lineKeySeed = 0;
function nextKey(): string {
  lineKeySeed += 1;
  return `split-${String(lineKeySeed)}`;
}

function draftFromMoney(amount: MoneyType, userCategoryId: string | null, note: string): DraftLine {
  return {
    key: nextKey(),
    amount,
    amountText: Money.formatAmount(Money.absolute(amount)),
    userCategoryId,
    note,
  };
}

function seedLines(transaction: TransactionDetail): DraftLine[] {
  const total = Money.fromJSON(transaction.amount);
  if (transaction.splits.length > 0) {
    return transaction.splits
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((split) =>
        draftFromMoney(Money.fromJSON(split.amount), split.userCategoryId, split.note ?? ''),
      );
  }
  return splitEvenly(total, 2).map((share) => draftFromMoney(share, null, ''));
}

export interface SplitEditorProps {
  transaction: TransactionDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The split editor (05 §5.5), over `POST`/`DELETE /transactions/{id}/splits`.
 * A dedicated dialog, not an inline row edit — "splitting in a row is too
 * cramped" is the memo's own reasoning, and it holds here: the live remainder
 * is "the emotional centre of the UI" and needs room of its own.
 *
 * Amounts are typed as plain magnitudes and travel in bigint minor units end
 * to end (`split-math.ts`, `@core/kernel`'s `Money`) — no `number` ever
 * touches the wire amount. Save is disabled until the remainder is exactly
 * zero, the must-balance invariant `split-math.ts#isBalanced` is named for.
 */
export function SplitEditor({ transaction, open, onOpenChange }: SplitEditorProps) {
  const total = Money.fromJSON(transaction.amount);
  const [lines, setLines] = useState<DraftLine[]>(() => seedLines(transaction));
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      // Re-seeds the draft every time the sheet opens for this transaction —
      // an external-data sync (the transaction's own splits), not a
      // derived-during-render value.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLines(seedLines(transaction));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on open, not on every keystroke this component itself makes to `transaction` (it never mutates its own prop)
  }, [open, transaction.id]);

  const save = useMutation({
    ...setTransactionSplitsMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getTransactionOptions({ path: { transactionId: transaction.id } }).queryKey,
      });
      onOpenChange(false);
    },
  });

  const clear = useMutation({
    ...clearTransactionSplitsMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getTransactionOptions({ path: { transactionId: transaction.id } }).queryKey,
      });
      onOpenChange(false);
    },
  });

  const left = remainder(
    total,
    lines.map((line) => line.amount),
  );
  const balanced = isBalanced(
    total,
    lines.map((line) => line.amount),
  );
  const hadSplits = transaction.splits.length > 0;

  function updateLine(key: string, patch: Partial<DraftLine>): void {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function setAmountText(key: string, text: string): void {
    let amount: MoneyType;
    try {
      amount = applyDirection(parseSplitMagnitude(text, total.currency), total);
    } catch {
      amount = Money.zero(total.currency);
    }
    updateLine(key, { amountText: text, amount });
  }

  function addLine(): void {
    setLines((prev) => [...prev, draftFromMoney(Money.zero(total.currency), null, '')]);
  }

  function removeLine(key: string): void {
    setLines((prev) => prev.filter((line) => line.key !== key));
  }

  function assignRemainderTo(key: string): void {
    setLines((prev) =>
      prev.map((line) =>
        line.key === key
          ? {
              ...line,
              amount: Money.add(line.amount, left),
              amountText: Money.formatAmount(Money.absolute(Money.add(line.amount, left))),
            }
          : line,
      ),
    );
  }

  function splitAllEvenly(): void {
    const shares = splitEvenly(total, lines.length);
    setLines((prev) =>
      prev.map((line, index) => {
        const share = shares[index] ?? Money.zero(total.currency);
        return { ...line, amount: share, amountText: Money.formatAmount(Money.absolute(share)) };
      }),
    );
  }

  function handleSave(): void {
    setError(null);
    if (!balanced) return;
    if (lines.length < 2) {
      setError('A split needs at least two lines.');
      return;
    }
    save.mutate({
      path: { transactionId: transaction.id },
      body: {
        splits: lines.map((line) => ({
          amount: Money.toJSON(line.amount),
          userCategoryId: line.userCategoryId,
          note: line.note === '' ? null : line.note,
        })),
      },
    });
  }

  const remainderLabel = balanced
    ? 'Balanced'
    : `${formatMoney(Money.absolute(left), { signDisplay: 'never' })} unallocated`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Split this transaction</DialogTitle>
        <DialogDescription>
          Original amount <MoneyText value={transaction.amount} colorBySign={false} />
        </DialogDescription>

        <p
          role="status"
          aria-live="polite"
          className={
            balanced
              ? 'mt-3 text-small font-medium text-money-neutral'
              : 'mt-3 text-small font-medium text-status-warning'
          }
        >
          {remainderLabel}
        </p>

        <div className="mt-3 flex flex-col gap-3">
          {lines.map((line, index) => (
            <SplitLineRow
              key={line.key}
              index={index}
              line={line}
              currency={total.currency}
              removable={lines.length > 2}
              onAmountChange={(text) => setAmountText(line.key, text)}
              onCategoryChange={(categoryId) =>
                updateLine(line.key, { userCategoryId: categoryId })
              }
              onNoteChange={(note) => updateLine(line.key, { note })}
              onAssignRemainder={() => assignRemainderTo(line.key)}
              onRemove={() => removeLine(line.key)}
            />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={addLine} className="gap-1.5">
            <Plus size={14} aria-hidden="true" />
            Add line
          </Button>
          <Button variant="secondary" size="sm" onClick={splitAllEvenly}>
            Split evenly
          </Button>
          {hadSplits && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-status-critical"
              disabled={clear.isPending}
              onClick={() => clear.mutate({ path: { transactionId: transaction.id } })}
            >
              Remove splits
            </Button>
          )}
        </div>

        {error !== null && <p className="mt-2 text-small text-status-critical">{error}</p>}
        {save.isError && (
          <p className="mt-2 text-small text-status-critical">
            {save.error instanceof Error ? save.error.message : 'Could not save these splits.'}
          </p>
        )}

        <Button className="mt-4 w-full" disabled={!balanced || save.isPending} onClick={handleSave}>
          {save.isPending ? 'Saving…' : 'Save splits'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

interface SplitLineRowProps {
  index: number;
  line: DraftLine;
  currency: string;
  removable: boolean;
  onAmountChange: (text: string) => void;
  onCategoryChange: (categoryId: string | null) => void;
  onNoteChange: (note: string) => void;
  onAssignRemainder: () => void;
  onRemove: () => void;
}

function SplitLineRow({
  index,
  line,
  removable,
  onAmountChange,
  onCategoryChange,
  onNoteChange,
  onAssignRemainder,
  onRemove,
}: SplitLineRowProps) {
  const amountId = useId();
  const noteId = useId();
  return (
    <div className="rounded-md border border-border-hairline p-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={amountId} className="sr-only">
          Line {index + 1} amount
        </Label>
        <span aria-hidden="true" className="text-small text-text-muted">
          $
        </span>
        <Input
          id={amountId}
          inputMode="decimal"
          value={line.amountText}
          onChange={(event) => onAmountChange(event.target.value)}
          className="w-28"
        />
        <CategoryPicker
          value={line.userCategoryId}
          onChange={onCategoryChange}
          className="flex-1"
        />
        {removable && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove line ${String(index + 1)}`}
            onClick={onRemove}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Label htmlFor={noteId} className="sr-only">
          Line {index + 1} note
        </Label>
        <Input
          id={noteId}
          placeholder="Note (optional)"
          value={line.note}
          onChange={(event) => onNoteChange(event.target.value)}
          className="h-8 flex-1"
        />
        <Button variant="link" size="sm" onClick={onAssignRemainder} className="shrink-0">
          Assign remainder
        </Button>
      </div>
    </div>
  );
}
