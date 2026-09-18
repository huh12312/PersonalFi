// SPDX-License-Identifier: MIT
/**
 * D25's guard, asserted three ways.
 *
 * A `merchants` row means "a payee was involved" and `@ctx/ledger` is the only
 * thing allowed to decide that. A detector that took a descriptor would be one
 * regex away from minting merchant identity of its own — silently, and with
 * budget lines, price alerts and subscriptions hanging off the result.
 *
 * One assertion is not enough, because each of the three is individually
 * dodgeable:
 *
 *  1. **The exported surface.** No exported function takes a parameter named
 *     for a descriptor, and no exported *type* has a field that carries one.
 *     Dodged by naming the field something else.
 *  2. **The source.** No identifier under `src/` reads `descriptor`, `payee`,
 *     `merchantName` or `merchantKey` outside comments and message strings.
 *     Dodged by computing the property name.
 *  3. **The behaviour.** A whole detection pass runs with every input behind a
 *     `Proxy` that throws on any key outside the contract — including three
 *     decoy keys (`descriptor`, `payee`, `merchantName`) that are physically
 *     present on the object. Nothing dodges this one: reading the descriptor
 *     fails the test even if the code that does it was generated at runtime.
 *
 * WP 2.3 carries the other half (`no-merchant-creation.test.ts`: a full pass
 * leaves the `merchants` row count and ids unchanged), because only WP 2.3 has
 * a database to leave unchanged.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DateOnly, Money, fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import * as surface from '../src/index.ts';
import type { RecurringInput } from '../src/index.ts';

/** Words that name a payee's *text*, which this engine may never see. */
const BANNED = [
  'descriptor',
  'payee',
  'merchantName',
  'merchant_name',
  'merchantKey',
  'merchant_key',
  'normalizeMerchant',
  'normaliseMerchant',
  'counterparties',
  'alias',
  'aliases',
  'trigram',
] as const;

const SRC = join(import.meta.dirname, '..', 'src');

/** Remove comments and string literals: prose may discuss what code may not do. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function engineSources(): Array<{ file: string; code: string }> {
  return readdirSync(SRC)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, code: codeOnly(readFileSync(join(SRC, file), 'utf8')) }));
}

describe('no merchant writes', () => {
  it('the engine exports no function that takes a descriptor', () => {
    const functions: Array<readonly [string, (...args: never[]) => unknown]> = [];
    for (const [name, value] of Object.entries(surface)) {
      if (typeof value === 'function') {
        functions.push([name, value as unknown as (...args: never[]) => unknown]);
      }
    }
    expect(functions.length).toBeGreaterThan(5);

    for (const [name, fn] of functions) {
      // Node strips types in place, so the parameter *names* survive `toString`
      // while the annotations become whitespace — which is exactly the part
      // this assertion needs.
      const signature = fn.toString().slice(0, fn.toString().indexOf(')') + 1);
      for (const word of BANNED) {
        expect(signature.toLowerCase(), `${name}${signature}`).not.toContain(word.toLowerCase());
      }
      // …and no exported function is named for writing merchants either.
      expect(name.toLowerCase()).not.toMatch(/merchant(create|write|upsert|insert)/);
      expect(name.toLowerCase()).not.toMatch(/(create|write|upsert|insert|save)merchant/);
    }

    // The input contract itself: these are the only keys the engine is given.
    const sample: RecurringInput = {
      transactionId: 't-1',
      merchantId: 'm-1',
      accountId: 'a-1',
      amount: Money.of(-1299n, 'USD'),
      date: DateOnly.parse('2026-01-01'),
      pending: false,
      isTransfer: false,
    };
    expect(Object.keys(sample).sort()).toEqual([
      'accountId',
      'amount',
      'date',
      'isTransfer',
      'merchantId',
      'pending',
      'transactionId',
    ]);
  });

  it('no identifier under src/ names a descriptor, a payee or a merchant key', () => {
    const offences: string[] = [];
    for (const { file, code } of engineSources()) {
      for (const word of BANNED) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(code)) offences.push(`${file}: ${word}`);
      }
      // No merchant-normalisation pipeline either: identity is the ledger's.
      // (`normalisedResiduals` in cadence.ts is a *residual* scaled by its own
      // tolerance, which is why this pattern names the merchant explicitly
      // rather than banning the word outright.)
      if (/normali[sz]\w*merchant|merchant\w*normali[sz]/i.test(code)) {
        offences.push(`${file}: merchant normalisation`);
      }
    }
    expect(offences).toEqual([]);
    expect(engineSources().length).toBeGreaterThan(8);
  });

  it('a whole detection pass never reads a key outside the input contract', () => {
    const allowed = new Set([
      'transactionId',
      'merchantId',
      'accountId',
      'amount',
      'date',
      'pending',
      'isTransfer',
      // Structural reads any runtime may perform on a plain object.
      'then',
      'toJSON',
      Symbol.toPrimitive,
      Symbol.iterator,
      Symbol.toStringTag,
    ] as Array<string | symbol>);

    const touched: string[] = [];
    const guarded: RecurringInput[] = [];
    for (let index = 0; index < 24; index += 1) {
      const target = {
        transactionId: `t-${index}`,
        merchantId: index % 3 === 0 ? 'm-1' : 'm-2',
        accountId: 'a-1',
        amount: Money.of(BigInt(-1299 - (index % 3) * 700), 'USD'),
        date: DateOnly.addMonths(DateOnly.parse('2024-06-11'), index),
        pending: false,
        isTransfer: false,
        // Decoys. Present on the object, poisoned on read.
        descriptor: 'SQ *BLUE BOTTLE COFFEE OAKLAND CA',
        payee: 'BLUE BOTTLE COFFEE',
        merchantName: 'Blue Bottle Coffee',
      };
      guarded.push(
        new Proxy(target, {
          get(object, property, receiver) {
            if (!allowed.has(property as string)) {
              touched.push(String(property));
              throw new Error(`the engine read ${String(property)} from a RecurringInput`);
            }
            return Reflect.get(object, property, receiver);
          },
        }) as unknown as RecurringInput,
      );
    }

    const result = surface.detectRecurring(guarded, {
      clock: fixedClock('2026-09-15T12:00:00Z'),
      timeZone: 'UTC',
    });

    expect(touched).toEqual([]);
    // And the pass did real work, so a green result is not an empty one.
    expect(result.streams.length).toBeGreaterThan(0);
    expect(result.streams.some((stream) => stream.type !== 'ONE_OFF')).toBe(true);
    // Nothing on the way out carries a payee's text back either.
    const serialised = JSON.stringify(result, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const word of ['BLUE BOTTLE', 'SQ *', 'Blue Bottle']) {
      expect(serialised).not.toContain(word);
    }
  });
});
