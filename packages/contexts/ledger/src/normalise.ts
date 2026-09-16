// SPDX-License-Identifier: MIT
import type { DateOnly, Money } from '@core/kernel';
import { sha256 } from '@core/secretbox';

/**
 * Statement-descriptor normalisation, Phase-1 grade.
 *
 * A bank does not send you "Blue Bottle Coffee". It sends `SQ *BLUE BOTTLE
 * COFFEE`, `TST* THE FRENCH LAUNDRY`, `AMZN Mktp US*2K4TT1FF2`, `COSTCO WHSE
 * #1234 SEATTLE WA` and `SHELL OIL 57443021 PORTLAND OR`. The ledger needs those
 * to converge on one key per payee so the list can group, and so the transfer and
 * refund heuristics have something stable to match on.
 *
 * **This is deliberately a heuristic and deliberately small.** The real merchant
 * pipeline — alias corpora, trigram clustering, the learned payee map — is WP 1.4
 * (`@ctx/categorization`). What lives here is the part Ledger cannot do without,
 * and it is written to be obviously wrong in predictable ways rather than subtly
 * wrong in surprising ones: it only ever *removes* noise it can name.
 *
 * ## Two keys, not one (decision D25)
 *
 * Normalisation answers "do these two descriptors group?". It does **not** answer
 * "is there a payee here at all?", and until D25 nothing did: any non-blank
 * descriptor produced a `merchants` row, so `CHECK 1234`, `TRANSFER TO SAVINGS`
 * and `INTEREST PAID` became merchants alongside Blue Bottle Coffee (gate finding
 * R-4). That was survivable while merchants were only a display grouping; Phase 2
 * hangs rules, budgets, subscriptions and recurring detection off merchant
 * identity, so a merchant that is really a banking operation becomes a budget
 * line nobody can explain.
 *
 * So the result carries two keys and they are deliberately different:
 *
 *   * `key` — the **fingerprint**. Unchanged. `dedupKeyOf` hashes it and the
 *     fuzzy pending→posted matcher compares it. It must stay maximally
 *     discriminating: if `TRANSFER TO SAVINGS` and `TRANSFER FROM CHECKING`
 *     collapsed to the same empty key, two unrelated transfers on one date for
 *     one amount would fingerprint identically and one of them would be marked a
 *     cross-provider duplicate and hidden. Losing a real transaction to a tidier
 *     merchant table is not a trade worth making.
 *   * `merchantKey` — the **identity**. `null` when the residue names a banking
 *     operation. This is the one that reaches `merchants`.
 *
 * `resolveMerchantIdentity` below is the full rule, including what a provider's
 * own `merchant_name` and `counterparties[].entity_id` are allowed to override.
 */

/**
 * Payment-processor prefixes. Each of these is a real, recognisable pattern, and
 * each one otherwise produces a separate "merchant" per processor rather than per
 * payee. Ordered longest-first so `PAYPAL *` is tried before `PP*`.
 */
const PROCESSOR_PREFIXES = [
  'AMZN MKTP US*',
  'AMZN MKTP CA*',
  'AMZN MKTP',
  'PAYPAL *',
  'SQUARE *',
  'TST* ',
  'TST*',
  'SQ *',
  'SQ*',
  'SP ',
  'PP*',
  'POS ',
  'DEBIT CARD PURCHASE ',
  'ACH DEBIT ',
  'ACH CREDIT ',
] as const;

/**
 * Processor prefixes that identify the payee rather than merely wrapping it.
 * `AMZN Mktp US*2K4TT1FF2` carries an order id, not a merchant name, so stripping
 * the prefix leaves gibberish; the prefix *was* the merchant.
 */
const PREFIX_IS_THE_MERCHANT = new Map<string, string>([
  ['AMZN MKTP US*', 'Amazon'],
  ['AMZN MKTP CA*', 'Amazon'],
  ['AMZN MKTP', 'Amazon'],
]);

