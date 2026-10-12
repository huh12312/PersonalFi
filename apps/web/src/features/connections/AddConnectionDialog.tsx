// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { ComponentType } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { CoinbaseKeyForm } from '../crypto/CoinbaseKeyForm.tsx';
import { WalletWatchOnlyForm } from '../crypto/WalletWatchOnlyForm.tsx';
import { CsvImportForm } from './CsvImportForm.tsx';
import { ManualAccountForm } from './ManualAccountForm.tsx';
import { PlaidConnectCard } from './PlaidConnectCard.tsx';
import { PlaidCredentialsPanel } from './PlaidCredentialsPanel.tsx';
import { PlaidSetupForm } from './PlaidSetupForm.tsx';
import { usePlaidCredentialsQuery } from './plaid-credentials-api.ts';
import { iconForConnector } from './connector-icons.tsx';
import { useConnectorsQuery } from './useConnections.ts';

/**
 * The two `credential_form` providers this deployment ships (WP 3.12:
 * `features/crypto/{CoinbaseKeyForm,WalletWatchOnlyForm}.tsx`, both built as
 * self-contained forms — `provider`/`input` shape and all — against
 * `useCreateConnectionMutation`, but never wired into this dialog because WP
 * 3.12 could not edit `features/connections/**`; see
 * `docs/evidence/phase-3/wp3.12-networth-ui.md` §6, and
 * `wp3.14-carryovers.md` item 2). A `credential_form` connector whose
 * `provider` is not in this map still renders the placeholder below it, so a
 * future connector of that `linkKind` degrades the same way this branch
 * always has rather than silently rendering nothing.
 */
const CREDENTIAL_FORMS: Readonly<Record<string, ComponentType<{ onDone: () => void }>>> = {
  coinbase: CoinbaseKeyForm,
  wallet_rpc: WalletWatchOnlyForm,
};

/** What the Plaid tab says before the api lists a Plaid connector: the holder has no keys yet. */
const PLAID_SETUP_TAB = Object.freeze({
  provider: 'plaid',
  displayName: 'Plaid',
  iconKey: 'bank',
});

export interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Add a connection" (deliverable 3), rendered from `GET /connectors`
 * (wp1.5-api.md §4: "the 'add a connection' screen, as data") — a new
 * `manual_entry`/`file_upload`/`provider_hosted` adapter reaches this dialog
 * by being registered in `apps/api`, no UI change. `credential_form` is the
 * one `linkKind` that still needs a per-provider form (a key or an address
 * has a different shape per provider) — `CREDENTIAL_FORMS` above is that map,
 * currently `coinbase` and `wallet_rpc`; a `credential_form` connector not in
 * it renders the fallback placeholder rather than nothing.
 */
export function AddConnectionDialog({ open, onOpenChange }: AddConnectionDialogProps) {
  const connectorsQuery = useConnectorsQuery();
  const connectors = connectorsQuery.data?.connectors ?? [];
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);

  // WP 10.1. `GET /connectors` lists Plaid only once it is usable (the operator's files, or the
  // holder's stored keys). Until then the Plaid tab is still offered, as "Set up Plaid", so a holder
  // can add their own credentials from this menu; once saved the query refetches, Plaid becomes a
  // normal connector tab, and the Link card replaces the form with no reload.
  const credentialsQuery = usePlaidCredentialsQuery();
  const credentials = credentialsQuery.data;
  const plaidListed = connectors.some((connector) => connector.provider === 'plaid');
  const offerPlaidSetup =
    !plaidListed && credentials !== undefined && credentials.source !== 'files';
  const tabs = [
    ...connectors.map((connector) => ({
      provider: connector.provider,
      displayName: connector.displayName,
      iconKey: connector.iconKey,
    })),
    ...(offerPlaidSetup ? [PLAID_SETUP_TAB] : []),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName));

  function handleDone(): void {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Add a connection</DialogTitle>
        <DialogDescription>Link a bank, import a file, or add a manual account.</DialogDescription>

        {connectorsQuery.isLoading && <p className="mt-4 text-small text-text-muted">Loading…</p>}

        {tabs.length > 0 && (
          <Tabs
            className="mt-4"
            value={activeTab ?? connectors[0]?.provider ?? tabs[0]?.provider}
            onValueChange={(value) => setActiveTab(value as string)}
          >
            <TabsList>
              {tabs.map((connector) => {
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
            {offerPlaidSetup && (
              <TabsPanel value="plaid">
                <div className="flex flex-col gap-3">
                  {credentials.source === 'stored' && (
                    <PlaidCredentialsPanel status={credentials} />
                  )}
                  {credentials.source === 'none' && (
                    <PlaidSetupForm
                      mode="setup"
                      productionAllowed={credentials.productionAllowed}
                      onSaved={() => setActiveTab('plaid')}
                    />
                  )}
                </div>
              </TabsPanel>
            )}
            {connectors.map((connector) => (
              <TabsPanel key={connector.provider} value={connector.provider}>
                {connector.linkKind === 'manual_entry' && (
                  <ManualAccountForm provider={connector.provider} onDone={handleDone} />
                )}
                {connector.linkKind === 'file_upload' && <CsvImportForm onDone={handleDone} />}
                {connector.linkKind === 'provider_hosted' && (
                  <div className="flex flex-col gap-4">
                    <PlaidConnectCard connector={connector} onDone={handleDone} />
                    {connector.provider === 'plaid' && credentials !== undefined && (
                      <PlaidCredentialsPanel status={credentials} />
                    )}
                  </div>
                )}
                {connector.linkKind === 'credential_form' &&
                  (() => {
                    const CredentialForm = CREDENTIAL_FORMS[connector.provider];
                    return CredentialForm !== undefined ? (
                      <CredentialForm onDone={handleDone} />
                    ) : (
                      <p className="text-small text-text-muted">
                        {connector.displayName} needs a credential form this pass does not build
                        yet.
                      </p>
                    );
                  })()}
              </TabsPanel>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
