// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { KeyRound, Loader2 } from 'lucide-react';

import { IconCircle } from '../../components/patterns/IconCircle.tsx';
import { Button } from '../../components/ui/button.tsx';
import { AuthCard } from './AuthCard.tsx';
import { useStepUpUnlock } from './use-step-up-unlock.ts';

/**
 * `/lock` — the full-page equivalent of `IdleLockOverlay`, reached by a
 * direct link (e.g. a hard refresh while soft-locked loses the in-memory
 * overlay state, since the lock itself isn't persisted server-side — only
 * the idle *session* is). Same passkey step-up flow, page-shaped.
 */
export function LockScreen() {
  const navigate = useNavigate();
  const { error, busy, unlock } = useStepUpUnlock(() => navigate({ to: '/' }));

  return (
    <AuthCard>
      <IconCircle tone="muted">
        <KeyRound size={22} aria-hidden="true" />
      </IconCircle>
      <h1 className="mt-3 text-h2 text-text-primary">PersonalFi is locked</h1>
      <p className="mt-1 text-small text-text-muted">Unlock with your passkey to continue.</p>
      {error !== null && (
        <p role="alert" className="mt-3 text-small text-status-danger-text">
          {error}
        </p>
      )}
      <Button className="mt-5 w-full" disabled={busy} onClick={() => void unlock()}>
        {busy && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
        Unlock
      </Button>
    </AuthCard>
  );
}
