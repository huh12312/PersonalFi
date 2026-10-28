// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { documentTitleFor, titleForPath } from './document-title.ts';

describe('documentTitleFor (WCAG 2.4.2)', () => {
  it('names the screen on every route, in the same words as the top bar', () => {
    expect(documentTitleFor('/')).toBe('Dashboard · PersonalFi');
    expect(documentTitleFor('/budget')).toBe(`${titleForPath('/budget')} · PersonalFi`);
    expect(documentTitleFor('/settings/advisors')).toBe('Advisor management · PersonalFi');
    expect(documentTitleFor('/accounts/connections')).toBe('Connections · PersonalFi');
    expect(documentTitleFor('/login')).toBe('Sign in · PersonalFi');
    expect(documentTitleFor('/ask')).toBe('Ask · PersonalFi');
  });

  it('gives different routes different titles', () => {
    const titles = new Set(
      ['/', '/budget', '/goals', '/plan', '/settings', '/login', '/lock'].map(documentTitleFor),
    );
    expect(titles.size).toBe(7);
  });
});
