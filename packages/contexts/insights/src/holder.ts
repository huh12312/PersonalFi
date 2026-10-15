// SPDX-License-Identifier: MIT
/**
 * A holder's own narrator, laid over the process's dependencies for one run
 * (WP 10.6; decision D30).
 *
 * Before WP 10.6 the narrator was fixed at boot: the operator's `LOCAL_MODEL_*`
 * environment built one adapter, one renderer, one registry entry. Now each
 * holder picks the model in Settings — the local model, a hosted provider
 * with their own key, or Off — and may change it without a restart. The
 * composition root binds `InsightsDependencies.narratorFor(userId)` to its
 * cached per-holder resolution (`apps/api/src/narrator-wiring.ts`); this
 * function turns its answer into the dependencies a run, a preview or an
 * approval uses:
 *
 *   * a `HolderNarrator` → `local.narrator` is registered with that model,
 *     and the renderer is that model's (its template hash covers the provider
 *     and the model, so a switch is a new query shape and needs a new
 *     approval);
 *   * `null` (Off, or nothing configured) → no renderer, and `local.narrator`
 *     registered over a model port that refuses (`NO_NARRATOR`): kill level 2
 *     (`configuredKindsFor`, bound from the same answer) refuses the run first,
 *     by name — `kind_disabled` on its `advisor_runs` row — so a narration job
 *     queued before the holder chose Off ends named rather than as an
 *     "unregistered advisor" exception; the Brief enqueues none and keeps its
 *     own wording;
 *   * no `narratorFor` bound → the dependencies unchanged: today's behaviour.
 *
 * Resolved **once per run**, at its start, so the renderer that records the
 * prompt hash and the model, the model the run calls, and the shape the
 * approval is checked against all come from one answer. `@ctx/insights` still
 * imports no LLM client: `model` is a port.
 */
import { createNarratorAdvisor, type NarratorModelPort } from './advisors/local/narrator.ts';
import { NARRATOR_MANIFEST } from './advisors/local/manifest.ts';
import type { PromptRenderer } from './ports.ts';
import type { InsightsDependencies } from './service.ts';

export interface HolderNarrator {
  /** Pure; the bytes, the template hash, the model and the provider. */
  readonly renderer: PromptRenderer;
  /** Whatever produces the replies. `run` is never called by a preview or an approval. */
  readonly model: NarratorModelPort;
}

export const NARRATOR_ADVISOR_ID = NARRATOR_MANIFEST.advisor_id;

/** The model port when a holder has no narrator. Never reached past kill level 2; refuses if it is. */
const NO_NARRATOR: NarratorModelPort = Object.freeze({
  run: () =>
    Promise.reject(new Error('no narrator is configured for this holder (Off, or nothing set up)')),
});

export async function dependenciesForHolder(
  dependencies: InsightsDependencies,
  userId: string,
): Promise<InsightsDependencies> {
  if (dependencies.narratorFor === undefined) return dependencies;
  const narrator = await dependencies.narratorFor(userId);
  const registry = dependencies.registry.withAdvisor(
    NARRATOR_ADVISOR_ID,
    createNarratorAdvisor({ model: narrator === null ? NO_NARRATOR : narrator.model }),
  );
  const { promptRenderer: _dropped, ...rest } = dependencies;
  return narrator === null
    ? { ...rest, registry }
    : { ...rest, registry, promptRenderer: narrator.renderer };
}
