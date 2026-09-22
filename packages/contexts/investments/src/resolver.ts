// SPDX-License-Identifier: MIT
/**
 * `SecurityResolver` — the sneaky-hard part (08 §1.3 #7).
 *
 * One asset, named five ways by four providers, has to end up as **one**
 * `security_id`. Everything downstream is an aggregate over that id: allocation
 * sums weights by asset class, concentration divides by the total, TWR links
 * sub-period returns per position. Split one asset into two rows and every one
 * of those numbers is wrong in a way no user can see and no test downstream can
 * catch, because each half is internally consistent.
 *
 * ## The merge rule
 *
 * Tiers, strongest first, and **the first answer wins**:
 *
 * | # | Tier | Resolves when | Abstains when, and what it says |
 * |---|---|---|---|
 * | 1 | `figi` | the FIGI is well-formed | `absent` / `malformed` |
 * | 2 | `isin` | the ISIN passes its check digit | `absent` / `malformed` |
 * | 3 | `cusip` | the CUSIP passes its check digit | `absent` / `malformed` |
 * | 4 | `ticker` + MIC | the MIC is a well-formed ISO-10383 code | `absent` / `malformed` / **`unqualified_ticker`** |
 * | 5 | `chain` + `contract` | the chain is named | `absent` / `malformed` |
 * | 6 | `proprietary` | **never** | always `proprietary_is_not_an_identity` |
 *
 * Three consequences are worth stating plainly, because each is a thing the
 * resolver deliberately does *not* do:
 *
 *   * **A bare ticker never establishes a security.** `BHP` is a different
 *     company on XNYS, XASX and XLON, and a delisted ticker is reissued. An
 *     unqualified ticker is attached as corroborating evidence and abstains.
 *     The one exception is not an exception to the rule but to the premise: a
 *     crypto ticker *cannot* carry a MIC, because a chain is not a venue, so
 *     `ETH`, `ETHEREUM` and a wallet's native-coin sentinel address all
 *     canonicalise onto one `chain_contract` (see `NATIVE_ASSETS`).
 *   * **A provider's own id never establishes one either** — D25's shape. It
 *     *can* find a row it has corroborated before, which is the whole reason to
 *     store it, and that lookup mints nothing.
 *   * **Nothing is ever minted on an abstain.** When no tier answers, the
 *     resolver emits `investments.SecurityResolutionFailed` carrying every
 *     abstain reason and returns `unresolved`. 04 §5.5's rule that an unknown
 *     cost basis reports `unavailable` rather than gain-from-zero has a twin
 *     here: an unknown *security* reports itself, rather than becoming an
 *     anonymous row that nothing will ever merge with.
 *
 * ## When two rows turn out to be one asset
 *
 * A brokerage reports a CUSIP; a row already exists for it. Months later the
 * same brokerage starts reporting FIGIs, and the FIGI matches a *different*
 * row that a second provider created. Both rows are legitimate and both have
 * holdings pointing at them.
 *
 * The merge is **deterministic**, because a resolver whose answer depends on
 * which provider synced first is a resolver that produces different histories
 * on a replay: the winner is the row with the **strongest identity tier**;
 * ties break on the **earliest `created_at`**; ties after that break on the
 * **lexicographically smallest id**. The loser keeps its row and gains a
 * `merged_into_id`, so anything already pointing at it can be followed forward
 * rather than broken, and every identifier it held is re-pointed at the winner.
 *
 * ## What the resolver does not decide
 *
 * It does not price anything, it does not hold a quantity, and it does not
 * write a holding. It answers one question — "which `security_id` is this?" —
 * and classification (07 §4.3's waterfall) rides along because a row has to be
 * created with *some* `classification_source` and `UNCLASSIFIED` is a real
 * answer rather than a placeholder.
 */

