// SPDX-License-Identifier: MIT
import { CircleCheck, CircleOff, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { ProviderAttribution } from './Attribution.tsx';
import {
  useGiveYahooConsentMutation,
  useSetMarketDataPriorityMutation,
  useWithdrawYahooConsentMutation,
} from './api.ts';
import type {
  GetMarketDataSettingsResponse,
  PutMarketDataPriorityData,
} from '../../api/generated/types.gen.ts';

type Settings = GetMarketDataSettingsResponse;
type Yahoo = Settings['yahoo'];
type Placement = Yahoo['placements'][number];
type SecurityKind = PutMarketDataPriorityData['body']['securityKind'];
type PriceSource = PutMarketDataPriorityData['body']['sources'][number];

/** The three kinds Yahoo (equities by ticker) can be asked about. */
const KINDS: readonly { value: SecurityKind; label: string }[] = [
  { value: 'equity', label: 'Equity' },
  { value: 'etf', label: 'ETF' },
  { value: 'mutual_fund', label: 'Mutual fund' },
];

type Where = 'after_tiingo' | 'before_tiingo';

const SELECT_CLASS =
  'h-10 max-w-full rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary';

function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}

function kindLabel(kind: string): string {
  return KINDS.find((entry) => entry.value === kind)?.label ?? kind;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${String(n)}th`;
  switch (n % 10) {
    case 1:
      return `${String(n)}st`;
    case 2:
      return `${String(n)}nd`;
    case 3:
      return `${String(n)}rd`;
    default:
      return `${String(n)}th`;
  }
}

function sourcesOf(ladder: Settings['ladders'][number] | undefined): string[] {
  return ladder === undefined
    ? []
    : [...ladder.sources].sort((a, b) => a.rung - b.rung).map((entry) => entry.source);
}

/** "Equity: 3rd of 4, after Tiingo" - where Yahoo sits, relative to Tiingo when Tiingo is in the same ladder. */
export function placementSentence(placement: Placement, ladders: Settings['ladders']): string {
  const sources = sourcesOf(ladders.find((l) => l.securityKind === placement.securityKind));
  const yahooAt = sources.indexOf('yfinance');
  const tiingoAt = sources.indexOf('tiingo');
  const relation =
    yahooAt === -1 || tiingoAt === -1
      ? ''
      : yahooAt > tiingoAt
        ? ', after Tiingo (asked only for what Tiingo could not answer)'
        : ', before Tiingo (asked first)';
  return `${kindLabel(placement.securityKind)}: ${ordinal(placement.position)} of ${String(placement.of)}${relation}`;
}

/** The ladder with Yahoo placed once: right after Tiingo (the fallback) or right before it; never ahead of `user_override`, never behind `last_known`. */
export function ladderWithYahoo(current: string[], where: Where): string[] {
  const rest = current.filter((source) => source !== 'yfinance');
  const tiingoAt = rest.indexOf('tiingo');
  const lastKnownAt = rest.indexOf('last_known');
  const end = lastKnownAt === -1 ? rest.length : lastKnownAt;
  let at: number;
  if (where === 'after_tiingo') {
    at = tiingoAt === -1 ? end : tiingoAt + 1;
  } else if (tiingoAt === -1) {
    const pinned = rest.filter((s) => s === 'user_override' || s === 'exchange_fill').length;
    at = Math.min(pinned, end);
  } else {
    at = tiingoAt;
  }
  return [...rest.slice(0, at), 'yfinance', ...rest.slice(at)];
}

const OUTCOME_WORDS: Record<NonNullable<Yahoo['lastOutcome']>['outcome'], string> = {
  ok: 'Worked',
  partial: 'Answered only in part',
  failed: 'Failed',
  refused: 'Refused',
  rate_limited: 'Rate limited',
  skipped_no_key: 'Skipped',
};

const OPERATION_WORDS: Record<NonNullable<Yahoo['lastOutcome']>['operation'], string> = {
  price_refresh: 'price refresh',
  fx_refresh: 'exchange-rate refresh',
  macro_series: 'macro series',
  symbol_search: 'symbol search',
  figi_map: 'identifier mapping',
  test_fetch: 'test fetch',
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// -----------------------------------------------------------------------------------------------------------

/** The operator half, in words, with a glyph beside it - never colour alone. */
function OperatorHalf({ yahoo }: { yahoo: Yahoo }) {
  const Icon = yahoo.operatorEnabled ? CircleCheck : CircleOff;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-small font-medium text-text-primary">The operator&apos;s half</h4>
      <p
        className="flex items-start gap-2 text-small text-text-primary"
        data-testid="yahoo-operator"
      >
        <Icon
          size={16}
          aria-hidden="true"
          className={
            yahoo.operatorEnabled ? 'mt-0.5 shrink-0 text-status-success-text' : 'mt-0.5 shrink-0'
          }
        />
        <span className="min-w-0 break-words">
          {yahoo.operatorEnabled ? (
            'Enabled on this install.'
          ) : (
            <>
              Not enabled on this install: the operator adds{' '}
              <code className="break-all">YAHOO_FINANCE_ENABLED=true</code> to .env and runs{' '}
              <code className="break-all">docker compose --profile yahoo up -d</code>.
            </>
          )}
        </span>
      </p>
    </div>
  );
}

/** The holder's half: the checkbox is labelled by the api's `consentText`, verbatim; ticking PUTs, unticking DELETEs. */
function ConsentField({ yahoo }: { yahoo: Yahoo }) {
  const inputId = useId();
  const give = useGiveYahooConsentMutation();
  const withdraw = useWithdrawYahooConsentMutation();
  const stepUp = useStepUpRetry();
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) boxRef.current?.focus();
  }, [refocus]);
  const busy = give.isPending || withdraw.isPending || stepUp.busy;

  async function toggle(next: boolean): Promise<void> {
    setError(null);
    setSaid(null);
    try {
      if (next) {
        await stepUp.run(() =>
          give.mutateAsync({
            path: { provider: 'yfinance' },
            body: { consentVersion: yahoo.consentVersion },
          }),
        );
        setSaid('Consent recorded. Yahoo Finance can now be placed in a ladder below.');
      } else {
        await stepUp.run(() => withdraw.mutateAsync({ path: { provider: 'yfinance' } }));
        setSaid(
          'Consent withdrawn. Yahoo Finance was removed from every ladder; nothing is sent to it.',
        );
      }
    } catch (cause) {
      setError(
        problemDetail(
          cause,
          next ? 'Could not record the consent.' : 'Could not withdraw the consent.',
        ),
      );
    } finally {
      give.reset();
      withdraw.reset();
      setRefocus((n) => n + 1);
    }
  }

  const failure = error ?? stepUp.error;
  const consentedAt = yahoo.consent.consentedAt;

  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-small font-medium text-text-primary">Your half</h4>
      <div className="flex flex-col gap-1.5 rounded-md bg-bg-subtle p-3">
        <div className="flex items-start gap-2">
          <input
            ref={boxRef}
            id={inputId}
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={yahoo.consent.given}
            disabled={busy}
            aria-describedby={`${inputId}-hint`}
            onChange={(event) => void toggle(event.target.checked)}
          />
          <label htmlFor={inputId} className="text-small text-text-primary">
            {yahoo.consentText}
          </label>
        </div>
        <p className="ml-6 text-caption text-text-muted" data-testid="yahoo-what-leaves">
          Only this leaves the machine: {yahoo.whatLeaves}.
        </p>
        <p id={`${inputId}-hint`} className="ml-6 text-caption text-text-muted">
          {yahoo.consent.given
            ? `Ticked${consentedAt === null ? '' : ` ${formatWhen(consentedAt)}`}. Unticking withdraws it and removes Yahoo Finance from every ladder at once.`
            : 'Not ticked: Yahoo Finance cannot be placed in any ladder until it is.'}{' '}
          Ticking or unticking asks for your passkey.
        </p>
        {failure !== null && (
          <p className="ml-6 text-small text-status-danger-text" role="alert">
            {failure}
          </p>
        )}
        <p className="ml-6 text-small text-text-primary" role="status">
          {said}
        </p>
      </div>
    </div>
  );
}

/** Where Yahoo sits now, with a way to take it out of one ladder; and the form to place it (disabled until the consent is given). */
function Placements({ settings }: { settings: Settings }) {
  const yahoo = settings.yahoo;
  const setPriority = useSetMarketDataPriorityMutation();
  const stepUp = useStepUpRetry();
  const [kind, setKind] = useState<SecurityKind>('equity');
  const [where, setWhere] = useState<Where>('after_tiingo');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const ids = useId();
  const consented = yahoo.consent.given;
  const busy = setPriority.isPending || stepUp.busy;

  async function save(securityKind: SecurityKind, sources: string[], said: string): Promise<void> {
    setError(null);
    setSaid(null);
    setBusyKind(securityKind);
    try {
      await stepUp.run(() =>
        setPriority.mutateAsync({ body: { securityKind, sources: sources as PriceSource[] } }),
      );
      setSaid(said);
    } catch (cause) {
      setError(problemDetail(cause, 'Could not save this priority order.'));
    } finally {
      setBusyKind(null);
    }
  }

  function place(): void {
    const current = sourcesOf(settings.ladders.find((l) => l.securityKind === kind));
    void save(
      kind,
      ladderWithYahoo(current, where),
      `Yahoo Finance is now in the ${kindLabel(kind).toLowerCase()} ladder, ${where === 'after_tiingo' ? 'after' : 'before'} Tiingo.`,
    );
  }

  function remove(placement: Placement): void {
    const current = sourcesOf(
      settings.ladders.find((l) => l.securityKind === placement.securityKind),
    );
    void save(
      placement.securityKind as SecurityKind,
      current.filter((source) => source !== 'yfinance'),
      `Yahoo Finance was removed from the ${kindLabel(placement.securityKind).toLowerCase()} ladder.`,
    );
  }

  const failure = error ?? stepUp.error;

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-small font-medium text-text-primary">Where it is used</h4>
      {yahoo.placements.length === 0 ? (
        <p className="text-small text-text-muted" data-testid="yahoo-placements-none">
          Not used for any security kind. It is never added to a ladder on its own.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Ladders that include Yahoo Finance">
          {yahoo.placements.map((placement) => (
            <li
              key={placement.securityKind}
              className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-bg-subtle px-2 py-1 text-small"
              data-testid={`yahoo-placement-${placement.securityKind}`}
            >
              <span className="min-w-0 break-words">
                {placementSentence(placement, settings.ladders)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove Yahoo Finance from the ${kindLabel(placement.securityKind).toLowerCase()} ladder`}
                onClick={() => remove(placement)}
              >
                {busyKind === placement.securityKind ? 'Saving…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-1 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (consented) place();
        }}
        aria-label="Use Yahoo Finance as a price source"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-kind`}>Security kind</Label>
          <select
            id={`${ids}-kind`}
            className={SELECT_CLASS}
            value={kind}
            onChange={(event) => setKind(event.target.value as SecurityKind)}
          >
            {KINDS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-where`}>Where in the ladder</Label>
          <select
            id={`${ids}-where`}
            className={SELECT_CLASS}
            value={where}
            onChange={(event) => setWhere(event.target.value as Where)}
          >
            <option value="after_tiingo">After Tiingo (fallback)</option>
            <option value="before_tiingo">Before Tiingo (asked first)</option>
          </select>
        </div>
        <Button
          type="submit"
          disabled={!consented || busy}
          aria-describedby={!consented ? `${ids}-why` : undefined}
        >
          {busy && busyKind === kind ? 'Saving…' : 'Use this provider'}
        </Button>
      </form>
      {!consented && (
        <p id={`${ids}-why`} className="text-caption text-text-muted">
          Disabled until the consent above is ticked.
        </p>
      )}
      {failure !== null && (
        <p className="text-small text-status-danger-text" role="alert">
          {failure}
        </p>
      )}
      <p className="text-small text-text-primary" role="status">
        {said}
      </p>
    </div>
  );
}

