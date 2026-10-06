// SPDX-License-Identifier: MIT
/**
 * The narrator's half of the worker's composition root (WP 9.5; Phase 5 gate
 * C5-4, G5-6, B5b) — extracted from `worker.ts` so that the three things that
 * must run the narrator *as shipped* run this function and not a copy of it:
 *
 *   * `worker.ts`'s `main()`, which binds what it returns into `appModules`
 *     (`narratorModel`, `promptRenderer`, `localModelConfigured`);
 *   * `scripts/advisor-eval.ts --live` and `--brief`, the counted evaluation
 *     and the 5-item Brief measurement — the gate's G5-6 found both Phase 5
 *     live numbers taken on an adapter built with a reply format the worker
 *     never passed, a different template hash and a different query shape;
 *   * `apps/api/test/db/narrator-composition.test.ts`, which asserts through it
 *     that an accepted narration lands (B5b) and what format it sends.
 *
 * It takes **no `format` and no sampling options** on purpose: the adapter's
 * default `format` is the narrator's reply format (`@advisor/local-model`'s
 * `NARRATION_FORMAT`, pinned equal to `@ctx/insights`' `NARRATOR_REPLY_FORMAT`),
 * and there is no parameter through which a caller could measure a different
 * one. Importable from a plain script: nothing here reads config, opens a
 * database or boots anything (`worker.ts` cannot be imported outside Vitest).
 */
import {
  createLocalModelAdapter,
  type LocalModelAdapter,
  type LocalModelAdapterConfig,
  type LocalModelLogger,
  type LocalModelTransport,
} from '@advisor/local-model';
import type { Clock } from '@core/kernel';

export interface NarratorWiringDeps {
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** Tests and the eval's loopback smoke only; production resolves through the policy. */
  readonly transport?: LocalModelTransport;
}

export interface NarratorWiring {
  /** The adapter; its `promptRenderer` is what `appModules` binds for preview and approval. */
  readonly localModel: LocalModelAdapter;
  /**
   * What `insightsModule` wraps with `createNarratorAdvisor` — the adapter
   * itself: `LocalModelAdapter.run` satisfies `NarratorModelPort`
   * structurally, so there is nothing to adapt (W-C's own note).
   */
  readonly narratorModel: LocalModelAdapter;
}

/**
 * `undefined` exactly when no model is configured (`config.localModel`), the
 * W-A/W-C rule: then `insightsModule` registers no narrator either. Throws on
 * a malformed digest or an endpoint the local-endpoint policy refuses — boot
 * fails on purpose (`worker.ts`'s own comment).
 */
export function createNarratorWiring(
  config: LocalModelAdapterConfig | undefined,
  deps: NarratorWiringDeps = {},
): NarratorWiring | undefined {
  if (config === undefined) return undefined;
  const localModel = createLocalModelAdapter(config, {
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.transport === undefined ? {} : { transport: deps.transport }),
  });
  return Object.freeze({ localModel, narratorModel: localModel });
}
