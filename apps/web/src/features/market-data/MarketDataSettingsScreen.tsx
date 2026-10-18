// SPDX-License-Identifier: MIT
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { CloudOff } from 'lucide-react';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { ProviderAttribution } from './Attribution.tsx';
import {
  useMarketDataSettingsQuery,
  useSetMarketDataPriorityMutation,
  useTestMarketDataFetchMutation,
} from './api.ts';
import type {
  GetMarketDataSettingsResponse,
  PutMarketDataPriorityData,
  TestMarketDataFetchData,
} from '../../api/generated/types.gen.ts';

type Ladder = GetMarketDataSettingsResponse['ladders'][number];
type Provider = GetMarketDataSettingsResponse['providers'][number];
type SecurityKind = PutMarketDataPriorityData['body']['securityKind'];
type PriceSource = PutMarketDataPriorityData['body']['sources'][number];

function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}

/** One provider's key/registration/capabilities/budget/attribution — every field named explicitly, never a raw object spread, so an unexpected extra field on the wire (a key value, say) has no path onto the screen. */
function ProviderRow({ provider }: { provider: Provider }) {
  return (
    <li className="rounded-md border border-border-hairline p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-text-primary">{provider.provider}</p>
        <div className="flex items-center gap-2">
          <Badge variant={provider.keyPresent ? 'success' : 'neutral'}>
            {provider.keyPresent ? 'Key configured' : 'No key configured'}
          </Badge>
          {/* WP 10.4: where the key in force comes from (the "API keys" cards above change it). */}
          {provider.keyPresent && provider.keySource === 'file' && (
            <span className="text-caption text-text-muted">from the operator&apos;s file</span>
          )}
          {provider.keyPresent && provider.keySource === 'stored' && (
            <span className="text-caption text-text-muted">stored in this install</span>
          )}
          <Badge variant={provider.registered ? 'success' : 'neutral'}>
            {provider.registered ? 'Registered' : 'Not registered'}
          </Badge>
        </div>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-muted">
        {(['prices', 'fx', 'macro', 'search'] as const)
          .filter((capability) => provider.capabilities[capability])
          .map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
      </ul>

      {provider.budget.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {provider.budget.map((entry) => (
            <li key={entry.label} className="flex items-center gap-2 text-caption text-text-muted">
              <span className="w-32 shrink-0">{entry.label}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{
                    width: `${String(entry.limit > 0 ? Math.min(100, (entry.used / entry.limit) * 100) : 0)}%`,
                  }}
                />
              </span>
              <span className="tabular-nums">
                {entry.used} / {entry.limit}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ProviderAttribution attribution={provider.attribution} className="mt-2 text-caption" />
      {provider.attribution.required && (
        <details className="mt-1">
          <summary className="cursor-pointer text-caption text-text-muted">Licence clause</summary>
          <p className="mt-1 text-caption text-text-muted">{provider.attribution.clause}</p>
        </details>
      )}
    </li>
  );
}

/** One security kind's source ladder, reorderable with up/down (accessible, no drag-and-drop dependency this pass doesn't already have). */
function PriorityLadderEditor({
  ladder,
  onSave,
  saving,
}: {
  ladder: Ladder;
  onSave: (sources: string[]) => Promise<void>;
  saving: boolean;
}) {
  const initial = useMemo(
    () => [...ladder.sources].sort((a, b) => a.rung - b.rung).map((s) => s.source),
    [ladder],
  );
  const [order, setOrder] = useState<string[]>(initial);
  const dirty = order.join(',') !== initial.join(',');

  function move(index: number, delta: number): void {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const removed = next.splice(index, 1);
    const item = removed[0];
    if (item === undefined) return;
    next.splice(target, 0, item);
    setOrder(next);
  }

  return (
    <li className="rounded-md border border-border-hairline p-3">
      <p className="font-medium text-text-primary">{ladder.securityKind}</p>
      <ol className="mt-2 flex flex-col gap-1">
        {order.map((source, index) => (
          <li
            key={source}
            className="flex items-center justify-between gap-2 rounded-sm bg-bg-subtle px-2 py-1 text-small"
          >
            <span>
              {index + 1}. {source}
            </span>
            <span className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Move ${source} up in ${ladder.securityKind}'s priority`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Move ${source} down in ${ladder.securityKind}'s priority`}
                disabled={index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
            </span>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        size="sm"
        className="mt-2"
        disabled={!dirty || saving}
        onClick={() => void onSave(order)}
      >
        {saving ? 'Saving…' : 'Save priority'}
      </Button>
    </li>
  );
}

/**
 * Market-data settings (dispatch §3, WP 3.12): source priority (step-up,
 * since it "decides which provider's number becomes the price of everything
 * the user owns" — `wp3.9-routes.md`'s own reasoning for that route), key
 * presence (never a value — the wire type has no field a value could travel
 * in), budgets, a test fetch, and the attribution block next to every
 * provider that requires one.
 */
export function MarketDataSettingsScreen() {
  const settingsQuery = useMarketDataSettingsQuery();
  const setPriority = useSetMarketDataPriorityMutation();
  const testFetch = useTestMarketDataFetchMutation();
  const stepUp = useStepUpRetry();
  const testFetchStepUp = useStepUpRetry();

  const [savingKind, setSavingKind] = useState<string | null>(null);
  const [priorityError, setPriorityError] = useState<string | null>(null);

  const providers = settingsQuery.data?.providers ?? [];
  const [testProvider, setTestProvider] =
    useState<TestMarketDataFetchData['body']['provider']>('coingecko');
  const [testSymbol, setTestSymbol] = useState('');

  async function handleSavePriority(securityKind: string, sources: string[]): Promise<void> {
    setPriorityError(null);
    setSavingKind(securityKind);
    try {
      await stepUp.run(() =>
        setPriority.mutateAsync({
          body: {
            securityKind: securityKind as SecurityKind,
            sources: sources as PriceSource[],
          },
        }),
      );
    } catch (cause) {
      setPriorityError(problemDetail(cause, 'Could not save this priority order.'));
    } finally {
      setSavingKind(null);
    }
  }

  async function handleTestFetch(event: FormEvent): Promise<void> {
    event.preventDefault();
    await testFetchStepUp.run(() =>
      testFetch.mutateAsync({
        body: {
          provider: testProvider,
          ...(testSymbol !== '' ? { symbol: testSymbol } : {}),
        },
      }),
    );
  }

  if (settingsQuery.isLoading) return <SkeletonText lines={6} />;

  if (settingsQuery.isError) {
    return (
      <EmptyState
        icon={CloudOff}
        headline="Market data settings aren't available right now"
        description="Try again in a moment."
      />
    );
  }

  const result = testFetch.data;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-h3 text-text-primary">Providers</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {providers.map((provider) => (
            <ProviderRow key={provider.provider} provider={provider} />
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-h3 text-text-primary">Source priority</h2>
        <p className="mt-1 text-small text-text-muted">
          Which source wins when more than one has a price, per security kind. Saving needs a fresh
          passkey check — this ladder decides what every position in that class is worth.
        </p>
        {(priorityError !== null || stepUp.error !== null) && (
          <p className="mt-2 text-small text-status-danger-text">{priorityError ?? stepUp.error}</p>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {(settingsQuery.data?.ladders ?? []).map((ladder) => (
            <PriorityLadderEditor
              key={ladder.securityKind}
              ladder={ladder}
              saving={savingKind === ladder.securityKind}
              onSave={(sources) => handleSavePriority(ladder.securityKind, sources)}
            />
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-h3 text-text-primary">Test fetch</h2>
        <p className="mt-1 text-small text-text-muted">
          Ask one provider for one quote right now. This leaves the machine and spends that
          provider's real rate-limit budget, so it needs a fresh passkey check too.
        </p>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => void handleTestFetch(e)}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="test-fetch-provider">Provider</Label>
            <select
              id="test-fetch-provider"
              className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
              value={testProvider}
              onChange={(event) =>
                setTestProvider(event.target.value as TestMarketDataFetchData['body']['provider'])
              }
            >
              {['tiingo', 'fred', 'coingecko', 'openfigi', 'yfinance'].map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="test-fetch-symbol">Symbol (optional)</Label>
            <Input
              id="test-fetch-symbol"
              value={testSymbol}
              onChange={(event) => setTestSymbol(event.target.value)}
              placeholder="e.g. BTC"
            />
          </div>
          <Button type="submit" disabled={testFetch.isPending || testFetchStepUp.busy}>
            {testFetch.isPending || testFetchStepUp.busy ? 'Fetching…' : 'Run test fetch'}
          </Button>
        </form>

        {testFetchStepUp.error !== null && (
          <p className="mt-2 text-small text-status-danger-text">{testFetchStepUp.error}</p>
        )}
        {testFetch.isError && (
          <p className="mt-2 text-small text-status-danger-text" role="alert">
            {problemDetail(testFetch.error, 'The test fetch failed.')}
          </p>
        )}

        {result !== undefined && (
          <div className="mt-3 rounded-md border border-border-hairline p-3" role="status">
            <p className="text-small text-text-primary">
              <span className="font-medium">{result.provider}</span> — {result.outcome}
            </p>
            {result.detail !== null && (
              <p className="mt-1 text-caption text-text-muted">{result.detail}</p>
            )}
            {result.quote !== null && (
              <>
                <p className="mt-1 text-small text-text-primary">
                  {result.quote.date} · {result.quote.value}
                  {result.quote.currency !== null ? ` ${result.quote.currency}` : ''}
                </p>
                <ProviderAttribution attribution={result.quote.attribution} className="mt-1" />
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
