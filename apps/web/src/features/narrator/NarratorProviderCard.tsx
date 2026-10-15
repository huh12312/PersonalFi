// SPDX-License-Identifier: MIT
import { Bot, CircleCheck, Cloud, Server, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { ApprovalsWithdrawn } from './ApprovalsWithdrawn.tsx';
import { NarratorKeyField } from './NarratorKeyField.tsx';
import {
  DIGEST_PATTERN,
  MODEL_ID_PATTERN,
  problemCode,
  problemDetail,
  useClearOllamaEndpointMutation,
  useGiveConsentMutation,
  useSetModelMutation,
  useSetOllamaEndpointMutation,
  useTestProviderMutation,
  useWithdrawConsentMutation,
  type HostedNarratorProvider,
  type NarratorProviderState,
  type NarratorSettings,
} from './narrator-api.ts';
import { formatDate, notReadyWords, providerName } from './narrator-words.ts';

// ---------------------------------------------------------------------------------------------------------
// Consent (hosted only)
// ---------------------------------------------------------------------------------------------------------

/**
 * The consent a hosted provider needs before it can be made active. The label is the api's `consent.text`,
 * exactly - what the holder ticks is what `narrator_provider_consents` records the sha256 of. Ticking sends
 * `consentVersion` (`PUT`), unticking withdraws (`DELETE`); both ask for the passkey. The box shows the api's
 * state, not the click: a cancelled step-up leaves it as it was.
 */
function ConsentField({
  settings,
  state,
}: {
  settings: NarratorSettings;
  state: NarratorProviderState & { provider: HostedNarratorProvider };
}) {
  const provider = state.provider;
  const name = providerName(provider);
  const consent = state.consent;
  const inputId = `narrator-consent-${provider}`;
  const give = useGiveConsentMutation();
  const withdraw = useWithdrawConsentMutation();
  const stepUp = useStepUpRetry();
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  // Bumped when a toggle settles; the effect runs after the commit that re-enabled the box.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) boxRef.current?.focus();
  }, [refocus]);
  const busy = give.isPending || withdraw.isPending || stepUp.busy;

  if (consent === null) return null;
  const active = settings.activeProvider === provider;

  async function toggle(next: boolean): Promise<void> {
    setError(null);
    setSaid(null);
    try {
      if (next) {
        await stepUp.run(() =>
          give.mutateAsync({
            path: { provider },
            body: { consentVersion: settings.consentVersion },
          }),
        );
        setSaid(`Consent recorded. ${name} can now be made the narrator once it has a key.`);
      } else {
        const after = await stepUp.run(() => withdraw.mutateAsync({ path: { provider } }));
        setSaid(
          active && after.activeProvider === 'off'
            ? `Consent withdrawn. The narrator is now off: the Brief shows its own wording.`
            : `Consent withdrawn. Nothing is sent to ${name}.`,
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
      // Disabled while the request ran: focus goes back to the box, not the document body (2.4.3).
      setRefocus((n) => n + 1);
    }
  }

  const failure = error ?? stepUp.error;

  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-bg-subtle p-3">
      <div className="flex items-start gap-2">
        <input
          ref={boxRef}
          id={inputId}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={consent.given}
          disabled={busy}
          aria-describedby={`${inputId}-hint`}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <label htmlFor={inputId} className="text-small text-text-primary">
          {consent.text}
        </label>
      </div>
      <p id={`${inputId}-hint`} className="ml-6 text-caption text-text-muted">
        {consent.given
          ? `Ticked${consent.consentedAt === null ? '' : ` ${formatDate(consent.consentedAt)}`}. Unticking withdraws it${active ? ' and turns the narrator off' : ''}.`
          : `Not ticked: ${name} cannot be made the narrator until it is.`}{' '}
        Ticking or unticking asks for your passkey.
      </p>
      {failure !== null && (
        <p className="ml-6 text-small text-status-critical" role="alert">
          {failure}
        </p>
      )}
      <p className="ml-6 text-small text-text-primary" role="status">
        {said}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Model id (hosted)
// ---------------------------------------------------------------------------------------------------------

function HostedModelField({
  settings,
  state,
}: {
  settings: NarratorSettings;
  state: NarratorProviderState & { provider: HostedNarratorProvider };
}) {
  const provider = state.provider;
  const name = providerName(provider);
  const inputId = `narrator-model-${provider}`;
  const model = state.model;
  const [value, setValue] = useState(model.source === 'settings' ? (model.value ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ words: string; revoked: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useSetModelMutation();
  const stepUp = useStepUpRetry();
  const saving = mutation.isPending || stepUp.busy;

  async function send(next: string | null): Promise<void> {
    setError(null);
    setResult(null);
    if (next !== null && !MODEL_ID_PATTERN.test(next)) {
      setError(
        'A model id starts with a letter or digit and is letters, digits and . _ : / @ - only. Nothing was sent.',
      );
      return;
    }
    try {
      const response = await stepUp.run(() =>
        mutation.mutateAsync({ path: { provider }, body: { model: next } }),
      );
      const now = response.providers.find((p) => p.provider === provider)?.model.value ?? next;
      setValue(next ?? '');
      setResult({
        words:
          next === null
            ? `Saved. ${name} uses its default, ${now ?? 'the default'}.`
            : `Saved. ${name} uses ${now ?? next}.`,
        revoked: response.approvalsRevoked,
      });
    } catch (cause) {
      setError(problemDetail(cause, 'Could not save the model. Nothing was changed.'));
    } finally {
      mutation.reset();
      inputRef.current?.focus();
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = value.trim();
    void send(trimmed === '' ? null : trimmed);
  }

  return (
    <form className="flex flex-col gap-2" aria-label={`${name} model`} onSubmit={handleSubmit}>
      <Label htmlFor={inputId}>Model id</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          className="max-w-sm font-mono"
          value={value}
          placeholder={model.default ?? undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setResult(null);
          }}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={`${inputId}-hint`}
        />
        <Button type="submit" variant="secondary" disabled={saving}>
          {saving ? 'Saving…' : 'Save model'}
        </Button>
        {model.source === 'settings' && (
          <Button type="button" variant="ghost" disabled={saving} onClick={() => void send(null)}>
            Use the default
          </Button>
        )}
      </div>
      <p id={`${inputId}-hint`} className="text-caption text-text-muted">
        In use: <span className="font-mono">{model.value ?? 'none'}</span>
        {model.source === 'default' ? ' (the default)' : ' (your choice)'}. Leave empty for the
        default, <span className="font-mono">{model.default}</span>. Saving asks for your passkey.
      </p>
      {(error ?? stepUp.error) !== null && (
        <p className="text-small text-status-critical" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
      <div role="status" className="flex flex-col gap-1 text-small text-text-primary">
        {result !== null && (
          <>
            <span>{result.words}</span>
            {result.revoked > 0 && <ApprovalsWithdrawn settings={settings} />}
          </>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The local model (Ollama)
// ---------------------------------------------------------------------------------------------------------

function OllamaModelField({
  settings,
  state,
}: {
  settings: NarratorSettings;
  state: NarratorProviderState;
}) {
  const endpoint = state.endpoint;
  const locked = state.model.locked || endpoint?.locked === true;
  const [values, setValues] = useState({
    endpoint: endpoint?.value ?? '',
    model: state.model.source === 'settings' ? (state.model.value ?? '') : '',
    digest: state.model.source === 'settings' ? (endpoint?.digest ?? '') : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ words: string; revoked: number } | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const save = useSetOllamaEndpointMutation();
  const clear = useClearOllamaEndpointMutation();
  const stepUp = useStepUpRetry();
  const busy = save.isPending || clear.isPending || stepUp.busy;
  const ids = useId();

  if (locked) {
    return (
      <div className="flex flex-col gap-1" data-testid="narrator-ollama-locked">
        <p className="text-small text-text-primary">
          Model <span className="font-mono">{state.model.value ?? 'unknown'}</span>
          {endpoint?.digest != null && (
            <>
              {' '}
              · digest <span className="break-all font-mono">{endpoint.digest}</span>
            </>
          )}
        </p>
        <p className="text-caption text-text-muted">
          Pinned by the operator&apos;s environment: the endpoint, model and digest can only be
          changed where the install is run.
        </p>
      </div>
    );
  }

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setResult(null);
    const body = {
      endpoint: values.endpoint.trim(),
      model: values.model.trim(),
      digest: values.digest.trim(),
    };
    if (body.endpoint === '') {
      setError('Give the endpoint, for example http://ollama:11434. Nothing was sent.');
      return;
    }
    if (!MODEL_ID_PATTERN.test(body.model)) {
      setError(
        'A model name starts with a letter or digit and is letters, digits and . _ : / @ - only. Nothing was sent.',
      );
      return;
    }
    if (!DIGEST_PATTERN.test(body.digest)) {
      setError('The digest is sha256: followed by 64 lowercase hex characters. Nothing was sent.');
      return;
    }
    try {
      const response = await stepUp.run(() => save.mutateAsync({ body }));
      setResult({
        words: `Saved. The worker checks that ${body.model} serves this digest before every narration.`,
        revoked: response.approvalsRevoked,
      });
    } catch (cause) {
      setError(problemDetail(cause, 'Could not save the local model. Nothing was changed.'));
    } finally {
      save.reset();
      firstRef.current?.focus();
    }
  }

  async function handleClear(): Promise<void> {
    setError(null);
    setResult(null);
    try {
      const response = await stepUp.run(() => clear.mutateAsync({}));
      setValues({ endpoint: '', model: '', digest: '' });
      setResult({
        words: 'Cleared. No local model is set here.',
        revoked: response.approvalsRevoked,
      });
    } catch (cause) {
      setError(problemDetail(cause, 'Could not clear the local model.'));
    } finally {
      clear.reset();
      firstRef.current?.focus();
    }
  }

  const field = (key: 'endpoint' | 'model' | 'digest', label: string, placeholder: string) => {
    const id = `${ids}-${key}`;
    return (
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <Input
          ref={key === 'endpoint' ? firstRef : undefined}
          id={id}
          className="max-w-md font-mono"
          value={values[key]}
          placeholder={placeholder}
          onChange={(event) => {
            setValues((prev) => ({ ...prev, [key]: event.target.value }));
            setResult(null);
          }}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
    );
  };

  return (
    <form
      className="flex flex-col gap-2"
      aria-label="Local model"
      onSubmit={(event) => void handleSave(event)}
    >
      {field('endpoint', 'Endpoint', 'http://ollama:11434')}
      {field('model', 'Model name', 'qwen2.5:7b-instruct-q4_K_M')}
      {field('digest', 'Model digest', 'sha256:…')}
      <p className="text-caption text-text-muted">
        The endpoint must be this install&apos;s own network (loopback or a compose service name).
        The digest pins the exact model: <span className="font-mono">ollama show --modelfile</span>{' '}
        prints it. Saving asks for your passkey.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" disabled={busy}>
          {save.isPending ? 'Saving…' : 'Save local model'}
        </Button>
        {state.model.source === 'settings' && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void handleClear()}>
            Clear
          </Button>
        )}
      </div>
      {(error ?? stepUp.error) !== null && (
        <p className="text-small text-status-critical" role="alert">
          {error ?? stepUp.error}
        </p>
      )}
      <div role="status" className="flex flex-col gap-1 text-small text-text-primary">
        {result !== null && (
          <>
            <span>{result.words}</span>
            {result.revoked > 0 && <ApprovalsWithdrawn settings={settings} />}
          </>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------------------------------------

/**
 * **Test**: the api's fixed, personal-data-free probe (hosted) or a configuration check (local). The result is the
 * api's `message`, verbatim - the round trip in words - in a polite live region, so it is announced without moving
 * focus. The api allows one per provider per 20 s; its 409 is said as a sentence in the same region.
 */
function TestProvider({ state }: { state: NarratorProviderState }) {
  const provider = state.provider;
  const name = providerName(provider);
  const mutation = useTestProviderMutation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  // The button is disabled while the test runs; once the commit re-enables it, focus goes back to it (2.4.3).
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) buttonRef.current?.focus();
  }, [refocus]);

  async function run(): Promise<void> {
    setOutcome(null);
    try {
      const result = await mutation.mutateAsync({ path: { provider } });
      setOutcome({ ok: result.ok, message: result.message });
    } catch (cause) {
      setOutcome({
        ok: false,
        message:
          problemCode(cause) === 'narrator.test_too_soon'
            ? `Tested a moment ago. ${problemDetail(cause, 'Try again in a few seconds.')}`
            : problemDetail(cause, `Could not run the test for ${name}.`),
      });
    } finally {
      mutation.reset();
      setRefocus((n) => n + 1);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={buttonRef}
          type="button"
          variant="secondary"
          disabled={mutation.isPending}
          onClick={() => void run()}
        >
          {mutation.isPending ? 'Testing…' : `Test ${name}`}
        </Button>
        <span className="text-caption text-text-muted">
          {provider === 'ollama'
            ? 'Checks the configuration; only the worker can reach the model.'
            : 'Sends a fixed probe with nothing personal in it, using your key.'}
        </span>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="flex items-start gap-1.5 text-small text-text-primary"
        data-testid={`narrator-test-${provider}`}
      >
        {outcome !== null && (
          <>
            {outcome.ok ? (
              <CircleCheck
                size={14}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-status-good"
              />
            ) : (
              <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            )}
            <span>
              <strong className="font-medium">
                {outcome.ok ? 'Test passed.' : 'Test did not pass.'}
              </strong>{' '}
              {outcome.message}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------------

export interface NarratorProviderCardProps {
  readonly settings: NarratorSettings;
  readonly state: NarratorProviderState;
}

/**
 * One provider (WP 10.6): whether it could narrate now and why not, in words; where it talks to; its consent
 * (hosted); its key (an optional bearer token for Ollama); its model; and Test.
 */
export function NarratorProviderCard({ settings, state }: NarratorProviderCardProps) {
  const provider = state.provider;
  const headingId = `narrator-card-${provider}-heading`;
  const active = settings.activeProvider === provider;
  const hosted = state.kind === 'hosted' && provider !== 'ollama';

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      data-testid={`narrator-card-${provider}`}
    >
      <div className="flex flex-col gap-1">
        <h3
          id={headingId}
          className="flex flex-wrap items-center gap-2 font-medium text-text-primary"
        >
          {hosted ? (
            <Cloud size={16} aria-hidden="true" />
          ) : (
            <Server size={16} aria-hidden="true" />
          )}
          {state.displayName}
          {active && (
            <Badge variant="accent" icon={<Bot size={12} aria-hidden="true" />}>
              In use
            </Badge>
          )}
        </h3>
        <p className="text-small text-text-secondary">
          {state.host !== null
            ? `Talks only to ${state.host}.`
            : 'Runs on a machine you control: only the worker talks to it, never this server.'}
        </p>
        <p className="flex items-start gap-1.5 text-small text-text-primary">
          {state.ready ? (
            <CircleCheck
              size={14}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-status-good"
            />
          ) : (
            <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          )}
          {state.ready
            ? 'Ready to narrate.'
            : `Not ready: ${notReadyWords(provider, state.notReady ?? 'not_configured')}.`}
        </p>
      </div>

      {hosted && <ConsentField settings={settings} state={{ ...state, provider }} />}
      <NarratorKeyField state={state} />
      {hosted ? (
        <HostedModelField settings={settings} state={{ ...state, provider }} />
      ) : (
        <OllamaModelField settings={settings} state={state} />
      )}
      <TestProvider state={state} />
    </section>
  );
}
