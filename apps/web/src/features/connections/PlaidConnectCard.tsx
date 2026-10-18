// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Sdk } from '../../api/generated/sdk.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { openPlaidLink } from '../../lib/plaid-link.ts'; // gitleaks:allow — an identifier, not a key
import { useStepUpRetry } from '../../lib/step-up.ts';
import { useExchangePlaidTokenMutation } from './useConnections.ts';
import type { ConnectorManifest } from '../../api/generated/types.gen.ts';

/** `POST /connections/plaid/link-token` (wp1.3b-plaid-api.md) — a fresh token per click, never cached. */
async function getLinkToken(): Promise<string> {
  const { data } = await Sdk.__registry.get().createPlaidLinkToken({ throwOnError: true });
  return data.linkToken;
}

export interface PlaidConnectCardProps {
  connector: ConnectorManifest;
  onDone: () => void;
}

/** A `linkKind: 'provider_hosted'` connector (Plaid, in this app). */
export function PlaidConnectCard({ connector, onDone }: PlaidConnectCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchange = useExchangePlaidTokenMutation();
  const stepUp = useStepUpRetry();

  async function handleConnect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const linkToken = await getLinkToken();
      await openPlaidLink({
        token: linkToken,
        onSuccess: (publicToken, metadata) => {
          void stepUp
            .run(() =>
              exchange.mutateAsync({
                body: { publicToken, institutionName: metadata.institution?.name ?? null },
              }),
            )
            .then(onDone);
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Plaid Link.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-secondary">{connector.description}</p>
      {error !== null && <p className="text-small text-status-danger-text">{error}</p>}
      <Button onClick={() => void handleConnect()} disabled={busy}>
        {busy ? 'Connecting…' : `Connect with ${connector.displayName}`}
      </Button>
    </div>
  );
}
