// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import { listAdvisorGrantEventsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { AdvisorGrantEvent } from '../../api/generated/types.gen.ts';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';

export interface GrantHistoryProps {
  advisorId: string;
}

const EVENT_WORDS: Record<AdvisorGrantEvent['event'], string> = {
  granted: 'Granted',
  revoked: 'Revoked',
  re_granted: 'Granted again',
};

/** A session id is shown by its first eight characters: enough to match a row, not a credential. */
function sessionWords(id: string | null): string {
  return id === null
    ? 'made outside a sign-in session'
    : `authorised in sign-in session ${id.slice(0, 8)}`;
}

/**
 * The consent history for one advisor (O-9, WP 9.6 item 5):
 * `GET /advisors/{id}/grant-events`, newest first. Append-only on the server — a
 * re-grant is a new line beside the revoke it follows, never a rewrite of
 * either — so this list is the record of what the holder consented to and when,
 * which the grant state alone (overwritten on every change) cannot be.
 */
export function GrantHistory({ advisorId }: GrantHistoryProps) {
  const query = useQuery(listAdvisorGrantEventsOptions({ path: { advisorId } }));

  if (query.isLoading) return <SkeletonText lines={2} />;
  if (query.isError) {
    return (
      <p className="text-small text-status-danger-text" data-testid="grant-history-error">
        The consent history could not be loaded.
      </p>
    );
  }

  const events = query.data?.events ?? [];

  return (
    <section className="flex flex-col gap-2" data-testid="grant-history">
      <h3 className="text-small font-medium text-text-primary">Consent history</h3>
      {events.length === 0 ? (
        <p className="text-caption text-text-muted" data-testid="grant-history-empty">
          Nothing has been granted to this advisor yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {events.map((event) => (
            <li
              key={event.id}
              className="text-caption text-text-secondary"
              data-testid="grant-event"
              data-event={event.event}
            >
              <span className="font-medium text-text-primary">{EVENT_WORDS[event.event]}</span>{' '}
              <span className="font-mono">{event.scope}</span>
              {event.perRunConsent ? ' (consented per run)' : ''} —{' '}
              <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
              , {sessionWords(event.stepUpSessionId)}.
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
