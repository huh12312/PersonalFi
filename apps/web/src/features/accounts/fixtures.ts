// SPDX-License-Identifier: MIT
import type { Account } from '../../api/generated/types.gen.ts';

/**
 * The `overlay` block of an account the holder has set nothing on and whose
 * provider's subtype puts it in no tax bucket — what every cash account carries.
 * Test fixtures spread it so a new field on the wire is one edit here.
 */
export const DEFAULT_OVERLAY: Account['overlay'] = {
  taxTreatment: { effective: null, source: 'none', override: null, providerDefault: null },
  role: { effective: null, source: 'none' },
  valuation: { effective: 'holdings', source: 'default' },
  management: { effective: null, source: 'none' },
};