/** US state codes, for stripping a `... SEATTLE WA` tail without eating a real word. */
const STATE_CODES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
]);

export interface NormalisedMerchant {
  /**
   * Lower-case, alphanumeric, collapsed. Never contains spaces.
   *
   * The **fingerprint** key: what `dedupKeyOf` hashes and what the fuzzy
   * pending→posted matcher compares. Deliberately *not* gated by D25 — see
   * `merchantKey` below, and the header note on why the two must differ.
   */
  readonly key: string;
  /** What a human reads. Cleaned, but still recognisably what the bank sent. */
  readonly display: string;
  /**
   * The **identity** key (decision D25): `key` when the residue names a payee,
   * `null` when it names a banking operation and no `merchants` row should
   * exist. Always either `null` or exactly equal to `key`.
   */
  readonly merchantKey: string | null;
  /** Why identity was refused, for tests and for an operator's log line. */
  readonly abstainReason: MerchantAbstainReason | null;
}

const EMPTY: NormalisedMerchant = Object.freeze({
  key: '',
  display: '',
  merchantKey: null,
  abstainReason: 'empty',
});

export function normaliseMerchantName(raw: string): NormalisedMerchant {
  const collapsed = raw.replaceAll(/\s+/gu, ' ').trim();
  if (collapsed === '') return EMPTY;

  const upper = collapsed.toUpperCase();

  for (const prefix of PROCESSOR_PREFIXES) {
    if (!upper.startsWith(prefix)) continue;
    const replacement = PREFIX_IS_THE_MERCHANT.get(prefix);
    if (replacement !== undefined) return finish(replacement);
    return finish(stripNoise(collapsed.slice(prefix.length)));
  }

  return finish(stripNoise(collapsed));
}

/**
 * Remove the parts of a descriptor that vary between two visits to the same shop:
 * a store number, a terminal id, a city/state tail, a trailing order reference.
 */
function stripNoise(value: string): string {
  let out = value;
  // `#1234`, `# 1234`, `STORE 1234`.
  out = out.replaceAll(/\s*#\s*\d+/gu, ' ');
  out = out.replaceAll(/\bSTORE\s+\d+\b/giu, ' ');
  // Standalone digit runs of 4 or more: terminal ids, order references, phone
  // numbers. Four rather than three so `7-ELEVEN 711` style names survive.
  out = out.replaceAll(/\b\d{4,}\b/gu, ' ');
  out = out.replaceAll(/\s+/gu, ' ').trim();

  // A trailing `CITY ST` tail, where `ST` is a real state code. Up to three words
  // of city, because `SALT LAKE CITY UT` exists.
  const words = out.split(' ');
  const last = words.at(-1);
  if (words.length >= 3 && last !== undefined && STATE_CODES.has(last.toUpperCase())) {
    // Drop the state and up to one city word. Dropping more risks eating the
    // merchant ("MARRIOTT HOTELS DENVER CO" must not become "MARRIOTT").
    out = words.slice(0, -2).join(' ');
  }

  // Trailing separators left behind by the removals above.
  out = out.replace(/[\s*\-–—,.:;/\\]+$/u, '').trim();
  return out;
}

function finish(display: string): NormalisedMerchant {
  const cleaned = display.trim();
  if (cleaned === '') return EMPTY;
  const key = cleaned.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '');
  if (key === '') return EMPTY;
  const abstainReason = merchantAbstainReasonOf(cleaned);
  return {
    key,
    display: prettify(cleaned),
    merchantKey: abstainReason === null ? key : null,
    abstainReason,
  };
}

// ---------------------------------------------------------------------------
// D25 — the merchant-identity gate
// ---------------------------------------------------------------------------

/**
 * Why a descriptor was refused a `merchants` row. Reported rather than swallowed
 * so a test can assert *which* rule fired, and so "why is this not grouped?" has
 * an answer that is not "read the regex".
 */
