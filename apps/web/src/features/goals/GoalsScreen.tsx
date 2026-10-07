// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { Target } from 'lucide-react';
import { useId, useState } from 'react';

import type { Goal } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { ConfirmDialog } from '../../components/patterns/ConfirmDialog.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { ProjectionProblem } from '../plan/ProjectionProblem.tsx';
import { useDeleteGoalMutation, useGoalsQuery } from './api.ts';
import { ContributionsPanel } from './ContributionsPanel.tsx';
import { GoalDialog } from './GoalDialog.tsx';
import { GOAL_KIND_LABELS, GOAL_STATUS_LABELS } from './labels.ts';
import { RiskQuestionnaire } from './RiskQuestionnaire.tsx';

/**
 * `/goals` (WP 9.7, C-10): what the holder is saving toward, what funds it, and the risk questionnaire
 * the plan reads. Goal CRUD and contributions run over `/goals`; the questionnaire over `/risk-profile`.
 * Every control is a native button, input, select or a real dialog, so the whole screen is operable by
 * keyboard. Earmarks have no route and are not here.
 */
export function GoalsScreen() {
  const goalsQuery = useGoalsQuery();
  const [creating, setCreating] = useState(false);
  const goals = goalsQuery.data?.goals ?? [];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h2 className="text-h2 font-semibold text-text-primary">Goals</h2>
        <p className="text-body text-text-secondary">
          What you are saving toward. Your{' '}
          <Link to="/plan" className="text-text-primary underline underline-offset-4">
            plan
          </Link>{' '}
          shows how your savings are projected to grow.
        </p>
      </header>

      <section aria-labelledby="goals-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="goals-heading" className="text-h3 font-semibold text-text-primary">
            Your goals
          </h2>
          <Button type="button" onClick={() => setCreating(true)}>
            Add goal
          </Button>
        </div>

        {goalsQuery.isLoading && <Skeleton variant="block" height={120} />}
        {goalsQuery.isError && (
          <ProjectionProblem error={goalsQuery.error} onRetry={() => void goalsQuery.refetch()} />
        )}
        {goalsQuery.isSuccess && goals.length === 0 && (
          <EmptyState
            icon={Target}
            headline="No goals yet"
            description="Add something you are saving toward: a retirement date, an emergency fund, a purchase."
          />
        )}
        {goals.length > 0 && (
          <ul className="flex flex-col gap-4" data-testid="goals-list">
            {goals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </ul>
        )}
      </section>

      <RiskQuestionnaire />

      <GoalDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function GoalCard({ goal }: { readonly goal: Goal }) {
  const panelId = useId();
  const [editing, setEditing] = useState(false);
  const [funding, setFunding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useDeleteGoalMutation();

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border-hairline bg-bg-surface p-4"
      data-testid="goal"
      data-goal-id={goal.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-body font-semibold text-text-primary">{goal.name}</h3>
          <p className="text-small text-text-secondary">
            <Money value={goal.target} colorBySign={false} signDisplay="auto" /> by{' '}
            {goal.targetDate}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{GOAL_KIND_LABELS[goal.kind]}</Badge>
            <Badge variant="accent">{GOAL_STATUS_LABELS[goal.status]}</Badge>
            <span className="text-caption text-text-muted">Priority {goal.priority}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={funding}
            aria-controls={panelId}
            onClick={() => setFunding((open) => !open)}
          >
            {funding ? 'Hide contributions' : 'Contributions'}
            <span className="sr-only"> for {goal.name}</span>
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit<span className="sr-only"> {goal.name}</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleting(true)}>
            Delete<span className="sr-only"> {goal.name}</span>
          </Button>
        </div>
      </div>

      {funding && <ContributionsPanel goal={goal} panelId={panelId} />}
      {remove.isError && <ProjectionProblem error={remove.error} />}

      <GoalDialog open={editing} onOpenChange={setEditing} goal={goal} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${goal.name}?`}
        description="The goal and the contributions saved against it are deleted. This cannot be undone."
        confirmLabel="Delete goal"
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate({ path: { goalId: goal.id } }, { onSettled: () => setDeleting(false) })
        }
      />
    </li>
  );
}