import { newId, type Clock } from '@core/kernel';
import type { NewEvent } from '@core/platform';
import { classify, loadSeedTable, type Classification, type SeedTable } from './classify.ts';
import { SecurityResolutionFailed } from './events.ts';
import {
  createFakeFigiMapper,
  figiJobOf,
  firstUnambiguousFigi,
  type FigiMapJob,
  type FigiMapper,
} from './figi.ts';
import {
  confidenceOf,
  identifierKeyOf,
  identityRankOf,
  isIdentityBearing,
  normaliseIdentifiers,
  strongestIdentity,
  type NormalisedIdentifier,
  type SecurityIdentifier,
  type TierAbstention,
} from './identifiers.ts';
import {
  SecurityConstraintError,
  type IdentifierRow,
  type NewSecurity,
  type SecurityPatch,
  type SecurityRecord,
  type SecurityStore,
} from './store.ts';
import type { IdentityKind, SecurityType } from '../schema/index.ts';

/**
 * A security as some provider described it.
 *
 * Structurally compatible with `@connector/port`'s `ProviderSecurityFact` minus
 * the fields this context has no use for (`raw`, `fingerprint`, `closePrice`).
 * Structural rather than imported, for the boundary reason in `identifiers.ts`.
 */
export interface ResolvableSecurity {
  readonly identifiers: readonly SecurityIdentifier[];
  /** The provider's own opaque id. Evidence, never identity. */
  readonly providerSecurityId?: string | null;
  readonly name?: string | null;
  /** Provider vocabulary: `equity`, `etf`, `cryptocurrency`, `cash`. */
  readonly type?: string | null;
  readonly currency?: string | null;
  readonly isCashEquivalent?: boolean | null;
}

/** `resolve` accepts one bare identifier as well as a whole fact. */
export type ResolvableInput = SecurityIdentifier | ResolvableSecurity;

