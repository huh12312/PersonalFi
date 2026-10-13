// SPDX-License-Identifier: MIT
import type { Account } from '../../api/generated/types.gen.ts';

/**
 * What the holder reads for an account's overlay (WP 9.2): the effective value
 * and *where it came from*. The server resolves; this file only words it, so
 * "from Plaid: 401k" and "set by you" are never decided on the client.
 */

export type TaxTreatment = NonNullable<Account['overlay']['taxTreatment']['effective']>;
export type AccountRole = NonNullable<Account['overlay']['role']['effective']>;
export type ValuationBasis = Account['overlay']['valuation']['effective'];
export type ManagementStyle = NonNullable<Account['overlay']['management']['effective']>;

export const TAX_TREATMENTS: readonly TaxTreatment[] = ['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'];
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'spending',
  'savings',
  'taxable',
  'tax_deferred',
  'tax_free',
  'liability',
];

export const TAX_LABELS: Readonly<Record<TaxTreatment, string>> = {
  TAXABLE: 'Taxable',
  TAX_DEFERRED: 'Tax-deferred (traditional 401k or IRA)',
  ROTH: 'Roth (tax-free)',
  HSA: 'HSA',
};

export const ROLE_LABELS: Readonly<Record<AccountRole, string>> = {
  spending: 'Spending',
  savings: 'Savings',
  taxable: 'Taxable investing',
  tax_deferred: 'Tax-deferred retirement',
  tax_free: 'Tax-free',
  liability: 'Liability',
};

/** WP 10.3: who manages an investment account. */
export const MANAGEMENT_STYLES: readonly ManagementStyle[] = [
  'advisor',
  'robo_advisor',
  'self_directed',
];

export const MANAGEMENT_LABELS: Readonly<Record<ManagementStyle, string>> = {
  advisor: 'An advisor',
  robo_advisor: 'A robo-advisor',
  self_directed: 'Me (self-directed)',
};

export const VALUATION_LABELS: Readonly<Record<ValuationBasis, string>> = {
  holdings: 'Holdings',
  balance: 'My typed balance',
};

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  plaid: 'Plaid',
  coinbase: 'Coinbase',
  csv: 'your import',
  manual: 'you',
};

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** A tax treatment, as a value and the reason it is what it is. */
export function taxTreatmentText(account: Account): { value: string; source: string } {
  const tax = account.overlay.taxTreatment;
  if (tax.effective === null) {
    return { value: 'No tax bucket', source: 'not applicable to this kind of account' };
  }
  const value = TAX_LABELS[tax.effective];
  switch (tax.source) {
    case 'holder':
      return { value, source: 'set by you' };
    case 'provider_subtype':
      return {
        value,
        source: `from ${providerName(account.provider)}: ${account.subtype ?? 'unknown'}`,
      };
    case 'provider_fallback':
      return {
        value,
        source: `assumed — ${providerName(account.provider)} calls this “${
          account.subtype ?? 'unknown'
        }”, which is not a tax-advantaged type; set it if it is`,
      };
    case 'none':
      return { value, source: 'not applicable to this kind of account' };
  }
}

export function roleText(account: Account): { value: string; source: string } {
  const role = account.overlay.role;
  return role.effective === null
    ? { value: 'Not set', source: 'you have not classified it' }
    : { value: ROLE_LABELS[role.effective], source: 'set by you' };
}

export function valuationText(account: Account): { value: string; source: string } {
  const valuation = account.overlay.valuation;
  return valuation.source === 'holder'
    ? { value: VALUATION_LABELS[valuation.effective], source: 'set by you' }
    : { value: VALUATION_LABELS[valuation.effective], source: 'default' };
}

export function managementText(account: Account): { value: string; source: string } {
  const management = account.overlay.management;
  return management.effective === null
    ? { value: 'Not classified', source: 'you have not said' }
    : { value: MANAGEMENT_LABELS[management.effective], source: 'set by you' };
}

/** Whether the holder has set anything on this account. */
export function hasOverride(account: Account): boolean {
  return (
    account.overlay.taxTreatment.override !== null ||
    account.overlay.role.source === 'holder' ||
    account.overlay.valuation.source === 'holder' ||
    account.overlay.management.source === 'holder'
  );
}

/** Which of the three fields this kind of account can take (mirrors the server's 422s). */
export function applicableFields(account: Account): {
  tax: boolean;
  role: boolean;
  valuation: boolean;
  management: boolean;
} {
  const investing = account.type === 'investment' || account.type === 'crypto';
  return {
    tax: account.classification === 'asset',
    role: true,
    valuation: investing,
    // The server accepts it on any account; the screen offers it where a
    // portfolio lives, which is where "who picks the trades" means something.
    management: investing,
  };
}

/**
 * A key that changes exactly when the server's answer about this account's
 * overlay does, so the settings form remounts from what the server last said
 * instead of keeping a draft over it.
 */
export function overlayKeyOf(account: Account): string {
  const { taxTreatment, role, valuation, management } = account.overlay;
  return [
    taxTreatment.override ?? '-',
    role.effective ?? '-',
    valuation.source,
    valuation.effective,
    management.effective ?? '-',
  ].join('|');
}
