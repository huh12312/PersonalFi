// SPDX-License-Identifier: MIT
/**
 * The holder's live grant to the narrator, inside a bound — the one gate every
 * query type that sends the narrator's payload class reads (`insight.explain`,
 * WP 11.3; `brief.narrate`, WP 11.4) and the advisory catalogue's (WP 11.5b).
 *
 * Read from `snapshot_grants` for `local.narrator` through `effectiveRunScopes`
 * — the run path's own reading of a grant: the manifest's requested scopes,
 * the per-kind ceiling, and the per-run-consent rule for a `local_model`
 * advisor — then intersected with the caller's bound (the narrator's own list
 * by default, which never holds `transactions.raw`). One function, so a query
 * type and a catalogue function the holder has not granted are refused by the
 * same code path, not by two that agree today.
 */
import type { AdvisorScope } from '../../contract/scopes.ts';
import type { InsightsExecutor } from '../../db.ts';
import { effectiveRunScopes } from '../../preview.ts';
import { listGrants } from '../../store.ts';
import { NARRATOR_ADVISOR_ID, NARRATOR_MANIFEST, NARRATOR_SCOPES } from './manifest.ts';

/** The narrator's live grant ∩ `bound`, in catalogue order. */
export async function narratorGrantCeiling(
  executor: InsightsExecutor,
  userId: string,
  bound: readonly AdvisorScope[] = NARRATOR_SCOPES,
): Promise<readonly AdvisorScope[]> {
  const grant = effectiveRunScopes(
    NARRATOR_MANIFEST,
    await listGrants(executor, userId, NARRATOR_ADVISOR_ID),
  );
  const inside = new Set<string>(bound);
  return grant.filter((scope) => inside.has(scope));
}
