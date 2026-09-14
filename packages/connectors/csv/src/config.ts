// SPDX-License-Identifier: MIT
/**
 * Mapping profiles as user data: the schema a **stored** profile is checked by.
 *
 * 08 §2.6 — "Mapping profiles are user data, stored per institution" — puts a
 * `CsvProfile` in `connections.config` (JSONB, migration 0005), alongside the
 * datasets the user enabled. It comes back out of the driver as `unknown`, and
 * an `unknown` asserted to `CsvProfile` is not validation: TypeScript erased the
 * type before the row was ever read, so every field of a profile that drifted —
 * hand-edited, restored from an older backup, written by a UI that shipped a
 * typo — survives the assertion intact.
 *
 * Which matters because the failures are **silent**, not loud. The worst one:
 *
 * ```ts
 * // stored: { ..., "amountSign": "reversed" }   ← not one of the two values
 * (options.sign ?? 'natural') === 'inverted'     // scalars.ts: false
 * ```
 *
 * `'reversed'` is not `'inverted'`, so the profile is read as `natural` and a
 * credit-card statement imports with every row's sign backwards. Nothing throws,
 * no row is skipped, and the first thing that notices is the user's budget. The
 * same shape of bug hides in `delimiter: ';;'` (`readCsv` throws, but only after
 * the profile has already been handed round), in a `mapping` that lost its
 * amount column, and in `dateFormat: 'DMY'`.
 *
 * So: one zod schema per stored shape, parsed at the edge, raising the same
 * `CONFIG_ERROR` the rest of this package raises for a file the user got wrong.
 * The presets in `src/presets.ts` are starting points and stay frozen constants;
 * this file is about the profiles that came back from the database.
 *
 * This package still owns no table (`OWNERSHIP.md`): the schema travels *to*
 * `@ctx/connections`, which owns `connections`, rather than the other way round.
 */
import { ConnectorError } from '@connector/port';
import { z } from 'zod';
import type { CsvColumnMapping, ColumnRef } from './csv.ts';
import { presetById, type CsvProfile } from './presets.ts';
import { DATE_FORMATS } from './scalars.ts';

/**
 * A column named by header text, or by 0-based index for a headerless export.
 *
 * An empty header name is refused rather than accepted and matched against
 * nothing: `resolveColumns` folds `''` out of its index, so a profile with
 * `date: ''` would report "the file has no column named ''" from one layer
 * further away than the mistake.
 */
const columnRefSchema: z.ZodType<ColumnRef> = z.union([
  z.string().min(1),
  z.number().int().nonnegative(),
]);

/**
 * Which column holds what, validated.
 *
 * `date` and `description` are required because `resolveColumns` requires them;
 * the amount rule is the schema form of `importFile`'s "the profile maps neither
 * an amount column nor a debit/credit pair". Checking it here means the profile
 * is rejected when it is *stored or loaded*, not when the user next uploads a
 * statement and gets an error about a file that is perfectly fine.
 */
export const csvColumnMappingSchema = z
  .object({
    date: columnRefSchema,
    description: columnRefSchema,
    amount: columnRefSchema.optional(),
    debit: columnRefSchema.optional(),
    credit: columnRefSchema.optional(),
    payee: columnRefSchema.optional(),
    memo: columnRefSchema.optional(),
    currency: columnRefSchema.optional(),
    reference: columnRefSchema.optional(),
  })
  .refine(
    (mapping) =>
      mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined,
    { error: 'map either an amount column or a debit/credit pair' },
  )
  // Rebuilt key by key rather than returned as parsed: under
  // `exactOptionalPropertyTypes`, `{ amount: undefined }` and `{}` are different
  // types, and zod's inferred output is the first. Same reasoning, and the same
  // shape, as `CsvImportConnector.addFile`'s request builder.
  .transform((mapping): CsvColumnMapping => ({
    date: mapping.date,
    description: mapping.description,
    ...(mapping.amount === undefined ? {} : { amount: mapping.amount }),
    ...(mapping.debit === undefined ? {} : { debit: mapping.debit }),
    ...(mapping.credit === undefined ? {} : { credit: mapping.credit }),
    ...(mapping.payee === undefined ? {} : { payee: mapping.payee }),
    ...(mapping.memo === undefined ? {} : { memo: mapping.memo }),
    ...(mapping.currency === undefined ? {} : { currency: mapping.currency }),
    ...(mapping.reference === undefined ? {} : { reference: mapping.reference }),
  }));

