// SPDX-License-Identifier: MIT
/**
 * What every WP 1.5 router is handed.
 *
 * One shape rather than four, so a router that later needs the orchestrator does
 * not change its own signature and every call site with it. `connections()` is a
 * function and not a field for a reason worth stating: the `SyncOrchestrator`
 * needs the `SecretBox`, and the `SecretBox` does not exist until the KEK has
 * been derived — which happens after `buildApp` returns and, on a machine with
 * no `master_key`, never. A field would force `buildApp` to either block on six
 * seconds of Argon2id (breaking `emit-openapi`, which builds the app with no
 * database at all) or hold `null` and push the check into every handler.
 */
import type { AppConfig } from '@core/config';
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type pg from 'pg';
import type { Guards } from '../auth/guards.ts';
import type { DomainRuntime, WalletRpcRuntime } from '../domain.ts';

export interface RouteDeps {
  readonly guards: Guards;
  readonly database: Database;
  readonly pool: pg.Pool;
  readonly clock: Clock;
  /**
   * Added by WP 2.r: the routes for budgets, recurring, insights and
   * notification settings need the same operator configuration
   * `apps/api/src/domain.ts`'s `createNotificationEgressPolicy` and the
   * `module.insights` wiring already read (the notification egress allow-list,
   * the advisor token secret) but no route needed before. A plain field, not a
   * function like `connections()` — unlike the `SecretBox`, config exists from
   * the moment `buildApp` returns.
   */
  readonly config: AppConfig;
  /**
   * WP 3.9. The watch-only wallet store, when this process built one.
   *
   * `null` only when the caller injected its own `ConnectorRegistry` and no
   * runtime with it — the shape a narrow test registry is in. It is here rather
   * than inside `connections()` because it is needed **after**
   * `createConnection` has committed and before the response is written:
   * `docs/evidence/phase-3/wp3.w-wiring.md` §10 item 8 records that
   * `WalletAddressStore.put` cannot persist on a first link, because
   * `@ctx/connections`' `createConnection` calls `connector.connect()` *before*
   * it inserts the `connections` row, so at `put` time there is no
   * `connections.id` to reference. `persistPending` is the drain, and
   * `routes/connections.ts` is the one place that has both the staged
   * descriptor (same process, same request) and the committed id.
   *
   * A plain field rather than a function, like `config` and unlike
   * `connections()`: it needs no `SecretBox` — a watch-only descriptor is an
   * xpub or an address and there is nothing to seal.
   */
  readonly walletRpc: WalletRpcRuntime | null;
  /** The connections wiring, or a 503 problem naming why the app is locked. */
  connections(): DomainRuntime;
}
