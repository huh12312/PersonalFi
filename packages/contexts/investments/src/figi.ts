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
  /**
   * OpenFIGI's own exchange code — *not* a MIC. D29 uses exactly one value,
   * `US`, OpenFIGI's composite code for the United States, on a bare-ticker job
   * (`usCompositeJobOf`). Optional so every MIC- and identity-qualified job
   * keeps its shape; absent and `null` both mean "not sent".
   */
  readonly exchCode?: string | null;
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
  /**
   * OpenFIGI's `compositeFIGI`: the country-level FIGI every venue line of one
   * listing shares. D29's US-ticker tier establishes identity on it, and only
   * when every mapping in the answer names the same one. `null` when OpenFIGI
   * gave none.
   */
  readonly compositeFigi: string | null;
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
      // The job a ticker *would* need. The resolver only sends it for an
      // identity-bearing (MIC-qualified) ticker; a bare one is never sent this
      // way, because OpenFIGI answering a bare `TICKER` job with one mapping
      // would still not say *which* market's security it is. The one bare
      // ticker that is sent goes as `usCompositeJobOf`'s job, under D29's
      // narrower rule.
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

/**
 * D29: the OpenFIGI exchange code a bare US-dollar ticker is asked under.
 *
 * `US` is OpenFIGI's *composite* code for the United States — every US venue
 * line of one listing rolls up to it — and it is not an ISO-10383 MIC, which is
 * why it travels as `exchCode` and never as `micCode`.
 */
export const US_COMPOSITE_EXCH_CODE = 'US';

/**
 * D29's provenance for a FIGI established from a bare US ticker.
 *
 * `security_identifiers.provider` is "who said so"; for this row that is
 * OpenFIGI answering *our* question (bare ticker + `exchCode: US`), which is a
 * weaker statement than a connector or an ISIN mapping naming the FIGI. The
 * value is namespaced so a reader can tell it from a connector name and from
 * the `NULL` an ISIN/CUSIP upgrade records.
 */
export const US_COMPOSITE_FIGI_PROVIDER = 'openfigi:us_composite';

/**
 * Below the `1.0000` a FIGI carries when a provider says it, and below the
 * `0.9000` of a check-digited CUSIP, because the evidence is a bare ticker plus
 * a currency plus a type plus OpenFIGI's single answer; above a MIC-qualified
 * ticker's `0.7500`, because the answer was unique across every US venue.
 */
export const US_COMPOSITE_FIGI_CONFIDENCE = '0.8000';

/** The `TICKER` + `exchCode: US` job for one bare ticker. No MIC, by construction. */
export function usCompositeJobOf(symbol: string): FigiMapJob {
  return {
    idType: 'TICKER',
    idValue: symbol.trim().toUpperCase(),
    micCode: null,
    exchCode: US_COMPOSITE_EXCH_CODE,
  };
}

/** What D29's tier made of one outcome. */
export type UsCompositeVerdict =
  | { readonly status: 'unique'; readonly compositeFigi: string }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'no_match' }
  | { readonly status: 'error' };

/**
 * The composite FIGI from a bare-US-ticker answer, **only** when it is unique.
 *
 * OpenFIGI answers `TICKER VTI exchCode US` with one mapping per US venue line
 * (and sometimes per share class), so "exactly one mapping" is the wrong test:
 * what must be unique is the *composite* those lines roll up to. Several
 * distinct composites — two securities trading under one symbol — is
 * ambiguous, and so is any mapping with no composite at all, because then the
 * answer does not say which listing the line belongs to. A malformed composite
 * is treated as missing. `error` stays `error`: it is a fact about the call.
 */
export function usCompositeVerdictOf(outcome: FigiMapOutcome): UsCompositeVerdict {
  if (outcome.status === 'error') return { status: 'error' };
  if (outcome.status === 'no_match' || outcome.mappings.length === 0) {
    return { status: 'no_match' };
  }
  const composites = new Set<string>();
  for (const mapping of outcome.mappings) {
    const composite = mapping.compositeFigi?.trim().toUpperCase() ?? '';
    if (!COMPOSITE_FIGI_SHAPE.test(composite)) return { status: 'ambiguous' };
    composites.add(composite);
  }
  const [only] = [...composites];
  return composites.size === 1 && only !== undefined
    ? { status: 'unique', compositeFigi: only }
    : { status: 'ambiguous' };
}

/** `identifiers.ts`' `figiIsWellFormed`, restated so this file keeps one import. */
const COMPOSITE_FIGI_SHAPE = /^[BCDFGHJKLMNPQRSTVWXYZ]{2}G[BCDFGHJKLMNPQRSTVWXYZ0-9]{8}[0-9]$/u;

export interface FakeFigiMapper extends FigiMapper {
  /** Every batch the fake was asked for, in order. What the batching test counts. */
  readonly requests: readonly (readonly FigiMapJob[])[];
}

export interface FakeFigiMapperOptions {
  /** `figiTableKeyOf(job)` → the mappings to answer with. Missing ⇒ `no_match`. */
  readonly table?: Readonly<Record<string, readonly FigiMapping[]>>;
  /** Keys to answer with `error` instead, so a caller's degradation is testable. */
  readonly errors?: Readonly<Record<string, string>>;
  readonly jobsPerRequest?: number;
}

/**
 * The key `FakeFigiMapperOptions.table` is written in: `${idType}:${idValue}`,
 * plus `/${exchCode}` when the job carries one — so D29's `TICKER:VTI/US` is a
 * different entry from a MIC-qualified `TICKER:VTI` job, and a table written
 * before D29 answers exactly what it answered before.
 */
export function figiTableKeyOf(job: FigiMapJob): string {
  const exchCode = job.exchCode?.trim().toUpperCase() ?? '';
  return `${job.idType}:${job.idValue.toUpperCase()}${exchCode.length > 0 ? `/${exchCode}` : ''}`;
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
    compositeFigi: fields.compositeFigi ?? null,
  };
}
