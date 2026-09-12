// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { useUnlockStateQuery } from '../../api/pending-contracts.ts';
import { Button } from '../../components/ui/button.tsx';

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
      <CenteredCard>
        <Loader2 size={22} className="animate-spin text-text-muted" aria-hidden="true" />
        <p className="mt-3 text-small text-text-muted">Checking key custody state…</p>
      </CenteredCard>
    );
  }

  if (isError || data === undefined) {
    return (
      <CenteredCard>
        <Icon tone="critical" icon={AlertTriangle} />
        <h1 className="mt-3 text-h3 text-text-primary">Can’t reach PersonalFi</h1>
        <p className="mt-1 text-small text-text-muted">
          The API didn’t respond. Confirm the server is running and try again.
        </p>
        <Button className="mt-4" onClick={() => void refetch()} disabled={isFetching}>
          Retry
        </Button>
      </CenteredCard>
    );
  }

  if (data.state === 'locked') {
    return (
      <CenteredCard>
        <Icon tone="warning" icon={KeyRound} />
        <h1 className="mt-3 text-h3 text-text-primary">PersonalFi is locked</h1>
        <p className="mt-1 text-small text-text-muted">
          {(data.reason !== undefined ? REASON_COPY[data.reason] : undefined) ??
            'The encryption key is not available.'}
        </p>
        <Button className="mt-4" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <Icon tone="good" icon={ShieldCheck} />
      <h1 className="mt-3 text-h3 text-text-primary">Unlocked</h1>
      <p className="mt-1 text-small text-text-muted">
        {data.bootstrapped
          ? 'The encryption key is available. Continue to sign in.'
          : 'The encryption key is available, and no account exists yet.'}
      </p>
      <Button className="mt-4" onClick={() => void navigate({ to: '/login' })}>
        Continue to sign in
      </Button>
    </CenteredCard>
  );
}

function Icon({
  icon: LucideIconComponent,
  tone,
}: {
  icon: typeof KeyRound;
  tone: 'warning' | 'critical' | 'good';
}) {
  return (
    <div
      className={
        'mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle ' +
        (tone === 'critical'
          ? 'text-status-critical'
          : tone === 'warning'
            ? 'text-status-warning'
            : 'text-status-good')
      }
    >
      <LucideIconComponent size={22} aria-hidden="true" />
    </div>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-page px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-hairline bg-bg-surface p-6 text-center">
        {children}
      </div>
    </div>
  );
}
