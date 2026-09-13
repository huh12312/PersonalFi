// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from 'react';

import { createPersistedStore } from './persisted-store.ts';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'personalfi:theme';

const store = createPersistedStore<ThemePreference>(STORAGE_KEY, 'system', String, (raw) =>
  raw === 'light' || raw === 'dark' ? raw : 'system',
);

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;
}

/**
 * Write `data-theme` to `<html>` and flip `data-theme-ready` so the
 * `html:not([data-theme-ready]) body { visibility: hidden }` rule in
 * `base.css` releases the first paint. Called once, synchronously, as the
 * first statement of `main.tsx` — before React ever mounts — and again on
 * every theme change thereafter.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
  root.setAttribute('data-theme-ready', '');
}

export function setThemePreference(preference: ThemePreference): void {
  store.set(preference);
  applyTheme(preference);
}

export function getThemePreference(): ThemePreference {
  return store.get();
}

/** React hook: the user's stored preference, re-rendering on change (any tab). */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  // Explicit type argument: without it, `T` infers from the three callbacks'
  // return types as the widened `string` rather than the `ThemePreference`
  // union, and every downstream use of `preference` fails to typecheck.
  const preference = useSyncExternalStore<ThemePreference>(
    store.subscribe,
    store.get,
    () => 'system',
  );
  return [preference, setThemePreference];
}

export interface ThemeToggle {
  /** The current light/dark value, for choosing an icon. */
  readonly resolved: ResolvedTheme;
  readonly toggle: () => void;
  /** Names the destination, not the current state: what the control will do. */
  readonly label: string;
}

/**
 * The three theme toggles — top bar, command palette, login screen — in one
 * hook.
 *
 * The login screen needs its own control because `TopBar` never mounts for an
 * unauthenticated visitor, and the palette needs one because it is a keyboard
 * surface. Sharing the hook is what keeps all three flipping the same
 * persisted store and agreeing on which direction the label points.
 */
export function useThemeToggle(): ThemeToggle {
  const [, setPreference] = useThemePreference();
  const resolved = useResolvedTheme();
  return {
    resolved,
    toggle: () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    label: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
  };
}

/** React hook: the *resolved* light/dark value, tracking OS changes while on 'system'. */
export function useResolvedTheme(): ResolvedTheme {
  const [preference] = useThemePreference();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  return useSyncExternalStore(
    (listener) => {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => resolveTheme(preference),
    () => 'light',
  );
}