export type MerchantAbstainReason =
  /** Nothing survived normalisation at all. */
  | 'empty'
  /** Fewer than `MIN_ALPHABETIC` letters left once identity-free residue is gone. */
  | 'too_few_letters'
  /** `TRANSFER TO …` / `XFER FROM …`: the tail names an account, not a payee. */
  | 'self_transfer'
  /** Every remaining token is banking vocabulary: `CHECK`, `INTEREST PAID`, … */
  | 'bank_operation';

/**
 * The floor on alphabetic characters, set by the shortest real merchant names in
 * the corpus rather than by taste: `REI`, `CVS`, `PG&E` and `AT&T` are all
 * exactly three letters once punctuation is dropped. Four would delete them.
 */
const MIN_ALPHABETIC = 3;

/** Verbs that, followed by a direction, mean "this moved between accounts". */
const TRANSFER_VERBS = new Set(['TRANSFER', 'XFER', 'TFR', 'TRF']);
const TRANSFER_DIRECTIONS = new Set(['TO', 'FROM']);

/**
 * Tokens that name a banking *operation* rather than a payee.
 *
 * The list only matters when **every** surviving token is in it, which is what
 * makes it safe to include words that also occur inside real names: `BANK OF
 * AMERICA` keeps `AMERICA`, `CASH APP` keeps `APP`, `DIRECT TV` keeps `TV`, and
 * all three resolve. Membership is by whole whitespace-delimited token, so
 * `T-MOBILE` never matches `MOBILE`.
 *
 * English only, and seeded from the descriptors in this repo's own corpora
 * (`@core/seed`, the Plaid fixtures, the CSV/OFX/QIF fixtures) rather than
 * invented. A German `GEHALT` or a Spanish `NOMINA` therefore still resolves to
 * a merchant — which is the *recoverable* failure direction (see the D25 note in
 * `resolveMerchantIdentity`), and extending the vocabulary is a data change with
 * no structural consequence.
 */
const OPERATION_VOCABULARY = new Set([
  'ACH',
  'ADJUSTMENT',
  'ATM',
  'AUTH',
  'AUTHORIZATION',
  'AUTOPAY',
  'BAL',
  'BALANCE',
  'BANK',
  'BILL',
  'BILLPAY',
  'CARD',
  'CASH',
  'CHARGE',
  'CHECK',
  'CHEQUE',
  'CHK',
  'CREDIT',
  'DBT',
  'DEBIT',
  'DEP',
  'DEPOSIT',
  'DIRECT',
  'DRAFT',
  'EFT',
  'ELECTRONIC',
  // `ENDING IN 4471` reaches the gate as bare `ENDING IN`, because `stripNoise`
  // has already eaten the digits. The words have to be vocabulary or the residue
  // resolves to a merchant called "Ending In".
  'ENDING',
  'FEE',
  'FEES',
  'FROM',
  'IN',
  'INT',
  'INTEREST',
  'MEMO',
  'MISC',
  'MOBILE',
  'ONLINE',
  'OVERDRAFT',
  'PAID',
  'PAY',
  'PAYMENT',
  'PAYROLL',
  'PMT',
  'POS',
  'PPD',
  'PURCHASE',
  'RECURRING',
  'REF',
  'REFERENCE',
  'REVERSAL',
  'SALARY',
  'SERVICE',
  'SPLIT',
  'STATEMENT',
  'TEL',
  // `PAYMENT THANK YOU` and `ONLINE PAYMENT THANK YOU` are how most US card
  // issuers describe a statement payment. Without these two words the whole
  // phrase resolves to a merchant called "Payment Thank You" — which is both the
  // single most common noise merchant in the wild and, being a card payment, a
  // transfer that must never reach a spend total.
  'THANK',
  'YOU',
  'TFR',
  'TO',
  'TRANSACTION',
  'TRANSFER',
  'TRF',
  'WD',
  'WEB',
  'WIRE',
  'WITHDRAWAL',
  'XFER',
]);

