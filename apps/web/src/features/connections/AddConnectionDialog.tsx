// SPDX-License-Identifier: MIT
import { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { CsvImportForm } from './CsvImportForm.tsx';
import { ManualAccountForm } from './ManualAccountForm.tsx';
import { PlaidConnectCard } from './PlaidConnectCard.tsx';
import { iconForConnector } from './connector-icons.tsx';
import { useConnectorsQuery } from './useConnections.ts';

export interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Add a connection" (deliverable 3), rendered from `GET /connectors`
 * (wp1.5-api.md §4: "the 'add a connection' screen, as data") — a new
 * adapter reaches this dialog by being registered in `apps/api`, no UI
 * change. Each connector's `linkKind` selects which form its tab renders;
 * today's registry only has `manual_entry` and `file_upload`
 * (`packages/connectors/{manual,csv}`), so those are the two exercised
 * end-to-end — `provider_hosted` (Plaid) and `credential_form` render their
 * generic forms whenever such a connector is registered, without a code
 * change here.
 */
export function AddConnectionDialog({ open, onOpenChange }: AddConnectionDialogProps) {
  const connectorsQuery = useConnectorsQuery();
  const connectors = connectorsQuery.data?.connectors ?? [];
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);

  function handleDone(): void {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Add a connection</DialogTitle>
        <DialogDescription>Link a bank, import a file, or add a manual account.</DialogDescription>

        {connectorsQuery.isLoading && <p className="mt-4 text-small text-text-muted">Loading…</p>}

        {connectors.length > 0 && (
          <Tabs
            className="mt-4"
            value={activeTab ?? connectors[0]?.provider}
            onValueChange={(value) => setActiveTab(value as string)}
          >
            <TabsList>
              {connectors.map((connector) => {
                const Icon = iconForConnector(connector.iconKey);
                return (
                  <TabsTab
                    key={connector.provider}
                    value={connector.provider}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Icon size={14} aria-hidden="true" />
                    {connector.displayName}
                  </TabsTab>
                );
              })}
            </TabsList>
            {connectors.map((connector) => (
              <TabsPanel key={connector.provider} value={connector.provider}>
                {connector.linkKind === 'manual_entry' && (
                  <ManualAccountForm provider={connector.provider} onDone={handleDone} />
                )}
                {connector.linkKind === 'file_upload' && <CsvImportForm onDone={handleDone} />}
                {connector.linkKind === 'provider_hosted' && (
                  <PlaidConnectCard connector={connector} onDone={handleDone} />
                )}
                {connector.linkKind === 'credential_form' && (
                  <p className="text-small text-text-muted">
                    {connector.displayName} needs a credential form this pass does not build yet.
                  </p>
                )}
              </TabsPanel>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
