// SPDX-License-Identifier: MIT
/**
 * The scope catalogue (08 §4.2), as data rather than as prose.
 *
 * Data minimisation is enforced **structurally, in `SnapshotBuilder`, not by
 * convention**. This file is the half of that sentence a reviewer can check: one
 * row per scope, naming the snapshot key it produces, what it yields, what it
 * drops, and whether an `external` advisor may hold it at all. `builder.ts`
 * reads these rows; nothing else decides what may be emitted.
 *
 * Three properties fall out of keeping it here and keeping it declarative:
 *
 *   * **An ungranted scope has no code path.** The builder iterates *grants*, not
 *     sources, so a scope the user never granted produces no key rather than a
 *     key someone forgot to delete. `test/snapshot-scopes.test.ts` asserts it.
 *   * **`transactions.raw` is refused to `external` advisors by a row, not an
 *     `if`.** `externalAllowed: false` is read in one place and there is no
 *     second place to forget it.
 *   * **What each scope drops is reviewable next to what it yields.** The
 *     interesting column is `drops`: 08 §4.2's minimisation column is the whole
 *     point of the table and it is what the evidence doc prints.
 *
 * ## Coarser is better
 *
 * The list is ordered by sensitivity, least first, and `sensitivity` is a number
 * so a manifest review can sort by it. An advisor asking for `transactions.raw`
 * needs a very good reason; an advisor asking for `cashflow.monthly` when
 * `transactions.summary` would do is asking for less and should.
 */

/**
 * Every scope id in v1. The wire enum; the JSON Schema's `enum` is generated
 * from it, so adding one here is what adds it to the published contract.
 */
export const ADVISOR_SCOPES = [
  'networth.summary',
  'cash.summary',
  'cashflow.monthly',
  'budgets.status',
  'recurring.list',
  'goals.list',
  'risk.profile',
  'market.watchlist',
  'holdings.aggregate',
  'holdings.detail',
  'transactions.summary',
  'transactions.raw',
  'institutions.names',
  // WP 3.10. Appended rather than inserted in sensitivity order: this array is
  // the *wire enum*, and the published `request.schema.json` reproduces it
  // positionally. Appending keeps the diff in the contract artefact to two
  // added members; `SCOPE_CATALOGUE` below is where sensitivity order lives and
  // is what a manifest review sorts by.
  'liabilities.terms',
  'market.rates',
] as const;

export type AdvisorScope = (typeof ADVISOR_SCOPES)[number];

/** The three execution modes of 08 §4.1. Trust differs; the contract does not. */
export const ADVISOR_KINDS = ['builtin', 'local_model', 'external'] as const;
export type AdvisorKind = (typeof ADVISOR_KINDS)[number];

/** The minimisation levers a scope can pull. Each one is implemented once. */
export interface ScopeMinimisation {
  /**
   * Round every monetary figure in this block to this many minor units before
   * emitting. `10_000` is 08 §4.2's "rounded to $100" for `networth.summary`.
   * `1` means "exact" — which is still minor units, never a float.
   */
  readonly roundMonetaryToMinor: number;
  /** Amounts become a band label (`'50-200'`) instead of a figure. */
  readonly bucketAmounts: boolean;
  /** Merchant identity becomes `MERCHANT_<hash>`. Always true where merchants appear. */
  readonly tokeniseMerchants: boolean;
  /** Dates are coarsened to `YYYY-MM`. 08 §4.2: "no dates finer than month". */
  readonly monthGranularityOnly: boolean;
  /** Digit runs are stripped from any surviving descriptor text. */
  readonly redactDigits: boolean;
}

