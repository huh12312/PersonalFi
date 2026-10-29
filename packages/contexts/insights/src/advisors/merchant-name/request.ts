// SPDX-License-Identifier: MIT
/**
 * The `merchant.name` request: the one constructor of what the payload preview
 * shows, what the run inspector retains and what the model is sent.
 *
 * Exactly two fields cross, re-shaped here through an explicit field list so a
 * property a caller adds cannot ride along (the payload snapshot test pins it):
 * the descriptor residue and the stripped processor prefix. No id of any kind —
 * the request id is a fresh UUID per call, never a merchant's or a transaction's.
 */
import { newId } from '@core/kernel';
import { canonicalRunDigest } from '../../preview.ts';
import { MERCHANT_DESCRIPTOR_MAX, MERCHANT_NAME_SCOPES } from './manifest.ts';

export interface MerchantNameSubject {
  /** The normaliser's residue, as the holder reads it. */
  readonly descriptor: string;
  /** The processor prefix the normaliser stripped (`PAYPAL *`), or `null`. */
  readonly stripped_prefix: string | null;
}

/** The wire request `@advisor/local-model`'s merchant-name adapter renders. */
export interface MerchantNameWireRequest extends MerchantNameSubject {
  readonly request_id: string;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

export interface BuiltMerchantNameRequest {
  readonly request: MerchantNameWireRequest;
  /** What the run inspector retains and re-digests: the data, without per-run noise. */
  readonly payload: {
    readonly snapshot: { readonly transactions_residue: MerchantNameSubject };
    readonly granted_scopes: readonly string[];
  };
  /** `canonicalRunDigest(payload)`: `advisor_runs.input_digest`. */
  readonly digest: string;
}

export function buildMerchantNameRequest(input: {
  readonly descriptor: string;
  readonly strippedPrefix: string | null;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltMerchantNameRequest {
  const descriptor = String(input.descriptor);
  if (descriptor.trim() === '' || [...descriptor].length > MERCHANT_DESCRIPTOR_MAX) {
    throw new RangeError(
      `a merchant.name descriptor is 1 to ${String(MERCHANT_DESCRIPTOR_MAX)} characters`,
    );
  }
  const subject: MerchantNameSubject = {
    descriptor,
    stripped_prefix: input.strippedPrefix === null ? null : String(input.strippedPrefix),
  };
  const payload = {
    snapshot: { transactions_residue: subject },
    granted_scopes: [...MERCHANT_NAME_SCOPES],
  };
  return {
    request: {
      request_id: newId(),
      descriptor: subject.descriptor,
      stripped_prefix: subject.stripped_prefix,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
  };
}
