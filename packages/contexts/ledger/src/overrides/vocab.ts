// SPDX-License-Identifier: MIT
/**
 * The closed vocabularies of an account override. Defined beside the table
 * (`schema/account-overrides.ts`, as `ACCOUNT_TYPES` is beside `accounts`) and
 * re-exported here; each is also a CHECK constraint in
 * `0035_account_overrides.sql`, and `test/db/account-overrides.test.ts` asserts
 * the two agree.
 */
export {
  ACCOUNT_ROLES,
  TAX_TREATMENTS,
  VALUATION_BASES,
  type AccountRole,
  type TaxTreatment,
  type ValuationBasis,
} from '../../schema/account-overrides.ts';

/** The three overridable fields, by the name the event and the staleness reason use. */
export const OVERRIDE_FIELDS = ['taxTreatment', 'role', 'valuation'] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];
