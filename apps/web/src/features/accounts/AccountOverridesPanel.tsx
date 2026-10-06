// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { FormEvent } from 'react';

import type { Account } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import {
  useClearAccountOverridesMutation,
  useSetAccountOverridesMutation,
} from './useAccountOverrides.ts';
import {
  ACCOUNT_ROLES,
  ROLE_LABELS,
  TAX_LABELS,
  TAX_TREATMENTS,
  VALUATION_LABELS,
  applicableFields,
  hasOverride,
  overlayKeyOf,
  roleText,
  taxTreatmentText,
  valuationText,
  type AccountRole,
  type TaxTreatment,
  type ValuationBasis,
} from './overlay-labels.ts';

const SELECT_CLASS =
  'h-9 w-full max-w-md rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary';

export interface AccountOverridesPanelProps {
  account: Account;
}

/**
 * What the plan believes about one account, and the three things the holder can
 * say about it (WP 9.2; CF-16, O-2). The provider's metadata is never edited:
 * each field shows its *effective* value and its source — "from Plaid: 401k",
 * "assumed — Plaid calls this …", "set by you" — and an empty choice means "use
 * the provider's", so a guess is never presented as a fact and a holder can
 * always get back to it.
 *
 * Native `<select>`s on purpose: every one is keyboard-operable with no custom
 * widget to get wrong, and each has a visible `<label>`.
 *
 * Saving changes what the next projection starts from, so a stored projection
 * reads stale (the plan screen says so, naming this account); nothing is
 * recomputed behind the holder's back. No step-up: no money moves.
 *
 * The draft below starts from what the server last said and is reset whenever
 * that answer changes (`overlayKeyOf`) — without remounting, so the "Saved"
 * message the holder just earned is not thrown away by the refetch that
 * follows the save.
 */
export function AccountOverridesPanel({ account }: AccountOverridesPanelProps) {
  const fields = applicableFields(account);
  const saved: {
    tax: TaxTreatment | '';
    role: AccountRole | '';
    valuation: ValuationBasis | '';
  } = {
    tax: account.overlay.taxTreatment.override ?? '',
    role: account.overlay.role.effective ?? '',
    valuation:
      account.overlay.valuation.source === 'holder' ? account.overlay.valuation.effective : '',
  };
  const [tax, setTax] = useState<TaxTreatment | ''>(saved.tax);
  const [role, setRole] = useState<AccountRole | ''>(saved.role);
  const [valuation, setValuation] = useState<ValuationBasis | ''>(saved.valuation);
  const key = overlayKeyOf(account);
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    // The server's answer changed (our own save, or another tab's): start the draft from it.
    setSeenKey(key);
    setTax(saved.tax);
    setRole(saved.role);
    setValuation(saved.valuation);
  }
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setOverrides = useSetAccountOverridesMutation();
  const clearOverrides = useClearAccountOverridesMutation();

  const dirty = tax !== saved.tax || role !== saved.role || valuation !== saved.valuation;
  const busy = setOverrides.isPending || clearOverrides.isPending;
  const taxNow = taxTreatmentText(account);
  const roleNow = roleText(account);
  const valuationNow = valuationText(account);
  const providerDefault = account.overlay.taxTreatment.providerDefault;

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await setOverrides.mutateAsync({
        path: { accountId: account.id },
        body: {
          taxTreatment: fields.tax && tax !== '' ? tax : null,
          role: role !== '' ? role : null,
          valuation: fields.valuation && valuation !== '' ? valuation : null,
        },
      });
      setMessage(
        'Saved. A projection computed before this change is now out of date — open the Plan to recompute it.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save these settings.');
    }
  }

  async function reset(): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await clearOverrides.mutateAsync({ path: { accountId: account.id } });
      setMessage('Back to what your provider says. A projection computed before is out of date.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reset these settings.');
    }
  }

  return (
    <section
      aria-labelledby="account-overlay-heading"
      className="flex flex-col gap-4 rounded-xl border border-border-hairline bg-bg-surface p-5"
    >
      <div>
        <h2 id="account-overlay-heading" className="text-h3 font-semibold text-text-primary">
          How your plan treats this account
        </h2>
        <p className="text-small text-text-muted">
          Your provider’s details are never changed; what you set here outranks them.
        </p>
      </div>

      <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
        {fields.tax && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-tax-treatment">Tax treatment</Label>
            <select
              id="account-tax-treatment"
              className={SELECT_CLASS}
              value={tax}
              aria-describedby="account-tax-treatment-now"
              onChange={(event) => setTax(event.target.value as TaxTreatment | '')}
            >
              <option value="">
                {providerDefault === null
                  ? 'Use the provider’s (none)'
                  : `Use the provider’s (${TAX_LABELS[providerDefault]})`}
              </option>
              {TAX_TREATMENTS.map((option) => (
                <option key={option} value={option}>
                  {TAX_LABELS[option]}
                </option>
              ))}
            </select>
            <p id="account-tax-treatment-now" className="text-small text-text-muted">
              Now: {taxNow.value} — {taxNow.source}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-role">Role</Label>
          <select
            id="account-role"
            className={SELECT_CLASS}
            value={role}
            aria-describedby="account-role-now"
            onChange={(event) => setRole(event.target.value as AccountRole | '')}
          >
            <option value="">Not set</option>
            {ACCOUNT_ROLES.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
          <p id="account-role-now" className="text-small text-text-muted">
            Now: {roleNow.value} — {roleNow.source}
          </p>
        </div>

        {fields.valuation && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-valuation">Valued by</Label>
            <select
              id="account-valuation"
              className={SELECT_CLASS}
              value={valuation}
              aria-describedby="account-valuation-now"
              onChange={(event) => setValuation(event.target.value as ValuationBasis | '')}
            >
              <option value="">Holdings (the default)</option>
              <option value="balance">{VALUATION_LABELS.balance} when there are no holdings</option>
            </select>
            <p id="account-valuation-now" className="text-small text-text-muted">
              Now: {valuationNow.value} — {valuationNow.source}. An account with no holdings is left
              out of net worth, never counted as zero; choose your typed balance to count it at its
              latest balance, labelled as such.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || !dirty}>
            {setOverrides.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          {hasOverride(account) && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void reset()}>
              Use the provider’s settings
            </Button>
          )}
        </div>
        {message !== null && (
          <p className="text-small text-text-secondary" role="status">
            {message}
          </p>
        )}
        {error !== null && (
          <p className="text-small text-status-critical" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
