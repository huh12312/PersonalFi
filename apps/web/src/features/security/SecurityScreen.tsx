// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { listSessionsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { SessionSummary } from '../../api/generated/types.gen.ts';
import { useSessionQuery } from '../../api/pending-contracts.ts';
import { ConfirmDialog } from '../../components/patterns/ConfirmDialog.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { RecoveryCodes } from './RecoveryCodes.tsx';
import {
  useRemoveTotpMutation,
  useRevokeOtherSessionsMutation,
  useRevokeSessionMutation,
} from './api.ts';

const METHOD_LABELS: Readonly<Record<string, string>> = {
  webauthn: 'Passkey',
  totp: 'Authenticator code',
  recovery_code: 'Recovery code',
};

function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Settings › Security (WP 9.14; the routes are WP 9.11's G-02 and G-12): who is signed in, and the
 * authenticator-code seed.
 *
 * Every call here needs a fresh passkey assertion (`403 step_up_required`), so the list is NOT loaded
 * on open: the holder asks for it, `useStepUpRetry` runs the ceremony once, and the list lives in this
 * component's state only (never the query cache, which the app clears at sign-out). Signing out the
 * session you are using ends it, so that path leaves for `/login`.
 */
export function SecurityScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionQuery = useSessionQuery();
  const sessionsStepUp = useStepUpRetry();
  const revokeStepUp = useStepUpRetry();
  const totpStepUp = useStepUpRetry();
  const revokeOne = useRevokeSessionMutation();
  const revokeOthers = useRevokeOtherSessionsMutation();
  const removeTotp = useRemoveTotpMutation();

  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingTotp, setConfirmingTotp] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);

  async function load(): Promise<void> {
    setProblem(null);
    try {
      // `gcTime: 0`: the list is for this screen only and must not outlive it in the cache.
      const result = await sessionsStepUp.run(() =>
        queryClient.fetchQuery({ ...listSessionsOptions(), staleTime: 0, gcTime: 0, retry: false }),
      );
      setSessions(result.sessions);
    } catch (cause) {
      if (sessionsStepUp.error === null)
        setProblem(problemDetail(cause, 'Could not load sessions.'));
    }
  }

  async function signOut(entry: SessionSummary): Promise<void> {
    setProblem(null);
    setNotice(null);
    try {
      await revokeStepUp.run(() => revokeOne.mutateAsync({ path: { familyId: entry.familyId } }));
      if (entry.current) {
        // The server cleared this browser's cookies; nothing cached may outlive them.
        queryClient.clear();
        await navigate({ to: '/login' });
        return;
      }
      setSessions((current) => current?.filter((row) => row.familyId !== entry.familyId) ?? null);
      setNotice('That session was signed out.');
    } catch (cause) {
      if (revokeStepUp.error === null)
        setProblem(problemDetail(cause, 'Could not sign that session out.'));
    }
  }

  async function signOutOthers(): Promise<void> {
    setProblem(null);
    setNotice(null);
    try {
      const result = await revokeStepUp.run(() => revokeOthers.mutateAsync({}));
      setSessions((current) => current?.filter((row) => row.current) ?? null);
      setNotice(
        result.revoked === 0
          ? 'There were no other sessions to sign out.'
          : `${String(result.revoked)} other ${result.revoked === 1 ? 'session was' : 'sessions were'} signed out.`,
      );
    } catch (cause) {
      if (revokeStepUp.error === null)
        setProblem(problemDetail(cause, 'Could not sign the others out.'));
    }
  }

  async function removeAuthenticatorCode(): Promise<void> {
    setProblem(null);
    setNotice(null);
    try {
      await totpStepUp.run(() => removeTotp.mutateAsync({}));
      setNotice('The authenticator code was removed. It can no longer sign in.');
    } catch (cause) {
      if (totpStepUp.error === null)
        setProblem(problemDetail(cause, 'Could not remove the authenticator code.'));
    } finally {
      setConfirmingTotp(false);
    }
  }

  const totpEnrolled = sessionQuery.data?.totpEnrolled === true;
  const remaining = sessionQuery.data?.recoveryCodesRemaining ?? null;
  const others = sessions?.filter((entry) => !entry.current).length ?? 0;
  const stepUpMessage = sessionsStepUp.error ?? revokeStepUp.error ?? totpStepUp.error;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h2 className="text-h2 font-semibold text-text-primary">Security</h2>
        <p className="text-body text-text-secondary">
          Where you are signed in, and the ways you can sign in. Each action here asks for your
          passkey first.
        </p>
      </header>

      {(notice !== null || problem !== null || stepUpMessage !== null) && (
        <div role={problem !== null || stepUpMessage !== null ? 'alert' : 'status'}>
          {notice !== null && problem === null && stepUpMessage === null && (
            <p className="text-small text-text-primary">{notice}</p>
          )}
          {(problem ?? stepUpMessage) !== null && (
            <p className="text-small text-status-danger-text">{problem ?? stepUpMessage}</p>
          )}
        </div>
      )}

      <section aria-labelledby="sessions-heading" className="flex flex-col gap-3">
        <h3 id="sessions-heading" className="text-h3 font-semibold text-text-primary">
          Signed-in sessions
        </h3>
        <p className="text-small text-text-secondary">
          Every browser that is currently signed in to this install. A session you do not recognise
          is a reason to sign it out, and then to change how you sign in.
        </p>

        {sessions === null ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void load()}
              disabled={sessionsStepUp.busy}
            >
              {sessionsStepUp.busy ? 'Checking your passkey…' : 'Show my sessions'}
            </Button>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2" aria-label="Signed-in sessions">
              {sessions.map((entry) => {
                const method = METHOD_LABELS[entry.authMethod] ?? entry.authMethod;
                return (
                  <li
                    key={entry.familyId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-hairline bg-bg-surface p-3"
                  >
                    <div className="flex flex-col gap-1">
                      <p className="flex flex-wrap items-center gap-2 text-body font-medium text-text-primary">
                        {method}
                        {entry.current && <Badge variant="accent">This session</Badge>}
                        {entry.trustedDevice && <Badge variant="neutral">Trusted device</Badge>}
                      </p>
                      <p className="text-caption text-text-muted">
                        Last active {when(entry.lastSeenAt)} · expires {when(entry.familyExpiresAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={revokeStepUp.busy || revokeOne.isPending}
                      onClick={() => void signOut(entry)}
                    >
                      Sign out
                      <span className="sr-only">
                        {' '}
                        {entry.current
                          ? 'this session'
                          : `the ${method.toLowerCase()} session last active ${when(entry.lastSeenAt)}`}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={others === 0 || revokeStepUp.busy || revokeOthers.isPending}
                onClick={() => void signOutOthers()}
              >
                Sign out every other session
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void load()}
                disabled={sessionsStepUp.busy}
              >
                Refresh
              </Button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="signin-methods-heading" className="flex flex-col gap-3">
        <h3 id="signin-methods-heading" className="text-h3 font-semibold text-text-primary">
          Sign-in methods
        </h3>
        <p className="text-small text-text-secondary">
          Your passkeys are the strong way in. An authenticator code and recovery codes are
          fallbacks, and a session that used one of them cannot export your data or change how you
          sign in.
        </p>
        <div className="flex flex-col gap-2 rounded-lg border border-border-hairline bg-bg-surface p-3">
          <p className="flex flex-wrap items-center gap-2 text-body font-medium text-text-primary">
            Authenticator code
            <Badge variant={totpEnrolled ? 'success' : 'neutral'}>
              {totpEnrolled ? 'Set up' : 'Not set up'}
            </Badge>
          </p>
          <p className="text-small text-text-secondary">
            If the code&rsquo;s secret may have leaked, remove it. Anyone holding it can sign in
            until you do.
          </p>
          <div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!totpEnrolled || totpStepUp.busy || removeTotp.isPending}
              onClick={() => setConfirmingTotp(true)}
            >
              Remove authenticator code
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="recovery-heading" className="flex flex-col gap-3">
        <h3 id="recovery-heading" className="text-h3 font-semibold text-text-primary">
          Recovery codes
        </h3>
        <p className="text-small text-text-secondary">
          Ten single-use codes that let you in if you lose every passkey.{' '}
          {remaining === null
            ? ''
            : remaining === 0
              ? 'You have none left.'
              : `You have ${String(remaining)} unused.`}{' '}
          Creating new codes replaces the old ones, which stop working.
        </p>
        {codesOpen ? (
          <RecoveryCodes
            generateLabel="Create new recovery codes"
            savedLabel="Done"
            onSaved={() => {
              setCodesOpen(false);
              setNotice('Your new recovery codes are active. The old ones no longer work.');
            }}
          />
        ) : (
          <div>
            <Button type="button" variant="secondary" onClick={() => setCodesOpen(true)}>
              {remaining === 0 ? 'Create recovery codes' : 'Replace my recovery codes'}
            </Button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmingTotp}
        onOpenChange={setConfirmingTotp}
        title="Remove the authenticator code?"
        description="It stops working at once, everywhere. You can still sign in with a passkey or a recovery code. Setting up a new code afterwards is done through the API; the RUNBOOK's Lockout section says how."
        confirmLabel="Remove it"
        busy={totpStepUp.busy || removeTotp.isPending}
        onConfirm={() => void removeAuthenticatorCode()}
      />
    </div>
  );
}
