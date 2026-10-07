// SPDX-License-Identifier: MIT
/**
 * The words for the contract's enums on the goals and questionnaire screens. Each table is typed by the
 * generated enum, so a value the contract gains is a compile error here until it has words.
 */
import type { Goal, GoalContribution, RiskProfile } from '../../api/generated/types.gen.ts';

export const GOAL_KIND_LABELS: Readonly<Record<Goal['kind'], string>> = {
  retirement: 'Retirement',
  emergency_fund: 'Emergency fund',
  purchase: 'A purchase',
  sabbatical: 'Sabbatical',
  custom: 'Something else',
};

export const GOAL_STATUS_LABELS: Readonly<Record<Goal['status'], string>> = {
  active: 'Active',
  paused: 'Paused',
  achieved: 'Achieved',
  abandoned: 'Abandoned',
};

export const CADENCE_LABELS: Readonly<Record<GoalContribution['cadence'], string>> = {
  weekly: 'Every week',
  biweekly: 'Every two weeks',
  semimonthly: 'Twice a month',
  monthly: 'Every month',
  quarterly: 'Every quarter',
  annually: 'Every year',
};

export const TOLERANCE_LABELS: Readonly<Record<RiskProfile['tolerance'], string>> = {
  conservative: 'Conservative',
  moderate_conservative: 'Moderately conservative',
  moderate: 'Moderate',
  moderate_aggressive: 'Moderately aggressive',
  aggressive: 'Aggressive',
};

export const LIQUIDITY_LABELS: Readonly<Record<RiskProfile['liquidityNeed'], string>> = {
  low: 'Low: I will not need this money soon',
  medium: 'Medium: I might need some of it',
  high: 'High: I may need it soon',
};

export const DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  drawdown: 'When investments fall',
  volatility: 'Range of outcomes',
  risk_identity: 'How you see yourself',
};

export const FILING_STATUS_LABELS: Readonly<Record<'single' | 'mfj' | 'mfs' | 'hoh', string>> = {
  single: 'Single',
  mfj: 'Married filing jointly',
  mfs: 'Married filing separately',
  hoh: 'Head of household',
};

/** The class every native `<select>` on these screens shares — the shape `features/plan` already uses. */
export const SELECT_CLASS =
  'h-10 w-full rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none';
