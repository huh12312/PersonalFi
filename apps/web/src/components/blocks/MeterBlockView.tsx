// SPDX-License-Identifier: MIT
import { money as moneyOf } from '@core/kernel';

import { BudgetMeterRow } from '../finance/BudgetMeter.tsx';
import type { MeterFigures, PaceStatus } from '../finance/budget-meter.ts';
import type { Block } from './schema.ts';

type MeterBlock = Extract<Block, { kind: 'meter' }>;

/**
 * `meter`: the budget meter (`BudgetMeterRow`, WP 10.11) — its state the block's (the server decided it; the row
 * draws it, it does not re-decide), the pace tick at `tickPercent`, said in words as the share of the period elapsed.
 * A `no_budget` meter draws no bar and says "no amount set". `remaining` is `budgeted − spent`, the identity the
 * envelope already holds (07 §1.2), so the "left" / "over" line is the block's two figures, not a third one.
 */
export function MeterBlockView({ block }: { readonly block: MeterBlock }) {
  const budgeted = moneyOf(BigInt(block.budgetedMinor), block.currency);
  const spent = moneyOf(BigInt(block.spentMinor), block.currency);
  const figures: MeterFigures = {
    budgeted,
    spent,
    remaining: moneyOf(budgeted.minor - spent.minor, block.currency),
    rolledOver: moneyOf(0n, block.currency),
  };
  const pace: PaceStatus =
    block.tickPercent === undefined
      ? { kind: 'over' }
      : {
          kind: 'running',
          day: Math.round(block.tickPercent),
          days: 100,
          fraction: block.tickPercent / 100,
        };
  const paceText =
    block.tickPercent === undefined
      ? 'no pace: the period is not running'
      : `${String(Math.round(block.tickPercent))}% of the period elapsed`;
  return (
    <BudgetMeterRow
      title={block.label}
      label={block.label}
      figures={figures}
      pace={pace}
      state={block.state}
      paceText={paceText}
    />
  );
}
