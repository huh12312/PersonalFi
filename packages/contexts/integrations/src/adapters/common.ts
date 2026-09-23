// SPDX-License-Identifier: MIT
/**
 * The three checks every adapter performs before a byte leaves, in one place.
 *
 * Order matters and is the same for all four adapters:
 *
 *   1. **Is there a key?** No key ⇒ `skipped_no_key`, and nothing is spent,
 *      nothing is dialled. §6 of the dispatch: an install with no key is
 *      configured that way, not broken.
 *   2. **Does our own budget allow it?** Spent ⇒ `rate_limited` with
 *      `retryAfterMs`, and again nothing is dialled. This is the "refuses its
 *      own 1,001st call rather than being refused" posture; see
 *      `rate-limit.ts` for why it is ours and not theirs.
 *   3. **Does the egress guard allow it?** That check lives inside
 *      `ProviderClient.send`, because it needs the resolved addresses and
 *      because there must be exactly one place it can be skipped from.
 *
 * The budget is recorded **only after the request was actually issued**, which
 * is why `record` happens here and not inside `check`: a call refused by the
 * egress guard costs the provider nothing and should not cost us a unit.
 */
import { parseDecimalJson, MalformedProviderResponse } from '../json.ts';
import type { ProviderClient, ProviderRequest, ProviderResponse } from '../http.ts';
import type { RateBudget } from '../rate-limit.ts';
import type { SourceOutcome } from '../price-source.ts';
import type { ApiKey } from '../secrets.ts';

export interface CallContext {
  readonly client: ProviderClient;
  readonly key: ApiKey;
  readonly budget: RateBudget;
  readonly now: () => Date;
  /**
   * Whether a missing key means "do not call".
   *
   * `true` for the three price sources, which are useless without one. `false`
   * for OpenFIGI, which genuinely works anonymously at a tenth of the batch
   * size — a degraded mode, not a failure, and refusing to use it would make
   * symbol mapping unavailable on an install that has not created that key yet.
   */
  readonly requiresKey?: boolean;
}

/**
 * Run one provider request through the three checks and hand back either the
 * parsed body or the outcome that stopped it.
 *
 * The return type is deliberately `SourceOutcome<unknown>`-shaped on the
 * failure side so an adapter can `return outcome` unchanged: every refusal
 * reason survives to `market_data_runs` without being re-derived from a
 * message.
 */
export type CallResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly outcome: SourceOutcome<never> };

export async function callJson(
  context: CallContext,
  request: ProviderRequest,
): Promise<CallResult> {
  const { client, key, budget, now } = context;

  if (!key.present && context.requiresKey !== false) {
    return { ok: false, outcome: { kind: 'skipped_no_key' } };
  }

  const cost = request.cost ?? 1;
  const verdict = budget.check(cost, now());
  if (!verdict.ok) {
    return {
      ok: false,
      outcome: {
        kind: 'rate_limited',
        retryAfterMs: verdict.retryAfterMs,
        detail:
          `${client.provider}: this client's own ${verdict.window.label} budget is spent ` +
          '(refused here, not by the provider)',
      },
    };
  }

  const response = await client.send(request);
  // The request left the process, so it counts — even if the provider answered
  // 500. A provider that is down still received the call. A request the egress
  // guard refused never left, and costs nothing.
  if (response.kind !== 'refused') budget.record(cost, now());

  if (response.kind !== 'ok') return { ok: false, outcome: outcomeOf(response) };
  const parsed = parseBody(response.body);
  return parsed.ok ? { ok: true, body: parsed.value } : { ok: false, outcome: parsed.outcome };
}

function outcomeOf(response: ProviderResponse): SourceOutcome<never> {
  switch (response.kind) {
    case 'refused':
      return { kind: 'refused', code: response.code, detail: response.detail };
    case 'http_error':
      return {
        kind: 'error',
        detail: `HTTP ${String(response.status)}: ${response.detail}`,
      };
    case 'transport_error':
      return { kind: 'error', detail: response.detail };
    case 'ok':
      return { kind: 'error', detail: 'unreachable' };
  }
}

/** Parse a body, turning a malformed response into an `error` outcome rather than a throw. */
export function parseBody(
  body: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly outcome: SourceOutcome<never> } {
  try {
    return { ok: true, value: parseDecimalJson(body) };
  } catch (error) {
    const detail =
      error instanceof MalformedProviderResponse ? error.message : 'the response was not JSON';
    return { ok: false, outcome: { kind: 'error', detail } };
  }
}

/** The budget read-out every `PriceSource.budget()` returns. */
export function budgetReport(
  budget: RateBudget,
  now: Date,
): readonly { readonly label: string; readonly used: number; readonly limit: number }[] {
  return budget.spent(now).map((entry) => ({
    label: entry.window.label,
    used: entry.used,
    limit: entry.window.limit,
  }));
}

/** `YYYY-MM-DD`, the only date form that crosses this seam (07 §6.1, UTC 00:00). */
export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
