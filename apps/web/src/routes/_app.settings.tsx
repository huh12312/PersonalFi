// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { CryptoConnectScreen } from '../features/crypto/CryptoConnectScreen.tsx';
import { MarketDataSettingsScreen } from '../features/market-data/MarketDataSettingsScreen.tsx';
import { NotificationSettingsScreen } from '../features/notifications/NotificationSettingsScreen.tsx';
import { RulesListScreen } from '../features/rules/RulesListScreen.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsRoute,
});

/**
 * `/settings` (WP 2.11 owns this file; WP 3.12 adds the "Market data" and
 * "Crypto" tabs additively). Profile, passkeys/sessions and connections stay
 * future work, listed in the docstring the old placeholder carried rather
 * than silently dropped.
 *
 * "Market data" and "Crypto" land here rather than in
 * `features/connections/AddConnectionDialog.tsx` (that dialog's own
 * `credential_form` branch is the more natural home for the Coinbase/wallet
 * forms, but it is `features/connections/**`, which this work package may
 * not edit — see `features/crypto/CryptoConnectScreen.tsx`'s own header and
 * `docs/evidence/phase-3/wp3.12-networth-ui.md` §6).
 */
function SettingsRoute() {
  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="rules">
        <TabsList aria-label="Settings sections">
          <TabsTab value="rules">Rules</TabsTab>
          <TabsTab value="notifications">Notifications</TabsTab>
          <TabsTab value="market-data">Market data</TabsTab>
          <TabsTab value="crypto">Crypto</TabsTab>
          <TabsIndicator />
        </TabsList>
        <TabsPanel value="rules">
          <RulesListScreen />
        </TabsPanel>
        <TabsPanel value="notifications">
          <NotificationSettingsScreen />
        </TabsPanel>
        <TabsPanel value="market-data">
          <MarketDataSettingsScreen />
        </TabsPanel>
        <TabsPanel value="crypto">
          <CryptoConnectScreen />
        </TabsPanel>
      </Tabs>
      <p className="text-caption text-text-muted">
        Profile, security &amp; passkeys, connections, and appearance settings land in a later work
        package.
      </p>
    </div>
  );
}
