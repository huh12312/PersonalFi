// SPDX-License-Identifier: MIT
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Money as MoneyKernel } from '@core/kernel';

import { Sdk } from '../../api/generated/sdk.gen.ts';
import { getCurrentBudgetPeriodOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { lastCalendarMonthRange, planSeedLines } from './seed-from-last-month.ts';

/**
 * The empty-state "Start from last month's spending" action. No bulk-seed
 * route exists (`seed-from-last-month.ts`'s module header) — this composes
 * three existing routes per plan line: one `GET /reports/spending` for last
 * month, then one `POST /budgets/lines` + one `PATCH /budgets/lines/{id}`
 * (assign) per qualifying category, sequentially (not `Promise.all`) so a
 * later `assign` never races an earlier line's own dirty-cascade recompute.
 *
 * Imperative, like `useExportTransactions`/`useStepUpRetry`'s callers: this
 * is a one-shot multi-step action a `useMutation` can't express cleanly, not
 * cached state.
 */
export function useSeedBudgetFromLastMonth() {
  const queryClient = useQueryClient();
  const [isSeeding, setIsSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function seed(periodId: string, budgetCurrency: string): Promise<number> {
    setIsSeeding(true);
    setError(null);
    try {
      const { from, to } = lastCalendarMonthRange(new Date());
      const { data } = await Sdk.__registry
        .get()
        .getSpendingReport({ query: { from, to }, throwOnError: true });
      const lines = planSeedLines(data.cells, budgetCurrency);

      for (const line of lines) {
        const created = await Sdk.__registry.get().createBudgetLine({
          body: { periodId, categoryId: line.categoryId },
          throwOnError: true,
        });
        await Sdk.__registry.get().updateBudgetLine({
          path: { lineId: created.data.line.id },
          body: { assigned: MoneyKernel.toJSON(line.assign) },
          throwOnError: true,
        });
      }

      await queryClient.invalidateQueries({ queryKey: getCurrentBudgetPeriodOptions().queryKey });
      return lines.length;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not seed the budget.');
      throw cause;
    } finally {
      setIsSeeding(false);
    }
  }

  return { seed, isSeeding, error };
}
