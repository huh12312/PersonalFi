// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import { useUnlockStateQuery } from '../../api/pending-contracts.ts';
import { IconCircle } from '../../components/patterns/IconCircle.tsx';
import { Button } from '../../components/ui/button.tsx';
import { AuthCard } from './AuthCard.tsx';

const REASON_COPY: Record<string, string> = {
  no_passphrase:
    'No unlock passphrase was supplied when the server started. Set SECRETS_DIR / the KEK passphrase file and restart the container.',
  passphrase_mismatch:
    'The supplied passphrase does not match the one this data was encrypted with. Check the secret and restart.',
  not_started: 'The encryption key has not been initialised yet.',
};

/**
 * `/unlock` — the KEK custody gate (03 §2, decision D6's key-custody model).
 * This is deliberately **not** a form: the KEK is unlocked by the operator
 * supplying a passphrase file/env var to the server process, not by a value
 * typed into the browser (a browser-submitted encryption passphrase would
 * cross the network and defeat the point of at-rest envelope encryption).
 * This screen polls `/auth/unlock-state` and tells the operator what to fix.
 */
export function KekUnlockScreen() {
  const navigate = useNavigate();
  const { data, isPending, isError, refetch, isFetching } = useUnlockStateQuery();

  if (isPending) {
    return (
      <AuthCard>
        <Loader2
          size={22}
          className="motion-safe:animate-spin text-text-muted"
          aria-hidden="true"
        />
        <p className="mt-3 text-small text-text-muted">Checking key custody state…</p>
      </AuthCard>
    );
  }

  if (isError || data === undefined) {
    return (
      <AuthCard>
        <IconCircle tone="critical">
          <AlertTriangle size={22} aria-hidden="true" />
        </IconCircle>
        <h1 className="mt-3 text-h3 text-text-primary">Can’t reach PersonalFi</h1>
        <p className="mt-1 text-small text-text-muted">
          The API didn’t respond. Confirm the server is running and try again.
        </p>
        <Button className="mt-4" onClick={() => void refetch()} disabled={isFetching}>
          Retry
        </Button>
      </AuthCard>
    );
  }

  if (data.state === 'locked') {
    return (
      <AuthCard>
        <IconCircle tone="warning">
          <KeyRound size={22} aria-hidden="true" />
        </IconCircle>
        <h1 className="mt-3 text-h3 text-text-primary">PersonalFi is locked</h1>
        <p className="mt-1 text-small text-text-muted">
          {(data.reason !== undefined ? REASON_COPY[data.reason] : undefined) ??
            'The encryption key is not available.'}
        </p>
        <Button className="mt-4" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <IconCircle tone="good">
        <ShieldCheck size={22} aria-hidden="true" />
      </IconCircle>
      <h1 className="mt-3 text-h3 text-text-primary">Unlocked</h1>
      <p className="mt-1 text-small text-text-muted">
        {data.bootstrapped
          ? 'The encryption key is available. Continue to sign in.'
          : 'The encryption key is available, and no account exists yet.'}
      </p>
      <Button className="mt-4" onClick={() => void navigate({ to: '/login' })}>
        Continue to sign in
      </Button>
    </AuthCard>
  );
}
