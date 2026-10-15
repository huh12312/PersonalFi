// SPDX-License-Identifier: MIT
import { createFileRoute, Link } from '@tanstack/react-router';

import { CryptoConnectScreen } from '../features/crypto/CryptoConnectScreen.tsx';
import { MarketDataKeysSection } from '../features/market-data/MarketDataKeysSection.tsx';
import { MarketDataSettingsScreen } from '../features/market-data/MarketDataSettingsScreen.tsx';
import { NarratorSettingsSection } from '../features/narrator/NarratorSettingsSection.tsx';
import { NotificationSettingsScreen } from '../features/notifications/NotificationSettingsScreen.tsx';
import { RulesListScreen } from '../features/rules/RulesListScreen.tsx';
import { SecurityScreen } from '../features/security/SecurityScreen.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsRoute,
});

/**
 * `/settings` (WP 2.11 owns this file; WP 3.12 adds the "Market data" and
 * "Crypto" tabs additively). Profile, passkeys/sessions and connections stay
 * future work, listed in the docstring the old placeholder carried rather
 * than silently dropped. WP 9.14 adds "Security": signed-in sessions and the
 * authenticator code (`features/security/`).
 *
 * "Market data" and "Crypto" land here rather than in
 * `features/connections/AddConnectionDialog.tsx` (that dialog's own
 * `credential_form` branch is the more natural home for the Coinbase/wallet
 * forms, but it is `features/connections/**`, which this work package may
 * not edit — see `features/crypto/CryptoConnectScreen.tsx`'s own header and
 * `docs/evidence/phase-3/wp3.12-networth-ui.md` §6).
 *
 * WP 10.4 puts the market-data API key cards (`MarketDataKeysSection`) at the
 * top of the "Market data" tab, beside the provider list they configure.
 *
 * WP 10.6 adds "Language model" (`features/narrator/`): which language model
 * words the Brief (Ollama, OpenAI, OpenRouter, Anthropic or Off), and each
 * provider's key, model, consent and Test.
 *
 * "Advisor management" (WP 5.12) is a separate route rather than a tab here:
 * `routes/_app.settings_.advisors.tsx` escapes this file's layout (that
 * file's own header says why), so it is reached by the one link line below,
 * not an `Outlet`.
 */
function SettingsRoute() {
  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="rules">
        <TabsList aria-label="Settings sections">
          <TabsTab value="rules">Rules</TabsTab>
          <TabsTab value="notifications">Notifications</TabsTab>
          <TabsTab value="market-data">Market data</TabsTab>
          <TabsTab value="language-model">Language model</TabsTab>
          <TabsTab value="crypto">Crypto</TabsTab>
          <TabsTab value="security">Security</TabsTab>
          <TabsIndicator />
        </TabsList>
        <TabsPanel value="rules">
          <RulesListScreen />
        </TabsPanel>
        <TabsPanel value="notifications">
          <NotificationSettingsScreen />
        </TabsPanel>
        <TabsPanel value="market-data">
          <div className="flex flex-col gap-6">
            <MarketDataKeysSection />
            <MarketDataSettingsScreen />
          </div>
        </TabsPanel>
        <TabsPanel value="language-model">
          <NarratorSettingsSection />
        </TabsPanel>
        <TabsPanel value="crypto">
          <CryptoConnectScreen />
        </TabsPanel>
        <TabsPanel value="security">
          <SecurityScreen />
        </TabsPanel>
      </Tabs>
      <p className="text-small">
        <Link to="/settings/advisors" className="text-accent-text underline">
          Advisor management
        </Link>{' '}
        — scope grants, the kill ladder, the run inspector and the payload preview.
      </p>
      <p className="text-caption text-text-muted">
        Profile, passkey management, connections, and appearance settings land in a later work
        package.
      </p>
    </div>
  );
}
