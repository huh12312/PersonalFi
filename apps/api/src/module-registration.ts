// SPDX-License-Identifier: MIT
/**
 * Which modules the **worker** registers beyond their events (WP 11.8).
 *
 * A module flag (`module.insights`, ...) is the holder's switch; registration
 * is the install's. `insightsModule` (`modules.ts`) registers no consumer, no
 * job and no schedule when `advisor_token_secret` is absent — by design, an
 * install without it "has simply not opted into module.insights"
 * (`packages/config/src/schema.ts`). Production ran three weeks like that
 * while the api, whose narrator runtime exists in preview mode regardless,
 * let the holder pick a provider, save a key, read `module.insights` "on" and
 * press "Run control checks" — none of which the worker could ever run.
 *
 * This file is the one place the answer is computed. `insightsModule` asks
 * `insightsRegistered` with its own wiring options (the worker's, built from
 * `config.secrets.advisor_token_secret` in `worker.ts`), and the api asks the
 * same function with the same config value (`registrationSourceOf`), so the
 * api's `/ready` `modules` line, `GET /advisors/module/enabled`'s `worker`
 * half, the control checks' level-1 line and `just genai-selftest`'s refusal
 * cannot disagree with what the worker actually did. No database read: it is
 * a property of the install's secrets, not of a holder.
 */
import type { AppConfig } from '@core/config';
import { MODULE_FLAGS } from './platform.ts';

/** Why the worker leaves `module.insights` at events only. Shown verbatim on `/ready`. */
export const INSIGHTS_UNREGISTERED_REASON = 'advisor_token_secret absent';

/** The notice the Language model card shows, as plain text for an operator's terminal. */
export const INSIGHTS_UNREGISTERED_NOTICE =
  'The insights module is not enabled on this install: the operator has not written advisor_token_secret. ' +
  'Narration, the Brief, Ask and the advisor will not run until it is.';

/** One module flag and whether the worker registers its consumers, jobs and schedules. */
export type ModuleRegistrationLine =
  | { readonly flag: string; readonly registered: true }
  | { readonly flag: string; readonly registered: false; readonly reason: string };

/**
 * What registration is decided from. Only the secret's *presence* is read —
 * the value is never inspected here — so the worker's wiring options (a
 * revealed string) and the api's config (a `Redacted`) both fit.
 */
export interface RegistrationSource {
  readonly advisorTokenSecret?: unknown;
}

/** The api's view of the source: the same config value the worker reveals. */
export function registrationSourceOf(config: Pick<AppConfig, 'secrets'>): RegistrationSource {
  const secret = config.secrets.advisor_token_secret;
  return secret === undefined ? {} : { advisorTokenSecret: secret };
}

/**
 * Whether the worker registers `module.insights`' consumer, jobs and schedule.
 * A type guard, so `insightsModule` reads the secret it has just been told is there.
 */
export function insightsRegistered<T extends RegistrationSource>(
  source: T,
): source is T & { readonly advisorTokenSecret: NonNullable<T['advisorTokenSecret']> } {
  return source.advisorTokenSecret !== undefined;
}

/**
 * Every module flag, in `MODULE_FLAGS` order, with the worker's registration.
 * `module.insights` is the only one conditional on a secret today; every other
 * module is registered by the worker unconditionally (`module.integrations`
 * reads its keys a level down and runs with none — `platform.ts`).
 */
export function moduleRegistrations(source: RegistrationSource): readonly ModuleRegistrationLine[] {
  return MODULE_FLAGS.map(({ key }) =>
    key === 'module.insights' && !insightsRegistered(source)
      ? { flag: key, registered: false as const, reason: INSIGHTS_UNREGISTERED_REASON }
      : { flag: key, registered: true as const },
  );
}
