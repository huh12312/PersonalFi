// SPDX-License-Identifier: MIT
/**
 * `createConnectorRegistry`'s Plaid wiring (WP 1.3b) — feature-detection, one
 * info line, and never a secret value.
 *
 * No database is needed: `registry.manifests()`/`.capabilities()` never make a
 * network call, so this is `test/*.test.ts` (the `api` project), not
 * `test/db/`.
 */
import { redact, type PlaidConfig } from '@core/config';
import { recordingLogger } from '@core/testkit';
import { describe, expect, it } from 'vitest';
import { createConnectorRegistry } from '../src/domain.ts';

const PLAID_CONFIG: PlaidConfig = {
  clientId: redact('domain-test-plaid-client-id-do-not-leak'),
  secret: redact('domain-test-plaid-secret-do-not-leak-9f2c4d7a'),
  environment: 'sandbox',
  clientName: 'PersonalFi',
  countryCodes: ['US'],
  language: 'en',
  redirectUri: null,
  webhookUrl: null,
};

describe('createConnectorRegistry — plaid (wp1.3b)', () => {
  it('does not register plaid when config.plaid is null (feature-detect)', () => {
    const logger = recordingLogger();
    const registry = createConnectorRegistry({ plaid: null, logger });

    expect(registry.has('plaid')).toBe(false);
    expect(registry.manifests().map((m) => m.provider)).not.toContain('plaid');

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.level).toBe('info');
    expect(logger.lines[0]?.msg).toMatch(/not configured/);
  });

  it('registers plaid when config.plaid is present, and never logs the secret', () => {
    const logger = recordingLogger();
    const registry = createConnectorRegistry({ plaid: PLAID_CONFIG, logger });

    expect(registry.has('plaid')).toBe(true);
    expect(registry.manifests().map((m) => m.provider)).toContain('plaid');

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.level).toBe('info');
    expect(logger.lines[0]?.msg).toMatch(/registered/);
    const serialisedLog = JSON.stringify(logger.lines);
    expect(serialisedLog).not.toContain(PLAID_CONFIG.clientId.reveal());
    expect(serialisedLog).not.toContain(PLAID_CONFIG.secret.reveal());
    // The whole options object too, for a call site that logs it directly.
    expect(JSON.stringify(PLAID_CONFIG)).not.toContain(PLAID_CONFIG.clientId.reveal());
    expect(JSON.stringify(PLAID_CONFIG)).not.toContain(PLAID_CONFIG.secret.reveal());
  });

  it('boots with no registry options at all (the production default path)', () => {
    // `options = {}` is what `createConnectorRegistry()` (no args) resolves to;
    // `domain.ts`'s WP 1.5 hook comment used to show a *commented-out* call —
    // this proves the now-real call needs nothing to boot safely.
    const registry = createConnectorRegistry();
    expect(registry.has('plaid')).toBe(false);
  });
});
