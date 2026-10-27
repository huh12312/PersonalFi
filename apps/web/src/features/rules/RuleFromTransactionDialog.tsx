// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { ComponentProps } from 'react';

import type { RuleApplyResult, TransactionDetail } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useCategories } from '../categories/useCategories.ts';
import { CategoryPicker } from '../transactions/CategoryPicker.tsx';
import {
  useApplyRuleMutation,
  useCreateRuleFromTransactionMutation,
  usePreviewRuleMutation,
} from './useRules.ts';

export interface RuleFromTransactionDialogProps {
  transaction: TransactionDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * WP 11.1: the category the picker starts on (a rule suggestion's own category), instead of the transaction's
   * current one. Only a starting value: the holder can change it, and nothing is created until they press Preview.
   */
  initialCategoryId?: string | null;
  /** WP 11.1: called once the rule exists (`POST /transactions/{id}/rule` succeeded), before any apply. */
  onRuleCreated?: (ruleId: string) => void;
  /** Where focus goes when the dialog closes (Base UI's `finalFocus`); default: back to what opened it. */
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}

type Stage = { kind: 'draft' } | { kind: 'previewed'; ruleId: string; result: RuleApplyResult };

/**
 * "Always categorise like this" (05 §5.4, wp1.6-ui.md §7's carried-over
 * item). The rule is created first — `POST /transactions/{id}/rule` — which
 * only ever affects future syncs (`runOnSync`); a **preview step is
 * non-negotiable** before touching any existing transaction (05 §5.4), so
 * the retroactive count comes from `POST /rules/preview` on the rule that
 * was just created, and only `POST /rules/{id}/apply` — a separate,
 * explicit click — actually recategorises anything that already exists.
 */
export function RuleFromTransactionDialog({
  transaction,
  open,
  onOpenChange,
  initialCategoryId,
  onRuleCreated,
  finalFocus,
}: RuleFromTransactionDialogProps) {
  const { byId } = useCategories();
  const startingCategoryId =
    initialCategoryId === undefined ? transaction.categoryId : initialCategoryId;
  const [categoryId, setCategoryId] = useState<string | null>(startingCategoryId);
  const [stage, setStage] = useState<Stage>({ kind: 'draft' });
  const [error, setError] = useState<string | null>(null);

  const createRule = useCreateRuleFromTransactionMutation();
  const previewRule = usePreviewRuleMutation();
  const applyRule = useApplyRuleMutation();

  function reset(): void {
    setStage({ kind: 'draft' });
    setError(null);
    setCategoryId(startingCategoryId);
  }

  async function handlePreview(): Promise<void> {
    setError(null);
    const category = categoryId !== null ? byId.get(categoryId) : undefined;
    if (category === undefined) {
      setError('Choose a category first.');
      return;
    }
    try {
      const created = await createRule.mutateAsync({
        path: { transactionId: transaction.id },
        body: {
          categoryKey: category.key,
          name: `${transaction.merchantName ?? transaction.name} → ${category.label}`,
        },
      });
      onRuleCreated?.(created.rule.id);
      const preview = await previewRule.mutateAsync({
        body: { ruleId: created.rule.id, retroactive: true },
      });
      setStage({ kind: 'previewed', ruleId: created.rule.id, result: preview });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create this rule.');
    }
  }

  async function handleApply(ruleId: string): Promise<void> {
    setError(null);
    try {
      await applyRule.mutateAsync({ path: { ruleId }, body: { retroactive: true } });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply this rule.');
    }
  }

  const busy = createRule.isPending || previewRule.isPending || applyRule.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <DialogTitle>Always categorize like this</DialogTitle>
        <DialogDescription>
          Every future transaction from {transaction.merchantName ?? transaction.name} will be
          categorized automatically.
        </DialogDescription>

        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="rule-category">Category</Label>
          <CategoryPicker
            id="rule-category"
            value={categoryId}
            onChange={setCategoryId}
            disabled={stage.kind === 'previewed' || busy}
            className="w-full"
          />
        </div>

        {stage.kind === 'previewed' && (
          <p
            className="mt-4 rounded-md bg-bg-subtle p-3 text-small text-text-secondary"
            role="status"
          >
            This will recategorize <strong>{stage.result.changedCount}</strong> existing transaction
            {stage.result.changedCount === 1 ? '' : 's'} ({stage.result.matchedCount} matched).
          </p>
        )}

        {error !== null && <p className="mt-2 text-small text-status-danger-text">{error}</p>}

        <div className="mt-4 flex flex-col gap-2">
          {stage.kind === 'draft' && (
            <Button disabled={busy || categoryId === null} onClick={() => void handlePreview()}>
              {busy ? 'Previewing…' : 'Preview'}
            </Button>
          )}
          {stage.kind === 'previewed' && (
            <>
              <Button disabled={busy} onClick={() => void handleApply(stage.ruleId)}>
                {busy
                  ? 'Applying…'
                  : `Apply to ${String(stage.result.changedCount)} transaction${stage.result.changedCount === 1 ? '' : 's'}`}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
                Just save the rule
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