function LastOutcome({ yahoo }: { yahoo: Yahoo }) {
  const last = yahoo.lastOutcome;
  const Icon = last === null || last.outcome === 'ok' ? CircleCheck : TriangleAlert;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-small font-medium text-text-primary">Last time it was asked</h4>
      {last === null ? (
        <p className="text-small text-text-muted" data-testid="yahoo-last-outcome">
          Never asked yet.
        </p>
      ) : (
        <p
          className="flex items-start gap-2 text-small text-text-primary"
          data-testid="yahoo-last-outcome"
        >
          <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            {OUTCOME_WORDS[last.outcome]} - {OPERATION_WORDS[last.operation]}, {formatWhen(last.at)}
            .{last.detail !== null && last.detail !== '' ? ` ${last.detail}` : ''}
          </span>
        </p>
      )}
    </div>
  );
}

function budgetWords(entry: Yahoo['budget'][number]): string {
  const left = Math.max(0, entry.limit - entry.used);
  const per = /hour/i.test(entry.label) ? 'this hour' : `(${entry.label})`;
  return `${String(left)} of ${String(entry.limit)} left ${per}`;
}

/**
 * WP 12.6: Yahoo Finance through the yfinance sidecar - unofficial, best effort, opt-in on both halves (the
 * operator's variable and profile; the holder's consent), never a default, never recommended. The consent
 * text is the api's, verbatim. See `docs/research/14-yahoo-finance-optional.md`.
 */
export function YahooFinanceCard({ settings }: { settings: Settings }) {
  const yahoo = settings.yahoo;
  return (
    <section aria-labelledby="yahoo-heading" data-testid="yahoo-card">
      <h2 id="yahoo-heading" className="text-h3 text-text-primary">
        Yahoo Finance (unofficial)
      </h2>
      <p className="mt-1 text-small text-text-muted">
        An unofficial, best-effort source, read through the community yfinance library. It is off
        unless both halves below are in place, and it is only used in a ladder you place it in.
      </p>
      <div className="mt-3 flex flex-col gap-4 rounded-md border border-border-hairline p-3">
        <OperatorHalf yahoo={yahoo} />
        <ConsentField yahoo={yahoo} />
        <Placements settings={settings} />
        <LastOutcome yahoo={yahoo} />
        {yahoo.budget.length > 0 && (
          <ul
            className="flex flex-col gap-1 text-small text-text-primary"
            data-testid="yahoo-budget"
          >
            {yahoo.budget.map((entry) => (
              <li key={entry.label}>{budgetWords(entry)}</li>
            ))}
          </ul>
        )}
        <ProviderAttribution attribution={yahoo.attribution} className="text-caption" />
      </div>
    </section>
  );
}
