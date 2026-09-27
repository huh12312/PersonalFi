// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import type { CreatePlanLifeEventData, PlanLifeEvent } from '../../api/generated/types.gen.ts';

const KINDS: readonly { value: PlanLifeEvent['kind']; label: string }[] = [
  { value: 'inheritance', label: 'Inheritance' },
  { value: 'home_purchase', label: 'Home purchase' },
  { value: 'college', label: 'College' },
  { value: 'sabbatical', label: 'Sabbatical' },
  { value: 'windfall', label: 'Windfall' },
  { value: 'other', label: 'Other' },
];

export interface LifeEventFormProps {
  readonly onSubmit: (body: CreatePlanLifeEventData['body']) => void;
  readonly pending: boolean;
}

/** `POST /plan/life-events` — the one write `LifeEventsTimeline.tsx` (the drag) does not itself offer. */
export function LifeEventForm({ onSubmit, pending }: LifeEventFormProps) {
  const [kind, setKind] = useState<PlanLifeEvent['kind']>('windfall');
  const [name, setName] = useState('');
  const [occursOn, setOccursOn] = useState('');
  const [amountDollars, setAmountDollars] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    if (name.trim() === '' || occursOn.trim() === '' || amountDollars.trim() === '') {
      setError('Enter a name, a date, and an amount.');
      return;
    }
    try {
      const amount = MoneyKernel.toJSON(MoneyKernel.parseAmount(amountDollars.trim(), 'USD'));
      onSubmit({ kind, name: name.trim(), occursOn: occursOn.trim(), amount });
      setName('');
      setOccursOn('');
      setAmountDollars('');
    } catch {
      setError('Amount must be a plain dollar figure, e.g. 40000 (negative for an expense).');
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3"
      aria-label="Add a life event"
    >
      <div>
        <Label htmlFor="life-event-kind">Kind</Label>
        <select
          id="life-event-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as PlanLifeEvent['kind'])}
          className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="life-event-name">Name</Label>
        <Input
          id="life-event-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-40"
        />
      </div>
      <div>
        <Label htmlFor="life-event-date">Date</Label>
        <Input
          id="life-event-date"
          type="date"
          value={occursOn}
          onChange={(e) => setOccursOn(e.target.value)}
          className="w-40"
        />
      </div>
      <div>
        <Label htmlFor="life-event-amount">Amount</Label>
        <Input
          id="life-event-amount"
          inputMode="decimal"
          placeholder="40000"
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          className="w-32"
        />
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Adding…' : 'Add event'}
      </Button>
      {error !== null && (
        <p role="alert" className="w-full text-small text-status-critical">
          {error}
        </p>
      )}
    </form>
  );
}
