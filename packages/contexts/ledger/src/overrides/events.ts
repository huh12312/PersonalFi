// SPDX-License-Identifier: MIT
import { defineEvent } from '@core/platform';
import { z } from 'zod';
import { OVERRIDE_FIELDS } from './vocab.ts';

/**
 * The holder changed what they say an account is. Planning's staleness reads
 * it: a stored projection was computed from the old overlay and must read stale,
 * never be silently recomputed.
 *
 * Payload discipline, as every ledger event: the account id and the *names* of
 * the fields that changed, never their values. A consumer that wants the values
 * re-reads them through `listAccountOverrides`, which is also how it gets
 * whatever the holder has changed since.
 */
export const AccountOverrideChanged = defineEvent({
  type: 'ledger.AccountOverrideChanged',
  aggregateType: 'account',
  description:
    'The holder set, changed or cleared an account override (tax treatment, role, valuation). ' +
    'Carries which fields changed by name, not the values. `cleared` is true when the override ' +
    'row was removed, so the account is back to its provider-derived defaults.',
  schema: z.object({
    accountId: z.uuid(),
    changedFields: z.array(z.enum(OVERRIDE_FIELDS)).min(1),
    cleared: z.boolean(),
  }),
});
