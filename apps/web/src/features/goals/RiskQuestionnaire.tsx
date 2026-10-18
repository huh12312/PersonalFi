// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { AnswerRiskProfileResponse, RiskItem } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { ProjectionProblem } from '../plan/ProjectionProblem.tsx';
import { useAnswerRiskProfileMutation, useRiskProfileQuery } from './api.ts';
import {
  DISPOSITION_LABELS,
  FILING_STATUS_LABELS,
  LIQUIDITY_LABELS,
  SELECT_CLASS,
  TOLERANCE_LABELS,
} from './labels.ts';
import { describeProfile } from './RiskProfileSummary.tsx';

const FRAMING_LABELS: Readonly<Record<RiskItem['framing'], string>> = {
  stated: 'What you say',
  revealed: 'What you have done',
};

type Liquidity = 'low' | 'medium' | 'high';
type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh';

/**
 * The risk questionnaire (WP 9.7, C-10; `GET`/`PUT /risk-profile`). The instrument asks each question
 * twice — once about what the holder says, once about what they have actually done — and the server's
 * consistency penalty moves the score toward the conservative answer when the two disagree. This screen
 * only collects answers and shows the derivation the server returns, sentence for sentence; it never
 * scores anything itself.
 */
export function RiskQuestionnaire() {
  const query = useRiskProfileQuery();
  const answer = useAnswerRiskProfileMutation();
  const id = useId();
  const [taking, setTaking] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [horizon, setHorizon] = useState('');
  const [liquidity, setLiquidity] = useState<Liquidity>('medium');
  const [income, setIncome] = useState('');
  const [filing, setFiling] = useState<FilingStatus>('single');
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerRiskProfileResponse | null>(null);

  const items = query.data?.items ?? [];
  const current = query.data?.current ?? null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);
    const unanswered = items.filter((item) => answers[item.id] === undefined);
    if (unanswered.length > 0) {
      setFormError(
        `Answer every question: ${String(unanswered.length)} ${unanswered.length === 1 ? 'is' : 'are'} still open.`,
      );
      return;
    }
    const years = Number(horizon);
    if (horizon.trim() === '' || !Number.isInteger(years) || years < 0 || years > 100) {
      setFormError('Enter the number of years until you start using this money, from 0 to 100.');
      return;
    }
    let incomeBody;
    if (income.trim() !== '') {
      try {
        incomeBody = {
          taxableIncome: MoneyKernel.toJSON(MoneyKernel.parseAmount(income.trim(), 'USD')),
          filingStatus: filing,
        };
      } catch {
        setFormError('Income must be a plain dollar figure, for example 85000, or left blank.');
        return;
      }
    }
    answer.mutate(
      {
        body: {
          answers,
          horizonYears: years,
          liquidityNeed: liquidity,
          ...(incomeBody === undefined ? {} : { income: incomeBody }),
        },
      },
      {
        onSuccess: (data) => {
          setResult(data);
          setTaking(false);
        },
      },
    );
  }

  return (
    <section
      id="risk-profile"
      aria-labelledby="risk-heading"
      className="flex scroll-mt-4 flex-col gap-4"
      data-testid="risk-questionnaire"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="risk-heading" className="text-h3 font-semibold text-text-primary">
          Risk profile
        </h2>
        {query.isSuccess && !taking && (
          <Button type="button" variant="secondary" onClick={() => setTaking(true)}>
            {current === null ? 'Take the questionnaire' : 'Retake the questionnaire'}
          </Button>
        )}
      </div>

      {query.isLoading && <Skeleton variant="block" height={80} />}
      {query.isError && (
        <ProjectionProblem error={query.error} onRetry={() => void query.refetch()} />
      )}

      {query.isSuccess && result === null && !taking && (
        <p className="text-small text-text-secondary" data-testid="risk-current">
          {current === null
            ? 'You have not answered the questionnaire yet. It asks six short questions, each about what you say and what you have done, and turns them into a risk tolerance.'
            : describeProfile(current)}
        </p>
      )}

      {result !== null && !taking && <RiskResult result={result} />}

      {taking && (
        <form
          onSubmit={handleSubmit}
          aria-label="Risk questionnaire"
          className="flex flex-col gap-5"
          noValidate
        >
          {items.map((item) => (
            <fieldset
              key={item.id}
              className="flex flex-col gap-2"
              data-testid={`risk-item-${item.id}`}
            >
              <legend className="text-small font-medium text-text-primary">
                <span className="mr-2 text-caption font-normal text-text-muted">
                  {DISPOSITION_LABELS[item.disposition] ?? item.disposition} ·{' '}
                  {FRAMING_LABELS[item.framing]}
                </span>
                <span className="block">{item.prompt}</span>
              </legend>
              {item.options.map((option) => (
                <label
                  key={option.id}
                  className="flex items-start gap-2 text-small text-text-primary"
                >
                  <input
                    type="radio"
                    name={`${id}-${item.id}`}
                    value={option.id}
                    checked={answers[item.id] === option.id}
                    onChange={() =>
                      setAnswers((previous) => ({ ...previous, [item.id]: option.id }))
                    }
                    className="mt-1"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
          ))}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-horizon`}>Years until you start using this money</Label>
              <Input
                id={`${id}-horizon`}
                inputMode="numeric"
                placeholder="25"
                value={horizon}
                onChange={(e) => setHorizon(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-liquidity`}>How soon might you need cash from it?</Label>
              <select
                id={`${id}-liquidity`}
                className={SELECT_CLASS}
                value={liquidity}
                onChange={(e) => setLiquidity(e.target.value as Liquidity)}
              >
                {(Object.keys(LIQUIDITY_LABELS) as Liquidity[]).map((value) => (
                  <option key={value} value={value}>
                    {LIQUIDITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-income`}>Taxable income, per year (optional)</Label>
              <Input
                id={`${id}-income`}
                inputMode="decimal"
                placeholder="85000"
                value={income}
                onChange={(e) => setIncome(e.target.value)}
                autoComplete="off"
                aria-describedby={`${id}-income-hint`}
              />
              <span id={`${id}-income-hint`} className="text-caption text-text-muted">
                Used once to work out your tax bracket band. The figure itself is never stored.
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-filing`}>Filing status</Label>
              <select
                id={`${id}-filing`}
                className={SELECT_CLASS}
                value={filing}
                onChange={(e) => setFiling(e.target.value as FilingStatus)}
              >
                {(Object.keys(FILING_STATUS_LABELS) as FilingStatus[]).map((value) => (
                  <option key={value} value={value}>
                    {FILING_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {formError !== null && (
            <p role="alert" className="text-small text-status-danger-text">
              {formError}
            </p>
          )}
          {answer.isError && <ProjectionProblem error={answer.error} />}

          <div className="flex gap-2">
            <Button type="submit" disabled={answer.isPending}>
              {answer.isPending ? 'Scoring…' : 'See my risk profile'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setTaking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The derivation the server returned, with its own explanation sentences verbatim. */
function RiskResult({ result }: { readonly result: AnswerRiskProfileResponse }) {
  const { profile, derivation } = result;
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      data-testid="risk-result"
    >
      <p className="text-body font-semibold text-text-primary" data-testid="risk-result-tolerance">
        {TOLERANCE_LABELS[profile.tolerance]}
      </p>
      <p className="text-small text-text-secondary">
        Score {derivation.compositeScore}
        {derivation.consistencyPenalty > 0
          ? `, after a consistency penalty of ${String(derivation.consistencyPenalty)} from ${String(derivation.unpenalisedScore)}. Averaging your answers would have said ${TOLERANCE_LABELS[derivation.toleranceIfAveraged].toLowerCase()}.`
          : ', with no consistency penalty: what you say and what you have done agree.'}
      </p>
      {derivation.explanation.length > 0 && (
        <ul className="list-disc pl-5 text-small text-text-primary" data-testid="risk-explanation">
          {derivation.explanation.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
