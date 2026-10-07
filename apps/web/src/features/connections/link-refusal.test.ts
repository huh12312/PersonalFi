// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { linkRefusalDetail } from './link-refusal.ts';

describe('linkRefusalDetail (Phase 4 gate O-6)', () => {
  it('does not tell someone whose link was refused to "reconnect the connection"', () => {
    const words = linkRefusalDetail(
      {
        code: 'connector.invalid_input',
        detail:
          'The provider needs your attention (CONFIG_ERROR). Reconnect the connection to continue.',
      },
      'fallback',
    );
    expect(words).not.toMatch(/reconnect/i);
    expect(words).not.toMatch(/CONFIG_ERROR/);
    expect(words).toMatch(/nothing was connected/i);
  });

  it("keeps the API's own detail for every other problem, and a fallback when there is none", () => {
    expect(
      linkRefusalDetail(
        { code: 'connections.invalid_input', detail: 'value looks like private key material' },
        'fallback',
      ),
    ).toBe('value looks like private key material');
    expect(linkRefusalDetail({ code: 'x' }, 'fallback')).toBe('fallback');
    expect(linkRefusalDetail(new Error('boom'), 'fallback')).toBe('fallback');
    expect(linkRefusalDetail(null, 'fallback')).toBe('fallback');
  });
});
