// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { getCurrentBriefOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { Card } from '../../components/ui/card.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { headlineImpactOf } from '../insights/severity.ts';

/**
 * The dashboard's Brief card, beside `TopInsightsWidget`
 * (05-phase-5-dispatch.md §3 WP 5.11) — a small, isolated read-only
 * component: one query, no mutations, so `_app.index.tsx` only ever needs
 * the one mount line this file's own consumer adds.
 */
export function BriefDashboardCard() {
  const briefQuery = useQuery(getCurrentBriefOptions());

  // A fresh install (no Brief yet) and any other error both render nothing
  // here — `/brief` itself names the reason; the dashboard stays quiet
  // rather than showing a half-explained error tile.
  if (briefQuery.isLoading || briefQuery.isError) return null;

  const brief = briefQuery.data?.brief;
  if (brief === undefined) return null;

  const ranked = brief.items.filter((item) => item.section === 'ranked');
  const top = ranked[0];
  const topImpact = top === undefined ? null : headlineImpactOf(top);

  return (
    <Card padding="default" data-testid="brief-dashboard-card">
      <h2 className="mb-2 text-h2 text-text-primary">This week's Brief</h2>
      {brief.nothingMaterial || top === undefined ? (
        <p className="text-small text-text-secondary">Nothing material this week.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-small text-text-secondary">
            {ranked.length === 1 ? '1 action' : `${String(ranked.length)} actions`} ranked by dollar
            impact.
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-small text-text-primary">{top.title}</span>
            {topImpact !== null && (
              <Money
                value={topImpact.money}
                colorBySign={false}
                className="shrink-0 text-small font-medium"
              />
            )}
          </div>
        </div>
      )}
      <Link to="/brief" className="mt-3 inline-block text-small text-accent-text hover:underline">
        Open the Brief
      </Link>
    </Card>
  );
}
