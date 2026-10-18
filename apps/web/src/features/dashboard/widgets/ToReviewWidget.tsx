// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import { useInboxQueue } from '../../inbox/useInboxQueue.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';

/**
 * To review (WP 10.9): how many items the review inbox holds — the inbox's own queue (`useInboxQueue`), so the
 * count is the list the holder will see when they open it. A count at the uncategorised page limit is "at least".
 * Zero is a real answer here (the queue was read and is empty), so it is said in words, not drawn as a number.
 */
export function ToReviewWidget() {
  const queue = useInboxQueue();
  const count = queue.items.length;
  const transfers = queue.items.filter((item) => item.kind === 'transfer').length;
  const state: WidgetState = queue.isLoading
    ? { kind: 'loading' }
    : queue.isError
      ? { kind: 'error', message: "The review inbox isn't available right now." }
      : { kind: 'ready' };

  return (
    <DashboardWidgetCard
      id="to-review"
      title="To review"
      seeAll={{ to: '/inbox', label: 'Open inbox' }}
      state={state}
    >
      {count === 0 ? (
        <p className="text-body text-text-secondary" data-testid="to-review-count">
          You&apos;re all caught up: nothing needs a category or a transfer match.
        </p>
      ) : (
        <div>
          <p className="text-body text-text-primary" data-testid="to-review-count">
            <Link
              to="/inbox"
              className="text-display font-semibold text-text-primary underline-offset-4 hover:underline"
            >
              {queue.truncated ? `${String(count)}+` : String(count)}
            </Link>{' '}
            item{count === 1 ? '' : 's'} to review
          </p>
          <p className="mt-1 text-caption text-text-muted">
            {count - transfers} without a category
            {transfers > 0
              ? `, ${String(transfers)} possible transfer${transfers === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>
      )}
    </DashboardWidgetCard>
  );
}
