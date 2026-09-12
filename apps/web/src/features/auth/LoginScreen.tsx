// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser';
import { Fingerprint, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  useFinishLoginMutation,
  useRecoveryCodeLoginMutation,
  useStartLoginMutation,
  useTotpLoginMutation,
} from '../../api/pending-contracts.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';

type Mode = 'passkey' | 'totp' | 'recovery';

/**
 * `/login` — passkey-first sign-in (05-frontend-architecture.md §7.1). No
 * password field exists anywhere in this app; TOTP and a recovery code are
 * the only fallbacks, both reached from links below the primary action.
 *
 * Conditional UI: on mount, if the browser supports WebAuthn autofill, a
 * discoverable-credential request is armed against the `autocomplete="webauthn"`
 * input below, so a passkey can appear in the browser's native autofill
 * dropdown with zero clicks. The visible "Sign in with a passkey" button is
 * the explicit, always-available fallback for browsers that don't.
 */
export function LoginScreen() {
  const [mode, setMode] = useState<Mode>('passkey');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const startLogin = useStartLoginMutation();
  const finishLogin = useFinishLoginMutation();
  const totpLogin = useTotpLoginMutation();
  const recoveryLogin = useRecoveryCodeLoginMutation();

  const autofillArmed = useRef(false);

  async function signInWithPasskey(useBrowserAutofill: boolean): Promise<void> {
    setError(null);
    try {
      const { options } = await startLogin.mutateAsync();
      const response = await startAuthentication({
        optionsJSON: options as never,
        useBrowserAutofill,
      });
      await finishLogin.mutateAsync({ response: response as never });
      await navigate({ to: '/' });
    } catch (cause) {
      if (useBrowserAutofill) return; // a cancelled/expired conditional request is silent, not an error banner
      setError(describeWebauthnError(cause));
    }
  }

  useEffect(() => {
    if (autofillArmed.current) return;
    autofillArmed.current = true;
    void browserSupportsWebAuthnAutofill().then((supported) => {
      if (supported) void signInWithPasskey(true);
    });
    // Conditional UI is armed exactly once per mount; re-arming on every
    // render would stack duplicate `navigator.credentials.get()` calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = startLogin.isPending || finishLogin.isPending;

  return (
    <AuthScreenFrame>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle text-accent-text">
        <Fingerprint size={22} aria-hidden="true" />
      </div>
      <h1 className="mt-3 text-h2 text-text-primary">Sign in to PersonalFi</h1>

      {mode === 'passkey' && (
        <>
          <p className="mt-1 text-small text-text-muted">
            Your face, fingerprint, or device PIN replaces a password.
          </p>
          {/* Anchor for conditional UI (§7.1) — deliberately present even though this is a
              single-user app, so the discoverable credential has an input to autofill into. */}
          <label className="sr-only" htmlFor="login-username">
            Account
          </label>
          <input
            id="login-username"
            name="username"
            autoComplete="username webauthn"
            className="sr-only"
            tabIndex={-1}
          />
          {error !== null && (
            <p role="alert" className="mt-3 text-small text-status-critical">
              {error}
            </p>
          )}
          <Button
            className="mt-5 w-full"
            disabled={busy}
            onClick={() => void signInWithPasskey(false)}
          >
            {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Sign in with a passkey
          </Button>
          <div className="mt-4 flex flex-col gap-1 text-small">
            <button
              type="button"
              className="text-accent-text hover:underline"
              onClick={() => setMode('totp')}
            >
              Use an authenticator code instead
            </button>
            <button
              type="button"
              className="text-accent-text hover:underline"
              onClick={() => setMode('recovery')}
            >
              Use a recovery code instead
            </button>
          </div>
        </>
      )}

      {mode === 'totp' && (
        <TotpForm
          busy={totpLogin.isPending}
          onSubmit={(token) =>
            totpLogin.mutate(
              { token },
              { onSuccess: () => void navigate({ to: '/' }), onError: (e) => setError(e.message) },
            )
          }
          error={error}
          onBack={() => {
            setMode('passkey');
            setError(null);
          }}
        />
      )}

      {mode === 'recovery' && (
        <RecoveryCodeForm
          busy={recoveryLogin.isPending}
          onSubmit={(code) =>
            recoveryLogin.mutate(
              { code },
              { onSuccess: () => void navigate({ to: '/' }), onError: (e) => setError(e.message) },
            )
          }
          error={error}
          onBack={() => {
            setMode('passkey');
            setError(null);
          }}
        />
      )}
    </AuthScreenFrame>
  );
}

function TotpForm({
  busy,
  error,
  onSubmit,
  onBack,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (token: string) => void;
  onBack: () => void;
}) {
  const [token, setToken] = useState('');
  return (
    <form
      className="mt-4 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(token);
      }}
    >
      <Label htmlFor="totp-token">6-digit authenticator code</Label>
      <Input
        id="totp-token"
        className="mt-1.5"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6,8}"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        aria-describedby={error !== null ? 'totp-error' : undefined}
        aria-invalid={error !== null}
      />
      {error !== null && (
        <p id="totp-error" role="alert" className="mt-1.5 text-small text-status-critical">
          {error}
        </p>
      )}
      <Button type="submit" className="mt-4 w-full" disabled={busy || token.length < 6}>
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        Verify code
      </Button>
      <button
        type="button"
        className="mt-3 text-small text-accent-text hover:underline"
        onClick={onBack}
      >
        Back to passkey sign-in
      </button>
    </form>
  );
}

function RecoveryCodeForm({
  busy,
  error,
  onSubmit,
  onBack,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (code: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form
      className="mt-4 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(code);
      }}
    >
      <Label htmlFor="recovery-code">Recovery code</Label>
      <Input
        id="recovery-code"
        className="mt-1.5 font-mono"
        autoComplete="off"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        aria-describedby={error !== null ? 'recovery-error' : undefined}
        aria-invalid={error !== null}
      />
      {error !== null && (
        <p id="recovery-error" role="alert" className="mt-1.5 text-small text-status-critical">
          {error}
        </p>
      )}
      <Button type="submit" className="mt-4 w-full" disabled={busy || code.length < 8}>
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        Use recovery code
      </Button>
      <button
        type="button"
        className="mt-3 text-small text-accent-text hover:underline"
        onClick={onBack}
      >
        Back to passkey sign-in
      </button>
    </form>
  );
}

function AuthScreenFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-page px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-hairline bg-bg-surface p-6 text-center">
        {children}
      </div>
    </div>
  );
}

/** §7.1: `NotAllowedError` means "cancelled or timed out," never "wrong credential." */
function describeWebauthnError(cause: unknown): string {
  if (cause instanceof Error && cause.name === 'NotAllowedError') {
    return 'That was cancelled. Try again, or use a recovery code.';
  }
  return 'Something went wrong signing in. Try again, or use a recovery code.';
}
