// SPDX-License-Identifier: MIT
import { Info } from 'lucide-react';

import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { Button } from '../../components/ui/button.tsx';
import { useAccountsLookup } from '../accounts/useAccountsLookup.ts';
import { useCoinGeckoAttribution } from '../market-data/api.ts';
import { AccountPositionsPanel } from './AccountPositionsPanel.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';
import { AllocationPanel } from './AllocationPanel.tsx';
import { DriftPanel } from './DriftPanel.tsx';
import { HoldingsTable } from './HoldingsTable.tsx';
import { PerformancePanel } from './PerformancePanel.tsx';
import { UnresolvedSecuritiesNotice } from './UnresolvedSecuritiesNotice.tsx';
import {
  useAccountHoldingsQuery,
  useAccountsHoldingsQueries,
  useAllocationQuery,
  useBasisMethodElection,
  useDriftQuery,
  useHoldingsQuery,
  useInvestmentActivity,
  usePerformanceByManagementQuery,
  usePerformanceQuery,
} from './api.ts';
import { ratioToNumber } from './labels.ts';
import {
  DEFAULT_BASIS,
  DEFAULT_DIMENSION,
  DEFAULT_TAB,
  defaultActivityWindow,
  defaultPerformanceFrom,
  type InvestmentsSearch,
  type InvestmentsTab,
} from './search.ts';

/**
 * A sample target set, applied only when the user explicitly asks for one
 * from the drift empty state.
 *
 * It is *not* a default: nothing on first load applies it, the drift panel
 * renders nothing until it (or a hand-written `?target=`) is in the URL, and
 * the button that applies it says "sample". 07 §8 Q9's "suppress rather than
 * invent" is about the screen never asserting a target the user did not
 * choose — a labelled, one-click demonstration the user asks for is a choice.
 */
const SAMPLE_TARGETS = ['US_EQUITY:0.6', 'US_BOND:0.3', 'CASH:0.1'] as const;

const TABS: readonly { id: InvestmentsTab; label: string }[] = [
  { id: 'holdings', label: 'Holdings' },
  { id: 'activity', label: 'Activity' },
  { id: 'allocation', label: 'Allocation' },
  { id: 'drift', label: 'Drift' },
  { id: 'performance', label: 'Performance' },
];

export interface InvestmentsScreenProps {
  readonly search: InvestmentsSearch;
  readonly onSearchChange: (next: InvestmentsSearch) => void;
  /** Injected so tests and screenshots pin the default performance window. */
  readonly today?: Date;
}

/**
 * `/investments` — holdings, allocation, drift, per-account detail and
 * performance, all of it read from `GET /holdings`,
 * `GET /accounts/{id}/holdings`, `GET /investments/{allocation,drift,performance}`
 * through the generated client.
 *
 * Every piece of view state is in the URL (`./search.ts`): the tab, the open
 * account, the allocation dimension, the valuation basis and the drift
 * targets. That makes a per-account lot view a linkable thing, and it is also
 * how the drift targets are expressed at all — there is no
 * `allocation_targets` table yet, so the route takes them in its query
 * (`wp3.9-routes.md` §8 item 1) and the URL is the only place they live.
 */
