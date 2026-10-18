// SPDX-License-Identifier: MIT
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { useSavePlaidCredentialsMutation } from './plaid-credentials-api.ts';

export interface PlaidSetupFormProps {
  /** `GET .../credentials` `productionAllowed`: `production` is offered only when the install allows it (D16). */
  readonly productionAllowed: boolean;
  /** `setup`: nothing stored yet. `change`: replacing keys that are. */
  readonly mode: 'setup' | 'change';
  readonly onSaved: () => void;
  readonly onCancel?: () => void;
}

/** What a failed save says, in words of the moment. The api's detail is fixed copy that never repeats a value. */
function saveFailureDetail(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return 'Could not save these Plaid credentials. Nothing was stored.';
}

/**
 * "Set up Plaid" (WP 10.1): the holder's own Plaid client ID and secret, kept sealed in this install.
 *
 * **The secret is masked, can be pasted, and is never echoed back**: it is cleared from this component's
 * state the moment the request body is built - before the request is sent, so it does not linger through a
 * slow round trip, a step-up ceremony or a re-render - and the api has no way to return it. The step-up
 * (a passkey assertion) is asked for by `useStepUpRetry` on the api's `step_up_required`, then the same
 * request is retried once with the body captured here.
 */
export function PlaidSetupForm({
  productionAllowed,
  mode,
  onSaved,
  onCancel,
}: PlaidSetupFormProps) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useSavePlaidCredentialsMutation();
  const stepUp = useStepUpRetry();
  const busy = save.isPending || stepUp.busy;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const body = { clientId: clientId.trim(), secret: secret.trim(), env };
    setSecret('');
    setRevealed(false);
    try {
      await stepUp.run(() => save.mutateAsync(body));
      setClientId('');
      onSaved();
    } catch (cause) {
      setError(saveFailureDetail(cause));
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => void handleSubmit(event)}
      aria-label={mode === 'setup' ? 'Set up Plaid' : 'Change Plaid credentials'}
    >
      {mode === 'setup' && (
        <p className="text-small text-text-secondary">
          Plaid links your banks. Paste the client ID and secret from your own Plaid dashboard
          (Developers, Keys).
        </p>
      )}

      <div className="flex items-start gap-2 rounded-md border border-border-strong bg-bg-subtle p-3 text-small text-text-primary">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          Stored encrypted in this install, with the same key that protects your bank access tokens,
          and never shown again (only the last four characters of the client ID). Saving asks for
          your passkey.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="plaid-client-id">Plaid client ID</Label>
        <Input
          id="plaid-client-id"
          required
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={error === null ? undefined : 'plaid-setup-error'}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="plaid-secret">Plaid secret</Label>
          <button
            type="button"
            className="text-caption text-text-muted underline-offset-4 hover:underline"
            aria-pressed={revealed}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? 'Hide secret' : 'Show secret'}
          </button>
        </div>
        <Input
          id="plaid-secret"
          type={revealed ? 'text' : 'password'}
          required
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={error === null ? undefined : 'plaid-setup-error'}
        />
        <p className="text-caption text-text-muted">
          Use the secret for the environment you choose below.
        </p>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-small font-medium text-text-secondary">Environment</legend>
        <div className="flex flex-col gap-1">
          <label className="inline-flex items-center gap-2 text-body text-text-primary">
            <input
              type="radio"
              name="plaid-env"
              value="sandbox"
              checked={env === 'sandbox'}
              onChange={() => setEnv('sandbox')}
            />
            Sandbox (test banks, no real data)
          </label>
          {productionAllowed && (
            <label className="inline-flex items-center gap-2 text-body text-text-primary">
              <input
                type="radio"
                name="plaid-env"
                value="production"
                checked={env === 'production'}
                onChange={() => setEnv('production')}
              />
              Production (your real banks)
            </label>
          )}
        </div>
        {!productionAllowed && (
          <p className="text-caption text-text-muted">
            Production is off for this install; the person who runs it turns it on in the
            install&apos;s settings.
          </p>
        )}
      </fieldset>

      {mode === 'change' && (
        <p className="text-caption text-text-muted">
          Banks you already linked keep working only if these keys belong to the same Plaid account
          as the old ones.
        </p>
      )}

      {(error !== null || stepUp.error !== null) && (
        <p id="plaid-setup-error" className="text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy || clientId.trim() === '' || secret.trim() === ''}>
          {busy ? 'Checking with Plaid…' : mode === 'setup' ? 'Save and continue' : 'Save changes'}
        </Button>
        {onCancel !== undefined && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
