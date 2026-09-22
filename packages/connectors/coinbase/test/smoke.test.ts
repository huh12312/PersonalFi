// SPDX-License-Identifier: MIT
/**
 * The first file in the package, written before anything else, so the vitest
 * project has something to run and the orchestrator can register
 * `connector-coinbase` the moment the directory exists.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTOR_ERROR_KINDS } from '@connector/port';
import { money } from '@core/kernel';

describe('@connector/coinbase package wiring', () => {
  it('resolves @connector/port and @core/kernel from this package', () => {
    expect(CONNECTOR_ERROR_KINDS).toContain('permanent');
    expect(money(1n, 'USD').currency).toBe('USD');
  });
});
