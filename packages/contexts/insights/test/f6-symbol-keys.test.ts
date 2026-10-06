// SPDX-License-Identifier: MIT
/**
 * WP 9.5, F-6 (wp5.4-redteam.md §4): a third-party token symbol outside the
 * insight-key alphabet used to fail the crypto and investing built-ins' whole
 * response at step 2 — every holding's finding went with it, an `urgent`
 * concentration finding included. Fail-closed for the model, fail-silent for
 * the holder. `builtin/symbol-key.ts` now keys such a symbol through a safe
 * slug plus a short hash.
 *
 * The drift seed's real snapshot with its `BTC` holding renamed everywhere it
 * appears — to a symbol with a space and a slash (harmless prose, outside the
 * key alphabet), and to the red team's I-06 bidi/zero-width symbol — run
 * through every built-in and the real `validateResponse`.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import { symbolKeyPart } from '../src/advisors/builtin/symbol-key.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';

const KEY_ALPHABET = /^[A-Za-z0-9_.:-]+$/u;

/** Every built-in over `snapshot`: per advisor, the keys it got accepted, or the step-2 refusal. */
async function keysByAdvisor(
  snapshot: AdvisorSnapshot,
): Promise<Map<string, readonly string[] | string>> {
  const out = new Map<string, readonly string[] | string>();
  for (const entry of BUILTIN_CATALOGUE) {
    const { manifest } = entry.advisor;
    const request = requestFor(manifest, snapshot);
    const body = await entry.advisor.run(request, new AbortController().signal);
    const outcome = validateResponse({ request, manifest, limits: resolveLimits(manifest), body });
    out.set(
      manifest.advisor_id,
      outcome.ok
        ? outcome.accepted.map((validated) => validated.insight.key)
        : `${outcome.rejection.step}:${outcome.rejection.reason}`,
    );
  }
  return out;
}

function renamed(snapshot: AdvisorSnapshot, from: string, to: string): AdvisorSnapshot {
  return JSON.parse(
    JSON.stringify(snapshot).split(JSON.stringify(from)).join(JSON.stringify(to)),
  ) as AdvisorSnapshot;
}

describe('F-6 — a symbol outside the key alphabet', () => {
  it('a token symbol outside the key alphabet no longer silences the builtin; the finding is raised under a safe key', async () => {
    const clean = await seedSnapshot('drift');
    const before = await keysByAdvisor(clean);
    const btcAdvisors = [...before.entries()].filter(
      ([, keys]) => Array.isArray(keys) && keys.some((key) => key.includes('.BTC')),
    );
    // Non-vacuous: the seed's BTC holding is narrated by at least one rule.
    expect(btcAdvisors.length).toBeGreaterThan(0);

    const symbol = 'BTC / USD';
    const after = await keysByAdvisor(renamed(clean, 'BTC', symbol));
    const safe = symbolKeyPart(symbol);
    for (const [advisorId, keys] of before) {
      const now = after.get(advisorId);
      // Nothing silenced: every advisor that answered still answers, with as
      // many findings as before …
      expect(Array.isArray(now), `${advisorId}: ${String(now)}`).toBe(Array.isArray(keys));
      if (!Array.isArray(keys) || !Array.isArray(now)) continue;
      expect(now.length, advisorId).toBe(keys.length);
      // … every key inside the alphabet, and the renamed holding's finding
      // raised under the safe key where the clean one said `BTC`.
      for (const key of now) expect(key, advisorId).toMatch(KEY_ALPHABET);
      expect([...now].sort(), advisorId).toEqual(
        [...keys].map((key) => key.replace('.BTC', `.${safe}`)).sort(),
      );
    }

    // The red team's I-06 symbol: a bidi override and a zero-width space. The
    // finding that quotes it in its own prose is still refused — per insight,
    // at step 7 (F-5) — but no rule's whole response fails any more, so every
    // other holding's finding survives.
    const hostile = await keysByAdvisor(renamed(clean, 'BTC', 'BTC‮eno​'));
    for (const [advisorId, keys] of before) {
      const now = hostile.get(advisorId);
      expect(Array.isArray(now), `${advisorId}: ${String(now)}`).toBe(Array.isArray(keys));
      if (!Array.isArray(keys) || !Array.isArray(now)) continue;
      expect([...now].sort(), advisorId).toEqual(
        [...keys].filter((key) => !key.includes('.BTC')).sort(),
      );
    }
    // The safe key: the alphabet's characters of the symbol, and a hash of it.
    expect(safe).toMatch(/^BTCUSD-x[0-9a-f]{10}$/u);
    // An in-alphabet symbol keeps its key exactly: no existing key moves.
    expect(symbolKeyPart('BRK.B')).toBe('BRK.B');
    expect(symbolKeyPart('SYSTEM:QXZDELTA')).toBe('SYSTEM:QXZDELTA');
  });
});
