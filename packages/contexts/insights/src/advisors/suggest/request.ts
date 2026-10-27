// SPDX-License-Identifier: MIT
/**
 * The `categorize.suggest` request: the one constructor of what is shown in
 * the payload preview, retained for the run inspector, and sent to the model.
 *
 * Rows arrive from the composition root already minimised — `@ctx/categorization`'s
 * `residueFeaturesOf` reads them off the classifier's own features — and are
 * re-shaped here through an explicit field list, so a property a caller adds
 * to a row object cannot ride along: the scope-minimisation test snapshots
 * this function's output. Each row gets a batch-local ref (`r1`…`r50`); the
 * mapping back to merchants never leaves the process.
 */
import { newId } from '@core/kernel';
import { canonicalRunDigest } from '../../preview.ts';
import { CATEGORY_SUGGEST_SCOPES } from './manifest.ts';

/** At most this many rows per request. `@advisor/local-model` refuses more. */
export const SUGGEST_BATCH_MAX = 50;

export interface ResidueRowInput {
  readonly payee_tokens: readonly string[];
  readonly mcc_family: string | null;
  readonly pfc_primary: string | null;
  readonly amount_bucket: string;
  readonly account_kind: string | null;
  readonly direction: 'in' | 'out';
  readonly day_bucket: 'early' | 'mid' | 'late';
}

export interface SuggestWireRow extends ResidueRowInput {
  readonly transaction_ref: string;
}

export interface SuggestTaxonomyEntry {
  readonly key: string;
  readonly label: string;
}

/** The wire request `@advisor/local-model`'s suggestion adapter renders. */
export interface SuggestWireRequest {
  readonly request_id: string;
  readonly taxonomy: readonly SuggestTaxonomyEntry[];
  readonly rows: readonly SuggestWireRow[];
  readonly deadline: string;
  readonly max_response_bytes: number;
}

export interface BuiltSuggestRequest {
  readonly request: SuggestWireRequest;
  /** What the run inspector retains and re-digests: the data, without per-run noise. */
  readonly payload: {
    readonly snapshot: {
      readonly transactions_residue: {
        readonly taxonomy: readonly SuggestTaxonomyEntry[];
        readonly rows: readonly SuggestWireRow[];
      };
    };
    readonly granted_scopes: readonly string[];
  };
  /** `canonicalRunDigest(payload)`: `advisor_runs.input_digest`. */
  readonly digest: string;
}

function rowOf(row: ResidueRowInput, index: number): SuggestWireRow {
  return {
    transaction_ref: `r${String(index + 1)}`,
    payee_tokens: row.payee_tokens.map((token) => String(token)),
    mcc_family: row.mcc_family,
    pfc_primary: row.pfc_primary,
    amount_bucket: String(row.amount_bucket),
    account_kind: row.account_kind,
    direction: row.direction === 'in' ? 'in' : 'out',
    day_bucket: row.day_bucket,
  };
}

export function buildSuggestRequest(input: {
  readonly taxonomy: readonly SuggestTaxonomyEntry[];
  readonly rows: readonly ResidueRowInput[];
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltSuggestRequest {
  if (input.rows.length === 0 || input.rows.length > SUGGEST_BATCH_MAX) {
    throw new RangeError(
      `a categorize.suggest batch is 1 to ${String(SUGGEST_BATCH_MAX)} rows; got ${String(input.rows.length)}`,
    );
  }
  const taxonomy = input.taxonomy.map((entry) => ({ key: entry.key, label: entry.label }));
  const rows = input.rows.map(rowOf);
  const payload = {
    snapshot: { transactions_residue: { taxonomy, rows } },
    granted_scopes: [...CATEGORY_SUGGEST_SCOPES],
  };
  return {
    request: {
      request_id: newId(),
      taxonomy,
      rows,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
  };
}
