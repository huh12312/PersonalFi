// SPDX-License-Identifier: MIT
/**
 * WP 3.13 carry-over (03-phase-3-dispatch.md §2): "Kill-switch defaults —
 * `module.insights` ships `true`-but-inert until `advisor_token_secret` is
 * mounted; the four-level switch has no Phase 3 owner and no documented
 * default per level ... WP 3.13 writes the defaults into
 * `apps/api/src/platform.ts` and `docs/RUNBOOK.md` and asserts them."
 *
 * `apps/api/src/platform.ts`'s `MODULE_FLAGS` already carries every default
 * this carry-over asked for, with a `removeWhen` reasoning comment per flag
 * (written during the Phase 2 wiring batch, 0cf642c and its close-out,
 * 225c616) — this session does not own `platform.ts` (it is a shared file
 * the orchestrator applies; apps/api/src/{domain,modules,platform}.ts are
 * excluded from this work package's paths). What was still missing is what
 * this file and `docs/RUNBOOK.md`'s new "Export and import" /
 * `NOTIFICATIONS_ALLOWED_HOSTS` notes now both provide: the defaults **written
 * down somewhere a person reads** and **asserted** so a change to
 * `platform.ts` that silently flips one is caught here rather than only in
 * the shipped behaviour.
 *
 * **Sabotage.** Flip any `defaultEnabled` in `platform.ts`'s `MODULE_FLAGS`
 * (e.g. `module.notifications` to `false`) and the matching assertion below
 * fails by name.
 */
import { describe, expect, it } from 'vitest';
import { MODULE_FLAGS } from '../src/platform.ts';

/** The documented default per module, mirrored from `platform.ts`'s own comments. */
const EXPECTED_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  'module.ledger': true,
  'module.connections': true,
  'module.categorization': true,
  'module.budgeting': true,
  'module.recurring': true,
  'module.notifications': true,
  // Provably inert on a fresh install until `advisor_token_secret` is
  // mounted — `true` is what "on" means the day that secret lands, without a
  // second code change (platform.ts's own comment on this entry).
  'module.insights': true,
  // Phase 3's two (docs/evidence/phase-3/wp3.w-wiring.md). Flipped `true` at
  // the Wave A′ boundary once `apps/api/test/db/phase3-wiring.test.ts` proved
  // the real `appModules()` registration green against a real database.
  //
  // `module.investments` is inert on an install with no investment accounts:
  // the lot consumer derives from `InvestmentSyncPort.factsForRun`, which is
  // empty until WP 3.7's provider legs land, and a derivation over no facts
  // writes nothing. `module.integrations` is not inert — it registers the
  // 03:45 job and schedule — but is safe at `true` because a provider with no
  // key file gets no adapter at all, so the refresh runs and asks nobody.
  'module.investments': true,
  'module.integrations': true,
  // WP 3.8, flipped at the same boundary and on the same evidence:
  // `phase3-wiring.test.ts` drove the real `createNetWorthConsumer` through the
  // real pump and landed the real `planning.net_worth_snapshot` schedule row
  // through the real `upsertSchedule`. Safe at `true` on a fresh install
  // because the consumer's handler is an UPDATE — it marks nothing when there
  // is no open day — and the 04:00 job computes a day from whatever the ledger
  // and investments actually hold, which for a holder with no accounts is
  // nothing. It never writes a placeholder row, because a zero that means "not
  // computed yet" is the exact lie WP 3.8 exists to refuse.
  'module.planning': true,
});

describe('module kill-switch defaults are pinned (WP 3.13 carry-over)', () => {
  it('every documented module flag exists with its documented default, and nothing undocumented sneaked in', () => {
    const byKey = new Map(MODULE_FLAGS.map((flag) => [flag.key, flag] as const));

    for (const [key, expected] of Object.entries(EXPECTED_DEFAULTS)) {
      const flag = byKey.get(key);
      expect(flag, `no MODULE_FLAGS entry named ${key}`).toBeDefined();
      expect(flag?.defaultEnabled, `${key} default changed from the documented value`).toBe(
        expected,
      );
    }

    const documented = new Set(Object.keys(EXPECTED_DEFAULTS));
    const undocumented = MODULE_FLAGS.map((flag) => flag.key).filter((key) => !documented.has(key));
    expect(
      undocumented,
      'a module flag exists that this test (and RUNBOOK.md) does not document yet',
    ).toEqual([]);
  });

  it('every module flag names a real owner and a reasoned removeWhen — never a placeholder', () => {
    for (const flag of MODULE_FLAGS) {
      expect(flag.owner.length, `${flag.key} has no owner`).toBeGreaterThan(0);
      expect(flag.removeWhen.length, `${flag.key} has no removeWhen reasoning`).toBeGreaterThan(10);
    }
  });
});
