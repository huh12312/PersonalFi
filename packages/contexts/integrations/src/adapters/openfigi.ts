// SPDX-License-Identifier: MIT
/**
 * OpenFIGI — the HTTP adapter for WP 3.1's `FigiMapper` port.
 *
 * WP 3.1 declared the port and explained why the adapter is *this* work
 * package's (`@ctx/investments/src/figi.ts`, quoted):
 *
 *   > OpenFIGI is an egress surface: it must go behind the same allow-list
 *   > module WP 2.4 built for notifications … and 03 §5.2's lesson is that the
 *   > second implementation of an allow-list is where the hole is. So
 *   > `@ctx/investments` declares the shape it needs and consumes whatever the
 *   > composition root hands it; `@ctx/integrations` writes the one adapter
 *   > that actually opens a socket.
 *
 * ## The port is matched structurally, not imported
 *
 * `personalfi/layer-imports` denies `@ctx/integrations` -> `@ctx/investments`:
 * contexts never import each other. So the shapes below are re-declared here
 * rather than imported, the same arrangement `@ctx/ledger`'s `SeedDatasetLike`
 * uses for `@core/seed`. They are structurally identical by design, the
 * composition root assigns this adapter to the port in `apps/api/src/domain.ts`
 * and TypeScript checks the match there, and `test/openfigi.test.ts` asserts
 * the batching contract the port documents (`'120 symbols are two batched
 * requests, not 120'`).
 *
 * If the two ever drift, the composition root stops compiling. That is the
 * intended failure: loud, at build time, in the one file whose job is knowing
 * about both contexts.
 *
 * ## Batching is the whole point
 *
 * `POST /v3/mapping` takes an array: **100 jobs per request with a key, 10
 * without**. One hundred and twenty symbols are two requests, not a hundred and
 * twenty. The budget is 25,000 *jobs* per minute (01 §4.1) — jobs, not
 * requests — so `cost` is the batch size, not 1.
 *
 * ## The response is positional
 *
 * OpenFIGI returns one result per job, **in the order the jobs were sent**. A
 * caller that re-derived the association by matching `idValue` back would get
 * it wrong for the case that matters: two jobs with the same value and
 * different `micCode`. This adapter preserves position and never re-matches.
 */
import { arrayOf, recordOf } from '../json.ts';
import type { ProviderClient } from '../http.ts';
import {
  createRateBudget,
  OPENFIGI_ANONYMOUS_WINDOWS,
  OPENFIGI_WINDOWS,
  type RateBudget,
} from '../rate-limit.ts';
import type { ApiKey } from '../secrets.ts';
import { budgetReport, callJson, type CallContext } from './common.ts';

/** Structural mirror of `@ctx/investments`' `FigiMapJob`. See the header. */
export interface FigiMapJob {
  readonly idType: 'ID_ISIN' | 'ID_CUSIP' | 'TICKER' | 'ID_BB_GLOBAL';
  readonly idValue: string;
  readonly micCode: string | null;
}

/** Structural mirror of `@ctx/investments`' `FigiMapping`. */
export interface FigiMapping {
  readonly figi: string;
  readonly name: string | null;
  readonly ticker: string | null;
  readonly exchCode: string | null;
  readonly securityType: string | null;
  readonly marketSector: string | null;
}

/** Structural mirror of `@ctx/investments`' `FigiMapOutcome`. */
export type FigiMapOutcome =
  | { readonly status: 'matched'; readonly mappings: readonly FigiMapping[] }
  | { readonly status: 'no_match' }
  | { readonly status: 'error'; readonly message: string };

/** Structural mirror of `@ctx/investments`' `FigiMapper` port. */
export interface FigiMapper {
  readonly source: string;
  map(jobs: readonly FigiMapJob[]): Promise<readonly FigiMapOutcome[]>;
}

/** 01 §4.1 / WP 3.1: 100 jobs per request with a key, 10 without. */
export const OPENFIGI_MAX_JOBS_PER_REQUEST = 100;
export const OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST = 10;

export interface OpenFigiOptions {
  readonly client: ProviderClient;
  readonly key: ApiKey;
  readonly now: () => Date;
  readonly budget?: RateBudget;
}

export interface OpenFigiMapper extends FigiMapper {
  /** What this adapter has spent, against 25,000 jobs/minute keyed or 25 requests/minute anonymous. */
  budget(
    now: Date,
  ): readonly { readonly label: string; readonly used: number; readonly limit: number }[];
  /** Every batch actually sent, for the evidence ledger. */
  readonly requestCount: () => number;
}

