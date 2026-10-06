// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { runPlanProjectionMutation } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { RunPlanProjectionResponse } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { TAX_LABELS, ROLE_LABELS, VALUATION_LABELS } from './overlay-labels.ts';
import { useAccountsLookup } from './useAccountsLookup.ts';

type Staleness = NonNullable<RunPlanProjectionResponse['staleness']>;
type OverrideChange = Extract<
  Staleness,
  { reason: 'account_overrides_changed' }
>['changes'][number];

function valueText(field: OverrideChange['field'], value: string | null): string {
  if (value === null) return 'default';
  const table: Readonly<Record<string, string>> =
    field === 'taxTreatment' ? TAX_LABELS : field === 'role' ? ROLE_LABELS : VALUATION_LABELS;
  return table[value] ?? value;
}

const FIELD_TEXT: Readonly<Record<OverrideChange['field'], string>> = {
  taxTreatment: 'tax treatment',
  role: 'role',
  valuation: 'valuation',
};

export interface ProjectionOverridesNoticeProps {
  /** The plan screen's current projection outcome. */
  projection: RunPlanProjectionResponse | undefined;
  scenarioId: string | undefined;
}

/**
 * The plan says so when the numbers on it were computed before the holder
 * changed what an account is (WP 9.2). The server returns the stored run
 * `stale` and computes nothing; this names each change and offers the explicit
 * recompute — `acceptAccountChanges`, the holder saying they know. Nothing
 * here recomputes by itself.
 *
 * Renders nothing for any other staleness reason or for a fresh projection.
 */
export function ProjectionOverridesNotice({
  projection,
  scenarioId,
}: ProjectionOverridesNoticeProps) {
  const { nameOf } = useAccountsLookup();
  const queryClient = useQueryClient();
  const recompute = useMutation({
    ...runPlanProjectionMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const head = query.queryKey[0] as { _id?: unknown } | undefined;
          return head?._id === 'runPlanProjection';
        },
      });
    },
  });

  const staleness = projection?.staleness ?? null;
  if (staleness === null || staleness.reason !== 'account_overrides_changed') return null;

  return (
    <div
      role="status"
      data-testid="projection-stale-notice"
      className="flex flex-col gap-2 rounded-md border border-status-warning bg-bg-subtle p-3 text-small text-text-primary"
    >
      <p>
        <strong className="font-semibold">This projection is out of date.</strong> You changed
        account settings after it was computed, so the figures below still use the old ones:
      </p>
      <ul className="list-disc pl-5">
        {staleness.changes.map((change) => (
          <li key={`${change.accountId}:${change.field}`}>
            <Link
              to="/accounts/$accountId"
              params={{ accountId: change.accountId }}
              className="font-medium text-text-primary underline"
            >
              {nameOf(change.accountId)}
            </Link>
            : {FIELD_TEXT[change.field]} was {valueText(change.field, change.from)}, now{' '}
            {valueText(change.field, change.to)}
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          size="sm"
          disabled={recompute.isPending || scenarioId === undefined}
          onClick={() =>
            scenarioId !== undefined &&
            recompute.mutate({ path: { scenarioId }, body: { acceptAccountChanges: true } })
          }
        >
          {recompute.isPending ? 'Recomputing…' : 'Recompute with my current settings'}
        </Button>
      </div>
      {recompute.isError && (
        <p className="text-status-critical" role="alert">
          Could not recompute. Try again.
        </p>
      )}
    </div>
  );
}
