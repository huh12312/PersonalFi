// SPDX-License-Identifier: MIT
/**
 * The validator is **total** over arbitrary JSON, and **deterministic**.
 *
 * Both halves matter and they are different claims.
 *
 * *Total* — every input produces a verdict and none produces a throw. The
 * validator's whole job is to be the thing standing between an untrusted
 * payload and the database; a validator that crashes on a payload has not
 * rejected it, it has taken the worker down and left the run in `started`. An
 * example-based test cannot make this claim, because the interesting inputs are
 * the ones nobody thought of: `__proto__` as a key, a 400-digit number, a
 * `NaN`-shaped string, an array where an object belongs, a cyclic structure.
 *
 * *Deterministic* — two calls on the same input produce the same verdict. The
 * reason is concrete rather than aesthetic: `advisor_runs` stores an
 * `input_digest` and a rejection list, and "reproduce this rejection from what
 * we stored" is the only way a Phase 5 model's refusals are ever debuggable. A
 * validator whose answer depends on iteration order, on `Date.now`, or on a
 * `Set`'s insertion history is a validator whose failures cannot be
 * reproduced.
 *
 * `fast-check` is a dev-only dependency of this context, allowed by the
 * `insights` entry in `scripts/eslint-boundaries.js` rather than by an
 * `eslint-disable` here, so the looseness lives in the policy.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDecimal, render } from '../src/validate/decimal.ts';
import { evaluateDerivation } from '../src/validate/derivations.ts';
import { resolveSourceRef } from '../src/validate/evidence.ts';
import { checkLink } from '../src/validate/links.ts';
import { markdownViolations, renderedText } from '../src/validate/markdown.ts';
import { untraceableNumerals, traceContext } from '../src/validate/numerals.ts';
import { validateResponse, type ValidationOutcome } from '../src/validate/pipeline.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { baseManifest, baseRequest, baseSnapshot } from './fixtures.ts';

const LIMITS = { timeoutMs: 30_000, maxInsights: 20, maxResponseBytes: 131_072 };
const MANIFEST = baseManifest();
const REQUEST = baseRequest(MANIFEST);

/**
 * Arbitrary JSON, including the keys that are interesting to a walker.
 *
 * `__proto__`, `constructor` and `prototype` are in the key alphabet on
 * purpose: a path walker that uses `in` or plain property access resolves them
 * against `Object.prototype` and returns "something", and "something" is what a
 * check like this must never return.
 */
const jsonValue = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.double({ noDefaultInfinity: false, noNaN: false }),
    fc.integer(),
    fc.string(),
    fc.constantFrom('__proto__', 'constructor', 'prototype', 'NaN', 'Infinity', '1e400'),
    fc.array(tie('node'), { maxLength: 6 }),
    fc.dictionary(
      fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('__proto__', 'constructor', 'minor')),
      tie('node'),
      { maxKeys: 6 },
    ),
  ),
})).node;

/** A verdict, reduced to something comparable for the determinism assertion. */
function shapeOf(outcome: ValidationOutcome): string {
  if (!outcome.ok) {
    return `reject:${outcome.rejection.step}:${outcome.rejection.reason}:${outcome.rejection.detail}`;
  }
  return [
    'ok',
    outcome.accepted.map((insight) => `${insight.insight.key}@${insight.severity}`).join(','),
    outcome.rejected.map((rejection) => `${rejection.step}:${rejection.reason}`).join(','),
  ].join('|');
}

describe('validation is total and deterministic over arbitrary JSON', () => {
  it('never throws, whatever the body is', () => {
    fc.assert(
      fc.property(jsonValue, (body) => {
        const outcome = validateResponse({
          request: REQUEST,
          manifest: MANIFEST,
          limits: LIMITS,
          body,
        });
        // A verdict, always. Nothing here asserts *which* verdict: the point is
        // that there is one.
        expect(typeof outcome.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('returns the same verdict twice for the same input', () => {
    fc.assert(
      fc.property(jsonValue, (body) => {
        const first = validateResponse({
          request: REQUEST,
          manifest: MANIFEST,
          limits: LIMITS,
          body,
        });
        const second = validateResponse({
          request: REQUEST,
          manifest: MANIFEST,
          limits: LIMITS,
          body,
        });
        expect(shapeOf(second)).toBe(shapeOf(first));
      }),
      { numRuns: 300 },
    );
  });

  it('never accepts an insight from arbitrary JSON', () => {
    // The property that actually protects the feed. Random data cannot happen
    // to satisfy seven steps, and if it ever did, that would be the finding.
    fc.assert(
      fc.property(jsonValue, (body) => {
        const outcome = validateResponse({
          request: REQUEST,
          manifest: MANIFEST,
          limits: LIMITS,
          body,
        });
        if (outcome.ok) expect(outcome.accepted).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });

  it('a body that is not serialisable is refused rather than thrown', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const outcome = validateResponse({
      request: REQUEST,
      manifest: MANIFEST,
      limits: LIMITS,
      body: cyclic,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.step).toBe('transport');
  });
});

describe('each validator primitive is total on its own', () => {
  const snapshot = baseSnapshot();

  it('resolveSourceRef', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (ref) => {
        const resolution = resolveSourceRef(snapshot, ref);
        expect(typeof resolution.ok).toBe('boolean');
        // And it never reaches the prototype: a resolved value is one we put in
        // the snapshot, never a function inherited from `Object`.
        if (resolution.ok) expect(typeof resolution.value).not.toBe('function');
      }),
      { numRuns: 400 },
    );
  });

  it('evaluateDerivation', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 40 }),
        (expression, value) => {
          const outcome = evaluateDerivation(snapshot, {
            id: 'x',
            expression,
            inputs: ['snapshot:recurring_list.streams[0].typical_amount.minor'],
            value,
            note: null,
          });
          expect(typeof outcome.ok).toBe('boolean');
        },
      ),
      { numRuns: 400 },
    );
  });

  it('the numeral trace', () => {
    const context = traceContext({ snapshot, derived: [] });
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (text) => {
        expect(Array.isArray(untraceableNumerals(text, context))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('markdown', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2500 }), (text) => {
        expect(Array.isArray(markdownViolations(text))).toBe(true);
        expect(typeof renderedText(text)).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  it('checkLink', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 3000 }),
        fc.array(fc.string(), { maxLength: 4 }),
        (url, list) => {
          const verdict = checkLink(url, list);
          expect(typeof verdict.ok).toBe('boolean');
          // An allow-list that contains the empty string must not allow
          // everything: `hostMatches` refuses an empty pattern outright.
          if (verdict.ok) expect(list.some((entry) => entry.trim().length > 0)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('decimal parse/render round-trips without an exponent or a float', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        const parsed = parseDecimal(text);
        if (parsed === null) return;
        const rendered = render(parsed, 6);
        expect(rendered).not.toBeNull();
        expect(rendered).not.toMatch(/[eE]/);
        expect(parseDecimal(rendered ?? '')).toBe(parsed);
      }),
      { numRuns: 400 },
    );
  });
});

describe('the snapshot the properties run against', () => {
  it('is the fixture, so a failure above is about the validator', () => {
    const snapshot: AdvisorSnapshot = baseSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['cash_summary', 'recurring_list']);
  });
});
