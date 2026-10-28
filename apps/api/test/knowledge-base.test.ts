// SPDX-License-Identifier: MIT
/**
 * WP 11.5a — the knowledge base, bound: Planning's parameter store behind
 * Insights' `ParameterPort` (`src/knowledge-base.ts`).
 *
 *   * The binding is the identity over every key in the assumptions file, and
 *     turns Planning's two refusals into the port's `found: false` answers.
 *   * Every `{{param:…}}` in every checked-in playbook page resolves in the real
 *     store and renders — checked on reviewed *copies*, because the real pages
 *     are drafts and the production knowledge base refuses every one of them.
 *   * A narration over a reviewed copy and a real parameter resolves end to end,
 *     and records what it read.
 */
import {
  KnowledgeRefusal,
  PLAYBOOK_PAGES,
  knowledgeCatalogueOf,
  knowledgeReadRecordSchema,
  resolveCitations,
  type PlaybookPageData,
} from '@ctx/insights';
import { assumptionsVersion, parameterByKey, parameterCatalogue } from '@ctx/planning';
import { describe, expect, it } from 'vitest';
import { createAdvisorKnowledgeBase, createKnowledgeParameterPort } from '../src/knowledge-base.ts';

const reviewedCopies: readonly PlaybookPageData[] = PLAYBOOK_PAGES.map((page) => ({
  ...page,
  status: 'reviewed',
  reviewedBy: 'test reviewer',
  reviewedOn: '2026-10-28',
}));

function refusalOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof KnowledgeRefusal) return error.code;
    throw error;
  }
  return 'served';
}

describe('WP 11.5a — Planning parameters behind the Insights port', () => {
  it('the binding is the identity over every key in the assumptions file', () => {
    const port = createKnowledgeParameterPort();
    const catalogue = parameterCatalogue();
    expect(catalogue.size).toBe(93);
    for (const key of catalogue.keys()) {
      expect(port.get(key), key).toEqual({ found: true, citation: parameterByKey(key) });
    }
  });

  it('a 2027 key answers year_unavailable, and a nonsense key unknown — never a 2026 value', () => {
    const port = createKnowledgeParameterPort();
    expect(port.get('tax.us.2027.retirement.elective_deferral')).toMatchObject({
      found: false,
      reason: 'year_unavailable',
    });
    expect(port.get('tax.us.2026.retirement.nothing')).toMatchObject({
      found: false,
      reason: 'unknown',
    });
    const knowledge = createAdvisorKnowledgeBase();
    expect(refusalOf(() => knowledge.params.get('tax.us.2027.retirement.elective_deferral'))).toBe(
      'param.year_unavailable',
    );
  });
});

describe('WP 11.5a — the checked-in playbook over the real store', () => {
  it('the production knowledge base serves no page: all eight are drafts', () => {
    const knowledge = createAdvisorKnowledgeBase();
    expect(knowledge.playbook.keys()).toHaveLength(8);
    for (const key of knowledge.playbook.keys()) {
      expect(
        refusalOf(() => knowledge.playbook.get(key)),
        key,
      ).toBe('playbook.unreviewed');
    }
  });

  it('every placeholder in every page resolves in the store and renders, with none left', () => {
    const knowledge = createAdvisorKnowledgeBase({ pages: reviewedCopies });
    let rendered = 0;
    for (const page of PLAYBOOK_PAGES) {
      const served = knowledge.playbook.get(page.key);
      expect(served.text, page.key).not.toContain('{{');
      expect(
        served.params.map((citation) => citation.key),
        page.key,
      ).toEqual(page.params);
      for (const citation of served.params)
        expect(citation.parametersVersion).toBe(assumptionsVersion());
      rendered += served.params.length;
    }
    expect(rendered).toBe(20);
    const order = knowledge.playbook.get('tax-advantaged-order');
    expect(order.sections.rule).toContain(
      'the elective deferral limit of $24,500 (tax year 2026), plus a catch-up of $8,000 (tax year 2026) from age 50',
    );
    expect(knowledge.playbook.get('guardrail-withdrawal').sections.rule).toContain(
      'a reference rate of 4.5%',
    );
    expect(knowledge.playbook.get('claiming-age').sections.why).toContain(
      'cut to 75% of the scheduled amount from 2034',
    );
  });

  it('a narration over a reviewed page and a real parameter resolves, and records what it read', () => {
    const knowledge = createAdvisorKnowledgeBase({ pages: reviewedCopies });
    const page = knowledge.playbook.get('tax-advantaged-order');
    const hsa = knowledge.params.get('tax.us.2026.hsa.family');
    const catalogue = knowledgeCatalogueOf(createAdvisorKnowledgeBase());
    const result = resolveCitations(
      'One common approach fills the IRA after the match, up to $7,500 [param:tax.us.2026.retirement.ira_contribution] ' +
        '[playbook:tax-advantaged-order]; with family coverage the HSA takes up to $8,750 [param:tax.us.2026.hsa.family].',
      { pages: [page], params: [hsa] },
      catalogue,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = knowledgeReadRecordSchema.parse(result.record);
    expect(record.pages).toEqual([
      { key: 'tax-advantaged-order', version: 1, digest: page.digest },
    ]);
    expect(record.params.map((entry) => entry.key)).toContain('tax.us.2026.hsa.family');
    expect(record.params.every((entry) => entry.parametersVersion === assumptionsVersion())).toBe(
      true,
    );
    expect(record.cited.params).toEqual([
      'tax.us.2026.hsa.family',
      'tax.us.2026.retirement.ira_contribution',
    ]);

    const stale = resolveCitations(
      'The IRA limit is $7,500 [param:tax.us.2027.retirement.ira_contribution].',
      { pages: [page], params: [] },
      catalogue,
    );
    expect(stale).toMatchObject({ ok: false, refusal: 'citation.unknown' });
  });
});
