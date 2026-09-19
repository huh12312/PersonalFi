// SPDX-License-Identifier: MIT
/**
 * The advisor registry — what may be asked, and what it may be asked for.
 *
 * Registration is the review point. By the time `service.ts` runs an advisor,
 * three questions are already answered and none of them is answered again at
 * run time:
 *
 *   * **Is this manifest well-formed?** `AdvisorManifestSchema` parses it, so a
 *     registration row with a `max_severity` of `'catastrophic'` or a
 *     `requires_scopes` naming a scope that does not exist fails here, at boot
 *     or at the moment a sidecar is added — not on the night it first runs.
 *   * **May an advisor of this kind hold these scopes?** The per-kind ceiling
 *     from `scopes.ts`. An external advisor asking for `transactions.raw` is
 *     refused registration outright, which is a stronger statement than
 *     silently omitting the block later: the manifest a human reviews is the
 *     manifest that describes what will actually happen.
 *   * **Does it claim egress it cannot have?** A `builtin` or `local_model`
 *     advisor with a non-empty `egress_allowlist` is refused. Neither has a
 *     network path, so a list is either dead configuration or somebody's plan.
 *
 * ## Registration is fail-closed and explicit
 *
 * `register` returns a verdict rather than throwing. A composition root
 * registering eight built-ins wants to know which one was rejected and to start
 * anyway with the other seven; a throw would take down the API because one rule
 * in the catalogue had a typo. `assertRegistered` exists for the tests that want
 * the throw.
 *
 * ## Invocation is one-way, with our deadline
 *
 * `Advisor.run` receives the request and an `AbortSignal` **we** control. 08
 * §4.4: "Hard timeout, enforced by us." The advisor gets no database handle, no
 * callback, no token and no second call — the signature is the whole of its
 * capability, which is why it is stated here rather than implied by whatever
 * `service.ts` happens to pass.
 *
 * ## Built-ins live in WP 2.7, and the registry does not know that
 *
 * This file has no list of advisors in it. `createAdvisorRegistry([])` is a
 * legitimate, fully-working registry that proposes nothing, which is what the
 * platform ships as until the catalogue lands — and is also what an operator
 * gets when kill switch 1 is off.
 */
import {
  AdvisorManifestSchema,
  resolveLimits,
  type AdvisorManifest,
  type ResolvedLimits,
} from './contract/manifest.ts';
import type { AdvisorRequest } from './contract/request.ts';
import { scopesPermittedForKind } from './contract/scopes.ts';

/**
 * What an advisor is, from the platform's side: a manifest and one function.
 *
 * The return type is `unknown` on purpose. A `builtin` returns an object, a
 * sidecar will return a response body as text, and both go through
 * `validateResponse`'s step 1 identically. Typing this as `AdvisorResponse`
 * would let a built-in skip the schema step by construction — the one advisor
 * kind whose compliance we most want mechanically proven.
 */
export interface Advisor {
  readonly manifest: AdvisorManifest;
  run(request: AdvisorRequest, signal: AbortSignal): Promise<unknown>;
}

export type RegistrationRefusal =
  | 'manifest_invalid'
  | 'duplicate_advisor_id'
  | 'scope_not_permitted_for_kind'
  | 'egress_without_network'
  | 'contract_version_unsupported';

export type RegistrationVerdict =
  | { readonly ok: true; readonly limits: ResolvedLimits }
  | { readonly ok: false; readonly reason: RegistrationRefusal; readonly detail: string };

export interface RegisteredAdvisor {
  readonly advisor: Advisor;
  readonly manifest: AdvisorManifest;
  /** The manifest's limits, floored by the platform's. Never the other way. */
  readonly limits: ResolvedLimits;
}

/**
 * Check a manifest without registering it.
 *
 * Exported because the API's "add an advisor" route wants to reject a bad
 * manifest with a 400 before it writes an `advisors` row, and because the same
 * check then runs at boot when that row is loaded — one function, two callers,
 * no chance of the write path being more permissive than the read path.
 */