export function InvestmentsScreen({ search, onSearchChange, today }: InvestmentsScreenProps) {
  const tab = search.tab ?? DEFAULT_TAB;
  const basis = search.basis ?? DEFAULT_BASIS;
  const dimension = search.dimension ?? DEFAULT_DIMENSION;
  const targets = search.target ?? [];
  const performanceFrom = search.from ?? defaultPerformanceFrom(today ?? new Date());

  const accounts = useAccountsLookup();
  const investmentAccountIds = accounts.accounts
    .filter((account) => account.type === 'investment' || account.type === 'crypto')
    .map((account) => account.id);

  const holdingsQuery = useHoldingsQuery(basis);
  const accountHoldings = useAccountsHoldingsQueries(investmentAccountIds, basis);
  const selectedAccountQuery = useAccountHoldingsQuery(search.account, basis);
  const allocationQuery = useAllocationQuery(basis);
  const driftQuery = useDriftQuery(basis, targets);
  const performanceScope = search.scope ?? 'portfolio';
  const investmentAccounts = investmentAccountIds.map((id) => ({
    id,
    name: accounts.nameOf(id),
  }));
  const scopeAccount = search.scopeAccount ?? investmentAccountIds[0];
  const performanceQuery = usePerformanceQuery(performanceFrom, performanceScope, scopeAccount);
  const byManagementQuery = usePerformanceByManagementQuery(
    performanceFrom,
    performanceScope === 'management',
  );
  const activityWindow = defaultActivityWindow(today ?? new Date());
  const activityFilters = {
    from: search.activityFrom ?? activityWindow.from,
    to: search.activityTo ?? activityWindow.to,
    account: search.activityAccount,
    kind: search.activityKind,
  };
  const activity = useInvestmentActivity(activityFilters, tab === 'activity');
  const election = useBasisMethodElection();

  function update(patch: Partial<InvestmentsSearch>): void {
    onSearchChange({ ...search, ...patch });
  }

  const holdings = holdingsQuery.data;
  const securityTypeOf = (securityId: string) =>
    holdings?.holdings.find((holding) => holding.securityId === securityId)?.securityType;

  // `wp3.14-carryovers.md` item 1: `GET /holdings` carries `price.source` per
  // row but no `attribution` field of its own (`wp3.9-routes.md`), so every
  // tab that renders a value derived from these prices needs both signals —
  // whether a CoinGecko-priced crypto holding exists at all, and the exact
  // licence text to render when it does.
  const coinGeckoAttribution = useCoinGeckoAttribution();
  const hasCoinGeckoCryptoHolding =
    holdings?.holdings.some((holding) => holding.price?.source === 'coingecko') ?? false;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-h2 font-semibold text-text-primary">Investments</h2>
          {holdings !== undefined && (
            <p className="text-small text-text-secondary">
              As of {holdings.asOf} · {holdings.currency} ·{' '}
              {basis === 'as_of_now'
                ? 'stale prices excluded (as of now)'
                : 'stale prices carried forward (last known)'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="investments-basis" className="text-small text-text-secondary">
            Valuation basis
          </label>
          <select
            id="investments-basis"
            className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small"
            value={basis}
            onChange={(event) =>
              update({ basis: event.target.value as InvestmentsSearch['basis'] })
            }
          >
            <option value="as_of_now">As of now</option>
            <option value="last_known">Last known</option>
          </select>
        </div>
      </header>

      {holdingsQuery.isLoading ? (
        <Skeleton variant="block" height={88} />
      ) : (
        holdings !== undefined && (
          <div className="grid gap-4 rounded-xl border border-border-hairline p-5 sm:grid-cols-3">
            <StatTile
              label="Portfolio value"
              value={
                <span data-testid="portfolio-total">
                  <Money value={holdings.total} signDisplay="auto" colorBySign={false} />
                </span>
              }
            />
            <StatTile
              label="% unclassified"
              value={
                <span data-testid="holdings-unclassified-pct">
                  <Percent value={ratioToNumber(holdings.unclassifiedPct)} />
                </span>
              }
            />
            <StatTile label="Securities held" value={<span>{holdings.holdings.length}</span>} />
          </div>
        )
      )}

      <Tabs value={tab} onValueChange={(next) => update({ tab: next as InvestmentsTab })}>
        <TabsList aria-label="Investment views">
          {TABS.map((entry) => (
            <TabsTab key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTab>
          ))}
          <TabsIndicator />
        </TabsList>

        <TabsPanel value="holdings">
          {holdingsQuery.isLoading ? (
            <Skeleton variant="block" height={280} />
          ) : search.account !== undefined ? (
            <AccountPositionsPanel
              accountName={accounts.nameOf(search.account)}
              data={selectedAccountQuery.data}
              isLoading={selectedAccountQuery.isLoading}
              securityTypeOf={securityTypeOf}
              election={election}
              onBack={() => onSearchChange({ ...search, account: undefined })}
              coinGeckoAttribution={coinGeckoAttribution}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {investmentAccountIds.length > 0 && (
                <nav aria-label="Investment accounts" className="flex flex-wrap gap-2">
                  {investmentAccountIds.map((accountId) => (
                    <Button
                      key={accountId}
                      variant="secondary"
                      size="sm"
                      onClick={() => update({ account: accountId })}
                    >
                      {accounts.nameOf(accountId)}
                    </Button>
                  ))}
                </nav>
              )}
              <HoldingsTable
                holdings={holdings?.holdings ?? []}
                unresolved={holdings?.unresolved ?? []}
                accountHoldings={accountHoldings.byAccountId}
                accountNameOf={accounts.nameOf}
                onOpenAccount={(accountId) => update({ account: accountId })}
                coinGeckoAttribution={coinGeckoAttribution}
              />
              <UnresolvedSecuritiesNotice unresolved={holdings?.unresolved ?? []} />
              {holdings !== undefined && holdings.excluded.length > 0 && (
                <p className="flex items-start gap-2 text-caption text-text-muted">
                  <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                  {holdings.excluded.length} position(s) are excluded from the portfolio total; see
                  the Allocation tab for the reason on each.
                </p>
              )}
            </div>
          )}
        </TabsPanel>

        <TabsPanel value="activity">
          <ActivityPanel
            filters={activityFilters}
            onFiltersChange={(patch) =>
              update({
                ...('account' in patch ? { activityAccount: patch.account } : {}),
                ...('kind' in patch ? { activityKind: patch.kind } : {}),
                ...('from' in patch ? { activityFrom: patch.from } : {}),
                ...('to' in patch ? { activityTo: patch.to } : {}),
              })
            }
            accounts={investmentAccounts}
            accountNameOf={accounts.nameOf}
            items={activity.items}
            syncStates={activity.first?.accounts}
            total={activity.first?.total}
            isLoading={activity.isLoading}
            hasNextPage={activity.hasNextPage}
            isFetchingNextPage={activity.isFetchingNextPage}
            onLoadMore={() => void activity.fetchNextPage()}
          />
        </TabsPanel>

        <TabsPanel value="allocation">
          <AllocationPanel
            data={allocationQuery.data}
            isLoading={allocationQuery.isLoading}
            dimension={dimension}
            onDimensionChange={(next) => update({ dimension: next })}
            hasCoinGeckoCryptoHolding={hasCoinGeckoCryptoHolding}
            coinGeckoAttribution={coinGeckoAttribution}
          />
        </TabsPanel>

        <TabsPanel value="drift">
          <div className="flex flex-col gap-3">
            <DriftPanel
              data={driftQuery.data}
              isLoading={driftQuery.isLoading}
              hasTargets={targets.length > 0}
              onUseExampleTargets={() => update({ target: [...SAMPLE_TARGETS] })}
            />
            {targets.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                <span>Target set: {targets.join(', ')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onSearchChange({ ...search, target: undefined })}
                >
                  Clear target
                </Button>
              </div>
            )}
          </div>
        </TabsPanel>

        <TabsPanel value="performance">
          <PerformancePanel
            data={performanceQuery.data}
            isLoading={performanceQuery.isLoading}
            scope={performanceScope}
            scopeAccount={scopeAccount}
            onScopeChange={(scope, accountId) =>
              update({ scope, scopeAccount: scope === 'account' ? accountId : undefined })
            }
            accounts={investmentAccounts}
            byManagement={byManagementQuery.data}
            byManagementLoading={byManagementQuery.isLoading}
            hasCoinGeckoCryptoHolding={hasCoinGeckoCryptoHolding}
            coinGeckoAttribution={coinGeckoAttribution}
          />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
