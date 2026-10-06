// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import { useAccountValuationQuery } from './useAccountOverrides.ts';

const REASON_TEXT = {
  no_priced_holding: 'no priced holdings',
  no_balance: 'no balance yet',
  no_earlier_observation: 'no earlier observation',
} as const;

/**
 * Names every account the figures on this screen do not include — and every
 * account they include only because the holder said to value it by its typed
 * balance (WP 9.2; O-2). Without it a manual investment account's balance counts
 * nowhere and nothing says so. Renders nothing when every account is valued the
 * ordinary way.
 *
 * `role="status"`, plain text and links: a notice, not a control.
 */
export function UnvaluedAccountsNotice() {
  const query = useAccountValuationQuery();
  const data = query.data;
  if (data === undefined) return null;
  if (data.unvalued.length === 0 && data.byBalance.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="unvalued-accounts-notice"
      className="flex flex-col gap-1 rounded-md border border-border-hairline bg-bg-subtle p-3 text-small text-text-secondary"
    >
      {data.unvalued.length > 0 && (
        <p>
          <strong className="font-semibold text-text-primary">Not counted:</strong>{' '}
          {data.unvalued.map((entry, index) => (
            <span key={entry.accountId}>
              {index > 0 && ', '}
              <Link
                to="/accounts/$accountId"
                params={{ accountId: entry.accountId }}
                className="font-medium text-text-primary underline"
              >
                {entry.name}
              </Link>{' '}
              ({REASON_TEXT[entry.reason]})
            </span>
          ))}
          . These are left out of the total, not counted as zero. If you track one by hand, open it
          and value it by your typed balance.
        </p>
      )}
      {data.byBalance.length > 0 && (
        <p>
          <strong className="font-semibold text-text-primary">
            Counted at your typed balance:
          </strong>{' '}
          {data.byBalance.map((entry, index) => (
            <span key={entry.accountId}>
              {index > 0 && ', '}
              <Link
                to="/accounts/$accountId"
                params={{ accountId: entry.accountId }}
                className="font-medium text-text-primary underline"
              >
                {entry.name}
              </Link>
            </span>
          ))}
          . Not from holdings.
        </p>
      )}
    </div>
  );
}
