// SPDX-License-Identifier: MIT
import { AlertTriangle } from 'lucide-react';

import type { UnresolvedSecurity } from '../../api/generated/types.gen.ts';

export interface UnresolvedSecuritiesNoticeProps {
  readonly unresolved: readonly UnresolvedSecurity[];
}

/**
 * C-8's UI half (gate-security-review.md G3-11): "a position the app could
 * not identify" is visible here rather than missing — the holdings screen's
 * half of the fix. The other half is `@ctx/notifications`' `render.ts`
 * case, which needs a rule the user created; this needs nothing, because it
 * reads `GET /holdings`/`GET /accounts/:id/holdings`'s own `unresolved`
 * field directly.
 *
 * Renders nothing when the list is empty — same "don't check before you
 * render me" contract `ProviderAttribution` uses.
 */
export function UnresolvedSecuritiesNotice({ unresolved }: UnresolvedSecuritiesNoticeProps) {
  if (unresolved.length === 0) return null;

  return (
    <div
      className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3"
      data-testid="unresolved-securities"
    >
      <p className="flex items-start gap-2 text-small text-text-primary">
        <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        {unresolved.length} position{unresolved.length === 1 ? '' : 's'} could not be identified and{' '}
        {unresolved.length === 1 ? "isn't" : "aren't"} included in your holdings.
      </p>
      <ul className="mt-2 flex flex-col gap-1 pl-6 text-caption text-text-muted">
        {unresolved.map((item) => (
          <li key={`${item.provider}:${item.providerSecurityId ?? item.name ?? ''}`}>
            {item.name ?? 'An unnamed position'} — reported by {item.provider}
          </li>
        ))}
      </ul>
    </div>
  );
}
