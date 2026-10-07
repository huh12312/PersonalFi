// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { ForkScenario } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useCreatePlanScenarioMutation } from './api.ts';
import { ProjectionProblem } from './ProjectionProblem.tsx';

export interface ScenarioForkFormProps {
  /** Called with the fork the server stored, so the screen can put it straight into the compare. */
  readonly onCreated: (fork: ForkScenario) => void;
}

/**
 * Fork the baseline with the levers that differ (`POST /plan/scenarios`, `kind: 'fork'`; WP 9.7, C-10).
 * Only the levers the holder fills in are sent — a fork stores what differs, and a fork that changes
 * nothing is refused by the server (`planning.scenario_levers_empty`), which this form words rather than
 * pre-empting: the server's rule has one home. The baseline is the server's to find, so no `baselineId`
 * is sent.
 */
export function ScenarioForkForm({ onCreated }: ScenarioForkFormProps) {
  const id = useId();
  const create = useCreatePlanScenarioMutation();
  const [name, setName] = useState('');
  const [retireAge, setRetireAge] = useState('');
  const [spending, setSpending] = useState('');
  const [returnShift, setReturnShift] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);
    if (name.trim() === '') {
      setFormError('Give the fork a name, for example “Retire at 62”.');
      return;
    }
    const levers: Extract<
      NonNullable<Parameters<typeof create.mutate>[0]>['body'],
      { kind: 'fork' }
    >['levers'] = {};
    if (retireAge.trim() !== '') {
      const age = Number(retireAge);
      if (!Number.isInteger(age) || age < 0 || age > 120) {
        setFormError('The retirement age must be a whole number of years.');
        return;
      }
      levers.retireAge = age;
    }
    if (spending.trim() !== '') {
      try {
        levers.annualSpending = MoneyKernel.toJSON(MoneyKernel.parseAmount(spending.trim(), 'USD'));
      } catch {
        setFormError('Annual spending must be a plain dollar amount, for example 60000.');
        return;
      }
    }
    if (returnShift.trim() !== '') {
      if (!/^-?\d+(\.\d+)?$/.test(returnShift.trim())) {
        setFormError('The return shift must be a plain decimal, for example -0.01.');
        return;
      }
      levers.expectedReturnShift = returnShift.trim();
    }
    create.mutate(
      { body: { kind: 'fork', name: name.trim(), levers } },
      {
        onSuccess: (created) => {
          if (created.kind === 'fork') onCreated(created);
          setName('');
          setRetireAge('');
          setSpending('');
          setReturnShift('');
        },
      },
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Fork the baseline"
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      noValidate
    >
      <p className="text-small text-text-secondary">
        Fork your baseline to try a change. Fill in only what should differ.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>Fork name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={96}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-retire`}>Retirement age</Label>
          <Input
            id={`${id}-retire`}
            inputMode="numeric"
            placeholder="62"
            value={retireAge}
            onChange={(e) => setRetireAge(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-spending`}>Annual spending</Label>
          <Input
            id={`${id}-spending`}
            inputMode="decimal"
            placeholder="60000"
            value={spending}
            onChange={(e) => setSpending(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-shift`}>Expected return shift</Label>
          <Input
            id={`${id}-shift`}
            inputMode="decimal"
            placeholder="-0.01"
            value={returnShift}
            onChange={(e) => setReturnShift(e.target.value)}
            autoComplete="off"
            aria-describedby={`${id}-shift-hint`}
          />
          <span id={`${id}-shift-hint`} className="text-caption text-text-muted">
            Added to the expected return, as a decimal: -0.01 is one point lower.
          </span>
        </div>
      </div>
      {formError !== null && (
        <p role="alert" className="text-small text-status-critical">
          {formError}
        </p>
      )}
      {create.isError && <ProjectionProblem error={create.error} />}
      <div>
        <Button type="submit" variant="secondary" disabled={create.isPending}>
          {create.isPending ? 'Forking…' : 'Fork and compare'}
        </Button>
      </div>
    </form>
  );
}
