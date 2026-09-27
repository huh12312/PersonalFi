// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import type { CreatePlanScenarioData } from '../../api/generated/types.gen.ts';

export interface BaselinePlanFormProps {
  readonly onSubmit: (body: CreatePlanScenarioData['body']) => void;
  readonly pending: boolean;
  readonly error: string | null;
}

/**
 * Creates the baseline scenario `POST /plan/scenarios` needs before any
 * projection can run. Deliberately minimal — three required fields plus one
 * optional spending override — because a full plan-profile editor (glidepath
 * tuning, pensions, Social Security claim strategy) is not one of WP 4.10's
 * five named exit tests; every field this form does not ask about takes the
 * engine's own documented default (age-based glidepath, wage-indexed
 * contribution growth, guardrails withdrawal policy over essential spend —
 * `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.4").
 */
export function BaselinePlanForm({ onSubmit, pending, error }: BaselinePlanFormProps) {
  const [name, setName] = useState('My plan');
  const [birthDate, setBirthDate] = useState('');
  const [retirementAge, setRetirementAge] = useState('65');
  const [planEndAge, setPlanEndAge] = useState('95');
  const [annualSpending, setAnnualSpending] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);
    if (birthDate === '') {
      setFormError('Enter a birth date.');
      return;
    }
    let spendingMoney: { minor: string; currency: string } | null = null;
    if (annualSpending.trim() !== '') {
      try {
        spendingMoney = MoneyKernel.toJSON(MoneyKernel.parseAmount(annualSpending.trim(), 'USD'));
      } catch {
        setFormError('Annual spending must be a plain dollar amount, e.g. 60000.');
        return;
      }
    }

    onSubmit({
      kind: 'baseline',
      name,
      profile: {
        birthDate,
        retirementAge: Number(retirementAge),
        planEndAge: Number(planEndAge),
        currency: 'USD',
        glidepath: { kind: 'age_based' },
        contributionGrowth: 'wage',
        annualSpending: spendingMoney,
        withdrawalPolicy: 'guardrails',
        spendingFloor: 'essential_spend',
        taxDeferredRate: '0.22',
        socialSecurity: null,
        pensions: [],
        contributions: null,
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Start your plan">
      <div>
        <Label htmlFor="plan-name">Plan name</Label>
        <Input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="plan-birth-date">Birth date</Label>
        <Input
          id="plan-birth-date"
          type="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="plan-retirement-age">Retirement age</Label>
          <Input
            id="plan-retirement-age"
            type="number"
            min={1}
            max={120}
            value={retirementAge}
            onChange={(e) => setRetirementAge(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="plan-end-age">Plan end age</Label>
          <Input
            id="plan-end-age"
            type="number"
            min={1}
            max={130}
            value={planEndAge}
            onChange={(e) => setPlanEndAge(e.target.value)}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="plan-annual-spending">
          Annual retirement spending (optional — leave blank to derive it from your observed
          spending)
        </Label>
        <Input
          id="plan-annual-spending"
          inputMode="decimal"
          placeholder="60000"
          value={annualSpending}
          onChange={(e) => setAnnualSpending(e.target.value)}
        />
      </div>
      {(formError ?? error) !== null && (
        <p className="text-small text-status-critical" role="alert">
          {formError ?? error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Start your plan'}
      </Button>
    </form>
  );
}