/**
 * Residue that identifies an *event* rather than a *payee* and therefore may not
 * contribute to identity: dates in any of the three common orders, clock times,
 * masked card suffixes, and bare digit runs of any length.
 *
 * `stripNoise` already removes digit runs of four or more, because those are the
 * ones that make two visits to one shop look like two shops. This goes further
 * because the question here is different: not "do these group?" but "is there a
 * payee here at all?", and `CHECK 123` has no payee in it.
 */
const IDENTITY_FREE_RESIDUE: readonly RegExp[] = [
  /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/gu,
  /\b\d{1,2}:\d{2}(:\d{2})?\b/gu,
  /\bENDING(\s+IN)?\s+\d+\b/giu,
  /\b[X*]{2,}\s*\d*\b/giu,
  /\b\d+\b/gu,
];

/**
 * The D25 predicate, as a function of the cleaned descriptor residue.
 *
 * Returns `null` when the residue names a payee — which is the default, and
 * deliberately so. This module's contract is that it "only ever removes noise it
 * can name" (see the file header): every rule below refuses identity for a
 * *named*, enumerable reason, and anything unrecognised keeps its merchant. The
 * alternative — a similarity or entropy score that abstains when unsure — fails
 * silently and unpredictably, and a real payee that never gets a `merchants` row
 * is invisible to every rule, budget and subscription Phase 2 hangs off merchant
 * identity.
 */
export function merchantAbstainReasonOf(cleaned: string): MerchantAbstainReason | null {
  let residue = cleaned.toUpperCase();
  for (const pattern of IDENTITY_FREE_RESIDUE) residue = residue.replaceAll(pattern, ' ');
  residue = residue.replaceAll(/\s+/gu, ' ').trim();

  const letters = residue.replaceAll(/[^A-Z]/gu, '');
  if (letters.length < MIN_ALPHABETIC) return 'too_few_letters';

  // Tokens are compared by their alphanumeric content (`stripPunctuation`), so a
  // token that has *no* alphanumeric content is not a word at all. Dropping
  // those is what makes `PAYMENT - THANK YOU` — a real and common card-payment
  // descriptor — read the same as `PAYMENT THANK YOU`; without it the bare `-`
  // is a token no vocabulary can contain, `tokens.every(...)` is false, and one
  // dash rescues the phrase from a gate that exists to refuse it. Filtering can
  // only ever make the vocabulary rule refuse *more*, never a real payee fewer:
  // a name survives on the strength of a word the vocabulary lacks, and
  // punctuation is never that word.
  const tokens = residue
    .split(' ')
    .map((token) => stripPunctuation(token))
    .filter((token) => token !== '');

  // `TRANSFER TO HIGH-YIELD SAVINGS`. The tail is one of the user's own account
  // names, so a `merchants` row here does not name a payee — it names an
  // account, and Phase 2 would hang a budget rule off it.
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    if (!TRANSFER_VERBS.has(token)) continue;
    if (next !== undefined && !TRANSFER_DIRECTIONS.has(next)) continue;
    return 'self_transfer';
  }

  if (tokens.every((token) => OPERATION_VOCABULARY.has(token))) {
    return 'bank_operation';
  }

  return null;
}

function stripPunctuation(token: string): string {
  return token.replaceAll(/[^A-Z0-9&]/giu, '').toUpperCase();
}

// ---------------------------------------------------------------------------
// D25 — merchant identity, across the three things a provider can tell us
// ---------------------------------------------------------------------------

/** The subset of a counterparty this rule reads. Structural, so the ledger's
 * `ProviderCounterparty` and a connector's own shape both satisfy it. */
export interface MerchantCounterparty {
  readonly name: string;
  readonly type: string | null;
  readonly entityId: string | null;
}

export interface MerchantIdentityInput {
  /** The raw statement descriptor. `transactions_provider.name`. */
  readonly name: string;
  /** The provider's own cleaned merchant name, when it supplied one. */
  readonly merchantName?: string | null;
  /** The user's override. Explicit intent; never gated. */
  readonly userMerchantName?: string | null;
  /** Namespaces the entity ids. `transactions_provider.provider`. */
  readonly provider?: string | null;
  readonly counterparties?: readonly MerchantCounterparty[] | null;
}

