// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { Account } from '../../api/generated/types.gen.ts';
import { DEFAULT_OVERLAY } from './fixtures.ts';
import {
  applicableFields,
  hasOverride,
  overlayKeyOf,
  roleText,
  taxTreatmentText,
  valuationText,
} from './overlay-labels.ts';

function account(overrides: Partial<Account>): Account {
  return {
    id: 'a1',
    connectionId: null,
    provider: 'plaid',
    name: 'Retirement',
    officialName: null,
    type: 'investment',
    subtype: '401k',
    classification: 'asset',
    currency: 'USD',
    mask: null,
    closedAt: null,
    includeInNetWorth: true,
    balance: null,
    overlay: DEFAULT_OVERLAY,
    ...overrides,
  };
}

const overlay = (tax: Account['overlay']['taxTreatment']): Account['overlay'] => ({
  ...DEFAULT_OVERLAY,
  taxTreatment: tax,
});

describe('the words an overlay is read in', () => {
  it('says a provider fact came from the provider, naming the subtype', () => {
    const text = taxTreatmentText(
      account({
        overlay: overlay({
          effective: 'TAX_DEFERRED',
          source: 'provider_subtype',
          override: null,
          providerDefault: 'TAX_DEFERRED',
        }),
      }),
    );
    expect(text).toEqual({
      value: 'Tax-deferred (traditional 401k or IRA)',
      source: 'from Plaid: 401k',
    });
  });

  it('says the holder set it, and a fallback is an assumption, not a fact', () => {
    expect(
      taxTreatmentText(
        account({
          overlay: overlay({
            effective: 'ROTH',
            source: 'holder',
            override: 'ROTH',
            providerDefault: 'TAX_DEFERRED',
          }),
        }),
      ).source,
    ).toBe('set by you');

    const guess = taxTreatmentText(
      account({
        subtype: 'brokerage',
        overlay: overlay({
          effective: 'TAXABLE',
          source: 'provider_fallback',
          override: null,
          providerDefault: 'TAXABLE',
        }),
      }),
    );
    expect(guess.source).toMatch(/^assumed — Plaid calls this “brokerage”/u);
  });

  it('words role and valuation, and knows which fields an account can take', () => {
    expect(roleText(account({})).value).toBe('Not set');
    expect(valuationText(account({})).source).toBe('default');
    const typed = account({
      overlay: { ...DEFAULT_OVERLAY, valuation: { effective: 'balance', source: 'holder' } },
    });
    expect(valuationText(typed)).toEqual({ value: 'My typed balance', source: 'set by you' });
    expect(hasOverride(account({}))).toBe(false);
    expect(hasOverride(typed)).toBe(true);

    expect(applicableFields(account({}))).toEqual({
      tax: true,
      role: true,
      valuation: true,
      management: true,
    });
    expect(applicableFields(account({ type: 'credit', classification: 'liability' }))).toEqual({
      tax: false,
      role: true,
      valuation: false,
      management: false,
    });
    expect(applicableFields(account({ type: 'depository' })).valuation).toBe(false);
  });

  it('keys the form on the server’s answer, so it remounts from what was saved', () => {
    expect(overlayKeyOf(account({}))).not.toBe(
      overlayKeyOf(
        account({
          overlay: overlay({
            effective: 'ROTH',
            source: 'holder',
            override: 'ROTH',
            providerDefault: null,
          }),
        }),
      ),
    );
  });
});