export function createOpenFigiMapper(options: OpenFigiOptions): OpenFigiMapper {
  // WP 4.12b, C-8: the anonymous tier is a *different* published budget, not
  // a smaller helping of the keyed one — 25 requests/minute, billed by
  // request, versus 25,000 jobs/minute, billed by job. Applying the keyed
  // window to an unkeyed process would let it call far faster than OpenFIGI's
  // own documented anonymous quota permits.
  const budget =
    options.budget ??
    createRateBudget(options.key.present ? OPENFIGI_WINDOWS : OPENFIGI_ANONYMOUS_WINDOWS);
  const context: CallContext = {
    client: options.client,
    key: options.key,
    budget,
    now: options.now,
    // See the comment below: anonymous OpenFIGI is a real, documented mode.
    requiresKey: false,
  };
  let requests = 0;

  // OpenFIGI works without a key, at a tenth of the batch size. That is a
  // genuine degraded mode rather than a failure, so — unlike the three price
  // sources — this adapter passes `requiresKey: false` and simply omits the
  // header when there is nothing to put in it.
  const batchSize = options.key.present
    ? OPENFIGI_MAX_JOBS_PER_REQUEST
    : OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST;

  async function mapBatch(batch: readonly FigiMapJob[]): Promise<readonly FigiMapOutcome[]> {
    const body = JSON.stringify(
      batch.map((job) => ({
        idType: job.idType,
        idValue: job.idValue,
        ...(job.micCode === null ? {} : { micCode: job.micCode }),
      })),
    );

    requests += 1;
    const call = await callJson(context, () => ({
      method: 'POST',
      path: '/v3/mapping',
      headers: {
        'content-type': 'application/json',
        ...(options.key.present ? { 'x-openfigi-apikey': options.key.reveal() } : {}),
      },
      body,
      // Keyed: billed in jobs, not requests (01 §4.1: "25,000 mapping
      // jobs/min"). Anonymous: billed by request — `OPENFIGI_ANONYMOUS_WINDOWS`'
      // own header explains why the two tiers do not share a unit.
      cost: options.key.present ? batch.length : 1,
    }));

    if (!call.ok) {
      // One error per job, so the caller's positional contract holds even when
      // the whole batch failed. An `error` is transient by the port's
      // definition and must not be recorded as a fact about the identifier.
      const message = messageOf(call.outcome);
      return batch.map(() => ({ status: 'error', message }));
    }

    const rows = arrayOf(call.body);
    if (rows === null || rows.length !== batch.length) {
      return batch.map(() => ({
        status: 'error',
        message: 'openfigi answered a result array that does not line up with the jobs sent',
      }));
    }

    return rows.map((row): FigiMapOutcome => {
      const record = recordOf(row);
      if (record === null) return { status: 'error', message: 'malformed result entry' };
      const error = record['error'];
      if (typeof error === 'string') {
        // OpenFIGI uses `{"error": "No identifier found."}` for a genuine
        // no-match. That is a *fact about the identifier*, permanent, and the
        // port's `no_match`; anything else is a fault.
        return /no identifier found/i.test(error)
          ? { status: 'no_match' }
          : { status: 'error', message: error };
      }
      const data = arrayOf(record['data']);
      if (data === null || data.length === 0) return { status: 'no_match' };
      const mappings: FigiMapping[] = [];
      for (const entry of data) {
        const mapping = recordOf(entry);
        const figi = mapping?.['figi'];
        if (typeof figi !== 'string') continue;
        mappings.push({
          figi,
          name: stringOrNull(mapping?.['name']),
          ticker: stringOrNull(mapping?.['ticker']),
          exchCode: stringOrNull(mapping?.['exchCode']),
          securityType: stringOrNull(mapping?.['securityType']),
          marketSector: stringOrNull(mapping?.['marketSector']),
        });
      }
      return mappings.length === 0 ? { status: 'no_match' } : { status: 'matched', mappings };
    });
  }

  return {
    source: 'openfigi',
    requestCount: () => requests,
    budget: (now) => budgetReport(budget, now),

    async map(jobs: readonly FigiMapJob[]): Promise<readonly FigiMapOutcome[]> {
      const outcomes: FigiMapOutcome[] = [];
      for (let index = 0; index < jobs.length; index += batchSize) {
        outcomes.push(...(await mapBatch(jobs.slice(index, index + batchSize))));
      }
      return outcomes;
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function messageOf(outcome: { readonly kind: string; readonly detail?: string }): string {
  return outcome.detail ?? outcome.kind;
}
