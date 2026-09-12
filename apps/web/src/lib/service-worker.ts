// SPDX-License-Identifier: MIT
import { toast } from 'sonner';

/**
 * `registerType: 'prompt'` (never `'autoUpdate'` — §10.4). A new service
 * worker installs in the background and waits; the user decides when to pick
 * it up via a persistent toast, because silently swapping the bundle under
 * someone mid-split-edit is hostile. `updateSW(true)` posts `SKIP_WAITING`
 * to the waiting worker and reloads once it activates.
 */
export async function registerServiceWorker(): Promise<void> {
  const { registerSW } = await import('virtual:pwa-register');

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast('A new version is available.', {
        id: 'sw-update-available',
        duration: Infinity,
        action: {
          label: 'Reload',
          onClick: () => void updateSW(true),
        },
      });
    },
    onOfflineReady() {
      toast('PersonalFi is ready to work offline.', { id: 'sw-offline-ready' });
    },
  });
}
