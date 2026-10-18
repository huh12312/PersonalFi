// SPDX-License-Identifier: MIT
/**
 * `@core/kernel` — the shared kernel.
 *
 * Owns no tables, imports no infrastructure, holds no business rules. Only the
 * types every bounded context must agree on. Adding something here is a
 * cross-cutting decision: if you are tempted to, it probably belongs in a context.
 *
 * The public surface is deliberately namespaced (`Money.add`, `DateOnly.addDays`)
 * rather than a flat spray of `add`/`compare`/`format`, because a shared kernel
 * that exports generic verbs becomes unimportable the first time two of them clash.
 */
export type { Brand } from './brand.ts';
export { KernelError, CurrencyMismatchError, InvalidValueError } from './errors.ts';
export { currency, isCurrencyCode, minorUnitScale, USD, type CurrencyCode } from './currency.ts';
export { Money, money, type MoneyJson, type RoundingMode } from './money.ts';
export {
  Quantity,
  quantity,
  ZERO_QUANTITY,
  QUANTITY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_MAX_INTEGER_DIGITS,
} from './quantity.ts';
export { DateOnly, dateOnly, parseDateOnly } from './date-only.ts';
export {
  systemClock,
  fixedClock,
  mutableClock,
  todayIn,
  type Clock,
  type MutableClock,
} from './clock.ts';
export {
  newId,
  parseId,
  isUuid,
  isUuidV7,
  timestampOfUuidV7,
  type Id,
  type UserId,
  type AccountId,
  type TransactionId,
  type ConnectionId,
  type CategoryId,
  type SecurityId,
  type InsightId,
  type EventId,
} from './ids.ts';
export {
  Stats,
  medianMinor,
  twiceMedianMinor,
  madMinor,
  medianNumber,
  madNumber,
} from './stats.ts';
export { CHART_HUES, isChartHue, hueForId, type ChartHue } from './hue.ts';
