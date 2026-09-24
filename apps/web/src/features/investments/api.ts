// SPDX-License-Identifier: MIT
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  getAllocationOptions,
  getDriftOptions,
  getPerformanceOptions,
  listAccountHoldingsOptions,
  listHoldingsOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/index.ts';
import type {
  ElectBasisMethodData,
  ListAccountHoldingsResponse,
} from '../../api/generated/types.gen.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';
import type { ValuationBasis } from './search.ts';

const STALE_TIME_MS = 30_000;

/**
 * `GET /holdings` — positions aggregated by security across every account
 * (`docs/evidence/phase-3/wp3.9-routes.md` §2). Every money field, the
 * weight, the staleness flag and `unclassifiedPct` are the server's; this
 * layer adds no arithmetic.
 */
export function useHoldingsQuery(basis: ValuationBasis) {
  return useQuery({
    ...listHoldingsOptions({ query: { basis } }),
    staleTime: STALE_TIME_MS,
  });
}

/**
 * `GET /accounts/{id}/holdings` — one account's positions with their lots,
 * each lot's basis and `basisSource`. Disabled until an account is selected,
 * which is how the holdings tab avoids a request for a detail panel nobody
 * has opened.
 */
export function useAccountHoldingsQuery(accountId: string | undefined, basis: ValuationBasis) {
  return useQuery({
    ...listAccountHoldingsOptions({
      path: { accountId: accountId ?? '' },
      query: { basis },
    }),
    enabled: accountId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/**
 * `GET /accounts/{id}/holdings`, once per investment account.
 *
 * The aggregated `/holdings` row carries `accountCount` but not the
 * breakdown, and there is no "holdings grouped by security *and* account"
 * route — so the per-account expansion under a ticker is assembled from the
 * per-account responses the detail view needs anyway. One request per
 * investment account, all cached under the same keys the detail panel reads,
 * so opening an account costs nothing further.
 */
export function useAccountsHoldingsQueries(
  accountIds: readonly string[],
  basis: ValuationBasis,
): { byAccountId: ReadonlyMap<string, ListAccountHoldingsResponse>; isLoading: boolean } {
  const results = useQueries({
    queries: accountIds.map((accountId) => ({
      ...listAccountHoldingsOptions({ path: { accountId }, query: { basis } }),
      staleTime: STALE_TIME_MS,
    })),
  });

  const isLoading = results.some((result) => result.isLoading);
  // Built on every render rather than memoised: the input is a handful of
  // accounts, and a `useMemo` over a `results` array that is a new reference
  // each render would need a hand-written dependency key that can silently
  // go stale — a worse trade than rebuilding a five-entry `Map`.
  const byAccountId = new Map<string, ListAccountHoldingsResponse>();
  for (const result of results) {
    if (result.data !== undefined) byAccountId.set(result.data.accountId, result.data);
  }

  return { byAccountId, isLoading };
}

/** `GET /investments/allocation` — all three dimensions in one response. */
export function useAllocationQuery(basis: ValuationBasis) {
  return useQuery({
    ...getAllocationOptions({ query: { basis } }),
    staleTime: STALE_TIME_MS,
  });
}

/**
 * `GET /investments/drift`.
 *
 * With no `target` the route answers `targetsSet: false`, `rows: []` and
 * still returns `unclassifiedPct` — 07 §8 Q9's "suppress rather than invent".
 * The targets travel in the query because there is no `allocation_targets`
 * table yet (`wp3.9-routes.md` §8 item 1).
 */
export function useDriftQuery(basis: ValuationBasis, targets: readonly string[]) {
  return useQuery({
    ...getDriftOptions({
      query: { basis, ...(targets.length > 0 ? { target: [...targets] } : {}) },
    }),
    staleTime: STALE_TIME_MS,
  });
}

/** `GET /investments/performance` — TWR, MWR and a dollar gain under three separate keys. */
export function usePerformanceQuery(from: string) {
  return useQuery({
    ...getPerformanceOptions({ query: { from } }),
    staleTime: STALE_TIME_MS,
  });
}

export interface BasisMethodElection {
  readonly submit: (body: ElectBasisMethodData['body']) => Promise<void>;
  /** The security whose election is in flight, so one spinner does not appear on every row. */
  readonly pendingSecurityId: string | null;
  /** The security of the most recent attempt — the row a step-up failure belongs under. */
  readonly attemptedSecurityId: string | null;
  /**
   * The API's own refusal, rendered verbatim — never re-worded client-side —
   * tagged with the security it belongs to. One shared hook serves every
   * position on the screen, so an untagged message would print the same
   * refusal under every control on the page.
   */
  readonly refusal: { readonly securityId: string; readonly message: string } | null;
  readonly stepUpError: string | null;
}

/**
 * `PUT /investments/basis-method` — step-up gated, because `AVERAGE_COST` is
 * sticky by database trigger and is a tax election the user cannot take back
 * (`wp3.9-routes.md` §2).
 *
 * Written imperatively over `useStepUpRetry` rather than as a bare
 * `useMutation`, the shape `features/reports/api.ts`'s export already uses:
 * the ceremony has to run *between* the first `403 step_up_required` and the
 * retry. Two refusals this surface must show rather than swallow —
 * `investments.average_cost_ineligible` (422, not a mutual fund) and
 * `investments.average_cost_is_sticky` (409) — arrive as the thrown `Problem`
 * body and are surfaced through `refusal` with the server's own `detail`.
 */
export function useBasisMethodElection(): BasisMethodElection {
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const [pendingSecurityId, setPendingSecurityId] = useState<string | null>(null);
  const [attemptedSecurityId, setAttemptedSecurityId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<BasisMethodElection['refusal']>(null);

  async function submit(body: ElectBasisMethodData['body']): Promise<void> {
    setRefusal(null);
    setPendingSecurityId(body.securityId);
    setAttemptedSecurityId(body.securityId);
    try {
      await stepUp.run(() => Sdk.__registry.get().electBasisMethod({ body, throwOnError: true }));
    } catch (cause) {
      setRefusal({ securityId: body.securityId, message: refusalMessageOf(cause) });
      return;
    } finally {
      setPendingSecurityId(null);
    }
    // Partial key match (`features/budget/api.ts`'s own pattern): the
    // per-account holdings query is keyed by `{ path, query }` too, and the
    // election invalidates every valuation basis of that account at once.
    await queryClient.invalidateQueries({ queryKey: [{ _id: 'listAccountHoldings' }] });
    await queryClient.invalidateQueries({ queryKey: [{ _id: 'listHoldings' }] });
  }

  return {
    submit,
    pendingSecurityId,
    attemptedSecurityId,
    refusal,
    stepUpError: stepUp.error,
  };
}

/**
 * The server's `detail` when the thrown value is an RFC 9457 `Problem`, its
 * `title` otherwise. Never a sentence this file invents: a refusal the user
 * reads has to be the one the server actually gave, or the screen is
 * describing a rule that may no longer be the rule.
 */
function refusalMessageOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const problem = cause as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === 'string' && problem.detail !== '') return problem.detail;
    if (typeof problem.title === 'string' && problem.title !== '') return problem.title;
  }
  return 'The election could not be recorded.';
}
