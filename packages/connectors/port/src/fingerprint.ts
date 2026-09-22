// SPDX-License-Identifier: MIT
/**
 * `fingerprint`, and the stable ids a file import derives from it.
 *
 * 08 §2.5: "**`fingerprint` is mandatory for every adapter**, even ones with
 * stable IDs. It is the dedupe key when a CSV import overlaps a Plaid backfill,
 * and when a provider rotates its IDs." The formula is stated there as
 * `sha256(accountRef, postedDate, amount, normalized(description))` and that is
 * what is implemented below.
 *
 * Two separate uses, and conflating them is a bug:
 *
 *   * **`fingerprintOf`** answers "are these two sightings the same purchase?"
 *     across providers. It deliberately excludes the provider and the provider's
 *     id, because those are exactly what differs between the two sightings.
 *   * **`importedTransactionIdOf`** answers "have I imported this row before?".
 *     A CSV or an OFX file has no provider transaction id, so the id *is* the
 *     content hash, scoped to the provider and the account. Re-importing the
 *     same file therefore produces the same `providerTransactionId`, which makes
 *     the ledger's natural-key upsert (04 §4.4 layer 1) do the de-duplication
 *     with no import-side bookkeeping at all.
 *
 * The distinction matters because the ledger's cross-provider dedup deliberately
 * ignores *same*-provider fingerprint collisions — two identical coffees on the
 * same day at the same shop are a real and common event. So a CSV re-import
 * cannot rely on the fingerprint to dedupe itself; it relies on the id.
 *
 * Fields are joined with `U+0000`, which cannot occur in a bank descriptor, so
 * the serialisation is unambiguous without length prefixes.
 */
import type { DateOnly, Money } from '@core/kernel';
import { sha256 } from '@core/secretbox';
import type { SecurityIdentifier, SecurityIdentifierKind } from './facts.ts';

// Written as an escape, not as a literal NUL byte: a source file containing a
// raw NUL is treated as *binary* by git, which means it never appears in a
// diff, never merges, and silently drops out of code review. The runtime value
// is identical, so no fingerprint changes.
const SEPARATOR = '\u0000';

/**
 * The inner separator, for a key that is itself one field of another key.
 *
 * Also written as an escape, and for the same reason as `SEPARATOR`: a source
 * file containing a raw control byte is treated as *binary* by git, so it never
 * appears in a diff and silently drops out of code review.
 */
const IDENTIFIER_SEPARATOR = '\u001f';

/**
 * The descriptor, reduced to what two sightings of one purchase will agree on.
 *
 * Deliberately cruder than `@ctx/ledger`'s `normaliseMerchantName`: that one
 * produces a *merchant* key and strips processor prefixes and store numbers,
 * which is right for grouping a payee but wrong here — two different purchases
 * at the same shop must not fingerprint alike. This only folds case, collapses
 * whitespace and drops punctuation, so "AMZN Mktp US*2H4LK" and
 * "AMZN MKTP US *2H4LK" agree while "SQ *COFFEE 1" and "SQ *COFFEE 2" do not.
 */
export function normaliseDescription(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function digestOf(parts: readonly string[]): string {
  return hex(sha256(new TextEncoder().encode(parts.join(SEPARATOR))));
}

export interface FingerprintInput {
  /** The provider's account id. Provider-agnostic on purpose: see the note above. */
  readonly providerAccountId: string;
  readonly postedDate: DateOnly;
  readonly amount: Money;
  readonly description: string;
}

/** The cross-provider dedupe key. Mandatory on every canonical transaction. */
export function fingerprintOf(input: FingerprintInput): string {
  return digestOf([
    input.providerAccountId,
    input.postedDate,
    input.amount.minor.toString(),
    input.amount.currency,
    normaliseDescription(input.description),
  ]);
}

export interface ImportedIdInput extends FingerprintInput {
  readonly provider: string;
  /**
   * Distinguishes two genuinely identical rows in one file — two $4.50 coffees
   * on the same day at the same shop, printed twice because they happened twice.
   * Pass the row's ordinal *within its (account, date, amount, description)
   * group*, never its line number: a re-export of the same statement with one
   * extra row at the top would shift every line number and re-import everything.
   */
  readonly occurrence: number;
}

/**
 * A stable `providerTransactionId` for a source that supplies none.
 *
 * Scoped to the provider so a CSV import and a Plaid backfill of the same
 * purchase keep separate ids (and are reconciled by `fingerprint` instead), and
 * to the occurrence so a genuine duplicate row survives.
 */
export function importedTransactionIdOf(input: ImportedIdInput): string {
  return digestOf([
    input.provider,
    input.providerAccountId,
    input.postedDate,
    input.amount.minor.toString(),
    input.amount.currency,
    normaliseDescription(input.description),
    String(input.occurrence),
  ]);
}

/**
 * Identifier strength, strongest first. The port's half of the merge rule.
 *
 * It lives here because a *fingerprint* has to pick one identifier out of a set
 * and two providers must pick the same one, which makes the order part of the
 * canonical model rather than an implementation detail of whoever stores it.
 * `@ctx/investments` states the same order as its resolution tiers and pins it
 * with its own test; the boundary lint denies `packages/connectors/*` → `@ctx/*`
 * (and `@ctx/investments` → `@connector/port`), so the two declarations are
 * separate on purpose and each is pinned to the same literal list.
 *
 * Why this order:
 *
 *   * **figi** — globally unique, permanent, exchange-level, and issued by an
 *     open standard rather than by a vendor. There is nothing stronger.
 *   * **isin** — globally unique at the issue level, but blind to which venue a
 *     line is held on, so it cannot separate dual listings.
 *   * **cusip** — North America only, and licensed rather than open.
 *   * **ticker** — ambiguous without a MIC and reused after delistings.
 *   * **chain_contract** — exact for a token, but says nothing about a security.
 *   * **proprietary** — a provider's own id. Never an identity anywhere.
 *
 * `chain_contract` ranks below `ticker` **only for fingerprint selection**,
 * where the question is "which single name do two providers most likely share".
 * It is not a claim that a contract address is weaker evidence than a ticker;
 * `@ctx/investments` treats a chain+contract as exact for the asset it names.
 */
export const IDENTIFIER_RANK: readonly SecurityIdentifierKind[] = [
  'figi',
  'isin',
  'cusip',
  'ticker',
  'chain_contract',
  'proprietary',
];

/** The identifier two providers are most likely to agree on. `null` for an empty set. */
export function strongestIdentifier(
  identifiers: readonly SecurityIdentifier[],
): SecurityIdentifier | null {
  let best: SecurityIdentifier | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const identifier of identifiers) {
    const rank = IDENTIFIER_RANK.indexOf(identifier.kind);
    if (rank < 0 || rank >= bestRank) continue;
    best = identifier;
    bestRank = rank;
  }
  return best;
}

