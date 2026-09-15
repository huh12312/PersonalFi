// SPDX-License-Identifier: MIT
/**
 * Wire scalars, named once.
 *
 * Every route below `routes/` speaks these four shapes and nothing else invents
 * its own spelling of them. That matters more than it looks: `.meta({ id })`
 * hoists a schema into `components.schemas`, so a second, structurally identical
 * `Money` object declared in `transactions.ts` would not merge with this one —
 * it would appear in the generated client as a *different type*, and a payload
 * that flowed from `/accounts` into `/transactions` would need a cast.
 *
 * The conventions encoded here come from docs/CONVENTIONS.md:
 *
 *   * **Money is `{ minor: string, currency }`.** `bigint` does not survive
 *     `JSON.stringify` and an IEEE-754 number cannot hold a cent.
 *   * **Instants are ISO-8601 strings, business dates are `YYYY-MM-DD`.** They
 *     are never the same type: converting a bank's posted date through a
 *     timezone is how a 2026-03-01 transaction becomes 2026-02-28.
 */
import { DateOnly, Money, type Money as MoneyType } from '@core/kernel';
import { z } from 'zod';

/** An instant, UTC, ISO 8601. */
export const isoInstant = z.string();

/** A business date. No zone, ever. */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'a business date is YYYY-MM-DD with no zone');

/** A business date arriving in a query string, validated into a `DateOnly`. */
export const dateOnlyQuery = dateOnly.refine(
  (value) => DateOnly.is(value),
  'not a calendar date that exists',
);

export const moneySchema = z
  .object({
    minor: z.string().describe('Minor units as a decimal string. Never a JSON number.'),
    currency: z.string().length(3),
  })
  .meta({ id: 'Money', description: 'An amount of money. Negative is an outflow.' });

export function money(value: MoneyType): z.infer<typeof moneySchema> {
  return Money.toJSON(value);
}

export function moneyOrNull(value: MoneyType | null): z.infer<typeof moneySchema> | null {
  return value === null ? null : Money.toJSON(value);
}

/** `Date | null` → ISO string or `null`, spelled once so nobody writes `?? ''`. */
export function instantOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * A repeatable query parameter, accepted either as `?a=1&a=2` or `?a=1,2`.
 *
 * Both spellings exist in the wild and a client that guesses wrong gets a silent
 * single-element filter rather than an error, so both are accepted here and
 * normalised to an array before anything reads them.
 */
export const idList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value): readonly string[] | undefined => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(','));
    const ids = parts.map((item) => item.trim()).filter((item) => item.length > 0);
    return ids.length === 0 ? undefined : ids;
  });

/** Minor units in a query string. A string, for the reason `Money` is. */
export const minorQuery = z
  .string()
  .regex(/^[+-]?\d+$/u, 'minor units are an integer, as a string')
  .optional()
  .transform((value) => (value === undefined ? undefined : BigInt(value)));

/** `?flag=true` / `?flag=1`. Absent means "the route's default", never `false`. */
export const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true' || value === '1'));
