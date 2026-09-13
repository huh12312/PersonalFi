// SPDX-License-Identifier: MIT
import { useEffect, useSyncExternalStore } from 'react';

import { createPersistedStore } from './persisted-store.ts';

const STORAGE_KEY = 'personalfi:hide-amounts';

const store = createPersistedStore<boolean>(STORAGE_KEY, false, String, (raw) => raw === 'true');

/**
 * `data-privacy="on|off"` on `<html>`, read by the `.money-sensitive` blur
 * rule in `base.css`. Applied before first paint from `main.tsx`, same as
 * the theme attribute, so a reload never flashes unblurred amounts.
 */
export function applyPrivacy(hidden: boolean): void {
  document.documentElement.setAttribute('data-privacy', hidden ? 'on' : 'off');
}

export function getHideAmounts(): boolean {
  return store.get();
}

export function setHideAmounts(hidden: boolean): void {
  store.set(hidden);
  applyPrivacy(hidden);
}

function toggleHideAmounts(): void {
  setHideAmounts(!store.get());
}

/** React hook: the current "hide amounts" flag, and a setter. */
export function useHideAmounts(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(store.subscribe, store.get, () => false);
  return [hidden, setHideAmounts];
}

/**
 * Installs the global `⌘⇧H` / `Ctrl⇧H` privacy shortcut once. Called from the
 * app root (`src/app/App.tsx`) — individual screens must not each re-bind it.
 */
export function usePrivacyShortcut(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const isModifierCombo = (event.metaKey || event.ctrlKey) && event.shiftKey;
      if (isModifierCombo && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        toggleHideAmounts();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
