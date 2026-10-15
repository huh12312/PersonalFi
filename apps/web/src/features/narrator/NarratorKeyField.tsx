// SPDX-License-Identifier: MIT
import { ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import {
  NARRATOR_KEY_PATTERN,
  problemDetail,
  useRemoveNarratorKeyMutation,
  useSaveNarratorKeyMutation,
  type NarratorProviderState,
} from './narrator-api.ts';
import { formatDate, providerName } from './narrator-words.ts';

/**
 * Where the key comes from, in words. Every field is named explicitly - nothing is spread from the wire - so the
 * only thing about a stored key that can reach the screen is `key.hint`, its last four characters.
 */
function KeyStatus({ state }: { state: NarratorProviderState }) {
  const key = state.key;
  const local = state.provider === 'ollama';
  if (key.source === 'file') {
    return (
      <p className="text-small text-text-primary">
        Set by the operator&apos;s secret file.{' '}
        <span className="text-text-secondary">
          It takes precedence, and can only be changed where the install is run.
        </span>
      </p>
    );
  }
  if (key.source === 'stored') {
    return (
      <p className="text-small text-text-primary">
        {local ? 'Bearer token stored' : 'Stored'} in this install
        {key.storedAt !== null && <> since {formatDate(key.storedAt)}</>}
        {key.hint !== null && (
          <>
            {' '}
            · ends in <span className="font-mono">{key.hint}</span>
          </>
        )}
        {key.rotatedAt !== null && <> · replaced {formatDate(key.rotatedAt)}</>}
      </p>
    );
  }
  return (
    <p className="text-small text-text-primary">
      {local
        ? 'No bearer token set. Ollama needs none unless your endpoint asks for one.'
        : 'Not set.'}
    </p>
  );
}

/**
 * One provider's key (WP 10.6), the WP 10.4 market-data key card's pattern:
 *
 * - `file`: read-only. The operator's secret file wins, so there is no field, no Save and no Remove.
 * - `stored` / `none`: a masked field and **Save with passkey**. The key is cleared from this component's state
 *   the moment the request body is built - before the request is sent - and whether the save succeeds or fails.
 *   The step-up is asked for by `useStepUpRetry` on `step_up_required`, then the same request is retried once.
 * - `stored`: **Remove**, behind a confirmation dialog and the same step-up.
 *
 * For Ollama the same field is an optional bearer token.
 */
export function NarratorKeyField({ state }: { state: NarratorProviderState }) {
  const provider = state.provider;
  const name = providerName(provider);
  const local = provider === 'ollama';
  const what = local ? 'bearer token' : 'key';
  const fieldLabel = local ? 'Ollama bearer token (optional)' : `${name} API key`;
  const inputId = `narrator-key-${provider}`;
  const errorId = `${inputId}-error`;

  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removedRef = useRef(false);

  const save = useSaveNarratorKeyMutation();
  const remove = useRemoveNarratorKeyMutation();
  const saveStepUp = useStepUpRetry();
  const removeStepUp = useStepUpRetry();
  const saving = save.isPending || saveStepUp.busy;
  const removing = remove.isPending || removeStepUp.busy;

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const candidate = key.trim();
    if (!NARRATOR_KEY_PATTERN.test(candidate)) {
      setError(`A ${what} is 16 to 512 letters, digits and - _ . : = + / only. Nothing was sent.`);
      return;
    }
    const body = { key: candidate };
    setKey('');
    try {
      await saveStepUp.run(() => save.mutateAsync({ path: { provider }, body }));
      setSaved(true);
    } catch (cause) {
      setError(problemDetail(cause, `Could not save this ${name} ${what}. Nothing was stored.`));
    } finally {
      save.reset();
      // The Save button is disabled while the request runs and stays disabled once the field is empty, so focus
      // would fall to the document body; it goes back to the (now empty) field instead (2.4.3).
      inputRef.current?.focus();
    }
  }

  async function handleRemove(): Promise<void> {
    setRemoveError(null);
    try {
      await removeStepUp.run(() => remove.mutateAsync({ path: { provider } }));
      removedRef.current = true;
      setSaved(false);
      setConfirmOpen(false);
    } catch (cause) {
      setRemoveError(problemDetail(cause, `Could not remove the stored ${name} ${what}.`));
    } finally {
      remove.reset();
    }
  }

  const saveFailure = error ?? saveStepUp.error;
  const removeFailure = removeError ?? removeStepUp.error;

  return (
    <div className="flex flex-col gap-2">
      <div data-testid={`narrator-key-${provider}-status`}>
        <KeyStatus state={state} />
      </div>

      {state.key.source !== 'file' && (
        <form
          className="flex flex-col gap-2"
          aria-label={local ? 'Ollama bearer token' : `${name} key`}
          onSubmit={(event) => void handleSave(event)}
        >
          <Label htmlFor={inputId}>{fieldLabel}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              id={inputId}
              type="password"
              className="max-w-sm"
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setSaved(false);
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={
                saveFailure === null ? `${inputId}-hint` : `${inputId}-hint ${errorId}`
              }
            />
            <Button type="submit" disabled={saving || key.trim() === ''}>
              {saving ? 'Saving…' : 'Save with passkey'}
            </Button>
            {state.key.source === 'stored' && (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  removedRef.current = false;
                  setRemoveError(null);
                  setConfirmOpen(true);
                }}
              >
                Remove
              </Button>
            )}
          </div>
          <p
            id={`${inputId}-hint`}
            className="flex items-start gap-1.5 text-caption text-text-muted"
          >
            <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            {state.key.source === 'stored'
              ? `Paste a new ${what} to replace the stored one. It is stored encrypted and never shown again.`
              : `Stored encrypted in this install and never shown again (only its last four characters). Saving asks for your passkey.`}
          </p>
          {saveFailure !== null && (
            <p id={errorId} className="text-small text-status-critical" role="alert">
              {saveFailure}
            </p>
          )}
          {saved && (
            <p className="text-small text-text-primary" role="status">
              Saved. Nothing was sent to {name}: use Test to check that it accepts the {what}.
            </p>
          )}
        </form>
      )}

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!removing) setConfirmOpen(open);
        }}
      >
        <DialogContent
          showClose={false}
          finalFocus={() => (removedRef.current ? inputRef.current : true)}
        >
          <DialogTitle>
            Remove the stored {name} {what}?
          </DialogTitle>
          <DialogDescription>
            {local
              ? 'The local model is then called without a bearer token.'
              : `${name} cannot narrate until you add a key again.`}{' '}
            This does not revoke the {what} at {name}. Removing asks for your passkey.
          </DialogDescription>
          {removeFailure !== null && (
            <p className="mt-3 text-small text-status-critical" role="alert">
              {removeFailure}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={removing}
              onClick={() => setConfirmOpen(false)}
            >
              Keep
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={() => void handleRemove()}
            >
              {removing ? 'Removing…' : `Remove ${what}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
