// SPDX-License-Identifier: MIT
/**
 * The stub's own test (05-phase-5-dispatch.md §4 item 1): one assertion so
 * the `advisor-local-model` vitest project is never reported empty while WP
 * 5.2 is still ahead. Replaced by WP 5.2's real suite, not extended by it.
 */
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@advisor/local-model (stub)', () => {
  it('exports its own package name', () => {
    expect(PACKAGE_NAME).toBe('@advisor/local-model');
  });
});