/** Which tier answered. Recorded so a merchant row's provenance is inspectable. */
export type MerchantIdentitySource =
  'user' | 'provider_entity' | 'provider_name' | 'descriptor' | 'none';

export interface MerchantIdentity {
  /** `null` means *no `merchants` row*, and is the whole point of D25. */
  readonly key: string | null;
  /** Always the best available display string, even when `key` is `null`. */
  readonly display: string;
  readonly source: MerchantIdentitySource;
  readonly abstainReason: MerchantAbstainReason | null;
  /**
   * Provider entity ids seen for this payee, namespaced `provider:entityId`.
   * Stored on `merchants.provider_entity_ids` as corroborating evidence — never
   * as the identity itself. Sorted and deduplicated, so the value is a function
   * of the input and two syncs cannot produce two orderings.
   */
  readonly entityIds: readonly string[];
}

/**
 * Resolve one transaction's merchant identity (decision D25).
 *
 * Pure and total. Four tiers, first answer wins:
 *
 * 1. **The user.** `userMerchantName` is explicit intent and is never gated — if
 *    somebody types "Transfer to Mum" into the merchant field, that is a payee
 *    they want grouped, and second-guessing it is how an app earns a reputation
 *    for arguing with its owner.
 * 2. **A provider entity.** A `counterparties[]` entry carrying an `entity_id`
 *    is the provider *asserting* that a merchant was involved, on evidence we do
 *    not have (Plaid resolves these against its own corpus). That assertion
 *    outranks our text heuristics, so the gate is skipped — `AMZN MKTP
 *    US*2K4TT1FF2` is gibberish as text and unambiguous as an entity.
 * 3. **The provider's cleaned name**, gated.
 * 4. **The raw descriptor**, gated.
 *
 * ## Why the entity id is evidence and not the key
 *
 * `plaid:eyg8o776…` would be a better key than `bluebottlecoffee` — it is stable
 * across every descriptor variation, which is exactly what merchant-store.ts's
 * header says the `merchants` table exists to achieve. It is still the wrong
 * choice here, because entity ids are *sparse*: the same Blue Bottle appears with
 * an entity id through Plaid and without one through a CSV import of the same
 * card, and keying on the entity id would file one payee under two rows and split
 * a year of history between them — the precise failure that header warns about.
 * So the normalised text stays the identity, the entity ids accumulate on the row
 * (`provider_entity_ids`, a column that has existed and been empty since
 * migration 0004), and a later work package that wants entity-first identity has
 * the corpus it needs to do the merge safely rather than a flag day.
 *
 * Namespacing (`provider:entityId`) is not decoration: two aggregators' id spaces
 * are unrelated, and the prefix is collision-proof against the text keys by
 * construction because a text key is `[a-z0-9]+` and can never contain a colon.
 */
export function resolveMerchantIdentity(input: MerchantIdentityInput): MerchantIdentity {
  const entityIds = namespacedEntityIds(input.provider ?? null, input.counterparties ?? null);

  const userName = blankToNull(input.userMerchantName ?? null);
  if (userName !== null) {
    const normalised = normaliseMerchantName(userName);
    return {
      key: normalised.key === '' ? null : normalised.key,
      display: normalised.display,
      source: normalised.key === '' ? 'none' : 'user',
      abstainReason: normalised.key === '' ? 'empty' : null,
      entityIds,
    };
  }

  const providerName = blankToNull(input.merchantName ?? null);
  const fallback = normaliseMerchantName(providerName ?? input.name);

  if (entityIds.length > 0) {
    const asserted = providerName ?? merchantCounterpartyName(input.counterparties ?? null);
    const normalised = asserted === null ? fallback : normaliseMerchantName(asserted);
    if (normalised.key !== '') {
      return {
        key: normalised.key,
        display: normalised.display,
        source: 'provider_entity',
        abstainReason: null,
        entityIds,
      };
    }
  }

  if (providerName !== null) {
    const normalised = normaliseMerchantName(providerName);
    return {
      key: normalised.merchantKey,
      display: normalised.display,
      source: normalised.merchantKey === null ? 'none' : 'provider_name',
      abstainReason: normalised.abstainReason,
      entityIds,
    };
  }

  const normalised = normaliseMerchantName(input.name);
  return {
    key: normalised.merchantKey,
    display: normalised.display,
    source: normalised.merchantKey === null ? 'none' : 'descriptor',
    abstainReason: normalised.abstainReason,
    entityIds,
  };
}

