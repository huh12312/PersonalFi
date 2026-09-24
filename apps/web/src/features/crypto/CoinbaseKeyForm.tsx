// SPDX-License-Identifier: MIT
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useCreateConnectionMutation } from '../connections/useConnections.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';

function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}

const KEY_NAME_PLACEHOLDER =
  'organizations/00000000-0000-0000-0000-000000000000/apiKeys/00000000-0000-0000-0000-000000000000';

export interface CoinbaseKeyFormProps {
  onDone: () => void;
}

/**
 * Coinbase CDP key form (dispatch §3, WP 3.12: "a CDP key form, sealed and
 * never echoed"). `wp3.5-coinbase.md` §2: the sealed credential is exactly
 * two names, `cdp_key_name` + `cdp_private_key` — on the wire,
 * `POST /connections` with `provider: 'coinbase'` and
 * `input: { keyName, privateKey }` (`packages/connectors/coinbase/src/connector.ts#parseConnectInput`).
 *
 * "Sealed on submit, never echoed back": the private key field is cleared
 * from this component's own state the instant the request body is built —
 * before the request is even sent — so it does not linger in memory for a
 * slow network round trip, a retry, or a component re-render. Nothing in
 * this file logs it, and the API never returns a key value (`GetMarketDataSettingsResponse`/
 * connection responses carry no such field to begin with).
 */
export function CoinbaseKeyForm({ onDone }: CoinbaseKeyFormProps) {
  const [keyName, setKeyName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createConnection = useCreateConnectionMutation();
  const stepUp = useStepUpRetry();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const body = { provider: 'coinbase', input: { keyName, privateKey } };
    // Cleared here, not in a `finally` — the value must not survive past the
    // point the request body was built, whether the request succeeds, fails,
    // or is still in flight.
    setPrivateKey('');
    try {
      await stepUp.run(() => createConnection.mutateAsync({ body }));
      setKeyName('');
      onDone();
    } catch (cause) {
      setError(problemDetail(cause, 'Could not add this Coinbase connection.'));
    }
  }

  const busy = createConnection.isPending || stepUp.busy;
  // `-webkit-text-security` has no entry in React's `CSSProperties` (it's a
  // non-standard, WebKit/Blink-only property — supported by the Chromium
  // this app's own e2e suite runs), hence the cast rather than a typed key.
  // There is no native masked multi-line input, so this is the same
  // obscure-until-revealed idea `Money.tsx` uses for privacy mode, applied
  // to a textarea instead of an amount.
  const textSecurityStyle = (
    revealed ? {} : { WebkitTextSecurity: 'disc', fontFamily: 'monospace' }
  ) as CSSProperties;

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-small text-text-primary">
        <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          Use a <strong>view-only</strong> CDP key (<code>can_view</code> only). Coinbase will
          refuse to sync if this key can trade or transfer funds — this app never asks for a trading
          key.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="coinbase-key-name">CDP key name</Label>
        <Input
          id="coinbase-key-name"
          required
          value={keyName}
          onChange={(event) => setKeyName(event.target.value)}
          placeholder={KEY_NAME_PLACEHOLDER}
          autoComplete="off"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="coinbase-private-key">Ed25519 private key (PEM)</Label>
          <button
            type="button"
            className="text-caption text-text-muted underline-offset-4 hover:underline"
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </div>
        <textarea
          id="coinbase-private-key"
          required
          rows={4}
          value={privateKey}
          onChange={(event) => setPrivateKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          style={textSecurityStyle}
          className="w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-body text-text-primary placeholder:text-text-muted focus-visible:outline-none"
          placeholder="-----BEGIN EC PRIVATE KEY-----…"
        />
        <p className="text-caption text-text-muted">
          Never stored in this form after you submit it, and never shown again by this app.
        </p>
      </div>

      {(error !== null || stepUp.error !== null) && (
        <p className="text-small text-status-critical" role="alert">
          {error ?? stepUp.error}
        </p>
      )}

      <Button type="submit" disabled={busy || keyName === '' || privateKey === ''}>
        {busy ? 'Connecting…' : 'Connect Coinbase'}
      </Button>
    </form>
  );
}
