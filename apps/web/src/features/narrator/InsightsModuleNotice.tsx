// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink } from 'lucide-react';

import { getAdvisorModuleEnabledOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import {
  INSIGHTS_NOT_ENABLED_LEAD,
  INSIGHTS_NOT_ENABLED_TAIL,
  INSIGHTS_RUNBOOK_LINK_TEXT,
  INSIGHTS_RUNBOOK_URL,
  INSIGHTS_SECRET_NAME,
} from './narrator-words.ts';

/**
 * Whether the worker has registered the insights module (WP 11.8): `worker.insightsRegistered` of
 * `GET /advisors/module/enabled`, the same query (and cache entry) as Advisor management's `ModuleSwitch`.
 * `false` only when the api said so; while the read is loading, or has failed, this is `true` (unknown is not
 * "unregistered": nothing is hidden or disabled on a guess, and the api's 503 is the backstop).
 */
export function useInsightsRegistered(): boolean {
  const query = useQuery({ ...getAdvisorModuleEnabledOptions(), retry: false });
  return query.data?.worker.insightsRegistered !== false;
}

export interface InsightsModuleNoticeProps {
  /** The id of the sentence, so a control that cannot act can name it with `aria-describedby`. */
  readonly textId?: string;
  readonly testId?: string;
}

/**
 * The install has not opted in to the insights module (no `advisor_token_secret`): said at the top of the Language
 * model card, above the control checks, and above the advisors' payload approvals. It is never dismissable and is
 * drawn only when the api said the module is unregistered. A static `role="status"` (no live-region churn: it
 * renders once with the page, as `StaleRunNotice` does), the warning border over the subtle surface every notice
 * in the app uses, the words in the primary text colour, and the RUNBOOK link reachable by Tab.
 */
export function InsightsModuleNotice({
  textId,
  testId = 'insights-module-notice',
}: InsightsModuleNoticeProps) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-md border-2 border-status-warning-border bg-bg-subtle p-3 text-small text-text-primary"
    >
      <AlertTriangle
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-status-warning-text"
      />
      <div className="flex flex-col gap-1">
        <p id={textId}>
          {INSIGHTS_NOT_ENABLED_LEAD}{' '}
          <code className="font-mono text-caption">{INSIGHTS_SECRET_NAME}</code>
          {INSIGHTS_NOT_ENABLED_TAIL}
        </p>
        <p>
          <a
            href={INSIGHTS_RUNBOOK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-accent-text underline underline-offset-2"
          >
            {INSIGHTS_RUNBOOK_LINK_TEXT}
            <ExternalLink size={12} aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      </div>
    </div>
  );
}
