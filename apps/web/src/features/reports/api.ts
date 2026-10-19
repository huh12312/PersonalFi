// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Sdk } from '../../api/generated/sdk.gen.ts';
import {
  getBudgetVsActualReportBlocksOptions,
  getBudgetVsActualReportOptions,
  getIncomeReportBlocksOptions,
  getIncomeReportOptions,
  getSankeyReportOptions,
  getSpendingReportBlocksOptions,
  getSpendingReportOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { downloadTextFile } from '../../lib/download-file.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';

export interface ReportWindow {
  readonly from: string;
  readonly to: string;
}

/** `GET /reports/spending` — category × month cells for the requested window. */
export function useSpendingReportQuery(window: ReportWindow, enabled = true) {
  return useQuery({
    ...getSpendingReportOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
    enabled,
  });
}

/** `GET /reports/income` — same shape as spending, income-side categories. */
export function useIncomeReportQuery(window: ReportWindow, enabled = true) {
  return useQuery({
    ...getIncomeReportOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
    enabled,
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
 * WP 10.15 (V8): the Spending / Income / Budget-vs-actual sections as blocks — the same figures as the three report
 * routes above, arranged by the API (`apps/api/src/blocks/reports.ts`) and drawn by the block renderer.
 */
export function useSpendingReportBlocksQuery(window: ReportWindow) {
  return useQuery({
    ...getSpendingReportBlocksOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
  });
}

export function useIncomeReportBlocksQuery(window: ReportWindow) {
  return useQuery({
    ...getIncomeReportBlocksOptions({ query: { from: window.from, to: window.to } }),
    staleTime: 30_000,
  });
}

/** Waits for the current period's id, as the screen always has: no id, no request. */
export function useBudgetVsActualReportBlocksQuery(periodId: string | undefined) {
  return useQuery({
    ...getBudgetVsActualReportBlocksOptions({ query: periodId !== undefined ? { periodId } : {} }),
    staleTime: 10_000,
    enabled: periodId !== undefined,
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