export function checkManifest(candidate: unknown): RegistrationVerdict {
  const parsed = AdvisorManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'manifest_invalid',
      detail: issue === undefined ? 'invalid' : `${issue.path.join('.')}: ${issue.message}`,
    };
  }
  const manifest = parsed.data;

  const permitted = new Set(scopesPermittedForKind(manifest.kind));
  for (const scope of manifest.requires_scopes) {
    if (!permitted.has(scope)) {
      return {
        ok: false,
        reason: 'scope_not_permitted_for_kind',
        detail: `${manifest.kind} may not hold ${scope}`,
      };
    }
  }

  if (manifest.kind !== 'external' && manifest.egress_allowlist.length > 0) {
    return {
      ok: false,
      reason: 'egress_without_network',
      detail: `${manifest.kind} advisors have no network path`,
    };
  }

  return { ok: true, limits: resolveLimits(manifest) };
}

export class AdvisorRegistry {
  readonly #byId = new Map<string, RegisteredAdvisor>();

  register(advisor: Advisor): RegistrationVerdict {
    const verdict = checkManifest(advisor.manifest);
    if (!verdict.ok) return verdict;
    const id = advisor.manifest.advisor_id;
    if (this.#byId.has(id)) {
      // Two advisors under one id is not "the later one wins": the id is the
      // upsert key for every insight either of them ever proposed, so a silent
      // replacement rewrites history that is already on somebody's screen.
      return { ok: false, reason: 'duplicate_advisor_id', detail: id };
    }
    this.#byId.set(id, { advisor, manifest: advisor.manifest, limits: verdict.limits });
    return verdict;
  }

  /** Register, or throw. For tests and for a catalogue that must be complete. */
  assertRegistered(advisor: Advisor): RegisteredAdvisor {
    const verdict = this.register(advisor);
    if (!verdict.ok) {
      throw new Error(
        `advisor ${advisor.manifest.advisor_id} refused registration: ${verdict.reason} (${verdict.detail})`,
      );
    }
    const registered = this.#byId.get(advisor.manifest.advisor_id);
    if (registered === undefined) throw new Error('registry lost an advisor it just accepted');
    return registered;
  }

  get(advisorId: string): RegisteredAdvisor | undefined {
    return this.#byId.get(advisorId);
  }

  /** Every advisor, in id order, so a run's ordering is reproducible. */
  list(): readonly RegisteredAdvisor[] {
    return [...this.#byId.values()].sort((left, right) =>
      left.manifest.advisor_id.localeCompare(right.manifest.advisor_id),
    );
  }

  /** The advisors a schedule fires. Their cron lines live on the manifest. */
  scheduled(): readonly RegisteredAdvisor[] {
    return this.list().filter((entry) =>
      entry.manifest.triggers.some((trigger) => trigger.type === 'schedule'),
    );
  }

  /**
   * The advisors that asked to be woken by this event type.
   *
   * A string comparison against a declared type, not a subscription object:
   * contexts do not import each other, so an advisor names
   * `'budgeting.ThresholdCrossed'` the way a URL is named. A type nobody
   * declares wakes nobody, which is why the consumer's own filter is the union
   * of what is registered rather than a hardcoded list.
   */
  triggeredBy(eventType: string): readonly RegisteredAdvisor[] {
    return this.list().filter((entry) =>
      entry.manifest.triggers.some(
        (trigger) => trigger.type === 'event' && trigger.event_type === eventType,
      ),
    );
  }

  /** Every event type any registered advisor wants. The consumer's filter. */
  eventTypes(): readonly string[] {
    const types = new Set<string>();
    for (const entry of this.list()) {
      for (const trigger of entry.manifest.triggers) {
        if (trigger.type === 'event') types.add(trigger.event_type);
      }
    }
    return [...types].sort();
  }
}

export function createAdvisorRegistry(advisors: readonly Advisor[] = []): AdvisorRegistry {
  const registry = new AdvisorRegistry();
  for (const advisor of advisors) registry.assertRegistered(advisor);
  return registry;
}
