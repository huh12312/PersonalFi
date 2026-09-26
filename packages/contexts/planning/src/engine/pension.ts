// SPDX-License-Identifier: MIT
/**
 * Pensions and other income streams — typed, each with its own COLA flag.
 *
 * The engine works in today's dollars (07 §5.2), and a pension is the one input
 * a user usually knows in *nominal* terms: "$2,500 a month from 65". Whether
 * that figure keeps its purchasing power is exactly the COLA flag:
 *
 *   * `cpi` — indexed to inflation from its start: a constant real stream, worth
 *     `nominal / (1 + i)^(years until it starts)` in today's dollars.
 *   * `none` — fixed nominal: its real value erodes by `(1 + i)` every year,
 *     before *and* after it starts. A 30-year retirement at 2.5% inflation loses
 *     about half of it, which is the reason this flag exists.
 *   * `fixed` — a stated nominal COLA (a 2% escalator): real growth
 *     `(1 + cola) / (1 + i)` per year once paying.
 *
 * `IncomeStream` is the other lever 07 §5.10 names (`part_time_income`) and is
 * already in today's dollars, so it needs no deflation.
 *
 * Interior module: `number` throughout, never money. Year `t` is the `t`-th
 * year of the projection; flows are at the start of the year, the same timing
 * the decumulation recursion `(B_t − W_t − tax_t)(1 + r)` uses.
 */

export type EnginePensionCola =
  | { readonly kind: 'none' }
  | { readonly kind: 'cpi' }
  | { readonly kind: 'fixed'; readonly rate: number };

export interface EnginePension {
  readonly startAge: number;
  /** The annual payment when it starts, in *nominal* dollars of that year. */
  readonly annualAtStart: number;
  readonly cola: EnginePensionCola;
}

export interface EngineIncomeStream {
  readonly startAge: number;
  /** Exclusive: paid for ages `startAge ≤ age < endAge`. */
  readonly endAge: number;
  /** Annual, today's dollars. */
  readonly annualReal: number;
}

/**
 * The pension's payment in projection year `t` (age `age`), in today's dollars.
 * `yearsFromNow` is `t`; `inflation` is the plan's expected annual rate.
 */
export function pensionForYear(
  pension: EnginePension,
  age: number,
  yearsFromNow: number,
  inflation: number,
): number {
  if (age < pension.startAge) return 0;
  const yearsPaying = age - pension.startAge;
  let nominal: number;
  switch (pension.cola.kind) {
    case 'none':
      nominal = pension.annualAtStart;
      break;
    case 'cpi':
      nominal = pension.annualAtStart * (1 + inflation) ** yearsPaying;
      break;
    case 'fixed':
      nominal = pension.annualAtStart * (1 + pension.cola.rate) ** yearsPaying;
      break;
  }
  return nominal / (1 + inflation) ** yearsFromNow;
}

export function incomeForYear(stream: EngineIncomeStream, age: number): number {
  return age >= stream.startAge && age < stream.endAge ? stream.annualReal : 0;
}
