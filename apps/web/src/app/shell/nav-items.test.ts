// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { ALL_NAV_ITEMS, BOTTOM_TABS, MORE_NAV_ITEMS, NAV_GROUPS } from './nav-items.ts';

describe('nav items: Ask (WP 11.5c)', () => {
  it('sits in Overview right after Insights, and in the More sheet', () => {
    const overview = NAV_GROUPS.find((group) => group.label === 'Overview');
    expect(overview?.items.map((item) => item.to)).toEqual([
      '/',
      '/insights',
      '/ask',
      '/advisor',
      '/health',
      '/brief',
    ]);
    expect(ALL_NAV_ITEMS.filter((item) => item.to === '/ask')).toHaveLength(1);
    expect(MORE_NAV_ITEMS.some((item) => item.to === '/ask')).toBe(true);
    expect(BOTTOM_TABS.some((item) => item.to === '/ask')).toBe(false);
  });

  it('lists Advisor (WP 11.5d) right after Ask, once, in the sidebar and the More sheet', () => {
    const all = ALL_NAV_ITEMS.map((item) => item.to);
    expect(all.indexOf('/advisor')).toBe(all.indexOf('/ask') + 1);
    expect(ALL_NAV_ITEMS.filter((item) => item.to === '/advisor')).toHaveLength(1);
    const more = MORE_NAV_ITEMS.map((item) => item.to);
    expect(more.indexOf('/advisor')).toBe(more.indexOf('/ask') + 1);
    expect(BOTTOM_TABS.some((item) => item.to === '/advisor')).toBe(false);
  });

  it('reaches every destination in the sidebar from the bottom bar or the More sheet', () => {
    const reachable = new Set([...BOTTOM_TABS, ...MORE_NAV_ITEMS].map((item) => item.to));
    for (const item of ALL_NAV_ITEMS) {
      if (item.to === '/') continue;
      expect(reachable.has(item.to), item.to).toBe(true);
    }
  });
});
