// SPDX-License-Identifier: MIT
/**
 * The two version numbers the Advisor contract carries, and why there are two.
 *
 * `@core/contracts` holds the normative artefact — `advisor/v1/*.schema.json` —
 * and one constant, `ADVISOR_CONTRACT_VERSION = '1.0.0'`. That is the *artefact*
 * version: it moves when anything in the published schema changes, additive or
 * not, so a reader can tell two checkouts apart.
 *
 * `contract_version` on the wire is a **single integer** (08 §4.4: "a single
 * integer, negotiated at registration … we support N and N-1 simultaneously").
 * An advisor pins a major and must refuse anything it does not understand; a
 * patch to the schema must never force a sidecar redeploy, which is exactly what
 * putting `'1.0.0'` on the wire would do.
 *
 * So: `1` crosses the boundary, `'1.0.0'` describes the file. They are bumped by
 * different events and `contract-parity.test.ts` asserts the major agrees with
 * the semver's leading component, so the two cannot silently disagree.
 */

/** The wire major. Everything in `v1/` speaks this. */
export const ADVISOR_CONTRACT_MAJOR = 1 as const;

/**
 * Majors this build will speak, newest first.
 *
 * One entry today. 08 §4.4 requires N and N-1 once there is an N-1, and the list
 * exists now so that the negotiation code path has something real to read rather
 * than being written for the first time under pressure.
 */
export const SUPPORTED_CONTRACT_MAJORS: readonly number[] = Object.freeze([
  ADVISOR_CONTRACT_MAJOR,
]);

/** `$id` prefix for every schema document in the bundle. */
export const ADVISOR_SCHEMA_BASE = 'https://personalfi.local/contracts/advisor/v1' as const;
