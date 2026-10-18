// SPDX-License-Identifier: MIT
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

import type { MarketDataCredentialsStatus } from '../../api/generated/types.gen.ts';
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
  MARKET_DATA_KEY_PATTERN,
  marketDataProviderName,
  problemDetail,
  useRemoveMarketDataKeyMutation,
  useSaveMarketDataKeyMutation,
} from './credentials-api.ts';

/** Shown once a key has been saved in this session: the key is used on the next run, or on demand. */
const KEY_USED_LINE =
  'Holdings sync and price refresh use this key from the next run; use Refresh prices to fetch now.';

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Where the key comes from, in words. Every field is named explicitly - nothing is spread from the wire -
 * so the only thing about a stored key that can reach the screen is `keyHint`, its last four characters.
 */
function KeyStatus({ status, name }: { status: MarketDataCredentialsStatus; name: string }) {
  if (status.source === 'file') {
    return (
      <p className="text-small text-text-primary">
        Set by the operator&apos;s secret file.{' '}
        <span className="text-text-secondary">
          It takes precedence, and can only be changed where the install is run.
        </span>
      </p>
    );
  }
  if (status.source === 'stored') {
    return (
      <p className="text-small text-text-primary">
        Stored in this install
        {status.storedAt !== null && <> since {formatDate(status.storedAt)}</>}
        {status.keyHint !== null && (
          <>
            {' '}
            · ends in <span className="font-mono">{status.keyHint}</span>
          </>
        )}
        {status.rotatedAt !== null && <> · replaced {formatDate(status.rotatedAt)}</>}
      </p>
    );
  }
  if (status.anonymous) {
    return (
      <p className="text-small text-text-primary">
        Not set — using {name} anonymously (10 per request).
      </p>
    );
  }
  return <p className="text-small text-text-primary">Not set.</p>;
}

export interface MarketDataKeyCardProps {
  readonly status: MarketDataCredentialsStatus;
}

/**
 * One provider's key (WP 10.4), in Settings › Market data.
 *
 * - `file`: read-only. The operator's secret file wins over anything the product could store, so there is no
 *   field, no Save and no Remove.
 * - `stored` / `none`: a masked field and **Save with passkey**. The key is cleared from this component's
 *   state the moment the request body is built - before the request is sent, so it does not linger through a
 *   slow provider check, the step-up ceremony or a re-render - and it is cleared whether the save succeeds or
 *   fails. The step-up is asked for by `useStepUpRetry` on the api's `step_up_required`, then the same request
 *   is retried once with the body captured here.
 * - `stored`: **Remove**, behind a confirmation dialog and the same step-up.
 */
export function MarketDataKeyCard({ status }: MarketDataKeyCardProps) {
  const provider = status.provider;
  const name = marketDataProviderName(provider);
  const headingId = `market-data-key-${provider}-heading`;
  const inputId = `market-data-key-${provider}`;
  const errorId = `market-data-key-${provider}-error`;

  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removedRef = useRef(false);

  const save = useSaveMarketDataKeyMutation(provider);
  const remove = useRemoveMarketDataKeyMutation(provider);
  const saveStepUp = useStepUpRetry();
  const removeStepUp = useStepUpRetry();
  const saving = save.isPending || saveStepUp.busy;
  const removing = remove.isPending || removeStepUp.busy;

  const readOnly = status.source === 'file';

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const candidate = key.trim();
    if (!MARKET_DATA_KEY_PATTERN.test(candidate)) {
      setError(
        `A ${name} key is 16 to 256 letters, digits, dashes or underscores. Nothing was sent.`,
      );
      return;
    }
    const body = { key: candidate };
    setKey('');
    try {
      await saveStepUp.run(() => save.mutateAsync({ path: { provider }, body }));
      setSaved(true);
    } catch (cause) {
      setError(problemDetail(cause, `Could not save this ${name} key. Nothing was stored.`));
    } finally {
      save.reset();
      // The Save button is disabled while the request runs and stays disabled once the field is empty, so
      // focus would fall to the document body; it goes back to the (now empty) field instead, where the
      // status or the alert just below it is announced (2.4.3).
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
      setRemoveError(problemDetail(cause, `Could not remove the stored ${name} key.`));
    } finally {
      remove.reset();
    }
  }

  const saveFailure = error ?? saveStepUp.error;
  const removeFailure = removeError ?? removeStepUp.error;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      data-testid={`market-data-key-${provider}`}
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="flex items-center gap-2 font-medium text-text-primary">
          <KeyRound size={16} aria-hidden="true" />
          {name}
        </h3>
        <p className="text-small text-text-secondary">{status.purpose}</p>
      </div>

      <div data-testid={`market-data-key-${provider}-status`}>
        <KeyStatus status={status} name={name} />
        {status.narrowedOut && (
          <p className="mt-1 text-small text-status-warning-text">
            This install&apos;s allowed hosts leave {name} out, so no key for it can be checked or
            used.
          </p>
        )}
      </div>

      {!readOnly && (
        <form
          className="flex flex-col gap-2"
          aria-label={`${name} key`}
          onSubmit={(event) => void handleSave(event)}
        >
          <Label htmlFor={inputId}>{name} API key</Label>
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
              {saving ? `Checking with ${name}…` : 'Save with passkey'}
            </Button>
            {status.source === 'stored' && (
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
            {status.source === 'stored'
              ? `Paste a new key to replace the stored one. ${name} checks it first; it is stored encrypted and never shown again.`
              : `${name} checks the key first; it is stored encrypted in this install and never shown again (only its last four characters).`}
          </p>
          {saveFailure !== null && (
            <p id={errorId} className="text-small text-status-danger-text" role="alert">
              {saveFailure}
            </p>
          )}
          {saved && (
            <p className="text-small text-text-primary" role="status">
              Saved. {name} accepted the key. {KEY_USED_LINE}
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
          <DialogTitle>Remove the stored {name} key?</DialogTitle>
          <DialogDescription>
            {provider === 'openfigi'
              ? 'OpenFIGI goes back to answering anonymously, at 10 per request, until you add a key again.'
              : `Prices from ${name} stop until you add a key again.`}{' '}
            This does not revoke the key at {name}. Removing asks for your passkey.
          </DialogDescription>
          {removeFailure !== null && (
            <p className="mt-3 text-small text-status-danger-text" role="alert">
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
              {removing ? 'Removing…' : 'Remove key'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
