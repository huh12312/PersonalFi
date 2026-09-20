// SPDX-License-Identifier: MIT
import { formatDateOnly } from '../../lib/date.ts';

/**
 * Pure formatting over `@ctx/recurring`'s wire vocabulary
 * (`apps/api/src/routes/recurring.ts`'s `seriesSchema`/`candidateSchema`/
 * `projectedChargeSchema`). No network, no React — every function here is a
 * string in, string out mapping so `RecurringScreen`'s rendering and this
 * file's own tests read the same value.
 */

/** The eight cadences `@ctx/recurring/src/types.ts` names, plus the honest "we don't know yet". */
export type CadenceCode =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'BIMONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL'
  | 'UNKNOWN';

const CADENCE_LABELS: Record<CadenceCode, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every 2 weeks',
  SEMIMONTHLY: 'Twice a month',
  MONTHLY: 'Monthly',
  BIMONTHLY: 'Every 2 months',
  QUARTERLY: 'Quarterly',
  SEMIANNUAL: 'Twice a year',
  ANNUAL: 'Yearly',
  UNKNOWN: 'Irregular',
};

/** A cadence code the wire never actually sends is treated as `UNKNOWN` rather than thrown on — a label is cosmetic, not a contract boundary. */
export function formatCadenceLabel(cadence: string): string {
  return CADENCE_LABELS[cadence as CadenceCode] ?? 'Irregular';
}

const AMOUNT_MODEL_LABELS: Record<string, string> = {
  FIXED: 'Fixed amount',
  VARIABLE: 'Varies',
  IRREGULAR: 'Irregular amount',
};

export function formatAmountModelLabel(model: string): string {
  return AMOUNT_MODEL_LABELS[model] ?? model;
}

/**
 * `GET /recurring/series` carries no explicit amount-model field — only the
 * observed range (`observedMin`/`observedMax`, both minor-unit strings in
 * the same currency). A stream whose observed extremes are identical never
 * varied; anything else has, so this reads the model off the range rather
 * than inventing a category the wire never sent.
 */
export function inferAmountModelLabel(observedMinMinor: string, observedMaxMinor: string): string {
  return observedMinMinor === observedMaxMinor ? 'Fixed amount' : 'Varies';
}

const STREAM_TYPE_LABELS: Record<string, string> = {
  SUBSCRIPTION: 'Subscription',
  RECURRING_BILL: 'Bill',
  RECURRING_INCOME: 'Income',
  LOAN_PAYMENT: 'Loan payment',
  FREQUENT_MERCHANT: 'Frequent charge',
  ONE_OFF: 'One-off',
};

export function formatStreamTypeLabel(type: string): string {
  return STREAM_TYPE_LABELS[type] ?? type;
}

/**
 * The dormancy ladder (07 §2.8), phrased as a question rather than an
 * accusation — 02-phase-2-dispatch.md §3's own instruction: "we haven't seen
 * a charge since…", never "you cancelled".
 */
const STATUS_COPY: Record<string, string> = {
  EARLY_DETECTION: 'Just noticed',
  ACTIVE: 'Active',
  AT_RISK: "Might be slowing down — we're watching",
  LIKELY_CANCELED: "Haven't seen a charge in a while",
  CANCELED: "Hasn't billed in a long time",
  MIGRATED: 'Looks like it moved to a new plan',
};

export function formatStatusLabel(status: string): string {
  return STATUS_COPY[status] ?? status;
}

/** Whether the dormancy status should read as a quiet notice rather than the default "Active" tone. */
export function isDormantStatus(status: string): boolean {
  return status === 'AT_RISK' || status === 'LIKELY_CANCELED' || status === 'CANCELED';
}

/**
 * "Next due Oct 1" or, when the detector's uncertainty band is wider than a
 * single day, "Next due around Oct 1 (Sep 30 – Oct 3)". `earliest`/`latest`
 * are `DateOnly` strings from a `ProjectedCharge`; a series on its own
 * (`GET /recurring/series`) carries only the point estimate `nextDueDate`; a
 * projected charge (`GET /recurring/upcoming` / `GET /recurring/forecast`)
 * carries the full band, which is why this takes the band as optional
 * fields rather than two separate functions that would drift apart.
 */
export function formatNextDue(
  nextDueDate: string | null,
  band?: { earliest: string; latest: string },
): string {
  if (nextDueDate === null) return 'No upcoming charge expected';
  const point = formatDateOnly(nextDueDate, 'MMM d');
  if (band === undefined || band.earliest === band.latest) {
    return `Next due ${point}`;
  }
  const earliest = formatDateOnly(band.earliest, 'MMM d');
  const latest = formatDateOnly(band.latest, 'MMM d');
  return `Next due around ${point} (${earliest} – ${latest})`;
}

/** The uncertainty band as its own short phrase, for a compact row that already shows the point date elsewhere. */
export function formatUncertaintyDays(uncertaintyDays: number): string {
  if (uncertaintyDays <= 0) return 'exact date';
  return uncertaintyDays === 1 ? '± 1 day' : `± ${String(uncertaintyDays)} days`;
}

/**
 * A duplicate-service group name, from the taxonomy node id
 * (`duplicateNode`, e.g. `entertainment.streaming`) into a readable label —
 * the last segment, title-cased. `@ctx/recurring`'s routes never send a
 * human label for this, only the taxonomy key.
 */
export function formatDuplicateGroupLabel(duplicateNode: string): string {
  const segment = duplicateNode.split('.').at(-1) ?? duplicateNode;
  return segment
    .split(/[-_]/u)
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}
