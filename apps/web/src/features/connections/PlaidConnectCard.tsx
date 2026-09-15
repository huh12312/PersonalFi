// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { openPlaidLink, PlaidLinkTokenUnavailableError } from '../../lib/plaid-link.ts'; // gitleaks:allow — an identifier, not a key
import { useStepUpRetry } from '../../lib/step-up.ts';
import { useCreateConnectionMutation } from './useConnections.ts';
import type { ConnectorManifest } from '../../api/generated/types.gen.ts';

/**
 * The one call this whole flow is missing: nothing in the generated client
 * requests a Plaid `link_token` because `apps/api` has no route for it (see
 * `src/lib/plaid-link.ts`'s header). Named and isolated so the day that route
 * exists, this function's body is the only edit `PlaidConnectCard` needs —
 * everything below it (`openPlaidLink`, the success handler that calls
 * `POST /connections`) is already real.
 */
async function getLinkToken(): Promise<string> {
  throw new PlaidLinkTokenUnavailableError();
}

export interface PlaidConnectCardProps {
  connector: ConnectorManifest;
  onDone: () => void;
}

/** A `linkKind: 'provider_hosted'` connector (Plaid, in this app) — see this file's `getLinkToken` for the one missing piece. */
export function PlaidConnectCard({ connector, onDone }: PlaidConnectCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createConnection = useCreateConnectionMutation();
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
              createConnection.mutateAsync({
                body: {
                  provider: connector.provider,
                  input: { publicToken, institutionName: metadata.institution?.name ?? null },
                },
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
      {error !== null && <p className="text-small text-status-critical">{error}</p>}
      <Button onClick={() => void handleConnect()} disabled={busy}>
        {busy ? 'Connecting…' : `Connect with ${connector.displayName}`}
      </Button>
    </div>
  );
}