export interface ScopeDefinition {
  readonly scope: AdvisorScope;
  /** 1 (coarsest, least sensitive) upwards. Sorting a manifest by this is the review. */
  readonly sensitivity: number;
  /** The key this scope produces in `snapshot`. One scope, one key, no overlap. */
  readonly key: string;
  readonly yields: string;
  /** What this scope removes that the underlying read model has. The review column. */
  readonly drops: string;
  /** `false` ⇒ never emitted to an `external` advisor, however it was granted. */
  readonly externalAllowed: boolean;
  /** `true` ⇒ needs a per-run consent record, not just a standing grant. */
  readonly requiresPerRunConsent: boolean;
  readonly minimisation: ScopeMinimisation;
  /**
   * `false` while the context that would source it does not exist yet
   * (investments is Phase 3, planning is Phase 4). A granted-but-unsourced scope
   * emits **no key**, exactly like an ungranted one — a snapshot must never
   * contain a block the builder could not actually fill, because an advisor
   * cannot tell "empty" from "none" and would happily reason about zero.
   *
   * **WP 3.10 note, closed by WP 3.10a.** The name says Phase 2 and the meaning
   * is "is there a reader behind it *today*". WP 3.10 added the investing, debt
   * and crypto rules and the scope rows they read but did not own `snapshot/`,
   * so `holdings.aggregate`, `holdings.detail`, `liabilities.terms` and
   * `market.rates` shipped `false`. WP 3.10a landed the four `#blockFor` arms
   * and the two ports behind them (`docs/evidence/phase-3/
   * wp3.10a-snapshot-readers.md`), and flipped the four flags **in the same
   * change** — an arm without a flag is dead code and a flag without an arm is
   * a silent no-key, so the two may never be split across commits.
   *
   * The four that remain `false` are the four whose source context does not
   * exist: `goals.list` and `risk.profile` are `@ctx/planning`'s and Phase 4's,
   * `market.watchlist` has no model at all, and `institutions.names` is a
   * deliberate refusal — 08 §4.2 gives it the highest sensitivity in the table
   * and nothing has needed it.
   */
  readonly sourcedInPhase2: boolean;
}

const EXACT: ScopeMinimisation = Object.freeze({
  roundMonetaryToMinor: 1,
  bucketAmounts: false,
  tokeniseMerchants: true,
  monthGranularityOnly: false,
  redactDigits: true,
});

function minimisation(overrides: Partial<ScopeMinimisation>): ScopeMinimisation {
  return Object.freeze({ ...EXACT, ...overrides });
}

/**
 * The catalogue. 08 §4.2's table, in the order that table uses.
 *
 * `Object.freeze` on the array and on every row because this is a policy
 * document that happens to be executable: a test or a route that could push a
 * row onto it would be a scope added at runtime, which is the one way a
 * minimisation rule can be bypassed without editing a reviewed file.
 */
