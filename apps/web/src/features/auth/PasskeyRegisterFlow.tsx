// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { startRegistration } from '@simplewebauthn/browser';
import { CheckCircle2, KeyRound, Loader2, ShieldPlus } from 'lucide-react';
import { useState } from 'react';

import {
  useFinishRegistrationMutation,
  useStartRegistrationMutation,
} from '../../api/pending-contracts.ts';
import { describeWebauthnError } from '../../lib/webauthn-error.ts';
import { IconCircle } from '../../components/patterns/IconCircle.tsx';
import { AuthCard } from './AuthCard.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { RecoveryCodes } from '../security/RecoveryCodes.tsx';

export interface PasskeyRegisterFlowProps {
  /** The one-time enrolment token from `just bootstrap-user` (first run). Omitted when a stepped-up session is adding a second authenticator instead. */
  registrationToken?: string | undefined;
}

type Step = 'first' | 'second' | 'codes' | 'done';

/**
 * First-run passkey enrolment (05-frontend-architecture.md §7.1): register
 * one passkey, then immediately prompt for a **second** — "a single
 * authenticator on a self-hosted app is a lockout waiting to happen." The
 * second step is explicitly skippable; it is a recommendation, not a gate.
 */
export function PasskeyRegisterFlow({ registrationToken }: PasskeyRegisterFlowProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('first');
  const [friendlyName, setFriendlyName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const startMutation = useStartRegistrationMutation();
  const finishMutation = useFinishRegistrationMutation();
  const busy = startMutation.isPending || finishMutation.isPending;

  async function enrol(name: string): Promise<void> {
    setError(null);
    try {
      const { userId, options } = await startMutation.mutateAsync(
        step === 'first' && registrationToken !== undefined ? { registrationToken } : {},
      );
      const response = await startRegistration({ optionsJSON: options as never });
      const result = await finishMutation.mutateAsync({
        userId,
        friendlyName: name,
        response: response as never,
      });
      setStep(
        result.enrolSecondAuthenticator && step === 'first'
          ? 'second'
          : registrationToken !== undefined
            ? 'codes'
            : 'done',
      );
    } catch (cause) {
      setError(
        describeWebauthnError(cause, {
          cancelled: 'That was cancelled. Try again when you’re ready.',
          failed: 'Could not create that passkey. Try again.',
        }),
      );
    }
  }

  if (step === 'codes') {
    return (
      <AuthCard>
        <IconCircle tone="accent">
          <KeyRound size={22} aria-hidden="true" />
        </IconCircle>
        <h1 className="mt-3 text-h2 text-text-primary">Save your recovery codes</h1>
        <p className="mt-1 text-small text-text-muted">
          If you lose every passkey, a recovery code is the way back in.
        </p>
        <div className="mt-5 text-left">
          <RecoveryCodes
            generateLabel="Create my recovery codes"
            savedLabel="Continue"
            onSaved={() => setStep('done')}
          />
        </div>
        <button
          type="button"
          className="mt-3 w-full text-small text-text-muted hover:underline"
          onClick={() => setStep('done')}
        >
          Skip for now — create them later in Settings › Security
        </button>
      </AuthCard>
    );
  }

  if (step === 'done') {
    return (
      <AuthCard>
        <IconCircle tone="good">
          <CheckCircle2 size={22} aria-hidden="true" />
        </IconCircle>
        <h1 className="mt-3 text-h2 text-text-primary">You’re all set</h1>
        <p className="mt-1 text-small text-text-muted">Your passkeys are ready.</p>
        <Button className="mt-5 w-full" onClick={() => void navigate({ to: '/' })}>
          Continue to PersonalFi
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <IconCircle tone="accent">
        <ShieldPlus size={22} aria-hidden="true" />
      </IconCircle>
      <h1 className="mt-3 text-h2 text-text-primary">
        {step === 'first' ? 'Set up a passkey' : 'Add a backup passkey'}
      </h1>
      <p className="mt-1 text-small text-text-muted">
        {step === 'first'
          ? 'Your face, fingerprint, or device PIN replaces a password.'
          : 'A phone, a security key, or another browser — so one lost device can’t lock you out.'}
      </p>

      <form
        className="mt-5 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          void enrol(friendlyName || (step === 'first' ? 'My passkey' : 'Backup passkey'));
        }}
      >
        <Label htmlFor="friendly-name">Name this passkey</Label>
        <Input
          id="friendly-name"
          className="mt-1.5"
          placeholder={step === 'first' ? 'e.g. MacBook Touch ID' : 'e.g. iPhone'}
          value={friendlyName}
          onChange={(event) => setFriendlyName(event.target.value)}
          maxLength={64}
        />
        {error !== null && (
          <p role="alert" className="mt-1.5 text-small text-status-critical">
            {error}
          </p>
        )}
        <Button type="submit" className="mt-4 w-full" disabled={busy}>
          {busy && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
          {step === 'first' ? 'Create passkey' : 'Add passkey'}
        </Button>
        {step === 'second' && (
          <button
            type="button"
            className="mt-3 w-full text-small text-text-muted hover:underline"
            onClick={() => setStep(registrationToken !== undefined ? 'codes' : 'done')}
          >
            Skip for now
          </button>
        )}
      </form>
    </AuthCard>
  );
}
