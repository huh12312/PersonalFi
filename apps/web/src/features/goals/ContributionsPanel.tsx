// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { Goal, GoalContribution } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { ConfirmDialog } from '../../components/patterns/ConfirmDialog.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { ProjectionProblem } from '../plan/ProjectionProblem.tsx';
import {
  useContributionsQuery,
  useCreateContributionMutation,
  useDeleteContributionMutation,
} from './api.ts';
import { CADENCE_LABELS, SELECT_CLASS } from './labels.ts';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CADENCES = Object.keys(CADENCE_LABELS) as GoalContribution['cadence'][];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function describe(contribution: GoalContribution): string {
  return `${CADENCE_LABELS[contribution.cadence].toLowerCase()} from ${contribution.startsOn}`;
}

export interface ContributionsPanelProps {
  readonly goal: Goal;
  /** The id the toggle button points at (`aria-controls`). */
  readonly panelId: string;
}

/**
 * What funds one goal: the recurring contributions saved against it, and a form to add one
 * (`GET`/`POST /goals/{goalId}/contributions`, `DELETE …/{contributionId}`). A contribution the app
 * derived from the holder's own history says so, with the date it was derived as of; one they typed
 * says that. Removing one asks first.
 */
export function ContributionsPanel({ goal, panelId }: ContributionsPanelProps) {
  const query = useContributionsQuery(goal.id, true);
  const remove = useDeleteContributionMutation(goal.id);
  const [pendingRemoval, setPendingRemoval] = useState<GoalContribution | null>(null);

  const contributions = query.data?.contributions ?? [];

  return (
    <div
      id={panelId}
      role="region"
      aria-label={`Contributions to ${goal.name}`}
      className="flex flex-col gap-3 border-t border-border-hairline pt-3"
      data-testid={`contributions-${goal.id}`}
    >
      {query.isLoading && <p className="text-small text-text-muted">Loading contributions…</p>}
      {query.isError && (
        <ProjectionProblem error={query.error} onRetry={() => void query.refetch()} />
      )}
      {query.isSuccess && contributions.length === 0 && (
        <p className="text-small text-text-secondary">
          Nothing is set aside for this goal yet. Add a contribution below.
        </p>
      )}
      {contributions.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-hairline">
          {contributions.map((contribution) => (
            <li
              key={contribution.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="contribution"
            >
              <div className="flex flex-col gap-0.5 text-small">
                <span className="text-text-primary">
                  <Money value={contribution.amount} colorBySign={false} signDisplay="auto" />{' '}
                  {CADENCE_LABELS[contribution.cadence].toLowerCase()}
                </span>
                <span className="text-caption text-text-muted">
                  From {contribution.startsOn}
                  {contribution.endsOn === null ? '' : ` until ${contribution.endsOn}`}
                  {Number(contribution.escalationPct) > 0
                    ? `, rising ${contribution.escalationPct}% a year`
                    : ''}
                  {' · '}
                  {contribution.source === 'DERIVED'
                    ? `worked out from your history${contribution.derivedAsOf === null ? '' : ` as of ${contribution.derivedAsOf}`}`
                    : 'entered by you'}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove the ${describe(contribution)} contribution`}
                onClick={() => setPendingRemoval(contribution)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AddContributionForm goal={goal} />
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title="Remove this contribution?"
        description={
          pendingRemoval === null
            ? ''
            : `The ${describe(pendingRemoval)} contribution to ${goal.name} will be removed. The goal itself stays.`
        }
        confirmLabel="Remove contribution"
        busy={remove.isPending}
        onConfirm={() => {
          if (pendingRemoval === null) return;
          remove.mutate(
            { path: { goalId: goal.id, contributionId: pendingRemoval.id } },
            { onSettled: () => setPendingRemoval(null) },
          );
        }}
      />
    </div>
  );
}

function AddContributionForm({ goal }: { readonly goal: Goal }) {
  const id = useId();
  const create = useCreateContributionMutation(goal.id);
  const [cadence, setCadence] = useState<GoalContribution['cadence']>('monthly');
  const [amount, setAmount] = useState('');
  const [escalation, setEscalation] = useState('');
  const [startsOn, setStartsOn] = useState(todayIso());
  const [endsOn, setEndsOn] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);
    let money;
    try {
      money = MoneyKernel.toJSON(MoneyKernel.parseAmount(amount.trim(), goal.target.currency));
    } catch {
      setFormError('The amount must be a plain dollar figure, for example 500.');
      return;
    }
    if (!DATE_PATTERN.test(startsOn)) {
      setFormError('Choose the date the contribution starts.');
      return;
    }
    if (endsOn !== '' && !DATE_PATTERN.test(endsOn)) {
      setFormError('The end date is not a date.');
      return;
    }
    create.mutate(
      {
        path: { goalId: goal.id },
        body: {
          cadence,
          amount: money,
          startsOn,
          source: 'USER',
          ...(escalation.trim() === '' ? {} : { escalationPct: escalation.trim() }),
          ...(endsOn === '' ? {} : { endsOn }),
        },
      },
      {
        onSuccess: () => {
          setAmount('');
          setEscalation('');
          setEndsOn('');
        },
      },
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={`Add a contribution to ${goal.name}`}
      className="flex flex-col gap-3"
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-cadence`}>How often</Label>
          <select
            id={`${id}-cadence`}
            className={SELECT_CLASS}
            value={cadence}
            onChange={(e) => setCadence(e.target.value as GoalContribution['cadence'])}
          >
            {CADENCES.map((value) => (
              <option key={value} value={value}>
                {CADENCE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-amount`}>Amount each time</Label>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            placeholder="500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-escalation`}>Yearly increase, %</Label>
          <Input
            id={`${id}-escalation`}
            inputMode="decimal"
            placeholder="0"
            value={escalation}
            onChange={(e) => setEscalation(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-starts`}>Starts on</Label>
          <Input
            id={`${id}-starts`}
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-ends`}>Ends on (optional)</Label>
          <Input
            id={`${id}-ends`}
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
        </div>
      </div>
      {formError !== null && (
        <p role="alert" className="text-small text-status-danger-text">
          {formError}
        </p>
      )}
      {create.isError && <ProjectionProblem error={create.error} />}
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add contribution'}
        </Button>
      </div>
    </form>
  );
}
