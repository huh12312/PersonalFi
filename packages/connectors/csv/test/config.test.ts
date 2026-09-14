// SPDX-License-Identifier: MIT
/**
 * Mapping profiles as user data: what happens to one that went through JSONB.
 *
 * 08 §2.6 stores a `CsvProfile` per institution in `connections.config`
 * (migration 0005). The round trip that matters is therefore
 * `object → JSON.stringify → JSONB → JSON.parse → unknown`, and the last arrow
 * is the one with no type at the end of it. These tests run that whole trip with
 * `JSON.parse(JSON.stringify(...))` standing in for the driver — it is the same
 * loss of type information, and it needs no database.
 *
 * The "malformed" cases below are written as *sabotage*: each one first shows
 * what the corrupted profile does when it is merely cast, and then that
 * `parseCsvProfile` refuses it. A schema that has never been observed catching
 * something is not evidence.
 */
import { ConnectorError } from '@connector/port';
import { describe, expect, it } from 'vitest';
import {
  csvConnectionConfigSchema,
  csvProfileSchema,
  parseCsvConnectionConfig,
  parseCsvProfile,
  resolveCsvProfile,
  type CsvConnectionConfig,
} from '../src/config.ts';
import { importFile, type TargetAccount } from '../src/import.ts';
import { CSV_PRESETS, presetById, type CsvProfile } from '../src/presets.ts';

const CARD: TargetAccount = {
  providerAccountId: 'acct-card',
  name: 'Harbour Rewards Card',
  type: 'credit',
  currency: 'USD',
};

/**
 * A profile a user built for their own bank, not one of `CSV_PRESETS`.
 *
 * Deliberately unlike every preset: a tab delimiter, a two-row preamble, no
 * header, positional columns, and `inverted` signs — the credit-card shape,
 * where a purchase is printed as a positive "charge".
 */
const USER_PROFILE: CsvProfile = {
  id: 'harbour_rewards',
  label: 'Harbour Rewards Card: tab-separated, no header, charges positive',
  delimiter: '\t',
  hasHeader: false,
  skipRows: 2,
  dateFormat: 'dmy',
  decimalSeparator: '.',
  amountSign: 'inverted',
  defaultCurrency: 'USD',
  mapping: { date: 0, description: 1, amount: 2, memo: 3 },
};

const STATEMENT = [
  'HARBOUR REWARDS CARD',
  'Statement period 01/05/2026 - 31/05/2026',
  ['07/05/2026', 'HARBOUR HARDWARE 14', '31.50', 'Nails'].join('\t'),
  ['12/05/2026', 'PAYMENT RECEIVED', '-200.00', ''].join('\t'),
  '',
].join('\n');

/** The driver's round trip, with no type at the far end of it. */
function throughJsonb(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function amountsFrom(profile: CsvProfile): bigint[] {
  return importFile({
    name: 'harbour.csv',
    content: STATEMENT,
    format: 'csv',
    profile,
    account: CARD,
  }).transactions.map((transaction) => transaction.amount.minor);
}

function failureOf(run: () => unknown): ConnectorError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }
  return expect.unreachable('the invalid profile should have been refused');
}

/** Every rejection is the user's own configuration, so: not retryable. */
function expectConfigError(run: () => unknown, message: RegExp): ConnectorError {
  const error = failureOf(run);
  expect(error.kind).toBe('invalid_input');
  expect(error.condition).toBe('CONFIG_ERROR');
  expect(error.policy()).toMatchObject({ retryable: false, userActionRequired: true });
  expect(error.message).toMatch(message);
  return error;
}

describe('csvProfileSchema', () => {
  it('accepts a user-defined profile that has been through JSONB, unchanged', () => {
    const stored = throughJsonb(USER_PROFILE);
    expect(parseCsvProfile(stored)).toEqual(USER_PROFILE);
  });

  it('parses a file identically whether the profile came from memory or from JSONB', () => {
    // The point of the schema is that this stays true. `inverted` means the
    // statement's positive 31.50 charge is an outflow and its negative 200.00
    // payment is an inflow; a profile that lost that field on the way through
    // the database would produce these two numbers with the signs swapped and
    // nothing would throw.
    const inMemory = amountsFrom(USER_PROFILE);
    expect(inMemory).toEqual([-3_150n, 20_000n]);
    expect(amountsFrom(parseCsvProfile(throughJsonb(USER_PROFILE)))).toEqual(inMemory);
  });

  it('drops keys that are not part of a profile instead of carrying them onward', () => {
    const stored = { ...USER_PROFILE, lastUsedAt: '2026-05-31', mapping: USER_PROFILE.mapping };
    expect(parseCsvProfile(throughJsonb(stored))).toEqual(USER_PROFILE);
  });

  it('validates every shipped preset, so a preset cannot drift from the schema', () => {
    // The presets are what a stored profile is usually copied from. If one of
    // them stopped satisfying the schema, users would be building profiles the
    // edge then refused.
    for (const preset of CSV_PRESETS) {
      expect(csvProfileSchema.parse(throughJsonb(preset))).toEqual(preset);
    }
  });
});

