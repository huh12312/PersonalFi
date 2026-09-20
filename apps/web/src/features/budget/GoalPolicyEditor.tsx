// SPDX-License-Identifier: MIT
import { useId, useState } from 'react';

import type { BudgetLine } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { useUpdateBudgetLineMutation } from './api.ts';

const GOAL_TYPE_LABELS: Record<BudgetLine['goalType'], string> = {
  NONE: 'No goal',
  MONTHLY_TARGET: 'Monthly target',
  TARGET_BY_DATE: 'Target by date',
  MINIMUM_BALANCE: 'Minimum balance',
  PCT_OF_INCOME: '% of income',
  REFILL_UP_TO: 'Refill up to',
};

const ROLLOVER_LABELS: Record<BudgetLine['rolloverPolicy'], string> = {
  ROLLOVER: 'Roll over',
  RESET: 'Reset to zero',
  ROLLOVER_ALLOW_NEGATIVE: 'Roll over (may go negative)',
};

export interface GoalPolicyEditorProps {
  line: BudgetLine;
}

/**
 * The per-line goal + rollover-policy editor (DELIVER item: "goal + rollover
 * policy editor per line"). A popover, not a full dialog — this is a quick
 * edit on one row, not a multi-field form worth a modal's focus trap and
 * "are you sure you want to close" weight.
 *
 * **Round-trips are honest about what the server does and doesn't echo
 * back.** `BudgetLine` (the `GET /budgets/current` read shape) carries
 * `goalType`/`rolloverPolicy`/`priority`/`class` but *not*
 * `goalAmount`/`goalTargetDate`/`goalPercent` — `PATCH /budgets/lines/{id}`
 * accepts all three as write-only fields (`wp2.r-routes.md` §4), so this
 * editor can set a goal amount but the form always opens blank on those
 * three inputs rather than pre-filled with a stale or fabricated guess. This
 * is a real gap (flagged in `docs/evidence/phase-2/wp2.9-budget-ui.md`), not
 * a bug in this component: re-opening the editor after a save shows the
 * fields that *did* round-trip (`neededThisPeriod`/`underfunded`, both
 * derived from the goal the server does remember) and nothing else.
 */
export function GoalPolicyEditor({ line }: GoalPolicyEditorProps) {
  const [open, setOpen] = useState(false);
  const [goalType, setGoalType] = useState<BudgetLine['goalType']>(line.goalType);
  const [rolloverPolicy, setRolloverPolicy] = useState<BudgetLine['rolloverPolicy']>(
    line.rolloverPolicy,
  );
  const [goalAmount, setGoalAmount] = useState('');
  const [goalTargetDate, setGoalTargetDate] = useState('');
  const [goalPercent, setGoalPercent] = useState('');
  const update = useUpdateBudgetLineMutation();
  const goalTypeId = useId();
  const rolloverId = useId();

  function handleSave(): void {
    update.mutate(
      {
        path: { lineId: line.id },
        body: {
          goalType,
          rolloverPolicy,
          goalAmount:
            goalType === 'NONE' || goalAmount.trim() === ''
              ? null
              : { minor: goalAmount, currency: line.assigned.currency },
          goalTargetDate:
            goalType === 'TARGET_BY_DATE' && goalTargetDate !== '' ? goalTargetDate : null,
          goalPercent: goalType === 'PCT_OF_INCOME' && goalPercent !== '' ? goalPercent : null,
        },
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm">
            Goal &amp; rollover
          </Button>
        }
      />
      <PopoverContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={goalTypeId}>Goal type</Label>
            <select
              id={goalTypeId}
              className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small"
              value={goalType}
              onChange={(event) => setGoalType(event.target.value as BudgetLine['goalType'])}
            >
              {Object.entries(GOAL_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {goalType !== 'NONE' && goalType !== 'PCT_OF_INCOME' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${goalTypeId}-amount`}>Goal amount (minor units)</Label>
              <Input
                id={`${goalTypeId}-amount`}
                inputMode="numeric"
                placeholder="e.g. 50000 for $500.00"
                value={goalAmount}
                onChange={(event) => setGoalAmount(event.target.value)}
              />
            </div>
          )}

          {goalType === 'TARGET_BY_DATE' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${goalTypeId}-date`}>Target date</Label>
              <Input
                id={`${goalTypeId}-date`}
                type="date"
                value={goalTargetDate}
                onChange={(event) => setGoalTargetDate(event.target.value)}
              />
            </div>
          )}

          {goalType === 'PCT_OF_INCOME' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${goalTypeId}-percent`}>Percent of income</Label>
              <Input
                id={`${goalTypeId}-percent`}
                inputMode="decimal"
                placeholder="e.g. 0.10 for 10%"
                value={goalPercent}
                onChange={(event) => setGoalPercent(event.target.value)}
              />
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label htmlFor={rolloverId}>Rollover policy</Label>
            <select
              id={rolloverId}
              className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small"
              value={rolloverPolicy}
              onChange={(event) =>
                setRolloverPolicy(event.target.value as BudgetLine['rolloverPolicy'])
              }
            >
              {Object.entries(ROLLOVER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {update.isError && (
            <p role="alert" className="text-caption text-status-critical">
              Could not save — try again.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
