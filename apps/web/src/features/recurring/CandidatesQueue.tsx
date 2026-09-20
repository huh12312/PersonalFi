// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';

import {
  confirmRecurringCandidateMutation,
  getRecurringUpcomingQueryKey,
  getSafeToSpendQueryKey,
  listRecurringCandidatesQueryKey,
  listRecurringSeriesQueryKey,
  rejectRecurringCandidateMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { RecurringCandidate } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { formatCadenceLabel, formatStreamTypeLabel } from './cadence-format.ts';
import { RejectCandidateDialog, type RejectCandidateResult } from './RejectCandidateDialog.tsx';

export interface CandidatesQueueProps {
  candidates: readonly RecurringCandidate[];
  nameOf: (merchantId: string) => string;
}

/**
 * The candidate inbox (02-phase-2-dispatch.md §3): one-tap confirm, or reject
 * behind the permanent-override warning (`RejectCandidateDialog.tsx`).
 * Confirming pins the series (`user_confirmed = true`, never lowered by a
 * later pass — wp2.3-recurring.md §2); rejecting writes the
 * `merchantKey → NOT_RECURRING` override.
 */
export function CandidatesQueue({ candidates, nameOf }: CandidatesQueueProps) {
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<RecurringCandidate | null>(null);

  function invalidateAll(): void {
    void queryClient.invalidateQueries({ queryKey: listRecurringCandidatesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: listRecurringSeriesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getRecurringUpcomingQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getSafeToSpendQueryKey() });
  }

  const confirm = useMutation({
    ...confirmRecurringCandidateMutation(),
    onSuccess: invalidateAll,
  });
  const reject = useMutation({
    ...rejectRecurringCandidateMutation(),
    onSuccess: () => {
      invalidateAll();
      setRejecting(null);
    },
  });

  if (candidates.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        headline="No new subscriptions to confirm"
        description="When PersonalFi notices a new recurring pattern, it will ask you here before treating it as one."
      />
    );
  }

  return (
    <>
      <ul aria-label="Recurring candidates awaiting a decision" className="flex flex-col gap-2">
        {candidates.map((candidate) => (
          <li
            key={candidate.candidateId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-body font-medium text-text-primary">
                {nameOf(candidate.merchantId)}
              </p>
              <p className="text-small text-text-muted">
                {formatStreamTypeLabel(candidate.type)} · {formatCadenceLabel(candidate.cadence)}
              </p>
            </div>
            <Money value={candidate.amount} className="shrink-0" />
            <Badge variant="neutral" className="shrink-0">
              {Math.round(candidate.confidence * 100)}% confident
            </Badge>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setRejecting(candidate)}
                disabled={reject.isPending || confirm.isPending}
              >
                Reject
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  confirm.mutate({ path: { candidateId: candidate.candidateId }, body: {} })
                }
                disabled={reject.isPending || confirm.isPending}
              >
                {confirm.isPending && confirm.variables?.path.candidateId === candidate.candidateId
                  ? 'Confirming…'
                  : 'Confirm'}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {rejecting !== null && (
        <RejectCandidateDialog
          open
          onOpenChange={(next) => !next && setRejecting(null)}
          merchantName={nameOf(rejecting.merchantId)}
          busy={reject.isPending}
          onReject={(result: RejectCandidateResult) =>
            reject.mutate({
              path: { candidateId: rejecting.candidateId },
              body: { scope: result.scope, reason: result.reason },
            })
          }
        />
      )}
    </>
  );
}
