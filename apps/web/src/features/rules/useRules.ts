// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  applyRuleMutation,
  createRuleFromTransactionMutation,
  deleteRuleMutation,
  listRulesOptions,
  previewRuleMutation,
  updateRuleMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

/** `GET /rules` — this user's categorisation rules, by ascending priority. */
export function useRulesQuery() {
  return useQuery({ ...listRulesOptions(), staleTime: 30_000 });
}

function invalidateRules(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: listRulesOptions().queryKey });
}

/**
 * "Always categorise like this" (wp1.6-ui.md §7's carried-over
 * rule-from-transaction item): `POST /transactions/{id}/rule`, built from one
 * transaction's own payee. Creating the rule alone does not touch any
 * existing transaction — only future syncs, via `runOnSync` — which is why
 * the preview/apply pair below is a separate step.
 */
export function useCreateRuleFromTransactionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...createRuleFromTransactionMutation(),
    onSuccess: () => invalidateRules(queryClient),
  });
}

/**
 * `POST /rules/preview` — writes nothing. The count this returns is the exact
 * count `POST /rules/{id}/apply` will report for the same `retroactive` flag,
 * which is the whole point: "912 transactions" shown before the fact turns a
 * retroactive apply from a trap into a tool.
 */
export function usePreviewRuleMutation() {
  return useMutation({ ...previewRuleMutation() });
}

/** `POST /rules/{id}/apply` — the non-preview half; emits `categorization.RuleApplied`. */
export function useApplyRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...applyRuleMutation(),
    onSuccess: () => invalidateRules(queryClient),
  });
}

/** `PATCH /rules/{id}` — used here only for the enable/disable toggle on the rules list. */
export function useUpdateRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...updateRuleMutation(),
    onSuccess: () => invalidateRules(queryClient),
  });
}

/** `DELETE /rules/{id}` — idempotent (`{deleted: false}` on someone else's rule or a repeat), per wp2.5-rules-api.md §2. */
export function useDeleteRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...deleteRuleMutation(),
    onSuccess: () => invalidateRules(queryClient),
  });
}