export const SCOPE_CATALOGUE: readonly ScopeDefinition[] = Object.freeze([
  Object.freeze({
    // WP 3.10, and the least sensitive row in the table by a distance: it
    // carries no fact about the user at all. It is here because C1, C2, D2 and
    // X3 each need a *market* rate, and WP 2.7 recorded why they could not have
    // one — "a hardcoded 4% would be a numeral nothing could account for". A
    // dated FRED observation is an answer to that; a constant in a source file
    // is not. The attribution string rides with the figure because 01 §4.3
    // makes it a licence condition, and a UI cannot render an obligation it was
    // never told about (WP 3.4 §4).
    scope: 'market.rates',
    sensitivity: 1,
    key: 'market_rates',
    yields:
      'One row per FRED series the deployment tracks: the series id, the observation date, the ' +
      'rate as a ratio, its units, and whether the observation is stale. Plus the exact ' +
      'attribution sentence and the link it must carry.',
    drops:
      'Nothing of the user’s — there is nothing of theirs in it. What it deliberately ' +
      'does not carry is an *undated* or unattributed rate: a rate with no observation date ' +
      'behind it is an assumption wearing a measurement’s clothes.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    // WP 3.10a: `#marketRates` reads `@ctx/integrations`' FRED source through
    // `MarketDataPort`, converts percent→ratio and computes `stale`.
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'networth.summary',
    sensitivity: 1,
    key: 'networth_summary',
    yields: 'Total assets, liabilities, net worth, and a 12-month trend.',
    drops:
      'Every account, institution and provider id. Figures are rounded to $100, so the block ' +
      'cannot be used to fingerprint a specific balance.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({ roundMonetaryToMinor: 10_000 }),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'cash.summary',
    sensitivity: 2,
    key: 'cash_summary',
    yields:
      'Total cash, account count, blended APY, emergency-fund months, and one row per cash ' +
      'account carrying an opaque ref, its type, balance and APY.',
    drops: 'Institution names, account names, masks, provider ids and account numbers.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'cashflow.monthly',
    sensitivity: 3,
    key: 'cashflow_monthly',
    yields: 'Income and expense totals by category by month, up to 24 months.',
    drops: 'Every individual transaction. Aggregates only; no merchant appears at all.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({ monthGranularityOnly: true }),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'budgets.status',
    sensitivity: 3,
    key: 'budgets_status',
    yields:
      'Per-line budget vs actual for the current period, with assigned, activity, available, ' +
      'overspend split into its cash and credit halves, and Ready-to-Assign.',
    drops:
      'User-written line names and notes. A line is identified by its id and its category id, ' +
      'which the app resolves back to a name when it renders.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'recurring.list',
    sensitivity: 4,
    key: 'recurring_list',
    yields:
      'Confirmed and candidate streams: tokenised vendor, cadence, typical amount, next due ' +
      'date, status, confidence, and the observed amount range.',
    drops: 'Merchant names (tokenised) and the individual charges behind the stream.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'goals.list',
    sensitivity: 4,
    key: 'goals_list',
    yields: 'Goal name, target, horizon and progress percentage.',
    drops: 'The accounts funding the goal and any note attached to it.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    // @ctx/planning lands in Phase 4.
    sourcedInPhase2: false,
  }),
  Object.freeze({
    scope: 'risk.profile',
    sensitivity: 4,
    key: 'risk_profile',
    yields: 'Risk tolerance, horizon in years, tax-bracket band, liquidity need.',
    drops: 'Exact income — the bracket crosses as a band, never a figure.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    sourcedInPhase2: false,
  }),
  Object.freeze({
    scope: 'market.watchlist',
    sensitivity: 4,
    key: 'market_watchlist',
    yields: 'The symbols the user is tracking.',
    drops: 'Any position, quantity or holding behind a symbol.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    sourcedInPhase2: false,
  }),
  Object.freeze({
    scope: 'holdings.aggregate',
    sensitivity: 5,
    key: 'holdings_aggregate',
    yields:
      'Per-asset-class weights and values, top-N positions by symbol and weight, the target ' +
      'allocation, the account-type mix, `unclassified_pct`, and two pre-triggered aggregates: ' +
      'idle brokerage cash and the exchange/self-custody split of crypto.',
    drops:
      'Quantities, cost basis and account linkage — those need `holdings.detail`, and no ' +
      'account id appears in either. `idle_cash` is an aggregate precisely so that a per-account ' +
      'threshold can be applied without a per-account row crossing.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    // WP 3.10a: `#holdingsAggregate` reads WP 3.3's analytics through
    // `InvestmentsPort.holdings`.
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'holdings.detail',
    sensitivity: 6,
    key: 'holdings_detail',
    yields:
      'Per position: quantity, cost basis, market value, unrealised P&L, lot ages and per-lot ' +
      'gain or loss, the account’s tax treatment, the expense ratio and its comparable, and ' +
      'whether a cost basis is recorded at all.',
    drops:
      'Account ids and institution names, still. The tax treatment crosses as a *class* — ' +
      '`taxable`, `tax_deferred`, `tax_free` — which is what I6 and I12 reason about, and not ' +
      'as the account that has it. A lot crosses as an age in days, never as an open date.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    // WP 3.10a: `#holdingsDetail`, over the same one valuation as the aggregate.
    sourcedInPhase2: true,
  }),
  Object.freeze({
    // WP 3.10. One block unblocks the whole D family at once, plus U8, C5 and
    // C6, which WP 2.7 recorded as unwritable for the want of exactly these
    // three fields: an APR, a credit limit and a statement balance.
    scope: 'liabilities.terms',
    sensitivity: 6,
    key: 'liabilities_terms',
    yields:
      'Per liability: its kind, APR, any promotional APR and when it ends, credit limit, ' +
      'statement and current balance, minimum payment, the next due date, when it was last paid ' +
      'and how many recent months were paid at the minimum only.',
    drops:
      'Account ids, provider ids, institution names, card masks and the lender’s name. A ' +
      'liability is identified by an opaque `liability_ref` minted by the same tokeniser that ' +
      'mints `account_ref` in `cash.summary`, so an insight can key on it stably without the ' +
      'advisor ever holding an identifier that means anything outside this snapshot.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({}),
    // WP 3.10a: `#liabilitiesTerms`, over `@ctx/ledger`'s liability accounts and
    // whatever WP 3.7's `connection_sync_facts` persisted for them.
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'transactions.summary',
    sensitivity: 7,
    key: 'transactions_summary',
    yields: 'Per-merchant-category counts and sums, and the top merchants by spend.',
    drops:
      'Descriptions entirely; merchant identity is tokenised; no date is finer than a month ' +
      '(08 §4.2).',
    externalAllowed: true,
    requiresPerRunConsent: false,
    minimisation: minimisation({ monthGranularityOnly: true }),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'transactions.raw',
    sensitivity: 9,
    key: 'transactions_raw',
    yields: 'Individual transactions: date, bucketed amount, tokenised merchant, category.',
    drops:
      'Raw descriptors, account identity and exact amounts — the amount crosses as a band label ' +
      '($0–50, $50–200, …) because exact amounts across enough rows are a fingerprint (03 §8.3).',
    // 08 §4.2: "never granted to `external`". One row, one reader, no second place to forget.
    externalAllowed: false,
    requiresPerRunConsent: true,
    minimisation: minimisation({ bucketAmounts: true }),
    sourcedInPhase2: true,
  }),
  Object.freeze({
    scope: 'institutions.names',
    sensitivity: 8,
    key: 'institutions_names',
    yields: 'The names of the institutions the user has linked.',
    drops:
      'Nothing further — this scope exists precisely to make the otherwise-unconditional strip ' +
      'of institution names an explicit, auditable grant rather than a leak.',
    externalAllowed: false,
    requiresPerRunConsent: true,
    minimisation: minimisation({}),
    sourcedInPhase2: false,
  }),
]);

