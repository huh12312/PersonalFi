// SPDX-License-Identifier: MIT
/** The holder's overlay on an account (WP 9.2). Re-exported through `src/index.ts`. */
export { AccountOverrideChanged } from './events.ts';
export {
  overrideFingerprint,
  resolveAccountOverlay,
  type AccountOverride,
  type ProviderTaxDefault,
  type ResolvedAccountOverlay,
  type TaxTreatmentSource,
} from './resolve.ts';
export {
  clearAccountOverrides,
  getAccountOverride,
  isOverrideNotApplicable,
  listAccountOverrides,
  OverrideNotApplicable,
  overrideRefusal,
  setAccountOverrides,
  type OverrideWriteResult,
  type SetAccountOverridesInput,
} from './store.ts';
export {
  ACCOUNT_ROLES,
  MANAGEMENT_STYLES,
  OVERRIDE_FIELDS,
  TAX_TREATMENTS,
  VALUATION_BASES,
  type AccountRole,
  type ManagementStyle,
  type OverrideField,
  type TaxTreatment,
  type ValuationBasis,
} from './vocab.ts';
