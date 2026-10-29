// SPDX-License-Identifier: MIT
/**
 * `insights.merchant_names` — the nightly `merchant.name` pass (WP 11.6). The
 * handler lives in the composition root (`apps/api/src/merchant-names.ts`),
 * which joins the ledger's noise merchants to this query type and the local
 * model; **the api never has a path to a model**: it lists, accepts and
 * dismisses, and the worker asks.
 *
 * Daily at 05:20 local — after the nightly sync and its categorisation pass,
 * before the 05:40 advisor follow-up and Sunday's Brief — at most fifty
 * descriptors a holder, deduplicated by merchant key, never a key asked before.
 */
import { systemClock, type Clock } from '@core/kernel';
import { upsertSchedule } from '@core/platform';
import { platformOf, type InsightsDatabase } from '../../db.ts';

export const MERCHANT_NAMES_JOB_KIND = 'insights.merchant_names';
export const MERCHANT_NAMES_SCHEDULE_NAME = 'insights.merchant_names_nightly';
/** 05:20 local: after the nightly sync and the 04:15 advisor pass, before the 05:40 follow-up. */
export const DEFAULT_MERCHANT_NAMES_CRON = '20 5 * * *';

export async function registerMerchantNamesSchedule(
  database: InsightsDatabase,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(database),
    {
      userId: input.userId,
      name: MERCHANT_NAMES_SCHEDULE_NAME,
      cron: input.cron ?? DEFAULT_MERCHANT_NAMES_CRON,
      timezone: input.timezone,
      jobKind: MERCHANT_NAMES_JOB_KIND,
      enabled: true,
      jitterSeconds: 120,
    },
    clock,
  );
}