const BY_SCOPE = new Map<AdvisorScope, ScopeDefinition>(
  SCOPE_CATALOGUE.map((definition) => [definition.scope, definition]),
);

export function scopeDefinition(scope: AdvisorScope): ScopeDefinition {
  const definition = BY_SCOPE.get(scope);
  // Unreachable through the type, reachable through a JSON payload that lied
  // about its scope: the schema's enum rejects that before this is called, and
  // this throw is the second line rather than the first.
  if (definition === undefined) throw new Error(`unknown advisor scope: ${String(scope)}`);
  return definition;
}

/** `true` when this scope is a scope. Used where the input is untrusted JSON. */
export function isAdvisorScope(value: unknown): value is AdvisorScope {
  return typeof value === 'string' && BY_SCOPE.has(value as AdvisorScope);
}

/**
 * The scopes this kind of advisor may ever hold, whatever the grant table says.
 *
 * The grant is the user's answer to "may this advisor read X". This is the
 * app's answer to "may an advisor of this kind be asked at all", and the second
 * one wins: 08 §4.2 makes `transactions.raw` unreachable for `external`, and a
 * user cannot grant their way past it.
 */
export function scopesPermittedForKind(kind: AdvisorKind): readonly AdvisorScope[] {
  return SCOPE_CATALOGUE.filter(
    (definition) => kind !== 'external' || definition.externalAllowed,
  ).map((definition) => definition.scope);
}

/** Snapshot keys, in catalogue order. The snapshot's own property order. */
export const SCOPE_KEYS: readonly string[] = Object.freeze(
  SCOPE_CATALOGUE.map((definition) => definition.key),
);
