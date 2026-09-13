// SPDX-License-Identifier: MIT
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useIdleTimer } from '../../lib/idle.ts';
import { useFinishStepUpMutation, useStartStepUpMutation } from '../../api/pending-contracts.ts';

const WARN_TOAST_ID = 'soft-lock-warning';

/** 05-frontend-architecture.md §7.2: 15 minutes idle by default (configurable 5/15/30/60/never in Settings — not built here), a 60s warning first. */
const LOCK_AFTER_MS = 15 * 60_000;
const WARN_AFTER_MS = LOCK_AFTER_MS - 60_000;

/**
 * The soft-lock overlay: the app does **not** log out on idle. It blurs the
 * UI behind a scrim, preserves route + in-memory state, and unlocks with a
 * single passkey assertion (step-up). Mounted once at the shell root
 * (`AppShell`) — never per-screen.
 */
export function IdleLockOverlay() {
  const queryClient = useQueryClient();
  const nearIdle = useIdleTimer(WARN_AFTER_MS);
  const idle = useIdleTimer(LOCK_AFTER_MS);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasNearIdle = useRef(false);

  useEffect(() => {
    // `locked` is not simply `idle`: once true it *latches* until a
    // successful passkey step-up clears it explicitly (handleUnlock below),
    // even though `idle` itself flips back to `false` the moment the user
    // touches the "Unlock" button — soft-lock must survive the very
    // interaction that reawakens the idle timer. That makes this a real
    // external-system sync (the idle timer is the external system), which is
    // exactly the documented exception to "don't setState in an effect."
    if (idle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocked(true);
      toast.dismiss(WARN_TOAST_ID);
      // gate-remediation-web.md M-4/M-8: with `query-client.ts` set to
      // `refetchOnWindowFocus: true` and nothing here touching the cache, a
      // locked session kept refetching balances behind the scrim — the exact
      // thing a "lock" is supposed to stop. Cancel first, so an in-flight
      // fetch that resolves *after* the lock fires can't repopulate the
      // cache it's racing to clear; only then wipe it. `handleUnlock` below
      // is the other half — it refetches once the user is back.
      void queryClient.cancelQueries().then(() => queryClient.clear());
    }
  }, [idle, queryClient]);

  useEffect(() => {
    if (nearIdle && !idle && !wasNearIdle.current) {
      toast('You’ll be locked out soon due to inactivity.', {
        id: WARN_TOAST_ID,
        duration: 60_000,
        action: { label: 'Stay signed in', onClick: () => toast.dismiss(WARN_TOAST_ID) },
      });
    }
    if (!nearIdle) toast.dismiss(WARN_TOAST_ID);
    wasNearIdle.current = nearIdle;
  }, [nearIdle, idle]);

  const startStepUp = useStartStepUpMutation();
  const finishStepUp = useFinishStepUpMutation();
  const unlocking = startStepUp.isPending || finishStepUp.isPending;

  async function handleUnlock(): Promise<void> {
    setError(null);
    try {
      const { options } = await startStepUp.mutateAsync();
      const response = await startAuthentication({ optionsJSON: options as never });
      await finishStepUp.mutateAsync({ response: response as never });
      setLocked(false);
      // Cache was wiped at lock time; repopulate whatever's still mounted
      // now that the user is verified again instead of leaving every screen
      // behind the (just-removed) overlay showing empty states until its own
      // next natural refetch.
      void queryClient.refetchQueries();
    } catch (cause) {
      // §7.1: `NotAllowedError` means cancelled/timed out, never "wrong credential".
      const cancelled = cause instanceof Error && cause.name === 'NotAllowedError';
      setError(
        cancelled
          ? 'That was cancelled. Try again, or use a recovery code from /login.'
          : 'Could not verify that passkey. Try again, or use a recovery code from /login.',
      );
    }
  }

  if (!locked) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="lock-overlay-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(11,11,11,0.7)] backdrop-blur-2xl"
    >
      <div className="w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-border-hairline bg-bg-surface-raised p-6 text-center shadow-[var(--shadow-elev-3)]">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle text-text-secondary">
          <KeyRound size={22} aria-hidden="true" />
        </div>
        <h2 id="lock-overlay-title" className="mt-3 text-h3 text-text-primary">
          PersonalFi is locked
        </h2>
        <p className="mt-1 text-small text-text-muted">
          You’ve been away for a while. Unlock with your passkey to continue.
        </p>
        {error !== null && (
          <p role="alert" className="mt-3 text-small text-status-critical">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleUnlock()}
          disabled={unlocking}
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent text-body font-medium text-accent-contrast disabled:opacity-60"
        >
          {unlocking && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          Unlock
        </button>
      </div>
    </div>
  );
}
