// SPDX-License-Identifier: MIT
/**
 * Time-zone validation, which is load-bearing twice over.
 *
 * Postgres has no IANA type, so the only check on `users.display_timezone` is this
 * function. Every period boundary in the application — budget months, "today",
 * digest windows, the daily snapshot seal — is computed in that zone, so a value
 * `Intl` cannot parse silently becomes a `RangeError` in a nightly job months
 * later.
 *
 * The `|` refusal is a second, unrelated reason: `|` is the AAD separator, and a
 * time zone is exactly the kind of user-controlled string that ends up
 * concatenated into one.
 */
import { describe, expect, it } from 'vitest';
import { isAuthError } from './errors.ts';
import { assertIanaZone, REGISTRATION_TOKEN_TTL_SECONDS } from './users.ts';

describe('assertIanaZone', () => {
  it('accepts real zones, including the awkward ones', () => {
    for (const zone of [
      'UTC',
      'America/Los_Angeles',
      'Europe/London',
      'Asia/Kolkata', // :30 offset
      'Australia/Eucla', // :45 offset
      'Pacific/Chatham', // :45 offset with DST
      'America/Argentina/Buenos_Aires', // three components
    ]) {
      expect(() => assertIanaZone(zone), zone).not.toThrow();
    }
  });

  it('refuses a zone Intl cannot resolve', () => {
    // `PST` is deliberately absent: ICU resolves the legacy abbreviations, so
    // `Intl` accepts it and so do we. The check is "can a period boundary be
    // computed in this zone?", not "is this a canonical tzdata name?".
    for (const zone of ['', 'Mars/Olympus_Mons', 'Not A Zone', 'America/Los Angeles']) {
      expect(() => assertIanaZone(zone), zone).toThrow();
    }
  });

  it('refuses the AAD separator before Intl ever sees it', () => {
    // `Europe|London` would also fail the `Intl` check, but the explicit refusal
    // is what guarantees the rule holds for any zone name a future ICU adds.
    try {
      assertIanaZone('Europe|London');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAuthError(error) && error.code).toBe('invalid_credential');
      expect((error as Error).message).toContain('|');
    }
  });

  it('reports a failure as invalid_credential without echoing anything sensitive', () => {
    try {
      assertIanaZone('Mars/Olympus_Mons');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAuthError(error) && error.code).toBe('invalid_credential');
      expect((error as Error).message).toContain('Mars/Olympus_Mons');
    }
  });
});

describe('registration token lifetime', () => {
  it('is one hour — long enough to walk to the other device, short enough to matter', () => {
    expect(REGISTRATION_TOKEN_TTL_SECONDS).toBe(3_600);
  });
});