export interface ResolveContext {
  readonly userId: string;
  /** Which connector is talking. Required: an anonymous failure is unactionable. */
  readonly provider: string;
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

export interface ResolvedSecurity {
  readonly outcome: 'resolved';
  readonly securityId: string;
  /** Whether this call created the row. A re-sync of the same fact is `false`. */
  readonly created: boolean;
  /** Rows merged into `securityId` by this call, loser-first. Usually empty. */
  readonly merged: readonly string[];
  /** The name that established the row, after any upgrade this call made. */
  readonly identity: NormalisedIdentifier;
  /** Every tier that could not answer. Present even on success. */
  readonly abstentions: readonly TierAbstention[];
}

export interface UnresolvedSecurity {
  readonly outcome: 'unresolved';
  readonly abstentions: readonly TierAbstention[];
  /** The event that was emitted, so a caller can log or assert on it. */
  readonly event: NewEvent;
}

export type Resolution = ResolvedSecurity | UnresolvedSecurity;

/** Where `SecurityResolutionFailed` goes. `appendEvent(outboxOf(tx), …)` in production. */
export interface ResolverEventSink {
  append(event: NewEvent): Promise<void>;
}

/** A sink that keeps the envelopes, for tests and for a dry run. */
export function collectingEventSink(): ResolverEventSink & {
  readonly events: readonly NewEvent[];
} {
  const events: NewEvent[] = [];
  return {
    get events() {
      return events;
    },
    append(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

export interface SecurityResolverOptions {
  readonly store: SecurityStore;
  readonly clock: Clock;
  readonly events?: ResolverEventSink;
  /**
   * Used to upgrade a CUSIP-, ISIN- or ticker-only sighting to a FIGI before
   * tiering. Optional, and absent is a supported mode rather than a degraded
   * one: without it, a CUSIP-only brokerage row still resolves — it just
   * resolves on its CUSIP, and joins a FIGI-named row only when some provider
   * eventually says both. WP 3.4 supplies the HTTP adapter.
   */
  readonly figi?: FigiMapper;
  readonly seed?: SeedTable;
}

export interface SecurityResolver {
  /** One fact, or one bare identifier. */
  resolve(input: ResolvableInput, context: ResolveContext): Promise<Resolution>;
  /**
   * Many, with **one batched FIGI pass for the whole list**.
   *
   * This is the method that exists for OpenFIGI's sake. Resolving a 120-position
   * brokerage one at a time would be 120 mapping requests; 01 §4.1 allows
   * 25,000 jobs a minute but `/v3/mapping` takes 100 jobs per *request*, so the
   * difference between calling this and looping over `resolve` is two requests
   * against a hundred and twenty. `test/openfigi.test.ts` counts them.
   */
  resolveAll(
    inputs: readonly ResolvableInput[],
    context: ResolveContext,
  ): Promise<readonly Resolution[]>;
}

function asResolvable(input: ResolvableInput): ResolvableSecurity {
  const fact = 'kind' in input ? { identifiers: [input] } : input;
  const providerSecurityId = fact.providerSecurityId ?? null;
  if (providerSecurityId === null || providerSecurityId.trim().length === 0) return fact;
  if (fact.identifiers.some((identifier) => identifier.kind === 'proprietary')) return fact;
  // The provider's own id travels beside the identifier set on
  // `ProviderSecurityFact`, not inside it, because an adapter that put it in
  // `identifiers` as anything other than `proprietary` would be stating
  // something it cannot know. Folding it in *here* is what makes it accumulate
  // as corroborating evidence without any adapter having to remember to: the
  // second time Plaid mentions `sec-vti-0001`, it finds the row that some
  // other name established the first time.
  return {
    ...fact,
    identifiers: [
      ...fact.identifiers,
      { kind: 'proprietary', value: providerSecurityId, chain: null, mic: null },
    ],
  };
}

/** Provider vocabulary → our small `securities.type` enum. */
export function securityTypeOf(
  providerType: string | null | undefined,
  identity: NormalisedIdentifier,
  isCashEquivalent: boolean | null | undefined,
): SecurityType {
  if (identity.kind === 'chain_contract') return 'crypto';
  const value = (providerType ?? '').trim().toLowerCase();
  if (value.includes('crypto')) return 'crypto';
  if (value === 'etf') return 'etf';
  if (value === 'mutual fund' || value === 'mutual_fund' || value === 'fund') return 'mutual_fund';
  if (value === 'fixed income' || value === 'bond' || value === 'derivative') return 'bond';
  if (value === 'cash' || isCashEquivalent === true) return 'cash';
  if (value === 'equity') return 'equity';
  return 'other';
}

export function createSecurityResolver(options: SecurityResolverOptions): SecurityResolver {
  const { store, clock } = options;
  const events = options.events ?? collectingEventSink();
  const seed = options.seed ?? loadSeedTable();
  // An absent mapper is modelled as one that matches nothing, so the code path
  // is identical either way and "no FIGI adapter configured" cannot be a branch
  // that only production takes.
  const figi = options.figi ?? createFakeFigiMapper();

  /**
   * Follow `merged_into_id` to the surviving row.
   *
   * Bounded rather than a `while (true)`: a merge chain is at most as long as
   * the number of merges, but a corrupt cycle would otherwise hang a sync, and
   * a sync that hangs is worse than one that raises.
   */
  async function survivorOf(userId: string, securityId: string): Promise<SecurityRecord | null> {
    let current = await store.getSecurity(userId, securityId);
    for (let hops = 0; hops < 8 && current?.mergedIntoId != null; hops += 1) {
      current = await store.getSecurity(userId, current.mergedIntoId);
    }
    return current;
  }

  function identifierRowsOf(
    userId: string,
    securityId: string,
    identifiers: readonly NormalisedIdentifier[],
    seenAt: Date,
  ): readonly IdentifierRow[] {
    return identifiers.map((identifier) => ({
      userId,
      securityId,
      kind: identifier.kind,
      value: identifier.value,
      chain: identifier.chain,
      mic: identifier.mic,
      identifierKey: identifier.key,
      provider: identifier.provider,
      confidence: confidenceOf(identifier.kind, identifier.mic !== null || identifier.identity),
      seenAt,
    }));
  }

  function fieldsOf(
    identifiers: readonly NormalisedIdentifier[],
  ): Pick<SecurityRecord, 'ticker' | 'mic' | 'cusip' | 'isin' | 'figi' | 'chain' | 'contract'> {
    const of = (kind: NormalisedIdentifier['kind']): NormalisedIdentifier | undefined =>
      identifiers.find((identifier) => identifier.kind === kind);
    const ticker = of('ticker');
    const contract = of('chain_contract');
    return {
      ticker: ticker?.value ?? null,
      mic: ticker?.mic ?? null,
      cusip: of('cusip')?.value ?? null,
      isin: of('isin')?.value ?? null,
      figi: of('figi')?.value ?? null,
      chain: contract?.chain ?? null,
      contract: contract?.value ?? null,
    };
  }

  function classificationOf(
    security: ResolvableSecurity,
    identifiers: readonly NormalisedIdentifier[],
    type: SecurityType,
  ): Classification {
    const fields = fieldsOf(identifiers);
    return classify(
      {
        ticker: fields.ticker ?? null,
        name: security.name ?? null,
        type,
        providerType: security.type ?? null,
        isCashEquivalent: security.isCashEquivalent ?? null,
        chain: fields.chain ?? null,
        sicCode: null,
      },
      { seed },
    );
  }

  function newSecurityOf(
    context: ResolveContext,
    security: ResolvableSecurity,
    identifiers: readonly NormalisedIdentifier[],
    identity: NormalisedIdentifier,
  ): NewSecurity {
    const type = securityTypeOf(security.type, identity, security.isCashEquivalent);
    const classification = classificationOf(security, identifiers, type);
    return {
      userId: context.userId,
      identityKind: identity.kind as IdentityKind,
      identityKey: identity.key,
      ...fieldsOf(identifiers),
      name: security.name ?? null,
      type,
      currency: security.currency ?? null,
      expenseRatio: classification.expenseRatio,
      isCashEquivalent: classification.isCashEquivalent ?? security.isCashEquivalent ?? false,
      assetClass: classification.assetClass,
      region: classification.region,
      sector: classification.sector,
      classificationSource: classification.source,
      classificationDepth: classification.depth,
      classificationResidual: classification.residual,
      classificationFlagged: classification.flagged,
    };
  }

  /**
   * Which of several candidate rows survives. Deterministic, by construction.
   *
   * Sorting rather than a fold so the rule reads in one place: strongest
   * identity tier, then oldest row, then smallest id. The third key exists only
   * so that two rows created in the same millisecond still have an answer, and
   * "usually unreachable" is exactly the kind of tie that eventually happens on
   * a backfill that inserts a thousand rows a second.
   */
  function winnerOf(candidates: readonly SecurityRecord[]): SecurityRecord {
    const sorted = [...candidates].sort((a, b) => {
      const rankA = identityRankOf(a.identityKind) ?? Number.POSITIVE_INFINITY;
      const rankB = identityRankOf(b.identityKind) ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      const ageA = a.createdAt.getTime();
      const ageB = b.createdAt.getTime();
      if (ageA !== ageB) return ageA - ageB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const winner = sorted[0];
    if (winner === undefined) throw new Error('winnerOf: called with no candidates');
    return winner;
  }

  /** The FIGI jobs a batch of facts would need, deduplicated by job key. */
  function figiJobsFor(
    normalised: readonly { readonly identifiers: readonly NormalisedIdentifier[] }[],
  ): readonly FigiMapJob[] {
    const jobs = new Map<string, FigiMapJob>();
    for (const entry of normalised) {
      if (entry.identifiers.some((identifier) => identifier.kind === 'figi')) continue;
      // The strongest mappable name only: asking OpenFIGI for both the CUSIP
      // and the ticker of one security would double the job count to answer a
      // question the CUSIP already answers better.
      const mappable = entry.identifiers.find(
        (identifier) => identifier.identity && figiJobOf(identifier) !== null,
      );
      if (mappable === undefined) continue;
      const job = figiJobOf(mappable);
      if (job === null) continue;
      jobs.set(`${job.idType}:${job.idValue}:${job.micCode ?? ''}`, job);
    }
    return [...jobs.values()];
  }

  async function resolveOne(
    security: ResolvableSecurity,
    normalised: readonly NormalisedIdentifier[],
    abstentions: readonly TierAbstention[],
    context: ResolveContext,
  ): Promise<Resolution> {
    const now = clock.now();
    const identity = strongestIdentity(normalised);
    const keys = normalised.map((identifier) => identifier.key);
    const matches = await store.findByIdentifierKeys(context.userId, keys);

    const candidates = new Map<string, SecurityRecord>();
    for (const match of matches) {
      const survivor = await survivorOf(context.userId, match.securityId);
      if (survivor !== null) candidates.set(survivor.id, survivor);
    }

    // --- nothing identity-bearing -------------------------------------------
    if (identity === null) {
      if (candidates.size === 1) {
        // A proprietary id we have corroborated before. It finds the row; it
        // did not create one, and it could not have.
        const [existing] = [...candidates.values()];
        if (existing !== undefined) {
          await store.attachIdentifiers(
            identifierRowsOf(context.userId, existing.id, normalised, now),
          );
          return {
            outcome: 'resolved',
            securityId: existing.id,
            created: false,
            merged: [],
            identity: {
              kind: existing.identityKind,
              value: existing.identityKey,
              chain: existing.chain,
              mic: existing.mic,
              provider: null,
              key: existing.identityKey,
              identity: true,
              canonicalisedFrom: null,
            },
            abstentions,
          };
        }
      }
      const event = SecurityResolutionFailed.create(
        {
          provider: context.provider,
          providerSecurityId: security.providerSecurityId ?? null,
          identifiers: security.identifiers.map((identifier) => ({
            kind: identifier.kind,
            value: identifier.value,
            chain: identifier.chain,
            mic: identifier.mic,
          })),
          abstentions: abstentions.map((entry) => ({ ...entry })),
          name: security.name ?? null,
        },
        {
          userId: context.userId,
          // A failure that arrives without a correlation id still has to be
          // traceable to itself, so it gets a fresh one rather than a null: the
          // thing a reader wants from this event is "which sync produced it",
          // and an id nobody else shares still answers "which attempt".
          correlationId: context.correlationId ?? newId(),
          causationId: context.causationId ?? null,
        },
        clock,
      );
      await events.append(event);
      return { outcome: 'unresolved', abstentions, event };
    }

    // --- a brand-new security ------------------------------------------------
    if (candidates.size === 0) {
      let created: SecurityRecord;
      try {
        created = await store.insertSecurity(
          newSecurityOf(context, security, normalised, identity),
        );
      } catch (error) {
        // Another connection won the race between our lookup and our insert.
        // The unique index is the arbiter; we re-read and join its answer,
        // which is why 'two identifiers for one security never create two rows'
        // survives concurrency rather than merely surviving a sequential test.
        if (!isUniqueViolation(error)) throw error;
        const again = await store.findByIdentifierKeys(context.userId, keys);
        const raced = again[0];
        if (raced === undefined) throw error;
        const survivor = await survivorOf(context.userId, raced.securityId);
        if (survivor === null) throw error;
        created = survivor;
      }
      await store.attachIdentifiers(identifierRowsOf(context.userId, created.id, normalised, now));
      return {
        outcome: 'resolved',
        securityId: created.id,
        created: true,
        merged: [],
        identity,
        abstentions,
      };
    }

    // --- one or more existing rows -------------------------------------------
    const winner = winnerOf([...candidates.values()]);
    const merged: string[] = [];
    for (const candidate of candidates.values()) {
      if (candidate.id === winner.id) continue;
      await store.mergeSecurities(candidate.id, winner.id);
      merged.push(candidate.id);
    }

    await store.attachIdentifiers(identifierRowsOf(context.userId, winner.id, normalised, now));

    // An upgrade: this sighting named the security more strongly than whatever
    // established it. The row keeps its id — holdings point at it — and gains a
    // better identity.
    const winnerRank = identityRankOf(winner.identityKind) ?? Number.POSITIVE_INFINITY;
    const ourRank = identityRankOf(identity.kind) ?? Number.POSITIVE_INFINITY;
    const patch: SecurityPatch = {
      ...fieldsOfNonNull(fieldsOf(normalised)),
      ...(ourRank < winnerRank
        ? { identityKind: identity.kind as IdentityKind, identityKey: identity.key }
        : {}),
    };
    await store.updateSecurity(winner.id, patch);

    return {
      outcome: 'resolved',
      securityId: winner.id,
      created: false,
      merged,
      identity: ourRank < winnerRank ? identity : identityOfRecord(winner),
      abstentions,
    };
  }

  return {
    async resolve(input, context) {
      const [only] = await this.resolveAll([input], context);
      if (only === undefined) throw new Error('resolve: resolveAll returned nothing');
      return only;
    },

    async resolveAll(inputs, context) {
      const facts = inputs.map(asResolvable);
      const normalised = facts.map((fact) =>
        normaliseIdentifiers(fact.identifiers, { provider: context.provider }),
      );

      // --- one batched FIGI pass for the whole list --------------------------
      const jobs = figiJobsFor(normalised);
      const upgrades = new Map<string, string>();
      if (jobs.length > 0) {
        const outcomes = await figi.map(jobs);
        jobs.forEach((job, index) => {
          const outcome = outcomes[index];
          if (outcome === undefined) return;
          const mapped = firstUnambiguousFigi(outcome);
          if (mapped !== null) upgrades.set(`${job.idType}:${job.idValue}`, mapped);
        });
      }

      const resolutions: Resolution[] = [];
      for (const [index, fact] of facts.entries()) {
        const entry = normalised[index];
        if (entry === undefined) continue;
        let identifiers = entry.identifiers;
        if (upgrades.size > 0) {
          const upgraded = figiUpgradeOf(identifiers, upgrades);
          if (upgraded !== null) identifiers = [upgraded, ...identifiers];
        }
        resolutions.push(await resolveOne(fact, identifiers, entry.abstentions, context));
      }
      return resolutions;
    },
  };
}

/**
 * The FIGI OpenFIGI gave us for this security's strongest mappable name.
 *
 * Attached with `provider: null` and full confidence: we derived it, no
 * connector said it, and recording it as though Plaid had would misattribute
 * evidence. It is prepended so `strongestIdentity` sees it first.
 */
function figiUpgradeOf(
  identifiers: readonly NormalisedIdentifier[],
  upgrades: ReadonlyMap<string, string>,
): NormalisedIdentifier | null {
  if (identifiers.some((identifier) => identifier.kind === 'figi')) return null;
  for (const identifier of identifiers) {
    const job = figiJobOf(identifier);
    if (job === null) continue;
    const mapped = upgrades.get(`${job.idType}:${job.idValue}`);
    if (mapped === undefined) continue;
    return {
      kind: 'figi',
      value: mapped,
      chain: null,
      mic: null,
      provider: null,
      key: identifierKeyOf({ kind: 'figi', value: mapped }),
      identity: isIdentityBearing('figi'),
      canonicalisedFrom: null,
    };
  }
  return null;
}

function identityOfRecord(record: SecurityRecord): NormalisedIdentifier {
  return {
    kind: record.identityKind,
    value: record.identityKey,
    chain: record.chain,
    mic: record.mic,
    provider: null,
    key: record.identityKey,
    identity: true,
    canonicalisedFrom: null,
  };
}

/**
 * Drop the `null`s out of a denormalised-field patch.
 *
 * A re-sync from a provider that knows less than the last one must not *erase*
 * what the last one told us: Plaid supplies a FIGI, a CSV import of the same
 * position supplies only a ticker, and blanking the FIGI column would undo the
 * upgrade every subsequent sighting depends on.
 */
function fieldsOfNonNull<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/** A unique-constraint violation, from either store. */
function isUniqueViolation(error: unknown): boolean {
  if (error instanceof SecurityConstraintError) {
    return error.constraint === 'security_identifiers_user_key_uniq';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}
