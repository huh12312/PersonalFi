// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  getAdvisorKindEnabledOptions,
  getAdvisorKindEnabledQueryKey,
  setAdvisorKindEnabledMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { kindStateWords } from './kill-levels.ts';

export interface KindSwitchProps {
  readonly kind: 'local_model';
}

function problemMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const problem = error as Partial<Problem>;
    return `${problem.title ?? fallback} (${String(problem.code)})${
      problem.detail !== undefined ? ` — ${problem.detail}` : ''
    }`;
  }
  return fallback;
}

/**
 * Level 2 of the kill ladder, `PUT /advisors/kinds/{kind}/enabled`
 * (`advisors.kind.local_model`; `docs/plan/05-phase-5-dispatch.md` §3 WP
 * 5.1/5.10 — only `local_model` has a declared flag today, else the route
 * 404s `insights.kind_flag_not_found`, so this component is not offered a
 * `kind` prop wider than that).
 *
 * Since WP 9.6 (item 2) the screen shows the state the api reports
 * (`GET /advisors/kinds/{kind}/enabled`: the flag, whether this deployment has
 * a model configured, and both together), in words, instead of "the last
 * write". The two buttons stay buttons, each naming exactly what it sends: a
 * change is a passkey step-up, and the line above them is re-read from the api
 * after every write, never assumed. If the read fails the screen says so and
 * still offers the writes.
 */
export function KindSwitch({ kind }: KindSwitchProps) {
  const stepUp = useStepUpRetry();
  const mutation = useMutation(setAdvisorKindEnabledMutation());
  const query = useQuery(getAdvisorKindEnabledOptions({ path: { kind } }));
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  async function set(enabled: boolean): Promise<void> {
    setError(null);
    try {
      await stepUp.run(() => mutation.mutateAsync({ path: { kind }, body: { enabled } }));
      await queryClient.invalidateQueries({
        queryKey: getAdvisorKindEnabledQueryKey({ path: { kind } }),
      });
    } catch (cause) {
      setError(problemMessage(cause, 'The kind switch could not be changed.'));
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border-hairline bg-bg-surface p-3"
      data-testid="kind-switch"
    >
      <p className="text-small font-medium text-text-primary">Level 2 — kind: {kind}</p>
      {query.data !== undefined ? (
        <p className="text-small text-text-secondary" role="status" data-testid="kind-state-words">
          {kindStateWords(query.data)}
        </p>
      ) : query.isLoading ? null : (
        <p className="text-small text-status-critical" data-testid="kind-state-error">
          {problemMessage(query.error, 'This level’s state could not be read.')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => void set(true)}
          disabled={stepUp.busy || mutation.isPending}
        >
          Enable {kind}
        </Button>
        <Button
          variant="destructive"
          onClick={() => void set(false)}
          disabled={stepUp.busy || mutation.isPending}
        >
          Disable {kind}
        </Button>
      </div>
      {error !== null && <p className="text-small text-status-critical">{error}</p>}
      {stepUp.error !== null && <p className="text-small text-status-critical">{stepUp.error}</p>}
    </div>
  );
}
