// SPDX-License-Identifier: MIT
/**
 * The advisory catalogue's version and the digest it is pinned to (WP 11.5b;
 * 12 §2.1: "the catalogue is versioned and its OpenAPI is the contract the
 * compiler is shown").
 *
 * `catalogueDescription()` is generated from the same definitions
 * `callCatalogue` runs, and `test/catalogue-pin.test.ts` holds two pins:
 *
 *   * the description is byte-for-byte the checked-in
 *     `packages/contracts/advisor/catalogue/catalogue-<n>.json` for this version;
 *   * its digest is `CATALOGUE_DESCRIPTION_DIGEST`.
 *
 * Change a function's name, scopes, description, parameters or result shape and
 * both go red. The way back is a decision, not a regeneration: bump
 * `CATALOGUE_VERSION` (a new file beside the old one, which stays as the record)
 * or, for a change that does not alter what a caller may rely on, move the pin
 * deliberately in the same diff as the definition — reviewable either way.
 */

/** The version every result carries and the compiler is shown. */
export const CATALOGUE_VERSION = 'catalogue/1' as const;

/** The file the description is published as, under `packages/contracts/advisor/catalogue/`. */
export const CATALOGUE_DESCRIPTION_FILE = 'catalogue-1.json';

/** `sha256:` over the canonical JSON of `catalogueDescription()` at this version. */
export const CATALOGUE_DESCRIPTION_DIGEST =
  'sha256:8c54512a00091504c8acecf8d6b2e6b9ae0262cbbc5f7a85623152fc58658a43';
