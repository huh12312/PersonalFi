// SPDX-License-Identifier: MIT
/**
 * Living expenses from the budget's own classification (WP 10.12, V5; V4 gave categories a
 * `variability`). Monarch asks a questionnaire which categories are fixed; PersonalFi reads the answer the
 * holder already gave on the Budget screen.
 *
 * ## The rule
 *
 * - **Fixed:** Σ net outflow in categories classified `fixed` over the **three complete calendar months**
 *   before today's month, ÷ 3.
 * - **The fixed share of non-monthly:** Σ net outflow in categories classified `non_monthly` over the
 *   **twelve complete calendar months** before today's month, ÷ 12. A non-monthly bill (insurance paid
 *   yearly, a registration, a tax bill) is a fixed cost that does not land every month; spread over the
 *   year it is what a month has to carry for it. A three-month window would either miss it or count it
 *   three times over.
 * - **Living expenses per month = fixed + the fixed share of non-monthly.** Flexible categories and
 *   unclassified ones are never counted.
 * - Net outflow per category: −Σ signed amount over the window (negative = outflow, refunds netted the way
 *   Reports nets them), floored at zero per category, so a category refunded more than it spent subtracts
 *   nothing from another.
 * - Division is integer, half-even, in minor units: never a float in a money path.
 * - **Withheld** (never a zero) when no category is classified `fixed` or `non_monthly` — the unlock is
 *   "classify your categories on the Budget screen" — or when the classified categories had no spending in
 *   their windows.
 *
 * ## What it feeds
 *
 * The emergency-fund pillar shows "months of living expenses your cash covers" beside its scored figure.
 * The **score itself is unchanged**: `emergency_fund_months` already has a defined input (cash ÷ the
 * six-month average of all spending, `snapshot/builder.ts`), and WP 10.12's dispatch forbids changing a
 * factor that has one. Recorded in docs/evidence/phase-10/wp10.12-health-gauge.md.
 */
import { DateOnly, type DateOnly as DateOnlyType, type MoneyJson } from '@core/kernel';

export const LIVING_EXPENSES_FIXED_MONTHS = 3;
export const LIVING_EXPENSES_NON_MONTHLY_MONTHS = 12;
export const CLASSIFY_UNLOCK = 'Classify your categories on the Budget screen.';

export type CategoryVariabilityValue = 'fixed' | 'flexible' | 'non_monthly';

export interface LivingExpensesCategory {
  readonly id: string;
  readonly variability: CategoryVariabilityValue | null;
}

/** One (month, category) spending cell — Reports' own cell (`GET /reports/spending`), signed. */
export interface LivingExpensesCell {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly categoryId: string | null;
  /** Signed minor units: negative = outflow. */
  readonly amountMinor: bigint;
}

export interface LivingExpensesSource {
  readonly currency: string;
  readonly categories: readonly LivingExpensesCategory[];
  /** At least the twelve complete months before today's month. Cells outside a window are ignored. */
  readonly cells: readonly LivingExpensesCell[];
}

/**
 * What the composition root binds: the holder's categories with their variability and Reports' spending
 * cells over `window` (inclusive dates). `@ctx/insights` never imports categorization or ledger.
 */
export type LivingExpensesPort = (input: {
  readonly userId: string;
  readonly window: { readonly from: DateOnlyType; readonly to: DateOnlyType };
}) => Promise<LivingExpensesSource>;

export interface MonthWindow {
  /** `YYYY-MM`, inclusive. */
  readonly from: string;
  /** `YYYY-MM`, inclusive. */
  readonly to: string;
}

export type LivingExpenses =
  | {
      readonly status: 'computed';
      /** Fixed + the fixed share of non-monthly, per month. */
      readonly monthly: MoneyJson;
      readonly fixedMonthlyAverage: MoneyJson;
      readonly nonMonthlyMonthlyShare: MoneyJson;
      readonly fixedCategoryCount: number;
      readonly nonMonthlyCategoryCount: number;
      readonly fixedWindow: MonthWindow;
      readonly nonMonthlyWindow: MonthWindow;
    }
  | { readonly status: 'withheld'; readonly reason: string; readonly unlock: string };

function monthKey(date: DateOnlyType): string {
  return date.slice(0, 7);
}

