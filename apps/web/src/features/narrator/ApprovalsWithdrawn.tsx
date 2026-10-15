// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { Info } from 'lucide-react';

import type { NarratorSettings } from './narrator-api.ts';
import { approvalsWithdrawnLead } from './narrator-words.ts';

/**
 * Said after a write whose answer carries `approvalsRevoked > 0`: making a provider active, or changing the
 * active one's model, withdraws the narrator's standing payload approvals (the approval records the provider and
 * model it was given for), so the holder re-approves under the new one in Advisor management.
 */
export function ApprovalsWithdrawn({ settings }: { settings: NarratorSettings }) {
  return (
    <span className="flex items-start gap-1.5" data-testid="narrator-approvals-withdrawn">
      <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {approvalsWithdrawnLead(settings)}{' '}
        <Link to="/settings/advisors" className="text-accent-text underline">
          Advisor management
        </Link>
        .
      </span>
    </span>
  );
}