/**
 * One institution's import profile, exactly.
 *
 * Every field is required. A partial profile is not a profile with defaults: a
 * missing `dateFormat` would be read as `undefined` and then as `'auto'`, which
 * resolves `01/02/2026` as January — the one reading `parseFileDate` refuses to
 * guess at precisely because a silently wrong month is a whole budget in the
 * wrong place. If a default is wanted, it belongs in the UI that writes the
 * profile, where the user can see it.
 */
export const csvProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // One character, checked here rather than by `readCsv`, which discovers it
  // after the profile has already been accepted and stored.
  delimiter: z.string().length(1),
  hasHeader: z.boolean(),
  skipRows: z.number().int().nonnegative(),
  dateFormat: z.enum(DATE_FORMATS),
  decimalSeparator: z.enum(['.', ',', 'auto']),
  amountSign: z.enum(['natural', 'inverted']),
  // Not upper-cased for the user: `parseAmount` resolves the code through the
  // kernel's currency table, and quietly "fixing" a stored value is how a typo
  // stops being visible in the thing that stored it.
  defaultCurrency: z.string().length(3),
  mapping: csvColumnMappingSchema,
});

/**
 * The per-connection `config` JSONB, for a file-import connection.
 *
 * Keyed by profile id, because that is what a `CsvFileInput.profile` string
 * already is: one connection is one institution, and the map holds the profiles
 * the user built for its exports (current statement layout, plus the one from
 * before the bank renamed its columns). `profiles` defaults to empty so a
 * connection created before any profile existed — `config` is `'{}'::jsonb` by
 * default in migration 0005 — parses rather than fails.
 */
export const csvConnectionConfigSchema = z.object({
  profiles: z
    .record(z.string().min(1), csvProfileSchema)
    .refine((profiles) => Object.entries(profiles).every(([key, profile]) => key === profile.id), {
      error: "each profile's key must equal its own id",
    })
    .default({}),
});

export interface CsvConnectionConfig {
  readonly profiles: Readonly<Record<string, CsvProfile>>;
}

/**
 * Validate one stored profile, or raise the typed error.
 *
 * `CONFIG_ERROR` rather than `MALFORMED_RESPONSE`, for the same reason
 * `errors.ts` gives: this is the user's own configuration, not a provider
 * breaking its contract, and `invalid_input` is what stops the orchestrator
 * retrying it at 03:15.
 */
export function parseCsvProfile(raw: unknown): CsvProfile {
  const parsed = csvProfileSchema.safeParse(raw);
  if (!parsed.success) throw configError('this import profile is not valid', parsed.error);
  return parsed.data;
}

/** Validate the whole `connections.config` payload, or raise the typed error. */
export function parseCsvConnectionConfig(raw: unknown): CsvConnectionConfig {
  const parsed = csvConnectionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw configError('this connection’s import configuration is not valid', parsed.error);
  }
  return parsed.data;
}

/**
 * A profile by id: the user's own first, then the shipped presets.
 *
 * The user wins the tie deliberately. A preset is a starting point with a
 * memorable id, and a user whose bank changed its export needs to be able to
 * store a corrected `us_signed` under that same id and have every file that
 * referenced it pick up the correction. A preset that shadowed the user's
 * profile would silently undo their fix.
 */
export function resolveCsvProfile(config: CsvConnectionConfig, id: string): CsvProfile {
  const stored = config.profiles[id];
  if (stored !== undefined) return stored;
  const preset = presetById(id);
  if (preset !== null) return preset;
  throw configError(`no import profile or preset named ${JSON.stringify(id)}`);
}

/**
 * The zod failure, flattened to `path: message` pairs and nothing else.
 *
 * Deliberately *not* the received value. This message ends up in
 * `sync_runs.last_error`, which is rendered in the UI and pasted into bug
 * reports — the same reason `asInvalidInput` carries a line number and not the
 * failing row.
 */
function configError(message: string, cause?: z.ZodError): ConnectorError {
  const detail =
    cause === undefined
      ? message
      : `${message}: ${cause.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; ')}`;
  return ConnectorError.fromCondition('CONFIG_ERROR', detail, {
    ...(cause === undefined ? {} : { cause }),
  });
}