describe('a stored profile that drifted', () => {
  it('refuses an amountSign that is neither natural nor inverted', () => {
    // The sabotage that matters most, because it is the one that does not
    // throw: `scalars.ts` asks `sign === 'inverted'`, so 'reversed' is read as
    // 'natural' and every row on the statement imports with the wrong sign.
    const drifted = { ...USER_PROFILE, amountSign: 'reversed' };
    const cast = drifted as unknown as CsvProfile;
    expect(amountsFrom(cast)).toEqual([3_150n, -20_000n]);
    expect(amountsFrom(cast)).not.toEqual(amountsFrom(USER_PROFILE));

    expectConfigError(() => parseCsvProfile(throughJsonb(drifted)), /amountSign/);
  });

  it('refuses a mapping that names no amount column, at the profile and not the file', () => {
    // `importFile` does catch this one — but only when the user next uploads a
    // statement, and it blames the file. Catching it where the profile is read
    // blames the profile, which is the thing that is actually wrong.
    const drifted = { ...USER_PROFILE, mapping: { date: 0, description: 1 } };
    expectConfigError(
      () => parseCsvProfile(throughJsonb(drifted)),
      /amount column or a debit\/credit pair/,
    );
  });

  it('refuses a delimiter that is not one character', () => {
    const drifted = { ...USER_PROFILE, delimiter: '||' };
    expectConfigError(() => parseCsvProfile(throughJsonb(drifted)), /delimiter/);
  });

  it('refuses a dateFormat with the wrong case, which would read as ambiguous', () => {
    const drifted = { ...USER_PROFILE, dateFormat: 'DMY' };
    expectConfigError(() => parseCsvProfile(throughJsonb(drifted)), /dateFormat/);
  });

  it('refuses a profile that lost a field entirely rather than defaulting it', () => {
    const { decimalSeparator: _dropped, ...drifted } = USER_PROFILE;
    expectConfigError(() => parseCsvProfile(throughJsonb(drifted)), /decimalSeparator/);
  });

  it('names the failing field and never echoes the stored value', () => {
    // This message lands in `sync_runs.last_error`, which the UI renders.
    const error = expectConfigError(
      () => parseCsvProfile(throughJsonb({ ...USER_PROFILE, defaultCurrency: 'DOLLARS' })),
      /defaultCurrency/,
    );
    expect(error.message).not.toContain('DOLLARS');
  });

  it('refuses a profile that is not an object at all', () => {
    expectConfigError(() => parseCsvProfile('us_signed'), /not valid/);
    expectConfigError(() => parseCsvProfile(null), /not valid/);
  });
});

describe('csvConnectionConfigSchema', () => {
  it('accepts the default empty config a new connection is created with', () => {
    // Migration 0005 defaults `config` to `'{}'::jsonb`, so this is the shape
    // every file-import connection has before the user saves a profile.
    expect(parseCsvConnectionConfig({})).toEqual({ profiles: {} });
  });

  it('round-trips a config holding one user profile', () => {
    const config = { profiles: { [USER_PROFILE.id]: USER_PROFILE } };
    expect(parseCsvConnectionConfig(throughJsonb(config))).toEqual(config);
  });

  it("refuses a config whose key disagrees with the profile's own id", () => {
    // Two names for one profile, and no way to tell which is the real one.
    const config = { profiles: { harbour_old: USER_PROFILE } };
    expectConfigError(() => parseCsvConnectionConfig(throughJsonb(config)), /key must equal/);
  });

  it('reports the path of the offending profile, not just that something failed', () => {
    const config = { profiles: { [USER_PROFILE.id]: { ...USER_PROFILE, skipRows: -1 } } };
    const error = expectConfigError(
      () => parseCsvConnectionConfig(throughJsonb(config)),
      /profiles\.harbour_rewards\.skipRows/,
    );
    expect(error.condition).toBe('CONFIG_ERROR');
  });

  it('is exported as a schema, so a caller may parse without the typed error', () => {
    // `@ctx/connections` may want the zod result rather than a thrown
    // `ConnectorError` — writing a profile from a settings form is a user
    // request, not a sync run.
    expect(csvConnectionConfigSchema.safeParse({ profiles: { bad: 1 } }).success).toBe(false);
  });
});

describe('resolveCsvProfile', () => {
  const config: CsvConnectionConfig = { profiles: { [USER_PROFILE.id]: USER_PROFILE } };

  it('finds a user-defined profile by id', () => {
    expect(resolveCsvProfile(config, 'harbour_rewards')).toEqual(USER_PROFILE);
  });

  it('still resolves a shipped preset id', () => {
    expect(resolveCsvProfile(config, 'us_signed')).toEqual(presetById('us_signed'));
    expect(resolveCsvProfile({ profiles: {} }, 'european_semicolon').delimiter).toBe(';');
  });

  it("lets a user's profile shadow a preset of the same id", () => {
    // A bank changed its export; the user corrected `us_signed` and every file
    // that named it must pick the correction up, not the shipped starting point.
    const corrected: CsvProfile = { ...USER_PROFILE, id: 'us_signed' };
    const shadowing: CsvConnectionConfig = { profiles: { us_signed: corrected } };
    expect(resolveCsvProfile(shadowing, 'us_signed')).toEqual(corrected);
  });

  it('raises the typed error for an id that names nothing', () => {
    expectConfigError(() => resolveCsvProfile(config, 'harbour_rewrds'), /no import profile/);
  });
});
