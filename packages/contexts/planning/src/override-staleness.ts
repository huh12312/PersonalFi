// SPDX-License-Identifier: MIT
/**
 * WP 9.2: a change to what the holder says an account is moves the projection's
 * input digest, so a stored baseline computed before it reads **stale** and
 * names what changed — never silently recomputed.
 *
 * ## Level-triggered, not event-triggered
 *
 * `ledger.AccountOverrideChanged` is emitted for anything that wants to react,
 * but staleness is not a flag an event sets. Each stored run carries, in its own
 * input document, the fingerprint of the overlay it was computed from; "stale"
 * is that fingerprint differing from the holder's overlay *now*. A flag set by a
 * consumer can be lost (a poisoned event, a replay from a restored backup, an
 * override changed while the pump was down) and then a stale plan reads fresh —
 * the one failure this feature exists to prevent. A comparison cannot miss a
 * change.
 *
 * Only accounts with something set are in the fingerprint, and a holder with
 * nothing set anywhere has *no* `accountOverrides` key in the document at all, so
 * every run stored before this feature digests, caches and reads back exactly as
 * it did.
 */
import type { CashflowAccount } from './ports.ts';

export const OVERRIDE_FIELDS = ['taxTreatment', 'role', 'valuation'] as const;
export type OverrideFieldName = (typeof OVERRIDE_FIELDS)[number];

export interface OverrideFingerprintEntry {
  readonly accountId: string;
  readonly taxTreatment: string | null;
  readonly role: string | null;
  readonly valuation: string | null;
}

/** `null`: the holder has set nothing on any account. Ordered by account id. */
export type OverrideFingerprint = readonly OverrideFingerprintEntry[] | null;

/** One field of one account that differs between the stored run and now. */
export interface OverrideChange {
  readonly accountId: string;
  readonly field: OverrideFieldName;
  /** What the run was computed with (`null`: nothing set). */
  readonly from: string | null;
  /** What the holder has set now (`null`: cleared). */
  readonly to: string | null;
}

/** The fingerprint of the overlay on a roster of accounts. */
export function fingerprintOf(
  accounts: readonly Pick<CashflowAccount, 'accountId' | 'overlay'>[],
): OverrideFingerprint {
  const entries = accounts
    .filter(
      (account) =>
        account.overlay != null &&
        (account.overlay.taxTreatment !== null ||
          account.overlay.role !== null ||
          account.overlay.valuation !== null),
    )
    .map((account) => ({
      accountId: account.accountId,
      taxTreatment: account.overlay?.taxTreatment ?? null,
      role: account.overlay?.role ?? null,
      valuation: account.overlay?.valuation ?? null,
    }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  return entries.length === 0 ? null : entries;
}

/** The fingerprint a stored run's input document recorded; `null` when it recorded none. */
export function storedFingerprintOf(input: Readonly<Record<string, unknown>>): OverrideFingerprint {
  const raw = input['accountOverrides'];
  if (!Array.isArray(raw)) return null;
  const entries: OverrideFingerprintEntry[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = (key: string): string | null =>
      typeof record[key] === 'string' ? (record[key] as string) : null;
    const accountId = text('accountId');
    if (accountId === null) continue;
    entries.push({
      accountId,
      taxTreatment: text('taxTreatment'),
      role: text('role'),
      valuation: text('valuation'),
    });
  }
  return entries.length === 0 ? null : entries;
}

/**
 * Every field that differs, ordered by account then field. Empty means the run
 * was computed from the overlay the holder has now.
 */
export function diffOverrideFingerprints(
  stored: OverrideFingerprint,
  current: OverrideFingerprint,
): OverrideChange[] {
  const before = new Map((stored ?? []).map((entry) => [entry.accountId, entry] as const));
  const after = new Map((current ?? []).map((entry) => [entry.accountId, entry] as const));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: OverrideChange[] = [];
  for (const accountId of ids) {
    for (const field of OVERRIDE_FIELDS) {
      const from = before.get(accountId)?.[field] ?? null;
      const to = after.get(accountId)?.[field] ?? null;
      if (from !== to) changes.push({ accountId, field, from, to });
    }
  }
  return changes;
}
