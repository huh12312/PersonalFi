// SPDX-License-Identifier: MIT
import { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Sdk } from '../../api/generated/sdk.gen.ts';
import { openPlaidLink } from '../../lib/plaid-link.ts'; // gitleaks:allow — an identifier, not a key
import { useStepUpRetry } from '../../lib/step-up.ts';
import { CsvImportForm } from './CsvImportForm.tsx';
import { useReconnectConnectionMutation } from './useConnections.ts';
import type { ConnectionSummary } from '../../api/generated/types.gen.ts';

/** `POST /connections/{id}/plaid/update-link-token` (wp1.3b-plaid-api.md) — an *update-mode* token: no `products` on the wire, and the access token does not change (01 §1.7). */
async function getUpdateLinkToken(connectionId: string): Promise<string> {
  const { data } = await Sdk.__registry.get().createPlaidUpdateLinkToken({
    path: { connectionId },
    body: {},
    throwOnError: true,
  });
  return data.linkToken;
}

export interface ReconnectDialogProps {
  connection: ConnectionSummary | null;
  onOpenChange: (open: boolean) => void;
}

/** `POST /connections/{id}/reconnect` (deliverable 3: "reconnect flow using the update-mode link token") — the form shown depends on the connector's own `reconnectFlow`. */
export function ReconnectDialog({ connection, onOpenChange }: ReconnectDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reconnectConnection = useReconnectConnectionMutation();
  const stepUp = useStepUpRetry();

  if (connection === null) return null;

  async function handlePlaidReconnect(): Promise<void> {
    if (connection === null) return;
    setBusy(true);
    setError(null);
    try {
      const linkToken = await getUpdateLinkToken(connection.id);
      await openPlaidLink({
        token: linkToken,
        onSuccess: (publicToken) => {
          void stepUp
            .run(() =>
              reconnectConnection.mutateAsync({
                path: { connectionId: connection.id },
                body: { input: { publicToken } },
              }),
            )
            .then(() => onOpenChange(false));
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Plaid Link.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={connection !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Reconnect {connection.displayName}</DialogTitle>
        <DialogDescription>
          {connection.capabilities.reconnectFlow === 'reupload'
            ? 'Upload a fresh export to pick up where the last one left off.'
            : 'Refresh access without losing your transaction history.'}
        </DialogDescription>

        <div className="mt-4">
          {connection.capabilities.reconnectFlow === 'reupload' && (
            <CsvImportForm connectionId={connection.id} onDone={() => onOpenChange(false)} />
          )}
          {connection.capabilities.reconnectFlow === 'provider_hosted' && (
            <div className="flex flex-col gap-3">
              {error !== null && <p className="text-small text-status-critical">{error}</p>}
              {stepUp.error !== null && (
                <p className="text-small text-status-critical">{stepUp.error}</p>
              )}
              <Button onClick={() => void handlePlaidReconnect()} disabled={busy || stepUp.busy}>
                {busy ? 'Connecting…' : 'Reconnect'}
              </Button>
            </div>
          )}
          {connection.capabilities.reconnectFlow === 'credential_form' && (
            <p className="text-small text-text-muted">
              This connector needs a credential form this pass does not build yet.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
