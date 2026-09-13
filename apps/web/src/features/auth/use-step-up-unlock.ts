// SPDX-License-Identifier: MIT
import { startAuthentication } from '@simplewebauthn/browser';
import { useState } from 'react';

import { useFinishStepUpMutation, useStartStepUpMutation } from '../../api/pending-contracts.ts';
import { describeWebauthnError, STEP_UP_ERROR_COPY } from '../../lib/webauthn-error.ts';

export interface StepUpUnlock {
  /** The message to render, or `null` while nothing has failed. */
  readonly error: string | null;
  /** True while either leg of the ceremony is in flight; disable the button. */
  readonly busy: boolean;
  readonly unlock: () => Promise<void>;
}

/**
 * The passkey step-up ceremony behind both lock surfaces.
 *
 * `IdleLockOverlay` and `LockScreen` are the same three-step flow — request a
 * challenge, assert, exchange the assertion for a fresh session — differing
 * only in what they do once it succeeds, which is why that is the parameter.
 * Keeping the ceremony in one place matters more here than elsewhere: the two
 * screens are the re-authentication boundary, and a fix applied to one and not
 * the other leaves a gap that still looks locked.
 *
 * `onUnlocked` runs inside the same `try`, so a failure to navigate or refetch
 * surfaces as the same error rather than silently leaving a dismissed lock.
 */
export function useStepUpUnlock(onUnlocked: () => void | Promise<void>): StepUpUnlock {
  const [error, setError] = useState<string | null>(null);
  const startStepUp = useStartStepUpMutation();
  const finishStepUp = useFinishStepUpMutation();

  async function unlock(): Promise<void> {
    setError(null);
    try {
      const { options } = await startStepUp.mutateAsync();
      const response = await startAuthentication({ optionsJSON: options as never });
      await finishStepUp.mutateAsync({ response: response as never });
      await onUnlocked();
    } catch (cause) {
      setError(describeWebauthnError(cause, STEP_UP_ERROR_COPY));
    }
  }

  return { error, busy: startStepUp.isPending || finishStepUp.isPending, unlock };
}
