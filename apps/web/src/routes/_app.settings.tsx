// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { NotificationSettingsScreen } from '../features/notifications/NotificationSettingsScreen.tsx';
import { RulesListScreen } from '../features/rules/RulesListScreen.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsRoute,
});

/**
 * `/settings` (WP 2.11 owns this file). Two of the placeholder's promised
 * sections land here — rules and notifications; profile, passkeys/sessions,
 * connections and data/appearance stay future work, listed in the docstring
 * the old placeholder carried rather than silently dropped.
 */
function SettingsRoute() {
  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="rules">
        <TabsList aria-label="Settings sections">
          <TabsTab value="rules">Rules</TabsTab>
          <TabsTab value="notifications">Notifications</TabsTab>
          <TabsIndicator />
        </TabsList>
        <TabsPanel value="rules">
          <RulesListScreen />
        </TabsPanel>
        <TabsPanel value="notifications">
          <NotificationSettingsScreen />
        </TabsPanel>
      </Tabs>
      <p className="text-caption text-text-muted">
        Profile, security &amp; passkeys, connections, and appearance settings land in a later work
        package.
      </p>
    </div>
  );
}