/**
 * The canonical serialisation of one identifier: `kind|value|chain|mic`.
 *
 * Case and surrounding whitespace are folded because providers are inconsistent
 * about both — a contract address arrives checksummed from one wallet and
 * lowercased from another, and they are the same address. Nothing else is
 * touched: a ticker's punctuation (`BRK.B` vs `BRK-B`) is a real difference
 * between venues and normalising it away would merge two securities.
 *
 * Joined with `U+001F` rather than the `U+0000` the money fingerprints use, so
 * that an identifier key nested inside `investmentTransactionFingerprintOf`'s
 * field list stays unambiguous at both levels without length prefixes.
 */
export function securityIdentifierKeyOf(identifier: SecurityIdentifier): string {
  return [
    identifier.kind,
    identifier.value.trim().toLowerCase(),
    (identifier.chain ?? '').trim().toLowerCase(),
    (identifier.mic ?? '').trim().toUpperCase(),
  ].join(IDENTIFIER_SEPARATOR);
}

/**
 * The cross-provider dedupe key for a security.
 *
 * Over the strongest identifier only — see `ProviderSecurityFact.fingerprint`
 * for why hashing the whole set would make the key a function of how chatty the
 * provider is. A fact with no identifiers at all is a fact that cannot be
 * deduplicated against anything, and saying so by throwing is better than
 * minting a hash of the empty string that every such fact would then share.
 */
export function securityFingerprintOf(identifiers: readonly SecurityIdentifier[]): string {
  const strongest = strongestIdentifier(identifiers);
  if (strongest === null) {
    throw new Error(
      'securityFingerprintOf: a security fact carried no identifiers at all. An adapter that ' +
        'cannot name a security must not emit a fact for it — a fingerprint over nothing would ' +
        'collide with every other unnamed security.',
    );
  }
  return digestOf([securityIdentifierKeyOf(strongest)]);
}

export interface InvestmentTransactionFingerprintInput {
  readonly providerAccountId: string;
  readonly date: DateOnly;
  readonly amount: Money;
  /** `null` for a cash sweep, a fee or a deposit — a real transaction with no security. */
  readonly security: SecurityIdentifier | null;
  /** Decimal string, signed. Part of the key: two same-day fills differ by size. */
  readonly quantity: string;
}

/**
 * The cross-provider dedupe key for an investment transaction.
 *
 * Deliberately *not* `fingerprintOf`: a bank transaction is identified by its
 * descriptor, and an investment transaction's `name` is provider boilerplate
 * ("BUY VANGUARD TOTAL STOCK MKT") that two providers will never spell alike.
 * What they do agree on is the account, the day, the security, the quantity and
 * the cash amount, so those are the fields. The security contributes its
 * strongest identifier for the same reason `securityFingerprintOf` does.
 */
export function investmentTransactionFingerprintOf(
  input: InvestmentTransactionFingerprintInput,
): string {
  return digestOf([
    input.providerAccountId,
    input.date,
    input.amount.minor.toString(),
    input.amount.currency,
    input.security === null ? '' : securityIdentifierKeyOf(input.security),
    input.quantity.trim(),
  ]);
}

/**
 * Number each row within its `(date, amount, description)` group, in file order.
 *
 * Returned as a parallel array so the caller can zip it with its own rows. Split
 * out from `importedTransactionIdOf` because it is the part with a subtle
 * requirement — stability under re-export — and a pure function over an array is
 * the only way to test that requirement directly.
 */
export function occurrencesOf(
  rows: readonly {
    readonly postedDate: DateOnly;
    readonly amount: Money;
    readonly description: string;
  }[],
): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = [
      row.postedDate,
      row.amount.minor.toString(),
      row.amount.currency,
      normaliseDescription(row.description),
    ].join(SEPARATOR);
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    return next;
  });
}
