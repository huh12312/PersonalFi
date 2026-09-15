// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Sdk } from '../../api/generated/sdk.gen.ts';
import { downloadTextFile } from '../../lib/download-file.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { toTransactionsQuery, type TransactionsSearch } from './filters.ts';

/**
 * `GET /transactions/export.csv` — step-up gated (wp1.5-api.md §1: "export
 * the ledger" is one of the five step-up routes). Imperative rather than a
 * `useQuery` because the step-up retry ceremony
 * (`lib/step-up.ts#useStepUpRetry`) needs to run *between* the first 403 and
 * a second attempt, which a declarative query can't express — and because a
 * download is a one-shot action, not cached state.
 */
export function useExportTransactions() {
  const stepUp = useStepUpRetry();
  const [isExporting, setIsExporting] = useState(false);

  async function exportCsv(search: TransactionsSearch): Promise<void> {
    setIsExporting(true);
    try {
      const { data } = await stepUp.run(() =>
        Sdk.__registry
          .get()
          .exportTransactions({ query: toTransactionsQuery(search), throwOnError: true }),
      );
      downloadTextFile(
        `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
        data,
        'text/csv',
      );
    } finally {
      setIsExporting(false);
    }
  }

  return { exportCsv, isExporting, stepUpError: stepUp.error, stepUpBusy: stepUp.busy };
}
