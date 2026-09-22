// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/investments`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — here,
 * `0013_securities.sql`, whose header is where the design is argued.
 *
 * Three tables so far, all user-scoped (decision D6), none of them carrying a
 * foreign key into another context's schema. WP 3.2 adds `holdings`,
 * `holdings_snapshots`, `investment_transactions` and `cost_basis_lots` in
 * 0014; WP 3.4 adds the market-data tables in 0015. They are *claimed* in
 * OWNERSHIP.md already, which is the point of claiming early.
 */
export {
  ASSET_CLASSES,
  CLASSIFICATION_SOURCES,
  IDENTIFIER_KINDS,
  IDENTITY_KINDS,
  OVERLAY_FIELDS,
  REGIONS,
  SECURITY_TYPES,
  securities,
  securityIdentifiers,
  securityOverlay,
  type AssetClass,
  type ClassificationSource,
  type IdentifierKind,
  type IdentityKind,
  type NewSecurityIdentifierRow,
  type NewSecurityOverlayRow,
  type NewSecurityRow,
  type OverlayField,
  type Region,
  type SecurityIdentifierRow,
  type SecurityOverlayRow,
  type SecurityRow,
  type SecurityType,
} from './securities.ts';
