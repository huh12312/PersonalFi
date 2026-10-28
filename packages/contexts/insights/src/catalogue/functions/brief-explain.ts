// SPDX-License-Identifier: MIT
/**
 * `insights.current` and `insights.explain` (WP 11.5b): what the deterministic
 * advisors already found, read only. Neither ever triggers a model call: the
 * Brief is the one the weekly job published, and an explanation is the one
 * WP 11.3's cache already holds for exactly this evidence, or nothing.
 *
 * Both are `any` functions under the narrator's bound, gated per item the way
 * `brief.narrate` and `insight.explain` gate theirs: an item (or an insight)
 * whose source run read a scope outside the holder's live narrator grant is
 * left out (or refused), never sent.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { advisoryBriefs } from '../../../schema/index.ts';
import { INSIGHT_EXPLAIN_MANIFEST } from '../../advisors/explain/manifest.ts';
import { buildExplainRequest } from '../../advisors/explain/request.ts';
import { findExplanation, loadInsightExplainTarget } from '../../advisors/explain/source.ts';
import { loadBriefNarrateSources } from '../../advisors/brief-narrate/source.ts';
import { NARRATOR_SCOPES } from '../../advisors/local/manifest.ts';
import { defineFunction, notAvailable, ok } from '../definition.ts';
import { MoneyFigureSchema, moneyFigure, ref } from '../figures.ts';
import { CatalogueRefusal } from '../ports.ts';

export const insightsCurrent = defineFunction({
  name: 'insights.current',
  summary: 'This week’s Brief: its ranked actions in order, with the dollar impact each states.',
  description:
    'The newest published Brief’s ranked items, in the Brief’s own order (by the dollar impact ' +
    'it computed), each with its title, summary and impact. An item built from a scope the ' +
    'holder has not granted the narrator is left out and counted. Read only; nothing is ranked ' +
    'again and no model is asked.',
  backing:
    'The weekly Brief (WP 5.6, advisory_briefs / advisory_brief_items), as brief.narrate reads it',
  scopes: NARRATOR_SCOPES,
  scopeRule: 'any',
  args: z.strictObject({}),
  result: z.strictObject({
    iso_week: z.string(),
    nothing_material: z.boolean(),
    items: z.array(
      z.strictObject({
        position: z.int(),
        insight_id: z.string().nullable(),
        title: z.string(),
        summary: z.string(),
        carried: z.boolean(),
        annual_impact: MoneyFigureSchema.nullable(),
        one_time_impact: MoneyFigureSchema.nullable(),
      }),
    ),
    withheld_count: z.int(),
  }),
  async run(context, _args, scopes) {
    const inputs: Record<string, unknown> = { args: {} };
    const rows = await context.database
      .select({ id: advisoryBriefs.id })
      .from(advisoryBriefs)
      .where(and(eq(advisoryBriefs.userId, context.userId)))
      .orderBy(desc(advisoryBriefs.isoWeek))
      .limit(1);
    const newest = rows[0];
    if (newest === undefined) {
      return notAvailable(inputs, 'no_brief', 'No weekly Brief has been published yet.');
    }
    const sources = await loadBriefNarrateSources(context.database, context.userId, newest.id);
    if (sources === null) {
      return notAvailable(inputs, 'no_brief', 'No weekly Brief has been published yet.');
    }
    const ceiling = new Set<string>(scopes);
    const shown = sources.ranked.filter(
      (item) => item.scopes !== null && item.scopes.every((scope) => ceiling.has(scope)),
    );
    inputs['brief'] = {
      iso_week: sources.isoWeek,
      nothing_material: sources.nothingMaterial,
      items: shown.map((item, position) => ({
        position: position + 1,
        insight_id: item.insightId,
        title: item.title,
        annualized_impact: item.annualizedImpact,
        one_time_impact: item.oneTimeImpact,
        scopes: [...(item.scopes ?? [])],
      })),
    };
    return ok(inputs, {
      iso_week: sources.isoWeek,
      nothing_material: sources.nothingMaterial,
      items: shown.map((item, index) => ({
        position: index + 1,
        insight_id: item.insightId,
        title: item.title,
        summary: item.summaryMd,
        carried: item.carried,
        annual_impact:
          item.annualizedImpact === null
            ? null
            : moneyFigure(item.annualizedImpact, [
                ref(`brief.items[${String(index)}].annualized_impact`),
              ]),
        one_time_impact:
          item.oneTimeImpact === null
            ? null
            : moneyFigure(item.oneTimeImpact, [
                ref(`brief.items[${String(index)}].one_time_impact`),
              ]),
      })),
      withheld_count: sources.ranked.length - shown.length,
    });
  },
});

export const insightsExplain = defineFunction({
  name: 'insights.explain',
  summary: 'The stored “Explain this” for one insight, if one has been given — never a new one.',
  description:
    'Returns the explanation WP 11.3 already stored for exactly this insight’s current evidence ' +
    '(or the refusal class, when the model’s draft was refused), or not_available when none is ' +
    'stored. Never triggers a model call. Refused when the insight was built from a scope the ' +
    'holder has not granted the narrator.',
  backing: 'WP 11.3’s explanation cache (insight_explanations), keyed by the evidence digest',
  scopes: NARRATOR_SCOPES,
  scopeRule: 'any',
  args: z.strictObject({ insight_id: z.uuid() }),
  result: z.strictObject({
    insight_id: z.string(),
    status: z.enum(['shown', 'refused']),
    text: z.string().nullable(),
    refusal_class: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
  }),
  async run(context, args, scopes) {
    const inputs: Record<string, unknown> = { args: { insight_id: args.insight_id } };
    const loaded = await loadInsightExplainTarget(
      context.database,
      context.userId,
      args.insight_id,
    );
    if (loaded.status === 'not_found') {
      throw new CatalogueRefusal('catalogue.insight_unknown', 404, `no insight ${args.insight_id}`);
    }
    if (loaded.status !== 'found') {
      return notAvailable(
        inputs,
        'not_explainable',
        `This insight has no explanation to give (${loaded.reason}).`,
      );
    }
    const ceiling = new Set<string>(scopes);
    const outside = loaded.target.scopes.filter((scope) => !ceiling.has(scope));
    if (outside.length > 0) {
      throw new CatalogueRefusal(
        'catalogue.scope_not_granted',
        403,
        `this insight was built from scopes not granted to the narrator: ${outside.join(', ')}`,
      );
    }
    const digest = buildExplainRequest({
      target: loaded.target,
      now: context.clock.now(),
      timeoutMs: INSIGHT_EXPLAIN_MANIFEST.limits.timeout_ms,
      maxResponseBytes: INSIGHT_EXPLAIN_MANIFEST.limits.max_response_bytes,
    }).digest;
    inputs['explanation_key'] = { insight_id: args.insight_id, evidence_digest: digest };
    const stored = await findExplanation(context.database, context.userId, {
      entityKind: 'insight',
      entityId: args.insight_id,
      evidenceDigest: digest,
    });
    if (stored === null) {
      return notAvailable(
        inputs,
        'no_stored_explanation',
        'No explanation is stored for this insight’s current evidence. The catalogue never asks a model for one.',
      );
    }
    return ok(inputs, {
      insight_id: args.insight_id,
      status: stored.text === null ? 'refused' : 'shown',
      text: stored.text,
      refusal_class: stored.refusal,
      provider: stored.provider,
      model: stored.model,
    });
  },
});
