// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { Goal } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { ProjectionProblem } from '../plan/ProjectionProblem.tsx';
import { useCreateGoalMutation, useUpdateGoalMutation } from './api.ts';
import { GOAL_KIND_LABELS, GOAL_STATUS_LABELS, SELECT_CLASS } from './labels.ts';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = Object.keys(GOAL_KIND_LABELS) as Goal['kind'][];
const STATUSES = Object.keys(GOAL_STATUS_LABELS) as Goal['status'][];

/** `1250000` minor units → `"12500"` — what the amount field shows when a goal is opened for editing. */
function minorToDollars(minor: string): string {
  const major = BigInt(minor) / 100n;
  const cents = BigInt(minor) % 100n;
  return cents === 0n
    ? major.toString()
    : `${major.toString()}.${cents.toString().padStart(2, '0')}`;
}

export interface GoalDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The goal being edited; absent for a new one. */
  readonly goal?: Goal;
}

/**
 * Create or edit one goal (`POST /goals`, `PATCH /goals/{goalId}`). A real dialog: focus moves into it,
 * Tab stays inside, Escape closes it, and focus returns to the control that opened it — so the whole
 * flow is operable by keyboard. A dollar figure becomes minor units once, here, through `@core/kernel`'s
 * `Money` (`docs/CONVENTIONS.md`: no client-side money math beyond parsing and formatting).
 */
export function GoalDialog({ open, onOpenChange, goal }: GoalDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <GoalForm key={goal?.id ?? 'new'} goal={goal} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function GoalForm({ goal, onDone }: { readonly goal?: Goal; readonly onDone: () => void }) {
  const id = useId();
  const create = useCreateGoalMutation();
  const update = useUpdateGoalMutation();
  const [name, setName] = useState(goal?.name ?? '');
  const [kind, setKind] = useState<Goal['kind']>(goal?.kind ?? 'custom');
  const [target, setTarget] = useState(goal === undefined ? '' : minorToDollars(goal.target.minor));
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [priority, setPriority] = useState(String(goal?.priority ?? 3));
  const [status, setStatus] = useState<Goal['status']>(goal?.status ?? 'active');
  const [formError, setFormError] = useState<string | null>(null);

  const pending = create.isPending || update.isPending;
  const failure = create.isError ? create.error : update.isError ? update.error : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);
    if (name.trim() === '') {
      setFormError('Give the goal a name.');
      return;
    }
    if (!DATE_PATTERN.test(targetDate)) {
      setFormError('Choose the date you want to reach it by.');
      return;
    }
    let money;
    try {
      money = MoneyKernel.toJSON(
        MoneyKernel.parseAmount(target.trim(), goal?.target.currency ?? 'USD'),
      );
    } catch {
      setFormError('The target must be a plain dollar amount, for example 25000.');
      return;
    }
    const body = {
      name: name.trim(),
      target: money,
      targetDate,
      priority: Number(priority),
    };
    if (goal === undefined) {
      create.mutate({ body: { ...body, kind } }, { onSuccess: onDone });
    } else {
      update.mutate(
        { path: { goalId: goal.id }, body: { ...body, status } },
        { onSuccess: onDone },
      );
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div>
        <DialogTitle>{goal === undefined ? 'Add a goal' : `Edit ${goal.name}`}</DialogTitle>
        <DialogDescription className="mt-1 text-small text-text-secondary">
          A goal is something you are saving toward, with an amount and a date.
        </DialogDescription>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={96}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </div>

      {goal === undefined && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-kind`}>Kind</Label>
          <select
            id={`${id}-kind`}
            className={SELECT_CLASS}
            value={kind}
            onChange={(e) => setKind(e.target.value as Goal['kind'])}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {GOAL_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-target`}>Target amount</Label>
          <Input
            id={`${id}-target`}
            inputMode="decimal"
            placeholder="25000"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-date`}>Target date</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-priority`}>Priority</Label>
          <select
            id={`${id}-priority`}
            className={SELECT_CLASS}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            aria-describedby={`${id}-priority-hint`}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={String(value)}>
                {value}
              </option>
            ))}
          </select>
          <span id={`${id}-priority-hint`} className="text-caption text-text-muted">
            1 to 5. A goal you leave unranked is a 3.
          </span>
        </div>
        {goal !== undefined && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-status`}>Status</Label>
            <select
              id={`${id}-status`}
              className={SELECT_CLASS}
              value={status}
              onChange={(e) => setStatus(e.target.value as Goal['status'])}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {GOAL_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {formError !== null && (
        <p role="alert" className="text-small text-status-danger-text">
          {formError}
        </p>
      )}
      {failure !== null && <ProjectionProblem error={failure} />}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : goal === undefined ? 'Add goal' : 'Save goal'}
        </Button>
      </div>
    </form>
  );
}
