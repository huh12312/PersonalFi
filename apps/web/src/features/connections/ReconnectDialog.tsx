// SPDX-License-Identifier: MIT
import { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Button } from '../../components/ui/button.tsx';
import { openPlaidLink, PlaidLinkTokenUnavailableError } from '../../lib/plaid-link.ts'; // gitleaks:allow — an identifier, not a key
import { useStepUpRetry } from '../../lib/step-up.ts';
import { CsvImportForm } from './CsvImportForm.tsx';
import { useReconnectConnectionMutation } from './useConnections.ts';
import type { ConnectionSummary } from '../../api/generated/types.gen.ts';

/** Same missing piece as `PlaidConnectCard`'s `getLinkToken` — an *update-mode* token this time (wp1.5-api.md's `reconnectFlow: 'provider_hosted'`), which needs `PlaidConnector.createUpdateLinkToken`, also unrouted. */
async function getUpdateLinkToken(): Promise<string> {
  throw new PlaidLinkTokenUnavailableError();
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
      const linkToken = await getUpdateLinkToken();
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
