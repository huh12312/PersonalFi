// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { startAuthentication } from '@simplewebauthn/browser';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { useFinishStepUpMutation, useStartStepUpMutation } from '../../api/pending-contracts.ts';
import { Button } from '../../components/ui/button.tsx';

/**
 * `/lock` — the full-page equivalent of `IdleLockOverlay`, reached by a
 * direct link (e.g. a hard refresh while soft-locked loses the in-memory
 * overlay state, since the lock itself isn't persisted server-side — only
 * the idle *session* is). Same passkey step-up flow, page-shaped.
 */
export function LockScreen() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const startStepUp = useStartStepUpMutation();
  const finishStepUp = useFinishStepUpMutation();
  const busy = startStepUp.isPending || finishStepUp.isPending;

  async function handleUnlock(): Promise<void> {
    setError(null);
    try {
      const { options } = await startStepUp.mutateAsync();
      const response = await startAuthentication({ optionsJSON: options as never });
      await finishStepUp.mutateAsync({ response: response as never });
      await navigate({ to: '/' });
    } catch (cause) {
      const cancelled = cause instanceof Error && cause.name === 'NotAllowedError';
      setError(
        cancelled
          ? 'That was cancelled. Try again, or use a recovery code from /login.'
          : 'Could not verify that passkey. Try again, or use a recovery code from /login.',
      );
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-page px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-hairline bg-bg-surface p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle text-text-secondary">
          <KeyRound size={22} aria-hidden="true" />
        </div>
        <h1 className="mt-3 text-h2 text-text-primary">PersonalFi is locked</h1>
        <p className="mt-1 text-small text-text-muted">Unlock with your passkey to continue.</p>
        {error !== null && (
          <p role="alert" className="mt-3 text-small text-status-critical">
            {error}
          </p>
        )}
        <Button className="mt-5 w-full" disabled={busy} onClick={() => void handleUnlock()}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          Unlock
        </Button>
      </div>
    </div>
  );
}