/** The `count` complete calendar months before `today`'s month, as an inclusive `YYYY-MM` window. */
export function completeMonthsBefore(today: DateOnlyType, count: number): MonthWindow {
  const thisMonth = DateOnly.startOfMonth(today);
  return {
    from: monthKey(DateOnly.addMonths(thisMonth, -count)),
    to: monthKey(DateOnly.addMonths(thisMonth, -1)),
  };
}

/** The inclusive date window the port must read: the longest of the two month windows. */
export function livingExpensesReadWindow(today: DateOnlyType): {
  readonly from: DateOnlyType;
  readonly to: DateOnlyType;
} {
  const thisMonth = DateOnly.startOfMonth(today);
  return {
    from: DateOnly.addMonths(thisMonth, -LIVING_EXPENSES_NON_MONTHLY_MONTHS),
    to: DateOnly.addDays(thisMonth, -1),
  };
}

/** Half-even integer division of a non-negative numerator by a positive divisor. */
export function divideHalfEvenMinor(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const twice = remainder * 2n;
  if (twice > divisor) return quotient + 1n;
  if (twice < divisor) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function inWindow(month: string, window: MonthWindow): boolean {
  return month >= window.from && month <= window.to;
}

/** Σ net outflow per category over the window, each floored at zero, summed. */
function outflowOver(
  cells: readonly LivingExpensesCell[],
  categoryIds: ReadonlySet<string>,
  window: MonthWindow,
): bigint {
  const perCategory = new Map<string, bigint>();
  for (const cell of cells) {
    if (cell.categoryId === null || !categoryIds.has(cell.categoryId)) continue;
    if (!inWindow(cell.month, window)) continue;
    perCategory.set(cell.categoryId, (perCategory.get(cell.categoryId) ?? 0n) - cell.amountMinor);
  }
  let total = 0n;
  for (const outflow of perCategory.values()) if (outflow > 0n) total += outflow;
  return total;
}

/** Pure. See this file's header for the rule. */
export function computeLivingExpenses(
  source: LivingExpensesSource,
  today: DateOnlyType,
): LivingExpenses {
  const fixedIds = new Set(
    source.categories.filter((c) => c.variability === 'fixed').map((c) => c.id),
  );
  const nonMonthlyIds = new Set(
    source.categories.filter((c) => c.variability === 'non_monthly').map((c) => c.id),
  );
  if (fixedIds.size === 0 && nonMonthlyIds.size === 0) {
    return {
      status: 'withheld',
      reason: 'No category is classified as fixed or non-monthly yet.',
      unlock: CLASSIFY_UNLOCK,
    };
  }
  const fixedWindow = completeMonthsBefore(today, LIVING_EXPENSES_FIXED_MONTHS);
  const nonMonthlyWindow = completeMonthsBefore(today, LIVING_EXPENSES_NON_MONTHLY_MONTHS);
  const fixedAverage = divideHalfEvenMinor(
    outflowOver(source.cells, fixedIds, fixedWindow),
    BigInt(LIVING_EXPENSES_FIXED_MONTHS),
  );
  const nonMonthlyShare = divideHalfEvenMinor(
    outflowOver(source.cells, nonMonthlyIds, nonMonthlyWindow),
    BigInt(LIVING_EXPENSES_NON_MONTHLY_MONTHS),
  );
  const monthly = fixedAverage + nonMonthlyShare;
  if (monthly <= 0n) {
    return {
      status: 'withheld',
      reason:
        'Your fixed and non-monthly categories had no spending in the months this reads ' +
        `(${fixedWindow.from} to ${fixedWindow.to} for fixed, ${nonMonthlyWindow.from} to ` +
        `${nonMonthlyWindow.to} for non-monthly).`,
      unlock:
        'Check that your rent, bills and other fixed costs are in categories classified fixed.',
    };
  }
  const json = (minor: bigint): MoneyJson => ({
    minor: minor.toString(),
    currency: source.currency,
  });
  return {
    status: 'computed',
    monthly: json(monthly),
    fixedMonthlyAverage: json(fixedAverage),
    nonMonthlyMonthlyShare: json(nonMonthlyShare),
    fixedCategoryCount: fixedIds.size,
    nonMonthlyCategoryCount: nonMonthlyIds.size,
    fixedWindow,
    nonMonthlyWindow,
  };
}
