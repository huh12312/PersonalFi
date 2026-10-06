// SPDX-License-Identifier: MIT
/**
 * WP 9.2: one account's overlay, resolved — the holder's override over the
 * provider-derived default.
 *
 * Planning owns the default (the subtype map in `ports.ts`) and the ledger owns
 * the override and the pure resolver; neither can import the other's half, but
 * Planning sits above Ledger (08 §1.6) and may call its published resolver. This
 * is the one function that joins them, and `apps/api/src/domain.ts` calls it
 * rather than re-deriving: the accounts screen's "from Plaid: 401k" / "set by
 * you", the projection's tax bucket and the net-worth valuation basis are all
 * this function's answer, so they cannot disagree.
 */
import {
  resolveAccountOverlay,
  type AccountOverride,
  type ResolvedAccountOverlay,
} from '@ctx/ledger';
import {
  defaultTaxBucketWithBasis,
  type AccountKind,
  type AccountOverlayFacts,
  type CashflowAccount,
} from './ports.ts';

export function resolveOverlayFor(
  kind: AccountKind,
  subtype: string | null,
  override: AccountOverride | null,
): ResolvedAccountOverlay {
  const provider = defaultTaxBucketWithBasis(kind, subtype);
  return resolveAccountOverlay({
    override,
    providerTaxDefault: { value: provider.bucket, basis: provider.basis },
  });
}

/** What the holder has set, raw, for the projection's input digest; `null` when nothing is. */
export function overlayFactsOf(override: AccountOverride | null): AccountOverlayFacts | null {
  if (override === null) return null;
  return {
    taxTreatment: override.taxTreatment,
    role: override.role,
    valuation: override.valuation,
  };
}

/**
 * A roster entry with the holder's overlay applied: the effective tax bucket
 * (the override's where set, the provider-subtype default otherwise) and the raw
 * overlay the digest is over. Assigning the ledger's `TaxTreatment` to this
 * context's `TaxBucket` here is the build-time check the two four-word lists
 * still agree.
 */
export function withOverlay(
  account: Omit<CashflowAccount, 'taxBucket' | 'overlay'>,
  input: { readonly subtype: string | null; readonly override: AccountOverride | null },
): CashflowAccount {
  const resolved = resolveOverlayFor(account.kind, input.subtype, input.override);
  return {
    ...account,
    taxBucket: resolved.taxTreatment.value,
    overlay: overlayFactsOf(input.override),
  };
}
