// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import type { BriefProgress } from '../../api/generated/types.gen.ts';

export interface BriefProgressBoxProps {
  readonly progress: BriefProgress;
}

/**
 * WP 11.5e: a Brief item that reports on a plan the holder picked in an advisor session. Everything it says is the
 * api's own: `wording` is the server's deterministic sentence (figures included), shown verbatim; the origin is the
 * finding the session was opened from; "Being worked on" names the finding the plan stands in for this week (it is
 * not listed again while the plan is followed). "Open the plan" is a real link to that session.
 */
export function BriefProgressBox({ progress }: BriefProgressBoxProps) {
  return (
    <div
      className="mt-2 rounded-md border border-border-hairline bg-bg-subtle px-2.5 py-2"
      data-testid="brief-progress"
      data-state={progress.state}
    >
      <p className="text-caption font-medium text-text-secondary">Plan you picked</p>
      <p
        className="mt-0.5 text-small text-text-primary [overflow-wrap:anywhere]"
        data-testid="brief-progress-wording"
      >
        {progress.wording}
      </p>
      {progress.state === 'reached' && (
        <p
          className="mt-0.5 text-small font-medium text-text-primary"
          data-testid="brief-progress-reached"
        >
          Target reached
        </p>
      )}
      {progress.origin !== null && (
        <p
          className="mt-0.5 text-caption text-text-muted [overflow-wrap:anywhere]"
          data-testid="brief-progress-origin"
        >
          From the finding “{progress.origin.title}”
        </p>
      )}
      {progress.workedOn !== null && (
        <p
          className="mt-0.5 text-caption text-text-muted [overflow-wrap:anywhere]"
          data-testid="brief-progress-worked-on"
        >
          Being worked on: “{progress.workedOn.title}”. It is not listed again while this plan is
          followed.
        </p>
      )}
      <p className="mt-1 text-small">
        <Link
          to="/advisor"
          search={{ session: progress.sessionId }}
          data-testid="brief-progress-link"
          className="inline-flex min-h-6 items-center rounded-sm text-accent-text underline-offset-2 hover:underline"
        >
          Open the plan
        </Link>
      </p>
    </div>
  );
}
