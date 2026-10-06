// SPDX-License-Identifier: MIT
/**
 * The one pure resolver: the provider's metadata is the default, the holder's
 * override wins.
 *
 * D11's shape, applied to an account. Provider facts are never mutated and this
 * function is the only place that decides which of the two a reader sees, so the
 * accounts screen, the projection's tax bucket and the net-worth valuation
 * cannot disagree about it.
 *
 * It is parameterised by the provider-derived tax default rather than computing
 * it, because the subtype map is `@ctx/planning`'s (`defaultTaxBucketFor`) and
 * this context may not import it. The composition root hands the default in.
 */
import type { AccountRole, TaxTreatment, ValuationBasis } from './vocab.ts';

/** What the holder has said about one account. `null` in a field: nothing said. */
export interface AccountOverride {
  readonly accountId: string;
  readonly taxTreatment: TaxTreatment | null;
  readonly role: AccountRole | null;
  readonly valuation: ValuationBasis | null;
  readonly updatedAt: Date;
}

/** The provider-derived default the caller computed from the account's own metadata. */
export interface ProviderTaxDefault {
  /** `null`: the provider's metadata puts the account in no bucket (cash, a loan, a 529). */
  readonly value: TaxTreatment | null;
  /**
   * `subtype`: the provider's subtype named it. `fallback`: nothing recognised it and the
   * conservative default (`TAXABLE`) applies. `none`: there is no bucket at all.
   */
  readonly basis: 'subtype' | 'fallback' | 'none';
}

export type TaxTreatmentSource = 'holder' | 'provider_subtype' | 'provider_fallback' | 'none';

export interface ResolvedAccountOverlay {
  readonly taxTreatment: {
    readonly value: TaxTreatment | null;
    readonly source: TaxTreatmentSource;
    /** What the holder set, whether or not it is the effective value. */
    readonly override: TaxTreatment | null;
    readonly providerDefault: TaxTreatment | null;
  };
  readonly role: {
    readonly value: AccountRole | null;
    readonly source: 'holder' | 'none';
  };
  readonly valuation: {
    readonly value: ValuationBasis;
    readonly source: 'holder' | 'default';
  };
}

export function resolveAccountOverlay(input: {
  readonly override: AccountOverride | null;
  readonly providerTaxDefault: ProviderTaxDefault;
}): ResolvedAccountOverlay {
  const override = input.override;
  const set = override?.taxTreatment ?? null;
  const provider = input.providerTaxDefault;
  const taxSource: TaxTreatmentSource =
    set !== null
      ? 'holder'
      : provider.value === null
        ? 'none'
        : provider.basis === 'subtype'
          ? 'provider_subtype'
          : 'provider_fallback';
  return Object.freeze({
    taxTreatment: Object.freeze({
      value: set ?? provider.value,
      source: taxSource,
      override: set,
      providerDefault: provider.value,
    }),
    role: Object.freeze({
      value: override?.role ?? null,
      source: override?.role != null ? ('holder' as const) : ('none' as const),
    }),
    valuation: Object.freeze({
      value: override?.valuation ?? 'holdings',
      source: override?.valuation != null ? ('holder' as const) : ('default' as const),
    }),
  });
}

/**
 * The override a projection's input digest is over: only accounts with something
 * set, ordered by account id so two processes digest the same bytes, and `null`
 * for "nothing set anywhere" so a holder who has never used overrides digests
 * exactly as before this feature existed.
 */
export function overrideFingerprint(overrides: readonly AccountOverride[]):
  | readonly {
      accountId: string;
      taxTreatment: string | null;
      role: string | null;
      valuation: string | null;
    }[]
  | null {
  const set = overrides
    .filter((o) => o.taxTreatment !== null || o.role !== null || o.valuation !== null)
    .map((o) => ({
      accountId: o.accountId,
      taxTreatment: o.taxTreatment,
      role: o.role,
      valuation: o.valuation,
    }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  return set.length === 0 ? null : set;
}
