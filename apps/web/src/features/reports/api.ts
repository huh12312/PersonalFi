// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Sdk } from '../../api/generated/sdk.gen.ts';
import {
  getBudgetVsActualReportOptions,
  getIncomeReportOptions,
  getSankeyReportOptions,
  getSpendingReportOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { downloadTextFile } from '../../lib/download-file.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';

export interface ReportWindow {
  readonly from: string;
  readonly to: string;
}

/** `GET /reports/spending` — category × month cells for the requested window. */
export function useSpendingReportQuery(window: ReportWindow) {
  return useQuery({
    ...getSpendingReportOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
  });
}

/** `GET /reports/income` — same shape as spending, income-side categories. */
export function useIncomeReportQuery(window: ReportWindow) {
  return useQuery({
    ...getIncomeReportOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
  });
}

/** `GET /reports/sankey` — income → category → top-N merchant → other, one currency. */
export function useSankeyReportQuery(window: ReportWindow) {
  return useQuery({
    ...getSankeyReportOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
  });
}

/** `GET /reports/budget-vs-actual` — defaults to the current period server-side when `periodId` is omitted. */
export function useBudgetVsActualReportQuery(periodId: string | undefined) {
  return useQuery({
    ...getBudgetVsActualReportOptions({ query: periodId !== undefined ? { periodId } : {} }),
    staleTime: 10_000,
  });
}

/**
 * `GET /export` — step-up gated (`wp2.r-routes.md` — export sits alongside
 * the four other decision-D21 routes), same imperative shape as
 * `features/transactions/useExportTransactions.ts`: the step-up retry
 * ceremony needs to run between the first 403 and a second attempt, which a
 * declarative `useQuery` can't express, and a download is a one-shot action.
 *
 * `?encrypt=true` is a real query flag on the route but is a documented,
 * untested deferral on the API side (`wp2.8-reports.md` §4, "Encryption
 * status") — this screen only ever calls the plaintext path, so the bundle
 * downloads as `.jsonl`, not `.age`.
 */
export function useExportBundle() {
  const stepUp = useStepUpRetry();
  const [isExporting, setIsExporting] = useState(false);

  async function exportBundle(): Promise<void> {
    setIsExporting(true);
    try {
      const { data } = await stepUp.run(() =>
        Sdk.__registry.get().exportBundle({ throwOnError: true }),
      );
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      downloadTextFile(
        `personalfi-export-${new Date().toISOString().slice(0, 10)}.jsonl`,
        text,
        'application/x-ndjson',
      );
    } finally {
      setIsExporting(false);
    }
  }

  return { exportBundle, isExporting, stepUpError: stepUp.error, stepUpBusy: stepUp.busy };
}
