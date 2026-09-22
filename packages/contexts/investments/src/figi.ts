// SPDX-License-Identifier: MIT
/**
 * The `FigiMapper` port — "turn a weaker identifier into a FIGI" — and a fake.
 *
 * ## Why this is a port and not a client
 *
 * 07 §4.3 states the need bluntly: "Brokerage CSVs frequently give only a
 * CUSIP; without this mapping the whole portfolio module stalls." A CUSIP-only
 * position can never join the row that a Plaid holding created from its FIGI,
 * and the two halves of one asset sit in the allocation chart as two lines.
 *
 * The **HTTP adapter is WP 3.4's**, not this work package's, and that split is
 * deliberate rather than administrative. OpenFIGI is an egress surface: it must
 * go behind the same allow-list module WP 2.4 built for notifications — host
 * allow-list, scheme allow-list, literal-IP refusal, private/link-local/loopback
 * refusal, DNS re-check against rebinding, no redirect following, no
 * user-supplied headers, timeouts — and 03 §5.2's lesson is that the second
 * implementation of an allow-list is where the hole is. So `@ctx/investments`
 * declares the shape it needs and consumes whatever the composition root hands
 * it; `@ctx/integrations` writes the one adapter that actually opens a socket,
 * and `api.openfigi.com` joins `MARKET_DATA_ALLOWED_HOSTS` there.
 *
 * What lives here instead: the job and mapping shapes, the documented limits as
 * **constants with the number in the code** (§4 of the dispatch is explicit
 * that a rate limit is implemented with its documented number, not with a
 * comment), the batching, and a fake that records what it was asked so a test
 * can prove the batching happened.
 */

import type { NormalisedIdentifier } from './identifiers.ts';

/**
 * Jobs per request, **with** an API key.
 *
 * OpenFIGI's `/v3/mapping` accepts a bounded array per POST: 100 jobs with a
 * key, 10 without. This is the number that makes "120 symbols are not 120
 * requests" true; it is *not* 120, so 120 symbols are two requests and cannot
 * be one. See `test/openfigi.test.ts`, which says so where it asserts it.
 */
export const OPENFIGI_MAX_JOBS_PER_REQUEST = 100;

/** Jobs per request without a key. The degraded mode, stated so it is visible. */
export const OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST = 10;

/** 01 §4.1's table: 25,000 mapping jobs per minute with a free key. */
export const OPENFIGI_MAX_JOBS_PER_MINUTE = 25_000;

/** The id types `/v3/mapping` accepts, restricted to the ones we can produce. */
export const FIGI_ID_TYPES = ['ID_ISIN', 'ID_CUSIP', 'TICKER', 'ID_BB_GLOBAL'] as const;
export type FigiIdType = (typeof FIGI_ID_TYPES)[number];

export interface FigiMapJob {
  readonly idType: FigiIdType;
  readonly idValue: string;
  /** ISO-10383 MIC, when we have one. A `TICKER` job without it is ambiguous. */
  readonly micCode: string | null;
}

/** One mapping OpenFIGI returned. Only the fields we are willing to believe. */
export interface FigiMapping {
  readonly figi: string;
  readonly name: string | null;
  readonly ticker: string | null;
  /** OpenFIGI's `exchCode`, kept verbatim; it is *not* a MIC. */
  readonly exchCode: string | null;
  readonly securityType: string | null;
  readonly marketSector: string | null;
}

/**
 * One job's outcome.
 *
 * Three states rather than "a mapping or null", because they mean different
 * things to a caller and collapsing them loses the difference: `no_match` is a
 * fact about the identifier (OpenFIGI does not know it), `error` is a fact
 * about the call (it did not complete). The first is permanent and should be
 * recorded; the second is transient and must not be.
 */
export type FigiMapOutcome =
  | { readonly status: 'matched'; readonly mappings: readonly FigiMapping[] }
  | { readonly status: 'no_match' }
  | { readonly status: 'error'; readonly message: string };

/**
 * The port.
 *
 * One method, taking an array: a mapper that took one job at a time could not
 * batch, and an interface that cannot express the only thing that makes the
 * provider usable is the wrong interface.
 *
 * The contract: **one outcome per job, in the order the jobs were given.**
 * OpenFIGI's response array is positional and a caller that re-derives the
 * association by matching values back would get it wrong for the case that
 * matters — two jobs with the same `idValue` and different `micCode`.
 */
export interface FigiMapper {
  /** Where the answers come from. Appears in logs and in `classification_source` audits. */
  readonly source: string;
  map(jobs: readonly FigiMapJob[]): Promise<readonly FigiMapOutcome[]>;
}

/**
 * Split a job list into request-sized batches.
 *
 * Exported and tested on its own because the interesting property — that the
 * number of requests grows with `ceil(n / cap)` and not with `n` — is a
 * property of this function, and asserting it here means it holds for whatever
 * adapter WP 3.4 writes rather than for one adapter's implementation of it.
 */
