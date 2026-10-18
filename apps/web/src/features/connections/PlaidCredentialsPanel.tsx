// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { PlaidSetupForm } from './PlaidSetupForm.tsx';
import {
  useRemovePlaidCredentialsMutation,
  type PlaidCredentialsStatus,
} from './plaid-credentials-api.ts';

export interface PlaidCredentialsPanelProps {
  readonly status: PlaidCredentialsStatus;
}

function environmentLabel(env: PlaidCredentialsStatus['env']): string {
  return env === 'production' ? 'Production' : 'Sandbox';
}

/**
 * Where Plaid's keys come from, under the Plaid tab's Connect card (WP 10.1).
 *
 * - `files`: read-only. The operator's secret files configure Plaid and win over anything the product could
 *   store, so there is nothing here to change.
 * - `stored`: the holder's own keys: where they are kept, the environment, the last four characters of the
 *   client ID, **Change** and **Remove**, both behind step-up. They live here, in the dialog where the holder
 *   meets Plaid, and not in Settings › Security: that screen is about how *you* sign in (passkeys, the
 *   authenticator code), and a bank-linking key tucked there would be a second place to learn.
 */
export function PlaidCredentialsPanel({ status }: PlaidCredentialsPanelProps) {
  const [mode, setMode] = useState<'view' | 'change' | 'confirm-remove'>('view');
  const [error, setError] = useState<string | null>(null);
  const remove = useRemovePlaidCredentialsMutation();
  const stepUp = useStepUpRetry();
  const busy = remove.isPending || stepUp.busy;

  if (status.source === 'files') {
    return (
      <p className="text-small text-text-muted">
        Plaid is configured by the operator&apos;s secret files ({environmentLabel(status.env)}).
        Those take precedence, and can only be changed where the install is run.
      </p>
    );
  }
  if (status.source !== 'stored') return null;

  async function handleRemove(): Promise<void> {
    setError(null);
    try {
      await stepUp.run(() => remove.mutateAsync());
      setMode('view');
    } catch (cause) {
      const message =
        typeof cause === 'object' && cause !== null && 'message' in cause
          ? String((cause as { message?: unknown }).message)
          : '';
      setError(message === '' ? 'Could not remove the Plaid credentials.' : message);
    }
  }

  return (
    <section aria-labelledby="plaid-credentials-heading" className="flex flex-col gap-2">
      <h3 id="plaid-credentials-heading" className="text-small font-medium text-text-primary">
        Plaid credentials
      </h3>
      <p className="text-small text-text-secondary">
        Stored encrypted in this install · {environmentLabel(status.env)} · client ID ends in{' '}
        <span className="font-mono">{status.clientIdHint ?? '····'}</span>
        {status.rotatedAt !== null && (
          <> · changed {new Date(status.rotatedAt).toLocaleDateString()}</>
        )}
      </p>
      {!status.configured && (
        <p className="text-small text-status-warning-text" role="status">
          These stored credentials cannot be used right now
          {status.env === 'production' && !status.productionAllowed
            ? ': Production is off for this install.'
            : '.'}
        </p>
      )}

      {mode === 'view' && (
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setMode('change')}>
            Change
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setMode('confirm-remove')}>
            Remove
          </Button>
        </div>
      )}

      {mode === 'change' && (
        <PlaidSetupForm
          mode="change"
          productionAllowed={status.productionAllowed}
          onSaved={() => setMode('view')}
          onCancel={() => setMode('view')}
        />
      )}

      {mode === 'confirm-remove' && (
        <div className="flex flex-col gap-2 rounded-md border border-border-strong p-3">
          <p className="text-small text-text-primary">
            Remove the stored Plaid credentials? Banks you linked through Plaid stop syncing until
            you add keys again. This does not revoke the keys at Plaid - do that in your Plaid
            dashboard if you want them dead.
          </p>
          {(error !== null || stepUp.error !== null) && (
            <p className="text-small text-status-danger-text" role="alert">
              {error ?? stepUp.error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void handleRemove()}
            >
              {busy ? 'Removing…' : 'Remove credentials'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setMode('view');
                setError(null);
              }}
            >
              Keep
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
