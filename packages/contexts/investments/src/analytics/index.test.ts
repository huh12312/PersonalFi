// SPDX-License-Identifier: MIT
/**
 * The analytics surface reaches the context's public surface.
 *
 * `src/index.ts` re-exports this barrel with `export *`, which is the one
 * export form that can lose a name *silently*: if a future module in this
 * context exports something called `ratio` or `concentration`, the explicit
 * export wins and the analytics one simply stops being reachable — no error,
 * no warning, and a consumer's import resolves to a different function.
 *
 * So the surface is asserted rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import * as contextSurface from '../index.ts';
import * as analyticsSurface from './index.ts';

describe('the analytics surface', () => {
  it('is reachable in full from @ctx/investments', () => {
    const names = Object.keys(analyticsSurface);
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      expect(contextSurface, `@ctx/investments does not re-export ${name}`).toHaveProperty(name);
    }
  });

  it('keeps the four rules reachable as values, not only as prose', () => {
    expect(contextSurface.DRIFT_BAND_POINTS).toBe('5.0000');
    expect(contextSurface.MIN_ANNUALIZATION_DAYS).toBe(365);
    expect(contextSurface.UNCLASSIFIED_KEYS.asset_class).toBe('UNCLASSIFIED');
    expect(contextSurface.IDLE_CASH_MIN_DAYS).toBe(14);
  });
});
