// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  getAdvisorModuleEnabledOptions,
  getAdvisorModuleEnabledQueryKey,
  setAdvisorModuleEnabledMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { MODULE_LEVEL_WORDS, moduleStateWords } from './kill-levels.ts';

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
 * Level 1 of the kill ladder, both halves, as the api reports them
 * (`GET /advisors/module/enabled`, WP 9.6 item 2, G5-14).
 *
 * The operator half (`ADVISORS_ENABLED`) is shown and cannot be changed here:
 * it is the deployment's setting, changed by a restart. The holder's half
 * (`module.insights`) is a switch that is rendered only once its position has
 * been read — a switch in a position nobody read would be the guess the Phase
 * 4 gate warned about — and flips with `PUT /advisors/module/enabled`, which
 * needs a fresh session (a passkey step-up), like every other kill switch.
 */
export function ModuleSwitch() {
  const query = useQuery(getAdvisorModuleEnabledOptions());
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const mutation = useMutation(setAdvisorModuleEnabledMutation());
  const [error, setError] = useState<string | null>(null);

  async function set(enabled: boolean): Promise<void> {
    setError(null);
    try {
      const result = await stepUp.run(() => mutation.mutateAsync({ body: { enabled } }));
      queryClient.setQueryData(getAdvisorModuleEnabledQueryKey(), result);
    } catch (cause) {
      setError(problemMessage(cause, 'The module switch could not be changed.'));
    }
  }

  if (query.isLoading) return <SkeletonText lines={2} />;

  const state = query.data;

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-border-hairline bg-bg-subtle p-3 text-caption text-text-secondary"
      data-testid="module-level-note"
    >
      <p>{MODULE_LEVEL_WORDS}</p>
      {state === undefined ? (
        <p className="text-status-critical" data-testid="module-state-error">
          {problemMessage(query.error, 'Level 1’s state could not be read.')}
        </p>
      ) : (
        <>
          <p role="status" data-testid="module-state-words">
            {moduleStateWords(state)}
          </p>
          <div className="flex items-center gap-3">
            <Switch
              checked={state.user.enabled}
              onCheckedChange={(checked: boolean) => void set(checked)}
              disabled={stepUp.busy || mutation.isPending}
              aria-label="Insights module (level 1, your switch)"
            />
            <span className="text-small text-text-primary">
              {state.user.enabled
                ? 'The insights module is on for you'
                : 'The insights module is off for you'}
            </span>
          </div>
        </>
      )}
      {error !== null && <p className="text-small text-status-critical">{error}</p>}
      {stepUp.error !== null && <p className="text-small text-status-critical">{stepUp.error}</p>}
    </section>
  );
}
