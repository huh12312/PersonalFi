// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { DEFAULT_GOAL_CURRENCY } from './search.ts';

export interface GoalControlsValue {
  readonly goalTargetMinor?: string;
  readonly goalCurrency?: string;
  readonly goalDate?: string;
  readonly maxMonthlyMinor?: string;
}

export interface GoalControlsProps {
  readonly value: GoalControlsValue;
  readonly onApply: (next: GoalControlsValue) => void;
}

function minorToDollarInput(minor: string | undefined): string {
  if (minor === undefined) return '';
  const asNumber = Number(minor) / 100;
  return Number.isFinite(asNumber) ? String(asNumber) : '';
}

/**
 * The ad hoc goal target that feeds the fan chart's dashed goal line and the
 * dotted gap line's `POST /plan/required-savings` call — `./search.ts`'s own
 * header explains why this is a URL-stated target rather than a saved `Goal`
 * row (WP 4.8 published no route tying a saved goal to a projection's
 * chart). Every field round-trips through `@core/kernel`'s `Money` so a
 * dollar figure typed here becomes minor units exactly once, at this
 * boundary, per `docs/CONVENTIONS.md`'s "no client-side money math beyond
 * formatting" — this is parsing input, not computing a result.
 */
export function GoalControls({ value, onApply }: GoalControlsProps) {
  const [targetDollars, setTargetDollars] = useState(minorToDollarInput(value.goalTargetMinor));
  const [date, setDate] = useState(value.goalDate ?? '');
  const [maxMonthlyDollars, setMaxMonthlyDollars] = useState(
    minorToDollarInput(value.maxMonthlyMinor),
  );
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    if (targetDollars.trim() === '' || date.trim() === '' || maxMonthlyDollars.trim() === '') {
      setError('Enter a target amount, a target date, and a monthly ceiling.');
      return;
    }
    try {
      const target = MoneyKernel.toJSON(MoneyKernel.parseAmount(targetDollars.trim(), 'USD'));
      const maxMonthly = MoneyKernel.toJSON(
        MoneyKernel.parseAmount(maxMonthlyDollars.trim(), 'USD'),
      );
      onApply({
        goalTargetMinor: target.minor,
        goalCurrency: DEFAULT_GOAL_CURRENCY,
        goalDate: date.trim(),
        maxMonthlyMinor: maxMonthly.minor,
      });
    } catch {
      setError('Amounts must be plain dollar figures, e.g. 2000000.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3" aria-label="Goal">
      <div>
        <Label htmlFor="goal-target">Target amount</Label>
        <Input
          id="goal-target"
          inputMode="decimal"
          placeholder="2000000"
          value={targetDollars}
          onChange={(e) => setTargetDollars(e.target.value)}
          className="w-32"
        />
      </div>
      <div>
        <Label htmlFor="goal-date">By date</Label>
        <Input
          id="goal-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-40"
        />
      </div>
      <div>
        <Label htmlFor="goal-max-monthly">Max extra monthly saving to consider</Label>
        <Input
          id="goal-max-monthly"
          inputMode="decimal"
          placeholder="2000"
          value={maxMonthlyDollars}
          onChange={(e) => setMaxMonthlyDollars(e.target.value)}
          className="w-32"
        />
      </div>
      <Button type="submit" variant="secondary">
        Set goal
      </Button>
      {error !== null && (
        <p role="alert" className="w-full text-small text-status-danger-text">
          {error}
        </p>
      )}
    </form>
  );
}
