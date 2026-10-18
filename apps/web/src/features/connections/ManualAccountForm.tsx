// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { useCreateConnectionMutation } from './useConnections.ts';
import type { Account } from '../../api/generated/types.gen.ts';

const ACCOUNT_TYPES: Array<Account['type']> = [
  'depository',
  'credit',
  'loan',
  'investment',
  'crypto',
  'manual',
];

export interface ManualAccountFormProps {
  provider: string;
  onDone: () => void;
}

/**
 * `POST /connections` with `provider: 'manual'` — `@connector/manual`'s
 * `connect()` schema (`{ displayName, accounts: [{ providerAccountId, name,
 * type, currency, mask? }] }`, one account per submission here). Step-up
 * gated (wp1.5-api.md §1: "add a connection" is one of the five).
 *
 * There is currently no route to set a starting balance or enter a manual
 * transaction — see docs/evidence/phase-1/wp1.6-ui.md's "left open" section —
 * so a manual account reads "No balance yet" until that lands.
 */
export function ManualAccountForm({ provider, onDone }: ManualAccountFormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<Account['type']>('depository');
  const [currency, setCurrency] = useState('USD');
  const [mask, setMask] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createConnection = useCreateConnectionMutation();
  const stepUp = useStepUpRetry();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await stepUp.run(() =>
        createConnection.mutateAsync({
          body: {
            provider,
            input: {
              displayName: name,
              accounts: [
                {
                  providerAccountId: crypto.randomUUID(),
                  name,
                  type,
                  currency: currency.toUpperCase(),
                  ...(mask !== '' ? { mask } : {}),
                },
              ],
            },
          },
        }),
      );
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add this account.');
    }
  }

  const busy = createConnection.isPending || stepUp.busy;

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-account-name">Account name</Label>
        <Input
          id="manual-account-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Rental property, 2019 Honda Civic"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-account-type">Type</Label>
        <select
          id="manual-account-type"
          className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
          value={type}
          onChange={(event) => setType(event.target.value as Account['type'])}
        >
          {ACCOUNT_TYPES.map((accountType) => (
            <option key={accountType} value={accountType}>
              {accountType}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-account-currency">Currency</Label>
          <Input
            id="manual-account-currency"
            required
            maxLength={3}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-account-mask">Last 4 digits (optional)</Label>
          <Input
            id="manual-account-mask"
            maxLength={4}
            value={mask}
            onChange={(event) => setMask(event.target.value)}
          />
        </div>
      </div>

      {(error !== null || stepUp.error !== null) && (
        <p className="text-small text-status-danger-text">{error ?? stepUp.error}</p>
      )}

      <Button type="submit" disabled={busy || name === ''}>
        {busy ? 'Adding…' : 'Add account'}
      </Button>
    </form>
  );
}
