// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import {
  getAdvisorSettingsOptions,
  getAdvisorSettingsQueryKey,
  setAdvisorSettingsMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { AdvisorSettings } from '../../api/generated/types.gen.ts';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { problemCode, problemDetail } from '../narrator/narrator-api.ts';
import { CONSENT_TICKED_WORDS, CONSENT_UNTICKED_WORDS } from '../advisor/advisor-words.ts';

type HostedProvider = NonNullable<AdvisorSettings['hostedProvider']>;

const PROVIDERS: ReadonlyArray<{ readonly value: HostedProvider; readonly label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'anthropic', label: 'Anthropic' },
];

/**
 * Advisor management: "Advisor sessions on a hosted provider" (WP 11.5d, D31). The advisor runs on the local model
 * unless this is ticked. The text is the api's own, shown verbatim beside the tick-box with its version; ticking
 * names that text's sha256, so a reworded consent is never covered by an old tick (409
 * `insights.advisor_consent_changed` re-reads the text). Every write needs a fresh session (the passkey step-up).
 * Unticked is the default and says so in words.
 */
export function AdvisorHostedConsentCard() {
  const queryClient = useQueryClient();
  const query = useQuery({ ...getAdvisorSettingsOptions(), retry: false });
  const mutation = useMutation({ ...setAdvisorSettingsMutation(), gcTime: 0 });
  const stepUp = useStepUpRetry();
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const settings = query.data;
  const busy = mutation.isPending || stepUp.busy;

  function apply(next: AdvisorSettings): void {
    queryClient.setQueryData(getAdvisorSettingsQueryKey(), next);
  }

  async function write(
    body: {
      hostedConsent?: boolean;
      consentTextSha256?: string;
      hostedProvider?: HostedProvider | null;
    },
    done: string,
    failed: string,
  ): Promise<void> {
    if (busy) return;
    setError(null);
    setSaid(null);
    try {
      const next = await stepUp.run(() => mutation.mutateAsync({ body }));
      apply(next);
      setSaid(done);
    } catch (cause) {
      setError(problemDetail(cause, failed));
      if (problemCode(cause) === 'insights.advisor_consent_changed') {
        await queryClient.invalidateQueries({ queryKey: getAdvisorSettingsQueryKey() });
      }
    } finally {
      mutation.reset();
    }
  }

  async function toggle(next: boolean, current: AdvisorSettings): Promise<void> {
    await write(
      next
        ? { hostedConsent: true, consentTextSha256: current.consent.sha256 }
        : { hostedConsent: false },
      next
        ? 'Recorded. Advisor sessions may now run on the hosted provider.'
        : 'Withdrawn. Advisor sessions run on the local model.',
      next ? 'Could not record the consent.' : 'Could not withdraw the consent.',
    );
    boxRef.current?.focus();
  }

  if (query.isLoading) return <SkeletonText lines={3} />;
  if (settings === undefined) {
    return (
      <p role="alert" className="text-small text-text-secondary">
        Could not load the advisor&apos;s hosted consent.
      </p>
    );
  }

  const providerId = `${id}-provider`;
  const boxId = `${id}-box`;
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3 rounded-md border border-border-hairline bg-bg-surface p-4"
      data-testid="advisor-consent"
    >
      <div>
        <h3 id={`${id}-heading`} className="text-h3 text-text-primary">
          Advisor sessions on a hosted provider
        </h3>
        <p className="mt-1 text-small text-text-secondary" data-testid="advisor-consent-default">
          Unticked, the advisor runs on the local model, and nothing about a session leaves this
          machine.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md bg-bg-subtle p-3">
        <div className="flex items-start gap-2">
          <input
            ref={boxRef}
            id={boxId}
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={settings.hostedConsented}
            aria-describedby={`${boxId}-hint`}
            aria-disabled={busy ? 'true' : undefined}
            onChange={(event) => void toggle(event.target.checked, settings)}
            data-testid="advisor-consent-box"
          />
          <label
            htmlFor={boxId}
            className="text-small text-text-primary [overflow-wrap:anywhere]"
            data-testid="advisor-consent-text"
          >
            {settings.consent.text}
          </label>
        </div>
        <p id={`${boxId}-hint`} className="ml-6 text-caption text-text-muted">
          {settings.hostedConsented ? CONSENT_TICKED_WORDS : CONSENT_UNTICKED_WORDS} Ticking or
          unticking asks for your passkey.
        </p>
        <p className="ml-6 text-caption text-text-muted" data-testid="advisor-consent-version">
          Consent text version {settings.consent.version}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={providerId} className="text-small font-medium text-text-secondary">
          Hosted provider for the advisor
        </label>
        <select
          id={providerId}
          className="h-10 w-full max-w-sm rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary focus-visible:outline-none"
          value={settings.hostedProvider ?? ''}
          disabled={busy}
          aria-describedby={`${providerId}-hint`}
          onChange={(event) => {
            const value = event.target.value;
            void write(
              { hostedProvider: value === '' ? null : (value as HostedProvider) },
              'Provider saved.',
              'Could not save the provider.',
            );
          }}
          data-testid="advisor-consent-provider"
        >
          <option value="">Same as the narrator</option>
          {PROVIDERS.map((provider) => (
            <option key={provider.value} value={provider.value}>
              {provider.label}
            </option>
          ))}
        </select>
        <p id={`${providerId}-hint`} className="text-caption text-text-muted">
          A hosted provider also needs its own consent and key under Settings, Language model.
        </p>
      </div>

      <p role="status" className="text-small text-text-primary empty:hidden">
        {said}
      </p>
      {(error ?? stepUp.error) !== null && (
        <p className="text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
    </section>
  );
}
