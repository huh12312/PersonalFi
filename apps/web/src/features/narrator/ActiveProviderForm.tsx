// SPDX-License-Identifier: MIT
import { CircleCheck, CircleOff, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { ApprovalsWithdrawn } from './ApprovalsWithdrawn.tsx';
import {
  NARRATOR_PROVIDERS,
  problemDetail,
  useSetActiveProviderMutation,
  type NarratorChoice,
  type NarratorSettings,
} from './narrator-api.ts';
import { activeSentence, choiceBlocker, choiceLabel } from './narrator-words.ts';

const CHOICES: readonly NarratorChoice[] = [...NARRATOR_PROVIDERS, 'off'];

/** What narrates now, in words, with a glyph beside it - never colour alone. */
export function ActiveSentence({ settings }: { settings: NarratorSettings }) {
  const off = settings.activeProvider === 'off';
  const ready = !off && settings.active.ready;
  const Icon = off ? CircleOff : ready ? CircleCheck : TriangleAlert;
  return (
    <p
      className="flex items-start gap-2 text-small font-medium text-text-primary"
      data-testid="narrator-active"
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={ready ? 'mt-0.5 shrink-0 text-status-success-text' : 'mt-0.5 shrink-0'}
      />
      {activeSentence(settings)}
    </p>
  );
}

/**
 * The narrator's provider as one radio group - Ollama (local), OpenAI, OpenRouter, Anthropic, Off - and **Use
 * this provider**, behind the step-up. A hosted provider cannot be chosen until its consent is ticked and it has
 * a key; the local model until one is configured. A blocked choice is disabled and says why beside it. The api's
 * own 409s (`narrator.consent_required`, `narrator.key_required`, `narrator.not_configured`) are shown in its words.
 */
export function ActiveProviderForm({ settings }: { settings: NarratorSettings }) {
  // The holder's pick, until saved; `null` follows the api (a consent withdrawal can turn the narrator off).
  const [picked, setPicked] = useState<NarratorChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ revoked: number } | null>(null);
  const mutation = useSetActiveProviderMutation();
  const stepUp = useStepUpRetry();
  const saving = mutation.isPending || stepUp.busy;
  const groupRef = useRef<HTMLFieldSetElement>(null);
  // The radios and the button are disabled while a save runs, and the button stays disabled once the choice is
  // the saved one, so focus would fall to the document body (2.4.3). The saved choice, once a save settles: focus moves to its radio after the commit that shows the saved
  // settings with the radios enabled again (the query's re-render can land a commit after the mutation's).
  const refocus = useRef<NarratorChoice | null>(null);
  useEffect(() => {
    const target = refocus.current;
    if (target === null || saving || settings.activeProvider !== target) return;
    refocus.current = null;
    groupRef.current
      ?.querySelector<HTMLInputElement>(`#narrator-choice-${target}:not(:disabled)`)
      ?.focus();
  });

  const choice = picked ?? settings.activeProvider;
  const blocker = choiceBlocker(choice, settings.providers);
  const unchanged = choice === settings.activeProvider;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (blocker !== null) {
      setError(blocker);
      return;
    }
    try {
      const response = await stepUp.run(() =>
        mutation.mutateAsync({ body: { activeProvider: choice } }),
      );
      setPicked(null);
      setResult({ revoked: response.approvalsRevoked });
      refocus.current = response.activeProvider;
    } catch (cause) {
      setError(problemDetail(cause, 'Could not change the narrator. Nothing was changed.'));
    } finally {
      mutation.reset();
    }
  }

  const failure = error ?? stepUp.error;

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      aria-labelledby="narrator-choice-legend"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="narrator-active-form"
    >
      <ActiveSentence settings={settings} />
      <fieldset ref={groupRef} className="flex flex-col gap-2">
        <legend
          id="narrator-choice-legend"
          className="mb-1 text-small font-medium text-text-secondary"
        >
          Which language model words the Brief
        </legend>
        {CHOICES.map((option) => {
          const optionBlocker = choiceBlocker(option, settings.providers);
          const inputId = `narrator-choice-${option}`;
          const whyId = `${inputId}-why`;
          return (
            <div key={option} className="flex flex-col gap-0.5">
              <label
                htmlFor={inputId}
                className="flex items-center gap-2 text-small text-text-primary"
              >
                <input
                  id={inputId}
                  type="radio"
                  name="narrator-choice"
                  value={option}
                  checked={choice === option}
                  disabled={optionBlocker !== null || saving}
                  aria-describedby={optionBlocker === null ? undefined : whyId}
                  onChange={() => {
                    setPicked(option);
                    setError(null);
                    setResult(null);
                  }}
                />
                {choiceLabel(option)}
                {option === settings.activeProvider && (
                  <span className="text-caption text-text-muted">(in use)</span>
                )}
              </label>
              {optionBlocker !== null && (
                <p id={whyId} className="ml-6 text-caption text-text-muted">
                  {optionBlocker}
                </p>
              )}
              {option === 'off' && (
                <p className="ml-6 text-caption text-text-muted">
                  Nothing is narrated; the Brief shows its own wording.
                </p>
              )}
            </div>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving || unchanged || blocker !== null}>
          {saving ? 'Saving…' : 'Use this provider'}
        </Button>
        <span className="text-caption text-text-muted">Changing it asks for your passkey.</span>
      </div>
      {failure !== null && (
        <p className="text-small text-status-danger-text" role="alert">
          {failure}
        </p>
      )}
      <div role="status" className="flex flex-col gap-1 text-small text-text-primary">
        {result !== null && (
          <>
            <span>Saved. {activeSentence(settings)}</span>
            {result.revoked > 0 && <ApprovalsWithdrawn settings={settings} />}
          </>
        )}
      </div>
    </form>
  );
}
