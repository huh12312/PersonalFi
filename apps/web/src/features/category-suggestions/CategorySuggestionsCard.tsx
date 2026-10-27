// SPDX-License-Identifier: MIT
import { ChevronRight, CircleCheck, CircleMinus, Loader2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { cn } from '../../lib/cn.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { useCategories } from '../categories/useCategories.ts';
import { formatDate } from '../narrator/narrator-words.ts';
import { problemCode, problemDetail } from '../narrator/narrator-api.ts';
import {
  MEASURE_GIVE_UP_MS,
  useApproveSuggestionPayloadMutation,
  useMeasureSuggestionsMutation,
  useRefreshSuggestionSettings,
  useSetSuggestionConsentMutation,
  useSetSuggestionModelMutation,
  useSetSuggestionsEnabledMutation,
  useSuggestionPreviewQuery,
  useSuggestionSettingsQuery,
  type CategorySuggestionEval,
  type SuggestionModel,
  type SuggestionModelChoice,
  type SuggestionSettings,
} from './suggestion-api.ts';
import {
  categoryWords,
  chosenModel,
  enableWords,
  measurementSummary,
  modelChoiceWords,
  percentWords,
  rowsWords,
  statusWords,
} from './suggestion-words.ts';

/** A measurement started from this screen: which model, and the `measuredAt` it must beat. */
interface Measuring {
  readonly choice: SuggestionModelChoice;
  readonly since: string | null;
}

type MeasureOutcome =
  { readonly kind: 'done'; readonly latest: CategorySuggestionEval } | { readonly kind: 'late' };

/** Owned by the card (the settings query polls while `measuring` is set); `outcome` is what the live region says. */
interface MeasureState {
  readonly measuring: Measuring | null;
  readonly outcome: MeasureOutcome | null;
}

function latestOf(
  settings: SuggestionSettings,
  choice: SuggestionModelChoice,
): CategorySuggestionEval | null {
  return settings.models.find((model) => model.choice === choice)?.latest ?? null;
}

function isNewer(latest: CategorySuggestionEval | null, since: string | null): boolean {
  if (latest === null) return false;
  if (since === null) return true;
  return new Date(latest.measuredAt).getTime() > new Date(since).getTime();
}

/**
 * Settings › Language model › **Category suggestions** (WP 11.2). When the six deterministic tiers abstain on a
 * transaction, a language model can suggest a category in the Inbox and the transaction list; nothing is filed until
 * the holder confirms it. Off until the model has been measured on the holder's own history and clears the gate
 * (85 % precision over at least 20 scored rows, the api's figures): the status line, the Enable switch's reason, and
 * the results say where it stands, in words.
 *
 * Measure queues the measurement in the worker (202) and the settings are read every 2 s until a newer result for
 * that model arrives (or 10 minutes pass), with "Measuring…" in a polite live region meanwhile. Every write asks for
 * the passkey (`useStepUpRetry`). Under a hosted narrator the separate consent (the api's text, verbatim) is shown
 * unticked until the holder ticks it.
 */
export function CategorySuggestionsCard() {
  const [measure, setMeasure] = useState<MeasureState>({ measuring: null, outcome: null });
  const query = useSuggestionSettingsQuery(measure.measuring !== null);
  // A newer result for the model being measured ends the wait (state adjusted while rendering, not in an effect).
  if (measure.measuring !== null && query.data !== undefined) {
    const latest = latestOf(query.data, measure.measuring.choice);
    if (latest !== null && isNewer(latest, measure.measuring.since)) {
      setMeasure({ measuring: null, outcome: { kind: 'done', latest } });
    }
  }

  return (
    <section
      aria-labelledby="category-suggestions-heading"
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      data-testid="category-suggestions"
    >
      <div className="flex flex-col gap-1">
        <h3 id="category-suggestions-heading" className="font-medium text-text-primary">
          Category suggestions
        </h3>
        <p className="text-small text-text-muted">
          When the categoriser cannot decide, a language model can suggest a category in the Inbox
          and the transaction list. Nothing is filed until you confirm a suggestion.
        </p>
      </div>
      {query.isLoading ? (
        <SkeletonText lines={4} />
      ) : query.data === undefined ? (
        <p className="text-small text-text-secondary">
          The category-suggestion settings cannot be read right now. Try again in a moment.
        </p>
      ) : (
        <SuggestionsBody settings={query.data} measure={measure} setMeasure={setMeasure} />
      )}
    </section>
  );
}

interface BodyProps {
  readonly settings: SuggestionSettings;
  readonly measure: MeasureState;
  readonly setMeasure: (next: MeasureState) => void;
}

function SuggestionsBody({ settings, measure, setMeasure }: BodyProps) {
  const model = chosenModel(settings);
  const latest = model?.latest ?? null;
  const on = settings.state === 'on';
  const ready = settings.state === 'ready';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p
          className="flex items-start gap-1.5 text-body font-medium text-text-primary"
          data-testid="suggestions-status"
          data-state={settings.state}
        >
          {on || ready ? (
            <CircleCheck
              size={16}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-status-success-text"
            />
          ) : (
            <CircleMinus size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          )}
          <span>{statusWords(settings)}</span>
        </p>
        <p className="text-small text-text-secondary" data-testid="suggestions-what-leaves">
          {settings.hosted.applies
            ? `What leaves this machine: the payload below, sent to ${model?.provider ?? 'the hosted provider'}, and only once you tick the consent below.`
            : 'What leaves this machine: nothing. The model runs on your own machine, reached only by the worker.'}
        </p>
      </div>

      <ModelChoice settings={settings} busy={measure.measuring !== null} />
      <Measure settings={settings} measure={measure} setMeasure={setMeasure} />
      <Results latest={latest} />
      <EnableSwitch settings={settings} />
      {settings.hosted.applies && <HostedConsent settings={settings} />}
      <PayloadApproval settings={settings} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The model choice
// ---------------------------------------------------------------------------------------------------------

function ModelChoice({ settings, busy }: { settings: SuggestionSettings; busy: boolean }) {
  const mutation = useSetSuggestionModelMutation();
  const stepUp = useStepUpRetry();
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const saving = mutation.isPending || stepUp.busy;
  // The second local model is offered only when the install has one (or it is already the choice).
  const shown = settings.models.filter(
    (entry) =>
      entry.choice === 'narrator' || entry.available || entry.choice === settings.modelChoice,
  );

  async function choose(choice: SuggestionModelChoice): Promise<void> {
    if (saving || busy || choice === settings.modelChoice) return;
    setError(null);
    try {
      await stepUp.run(() => mutation.mutateAsync({ body: { modelChoice: choice } }));
    } catch (cause) {
      setError(problemDetail(cause, 'Could not change the model. Nothing was changed.'));
    } finally {
      mutation.reset();
    }
  }

  return (
    <fieldset className="flex flex-col gap-2" data-testid="suggestions-model-choice">
      <legend className="mb-1 text-small font-medium text-text-primary">
        Which model suggests
      </legend>
      {shown.map((entry: SuggestionModel) => {
        const id = `${ids}-${entry.choice}`;
        return (
          <div key={entry.choice} className="flex items-start gap-2">
            <input
              id={id}
              type="radio"
              name={`${ids}-model`}
              className="mt-1 h-4 w-4 shrink-0"
              checked={settings.modelChoice === entry.choice}
              aria-describedby={`${id}-latest`}
              onChange={() => void choose(entry.choice)}
            />
            <div className="flex min-w-0 flex-col">
              <label htmlFor={id} className="text-small text-text-primary [overflow-wrap:anywhere]">
                {modelChoiceWords(entry)}
              </label>
              <span
                id={`${id}-latest`}
                className="text-caption text-text-muted [overflow-wrap:anywhere]"
                data-testid={`suggestions-latest-${entry.choice}`}
              >
                {entry.available
                  ? measurementSummary(entry.latest)
                  : `Not available${entry.unavailableReason === null ? '' : `: ${entry.unavailableReason}`}. ${measurementSummary(entry.latest)}`}
              </span>
            </div>
          </div>
        );
      })}
      <p className="text-caption text-text-muted">Changing the model asks for your passkey.</p>
      {(error ?? stepUp.error) !== null && (
        <p className="text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------------------------------------

function Measure({ settings, measure, setMeasure }: BodyProps) {
  const { measuring, outcome } = measure;
  const mutation = useMeasureSuggestionsMutation();
  const stepUp = useStepUpRetry();
  const refresh = useRefreshSuggestionSettings();
  const [error, setError] = useState<string | null>(null);
  const [deduped, setDeduped] = useState(false);
  const hintId = useId();
  const model = chosenModel(settings);
  const unavailable = model === undefined || !model.available;
  const starting = mutation.isPending || stepUp.busy;
  const blocked = starting || measuring !== null || unavailable;

  // A newer result ends the wait (`CategorySuggestionsCard`); so does the clock: after 10 minutes the polling stops
  // and the screen says so.
  useEffect(() => {
    if (measuring === null) return undefined;
    const timer = window.setTimeout(() => {
      setMeasure({ measuring: null, outcome: { kind: 'late' } });
    }, MEASURE_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [measuring, setMeasure]);

  async function start(): Promise<void> {
    if (blocked) return;
    setError(null);
    setMeasure({ measuring: null, outcome: null });
    const choice = settings.modelChoice;
    const since = latestOf(settings, choice)?.measuredAt ?? null;
    try {
      const queued = await stepUp.run(() =>
        mutation.mutateAsync({ body: { modelChoice: choice } }),
      );
      setDeduped(queued.deduped);
      setMeasure({ measuring: { choice: queued.modelChoice, since }, outcome: null });
      void refresh();
    } catch (cause) {
      setError(problemDetail(cause, 'The measurement could not start. Nothing was run.'));
    } finally {
      mutation.reset();
    }
  }

  const live =
    measuring !== null
      ? `Measuring… ${deduped ? 'A measurement of this model was already running; waiting for it. ' : ''}It replays your own history and can take a few minutes.`
      : starting
        ? 'Starting the measurement…'
        : outcome?.kind === 'late'
          ? 'The measurement has not reported back after 10 minutes. It may still be running; its result will show here once it does.'
          : outcome?.kind === 'done'
            ? outcome.latest.status === 'failed'
              ? `The measurement did not finish${outcome.latest.failure === null ? '' : `: ${outcome.latest.failure}`}.`
              : `Measured: ${percentWords(outcome.latest.precision)} precision, ${percentWords(outcome.latest.coverage)} coverage, ${rowsWords(outcome.latest.scored)} scored.`
            : '';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          aria-disabled={blocked}
          aria-describedby={hintId}
          className={cn(blocked && 'cursor-not-allowed')}
          onClick={() => void start()}
          data-testid="suggestions-measure"
        >
          {(measuring !== null || starting) && (
            <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />
          )}
          {measuring !== null || starting ? 'Measuring…' : 'Measure'}
        </Button>
      </div>
      <p id={hintId} className="text-caption text-text-muted">
        {unavailable
          ? `Nothing to measure: ${model?.unavailableReason ?? 'no model is available for this choice'}.`
          : 'Asks the chosen model about the transactions you have already categorised, as if they were new, and scores its answers against your own picks. Writes one result and nothing else; it can take a few minutes. Asks for your passkey.'}
      </p>
      {(error ?? stepUp.error) !== null && (
        <p className="text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
      <p
        role="status"
        aria-live="polite"
        className="text-small font-medium text-text-primary empty:hidden"
        data-testid="suggestions-measure-live"
      >
        {live}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The results
// ---------------------------------------------------------------------------------------------------------

const TOP_CONFUSIONS = 5;

function Results({ latest }: { latest: CategorySuggestionEval | null }) {
  const { categories } = useCategories();
  const labels = useMemo(
    () => new Map(categories.map((category) => [category.key, category.label])),
    [categories],
  );
  if (latest === null) {
    return (
      <p className="text-small text-text-secondary" data-testid="suggestions-results">
        No measurement yet for this model.
      </p>
    );
  }
  if (latest.status === 'failed') {
    return (
      <p className="text-small text-text-secondary" data-testid="suggestions-results">
        The last measurement ({formatDate(latest.measuredAt)}) did not finish
        {latest.failure === null ? '' : `: ${latest.failure}`}.
      </p>
    );
  }
  const confusions = [...latest.confusions]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CONFUSIONS);
  return (
    <div className="flex flex-col gap-2" data-testid="suggestions-results">
      <h4 className="text-small font-medium text-text-primary">
        Last measurement, {formatDate(latest.measuredAt)}
      </h4>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-small [overflow-wrap:anywhere]">
        <dt className="text-text-muted">Precision</dt>
        <dd className="text-text-primary" data-testid="suggestions-precision">
          {percentWords(latest.precision)}{' '}
          <span className="text-text-muted">
            ({String(latest.correct)} right of {String(latest.scored)} scored)
          </span>
        </dd>
        <dt className="text-text-muted">Coverage</dt>
        <dd className="text-text-primary" data-testid="suggestions-coverage">
          {percentWords(latest.coverage)}{' '}
          <span className="text-text-muted">
            (answered {String(latest.scored)} of {String(latest.asked)} asked)
          </span>
        </dd>
        <dt className="text-text-muted">Scored rows</dt>
        <dd className="text-text-primary" data-testid="suggestions-scored">
          {String(latest.scored)}
        </dd>
        <dt className="text-text-muted">Declined</dt>
        <dd className="text-text-primary">
          {String(latest.abstained)} abstained, {String(latest.refused)} refused by the validator
        </dd>
        <dt className="text-text-muted">Model</dt>
        <dd className="break-all font-mono text-caption text-text-secondary">{latest.model}</dd>
      </dl>
      {confusions.length === 0 ? (
        <p className="text-small text-text-secondary">No mix-ups in this measurement.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <h5 className="text-small font-medium text-text-primary" id="suggestions-confusions">
            Most common mix-ups (yours → the model&apos;s)
          </h5>
          <ul
            aria-labelledby="suggestions-confusions"
            className="flex flex-col gap-0.5 text-small text-text-secondary"
            data-testid="suggestions-confusions"
          >
            {confusions.map((entry) => (
              <li key={`${entry.expected}->${entry.got}`} className="[overflow-wrap:anywhere]">
                {categoryWords(entry.expected, labels)} → {categoryWords(entry.got, labels)}:{' '}
                {entry.count === 1 ? 'once' : `${String(entry.count)} times`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Enable
// ---------------------------------------------------------------------------------------------------------

function EnableSwitch({ settings }: { settings: SuggestionSettings }) {
  const mutation = useSetSuggestionsEnabledMutation();
  const stepUp = useStepUpRetry();
  const refresh = useRefreshSuggestionSettings();
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const labelId = useId();
  const whyId = useId();
  const model = chosenModel(settings);
  const canTurnOn = settings.gate.open && model?.available === true;
  // Turning it off is always allowed; turning it on only past the gate.
  const usable = settings.enabled || canTurnOn;
  const busy = mutation.isPending || stepUp.busy;

  async function toggle(next: boolean): Promise<void> {
    if (busy) return;
    setError(null);
    setSaid(null);
    try {
      await stepUp.run(() => mutation.mutateAsync({ body: { enabled: next } }));
      setSaid(
        next
          ? 'Category suggestions are on.'
          : 'Category suggestions are off. No suggestion is shown.',
      );
    } catch (cause) {
      const code = problemCode(cause);
      setError(
        problemDetail(
          cause,
          next ? 'Could not turn category suggestions on.' : 'Could not turn them off.',
        ),
      );
      if (
        code === 'categorization.suggestions_below_gate' ||
        code === 'categorization.suggestion_model_unavailable'
      ) {
        void refresh();
      }
    } finally {
      mutation.reset();
    }
  }

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-bg-subtle p-3"
      data-testid="suggestions-enable"
    >
      <div className="flex items-center gap-3">
        <Switch
          checked={settings.enabled}
          disabled={!usable}
          className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
          aria-labelledby={labelId}
          aria-describedby={whyId}
          onCheckedChange={(checked: boolean) => void toggle(checked)}
          data-testid="suggestions-enable-switch"
        />
        <span id={labelId} className="text-small font-medium text-text-primary">
          Show category suggestions
        </span>
      </div>
      <p
        id={whyId}
        className="text-caption text-text-secondary"
        data-testid="suggestions-enable-why"
      >
        {enableWords(settings)} Turning it on or off asks for your passkey.
      </p>
      {(error ?? stepUp.error) !== null && (
        <p className="text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
      <p role="status" className="text-small text-text-primary empty:hidden">
        {said}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The hosted consent (only when the narrator is on a hosted provider)
// ---------------------------------------------------------------------------------------------------------

function HostedConsent({ settings }: { settings: SuggestionSettings }) {
  const mutation = useSetSuggestionConsentMutation();
  const stepUp = useStepUpRetry();
  const refresh = useRefreshSuggestionSettings();
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const busy = mutation.isPending || stepUp.busy;
  const hosted = settings.hosted;

  async function toggle(next: boolean): Promise<void> {
    if (busy) return;
    setError(null);
    try {
      await stepUp.run(() =>
        mutation.mutateAsync({
          body: next
            ? { consent: true, consentTextSha256: hosted.consentTextSha256 }
            : { consent: false },
        }),
      );
    } catch (cause) {
      setError(
        problemDetail(
          cause,
          next ? 'Could not record the consent.' : 'Could not withdraw the consent.',
        ),
      );
      if (problemCode(cause) === 'categorization.consent_text_changed') void refresh();
    } finally {
      mutation.reset();
      boxRef.current?.focus();
    }
  }

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-bg-subtle p-3"
      data-testid="suggestions-consent"
    >
      <div className="flex items-start gap-2">
        <input
          ref={boxRef}
          id={inputId}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={hosted.consented}
          aria-describedby={`${inputId}-hint`}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <label htmlFor={inputId} className="text-small text-text-primary [overflow-wrap:anywhere]">
          {hosted.consentText}
        </label>
      </div>
      <p id={`${inputId}-hint`} className="ml-6 text-caption text-text-muted">
        {hosted.consented
          ? 'Ticked. Unticking withdraws it, and the hosted model is not asked again.'
          : 'Not ticked: the hosted model is not asked about your transactions until it is.'}{' '}
        Ticking or unticking asks for your passkey.
      </p>
      {(error ?? stepUp.error) !== null && (
        <p className="ml-6 text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The payload preview and its approval
// ---------------------------------------------------------------------------------------------------------

function PayloadApproval({ settings }: { settings: SuggestionSettings }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const preview = useSuggestionPreviewQuery(open);
  const mutation = useApproveSuggestionPayloadMutation();
  const stepUp = useStepUpRetry();
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const data = preview.data;
  const approved = data?.approved ?? settings.approval.approved;
  const busy = mutation.isPending || stepUp.busy;

  async function approve(queryShape: string): Promise<void> {
    if (busy) return;
    setError(null);
    setSaid(null);
    try {
      await stepUp.run(() => mutation.mutateAsync({ body: { queryShape } }));
      setSaid('Approved. Suggestions may now be asked for with this payload shape.');
    } catch (cause) {
      setError(
        problemCode(cause) === 'insights.shape_changed'
          ? 'The payload changed since it was shown. Read it again below, then approve it.'
          : problemDetail(cause, 'The payload could not be approved.'),
      );
    } finally {
      mutation.reset();
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="suggestions-approval">
      <h4 className="text-small font-medium text-text-primary">The payload</h4>
      <p className="text-small text-text-secondary" data-testid="suggestions-approval-status">
        {approved
          ? 'Approved: suggestions are asked for with exactly this payload shape.'
          : 'Not approved yet: no suggestion is asked for until you read the payload and approve it.'}
      </p>
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          className="-ml-3 gap-1"
          onClick={() => setOpen((was) => !was)}
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={cn('shrink-0', open && 'rotate-90')}
          />
          Show exactly what a run would send
        </Button>
      </div>
      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-3 rounded-md border border-border-hairline p-3"
        >
          {preview.isLoading ? (
            <SkeletonText lines={3} />
          ) : data === undefined ? (
            <p className="text-small text-text-secondary">
              {problemDetail(preview.error, 'The payload cannot be shown right now.')}
            </p>
          ) : (
            <>
              <p className="text-caption text-text-muted">
                What a run would send now, built from the transactions the categoriser could not
                decide. Showing it sends nothing.
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption [overflow-wrap:anywhere]">
                <dt className="text-text-muted">Model</dt>
                <dd className="break-all font-mono text-text-secondary">
                  {data.provider} · {data.model}
                </dd>
                <dt className="text-text-muted">Query shape</dt>
                <dd className="break-all font-mono text-text-secondary">{data.queryShape}</dd>
                <dt className="text-text-muted">Prompt hash</dt>
                <dd className="break-all font-mono text-text-secondary">{data.prompt.hash}</dd>
              </dl>
              <ScrollRegion label="The prompt" className="max-h-80 overflow-y-auto">
                <pre
                  className="whitespace-pre-wrap p-2 text-caption text-text-secondary [overflow-wrap:anywhere]"
                  data-testid="suggestions-prompt"
                >
                  {data.prompt.text}
                </pre>
              </ScrollRegion>
              {data.approved ? (
                <Badge variant="success" icon={<CircleCheck size={12} aria-hidden="true" />}>
                  Approved for this payload shape
                </Badge>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    aria-disabled={busy}
                    onClick={() => void approve(data.queryShape)}
                    data-testid="suggestions-approve"
                  >
                    {busy ? 'Approving…' : 'Approve this payload'}
                  </Button>
                  <span className="text-caption text-text-muted">Asks for your passkey.</span>
                </div>
              )}
            </>
          )}
          {(error ?? stepUp.error) !== null && (
            <p className="text-small text-status-danger-text" role="alert">
              {error ?? stepUp.error}
            </p>
          )}
          <p role="status" className="text-small text-text-primary empty:hidden">
            {said}
          </p>
        </div>
      )}
    </div>
  );
}
