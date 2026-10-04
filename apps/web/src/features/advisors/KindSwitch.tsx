// SPDX-License-Identifier: MIT
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { setAdvisorKindEnabledMutation } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';

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
 * Deliberately **not** a `Switch`: no route in this build reports this
 * flag's current value to the browser (`kill-levels.ts`'s own
 * `MODULE_LEVEL_WORDS`/`kindLevelWords` doc comment says the same of level
 * 1). A toggle rendered in an "on" or "off" position it never read would be
 * a lie this screen tells about its own state — exactly the kind of
 * never-exercised control the Phase 4 gate went looking for
 * (`docs/evidence/phase-4/gate-security-review.md`). Two explicit buttons
 * and the exact result of the last write instead.
 */
export function KindSwitch({ kind }: KindSwitchProps) {
  const stepUp = useStepUpRetry();
  const mutation = useMutation(setAdvisorKindEnabledMutation());
  const [lastResult, setLastResult] = useState<{ enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function set(enabled: boolean): Promise<void> {
    setError(null);
    try {
      const result = await stepUp.run(() =>
        mutation.mutateAsync({ path: { kind }, body: { enabled } }),
      );
      setLastResult({ enabled: result.enabled });
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
      <p className="text-caption text-text-muted">
        No route in this build reports this flag&apos;s current value, so this control is
        write-only: each button names exactly what it will send, and the line below is exactly what
        the route returned — never a guessed starting position.
      </p>
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
      {lastResult !== null && (
        <p className="text-small text-text-secondary" role="status">
          Last write: {kind} is now {lastResult.enabled ? 'enabled' : 'disabled'}.
        </p>
      )}
      {error !== null && <p className="text-small text-status-critical">{error}</p>}
      {stepUp.error !== null && <p className="text-small text-status-critical">{stepUp.error}</p>}
    </div>
  );
}
