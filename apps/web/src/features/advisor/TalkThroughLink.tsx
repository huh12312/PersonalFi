// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import { cn } from '../../lib/cn.ts';

export interface TalkThroughLinkProps {
  /** The finding (insight) the advisor session would be about. */
  readonly insightId: string;
  /** The ISO week of the Brief the link sits in (`YYYY-Www`); absent from an insight card. */
  readonly briefWeek?: string | undefined;
  readonly className?: string;
}

/**
 * WP 11.5e: "Talk this through" - a real link to `/advisor?finding=<id>&week=<YYYY-Www>`. Following it opens the
 * advisor screen, which starts one session about the finding (the api builds the question from the finding itself).
 * Nothing is asked of a model by showing the link.
 */
export function TalkThroughLink({ insightId, briefWeek, className }: TalkThroughLinkProps) {
  return (
    <Link
      to="/advisor"
      search={{ finding: insightId, ...(briefWeek === undefined ? {} : { week: briefWeek }) }}
      data-testid="talk-through-link"
      className={cn(
        'inline-flex min-h-6 items-center rounded-sm text-small text-accent-text underline-offset-2 hover:underline',
        className,
      )}
    >
      Talk this through
    </Link>
  );
}
