// SPDX-License-Identifier: MIT
/**
 * The request a `narrates_only` advisor is sent: the findings envelope and an
 * empty snapshot (contract 1.5.0; `contract/request.ts`'s header).
 *
 * Built through `preview.ts`'s `buildAdvisorRequest` — the one constructor of
 * an `AdvisorRequest` on the run path — with **no scopes**, so the snapshot is
 * the builder's own empty object and its digest is the builder's own digest of
 * it; then the envelope is attached and `granted_scopes` restored to the
 * effective grant, which is what every finding was laundered against. The
 * `BuiltSnapshot` returned beside it records, on `advisor_runs`, the grant as
 * `granted_scopes` and the union of the admitted findings' source scopes as
 * `emitted_scopes` — the data categories that actually reached the model.
 *
 * `input_digest` stays what the contract says it is — the digest of
 * `snapshot` — so WP 5.1's inspector re-digests a retained narrator payload
 * exactly as any other. What identifies the *findings* a narrator was sent is
 * the retained payload itself and `advisor_runs.llm_prompt_hash`, the sha256
 * of the rendered prompt, which contains them.
 */
import type { AdvisorScope } from '../../contract/scopes.ts';
import type { InsightsContext, InsightsExecutor } from '../../db.ts';
import { buildAdvisorRequest, type BuiltRequest } from '../../preview.ts';
import type { RegisteredAdvisor } from '../../registry.ts';
import type { InsightsDependencies } from '../../service.ts';
import { assembleFindings, type AssembledFindings } from './findings.ts';

export interface NarrationRequest extends BuiltRequest {
  /** `finding.key` → the built-in insight a narration of it links to. */
  readonly insightIdByKey: AssembledFindings['insightIdByKey'];
  readonly excluded: AssembledFindings['excluded'];
  readonly findingCount: number;
}

export async function buildNarrationRequest(
  executor: InsightsExecutor,
  dependencies: InsightsDependencies,
  context: InsightsContext,
  registered: RegisteredAdvisor,
  grant: readonly AdvisorScope[],
  insightIds?: readonly string[],
): Promise<NarrationRequest> {
  const assembled = await assembleFindings(executor, {
    userId: context.userId,
    grant,
    kind: registered.manifest.kind,
    registry: dependencies.registry,
    now: context.clock.now(),
    currency: dependencies.settings.baseCurrency,
    ...(insightIds === undefined ? {} : { insightIds }),
  });
  const empty = await buildAdvisorRequest(dependencies, context, registered, []);
  const request = {
    ...empty.request,
    granted_scopes: [...grant],
    ...(assembled.findings.length === 0 ? {} : { findings: [...assembled.findings] }),
  };
  return {
    request,
    built: { ...empty.built, grantedScopes: [...grant], emittedScopes: [...assembled.reached] },
    insightIdByKey: assembled.insightIdByKey,
    excluded: assembled.excluded,
    findingCount: assembled.findings.length,
  };
}