export function figiBatchesOf<T>(
  jobs: readonly T[],
  size: number = OPENFIGI_MAX_JOBS_PER_REQUEST,
): readonly (readonly T[])[] {
  if (size < 1) throw new RangeError('figiBatchesOf: batch size must be at least 1');
  const batches: T[][] = [];
  for (let index = 0; index < jobs.length; index += size) {
    batches.push([...jobs.slice(index, index + size)]);
  }
  return batches;
}

/**
 * The job that would map one identifier to a FIGI, or `null` if none would.
 *
 * A `chain_contract` has no job: OpenFIGI maps *securities*, and a token
 * contract is not one. A `proprietary` identifier has no job either, for the
 * reason it has no anything — it means nothing outside the provider that
 * issued it.
 */
export function figiJobOf(identifier: NormalisedIdentifier): FigiMapJob | null {
  switch (identifier.kind) {
    case 'isin':
      return { idType: 'ID_ISIN', idValue: identifier.value, micCode: null };
    case 'cusip':
      return { idType: 'ID_CUSIP', idValue: identifier.value, micCode: null };
    case 'ticker':
      // An unqualified ticker is deliberately still sent: OpenFIGI answering
      // with several mappings is *itself* the evidence that the ticker was
      // ambiguous, and `firstUnambiguousFigi` refuses that answer rather than
      // picking one. Asking is free; guessing is not.
      return { idType: 'TICKER', idValue: identifier.value, micCode: identifier.mic };
    case 'figi':
    case 'chain_contract':
    case 'proprietary':
      return null;
  }
}

/**
 * The FIGI from an outcome, **only** when the answer was unambiguous.
 *
 * Several mappings means OpenFIGI knows several securities by that name — a
 * dual listing, typically — and there is no rule by which one of them is
 * "the" answer. Picking the first would be inventing an identity, which is the
 * exact failure this whole file exists to prevent, so the answer is `null` and
 * the caller keeps the weaker identifier it already had.
 */
export function firstUnambiguousFigi(outcome: FigiMapOutcome): string | null {
  if (outcome.status !== 'matched') return null;
  if (outcome.mappings.length !== 1) return null;
  return outcome.mappings[0]?.figi ?? null;
}

export interface FakeFigiMapper extends FigiMapper {
  /** Every batch the fake was asked for, in order. What the batching test counts. */
  readonly requests: readonly (readonly FigiMapJob[])[];
}

export interface FakeFigiMapperOptions {
  /** `${idType}:${idValue}` → the mappings to answer with. Missing ⇒ `no_match`. */
  readonly table?: Readonly<Record<string, readonly FigiMapping[]>>;
  /** Keys to answer with `error` instead, so a caller's degradation is testable. */
  readonly errors?: Readonly<Record<string, string>>;
  readonly jobsPerRequest?: number;
}

/** The key `FakeFigiMapperOptions.table` is written in. */
export function figiTableKeyOf(job: FigiMapJob): string {
  return `${job.idType}:${job.idValue.toUpperCase()}`;
}

/**
 * A `FigiMapper` that answers from a table and records its batches.
 *
 * It batches internally at the same documented cap the real adapter will, which
 * is what lets `'120 symbols are one batched request, not 120'` be a claim
 * about the *port's* contract rather than about one adapter — WP 3.4 can then
 * be held to the same count.
 */
export function createFakeFigiMapper(options: FakeFigiMapperOptions = {}): FakeFigiMapper {
  const table = options.table ?? {};
  const errors = options.errors ?? {};
  const size = options.jobsPerRequest ?? OPENFIGI_MAX_JOBS_PER_REQUEST;
  const requests: (readonly FigiMapJob[])[] = [];

  return {
    source: 'fake-openfigi',
    get requests() {
      return requests;
    },
    map(jobs: readonly FigiMapJob[]): Promise<readonly FigiMapOutcome[]> {
      const outcomes: FigiMapOutcome[] = [];
      for (const batch of figiBatchesOf(jobs, size)) {
        requests.push(batch);
        for (const job of batch) {
          const key = figiTableKeyOf(job);
          const failure = errors[key];
          if (failure !== undefined) {
            outcomes.push({ status: 'error', message: failure });
            continue;
          }
          const mappings = table[key];
          outcomes.push(
            mappings === undefined ? { status: 'no_match' } : { status: 'matched', mappings },
          );
        }
      }
      return Promise.resolve(outcomes);
    },
  };
}

/** A `FigiMapping` without writing five `null`s at every call site. */
export function figiMappingOf(
  figi: string,
  fields: Partial<Omit<FigiMapping, 'figi'>> = {},
): FigiMapping {
  return {
    figi,
    name: fields.name ?? null,
    ticker: fields.ticker ?? null,
    exchCode: fields.exchCode ?? null,
    securityType: fields.securityType ?? null,
    marketSector: fields.marketSector ?? null,
  };
}
