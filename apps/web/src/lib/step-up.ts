// SPDX-License-Identifier: MIT
import { startAuthentication } from '@simplewebauthn/browser';
import { useState } from 'react';

import { useFinishStepUpMutation, useStartStepUpMutation } from '../api/pending-contracts.ts';
import { describeWebauthnError, STEP_UP_ERROR_COPY } from './webauthn-error.ts';

/**
 * `apps/api/src/auth/guards.ts`'s `requireFreshSession` rejects a stale
 * session with `403 { code: 'step_up_required' }` (decision D21). Five routes
 * in this work package's scope need it: export CSV, and add/reconnect/remove
 * a connection. The generated client throws the parsed `Problem` body
 * directly (`generated/client/client.gen.ts`'s `request()`:
 * `throw jsonError ?? textError`), so this only needs to read `.code` off an
 * `unknown` thrown value.
 */
export function isStepUpRequiredError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'step_up_required'
  );
}

export interface StepUpRetry {
  readonly busy: boolean;
  /** Set only when the step-up *ceremony itself* failed (cancelled or unverifiable) — never for the original call's own error, which the caller's own mutation/query error channel already reports. */
  readonly error: string | null;
  /**
   * Run `action`. If it fails with `step_up_required`, perform the passkey
   * step-up ceremony once and retry `action` exactly once more — the same
   * "request a challenge, assert, exchange it for a fresh session" ceremony
   * as `features/auth/use-step-up-unlock.ts`, without that hook's
   * lock-screen-specific `onUnlocked` callback.
   */
  run<T>(action: () => Promise<T>): Promise<T>;
}

export function useStepUpRetry(): StepUpRetry {
  const [error, setError] = useState<string | null>(null);
  const startStepUp = useStartStepUpMutation();
  const finishStepUp = useFinishStepUpMutation();

  async function run<T>(action: () => Promise<T>): Promise<T> {
    setError(null);
    try {
      return await action();
    } catch (cause) {
      if (!isStepUpRequiredError(cause)) throw cause;
      try {
        const { options } = await startStepUp.mutateAsync();
        const response = await startAuthentication({ optionsJSON: options as never });
        await finishStepUp.mutateAsync({ response: response as never });
      } catch (stepUpCause) {
        const message = describeWebauthnError(stepUpCause, STEP_UP_ERROR_COPY);
        setError(message);
        throw stepUpCause;
      }
      return await action();
    }
  }

  return { busy: startStepUp.isPending || finishStepUp.isPending, error, run };
}
