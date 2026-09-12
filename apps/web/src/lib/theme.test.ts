// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyTheme, getThemePreference, resolveTheme, setThemePreference } from './theme.ts';

describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    setThemePreference('system');
    document.documentElement.removeAttribute('data-theme');
  });

  it('resolves "system" against the OS preference', () => {
    // vitest.setup.ts stubs matchMedia to always report `matches: false`.
    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('applyTheme writes data-theme for an explicit preference and clears it for "system"', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applyTheme marks the document ready for first paint (base.css visibility gate)', () => {
    document.documentElement.removeAttribute('data-theme-ready');
    applyTheme('dark');
    expect(document.documentElement.hasAttribute('data-theme-ready')).toBe(true);
  });

  it('the theme toggle persists the preference across reads', () => {
    setThemePreference('dark');
    expect(getThemePreference()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    setThemePreference('light');
    expect(getThemePreference()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