/**
 * Merchant-type counterparties only, namespaced, sorted, deduplicated.
 *
 * `type === null` counts as a merchant: the CSV and manual connectors do not
 * populate a type, and dropping their entity ids would make the evidence column
 * a Plaid-only feature by accident rather than by decision.
 */
function namespacedEntityIds(
  provider: string | null,
  counterparties: readonly MerchantCounterparty[] | null,
): readonly string[] {
  if (counterparties === null || counterparties.length === 0) return [];
  const namespace = blankToNull(provider) ?? 'unknown';
  const ids = new Set<string>();
  for (const counterparty of counterparties) {
    if (counterparty.type !== null && counterparty.type.toLowerCase() !== 'merchant') continue;
    const entityId = blankToNull(counterparty.entityId);
    if (entityId === null) continue;
    ids.add(`${namespace}:${entityId}`);
  }
  return [...ids].sort();
}

function merchantCounterpartyName(
  counterparties: readonly MerchantCounterparty[] | null,
): string | null {
  if (counterparties === null) return null;
  for (const counterparty of counterparties) {
    if (counterparty.type !== null && counterparty.type.toLowerCase() !== 'merchant') continue;
    if (blankToNull(counterparty.entityId) === null) continue;
    const name = blankToNull(counterparty.name);
    if (name !== null) return name;
  }
  return null;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Banks shout. Title-case a SHOUTED descriptor so the list is readable, but leave
 * short all-caps tokens alone — `REI`, `CVS`, `PG&E` and `AT&T` are the name, not
 * an accident of the wire format, and "Pg&E" is worse than "PG&E".
 */
function prettify(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value
    .split(' ')
    .map((word) => {
      const letters = word.replaceAll(/[^A-Za-z]/gu, '');
      if (letters.length <= 3) return word;
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * The provider-agnostic fingerprint used to spot the same real-world transaction
 * arriving through two different providers.
 *
 * Deliberately excludes the provider, the provider's transaction id, and the
 * account: those are exactly the things that differ between two sightings of one
 * purchase. What is left — the calendar date, the signed amount, the currency, and
 * the normalised payee — is what a human would use to say "that is the same
 * charge".
 *
 * **The hash is a bucketing device, not a security control.** It exists so the
 * lookup is one fixed-width index probe instead of a four-column comparison, and
 * the components are stored beside it in `ledger_dedup_keys` so a candidate is
 * verified exactly rather than trusted on a hash match. It routes through
 * `@core/secretbox` because that package is the repo's single sanctioned hash;
 * hand-rolling one here to avoid the import would be the worse trade.
 */
export function dedupKeyOf(input: {
  readonly postedDate: DateOnly;
  readonly amount: Money;
  readonly nameKey: string;
}): string {
  // NUL as the separator, written as an escape rather than as a literal byte:
  // a raw NUL in the source makes git treat this file as binary and stop
  // producing a diff for it, which is a high price for one character. NUL is
  // the right delimiter because it cannot occur in any component, so "12|34"
  // and "1|234" cannot collide on one preimage.
  const material = [
    input.postedDate,
    input.amount.minor.toString(),
    input.amount.currency,
    input.nameKey,
  ].join('\u0000');
  const digest = sha256(new TextEncoder().encode(material));
  let hex = '';
  for (const byte of digest.subarray(0, 16)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
