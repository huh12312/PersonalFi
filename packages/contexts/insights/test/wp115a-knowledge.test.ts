// SPDX-License-Identifier: MIT
/**
 * WP 11.5a — the knowledge base, pure: the generated playbook module holds the
 * eight drafted pages, every one a draft; the knowledge base serves a page only
 * when it is reviewed (decision 2 of 12 §7, enforced in code), with every
 * `{{param:…}}` rendered from the parameter port and nothing left unrendered;
 * and `resolveCitations` holds a narration to the pages and parameters that
 * were actually sent, refusing by class.
 *
 * The parameter port here is a fake over a handful of citations. The real
 * binding — Planning's store behind the port — is `apps/api/test/knowledge-base.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PLAYBOOK_PAGES } from '../data/playbook.ts';
import {
  CITATION_REFUSAL_CLASSES,
  KnowledgeRefusal,
  PLAYBOOK_SECTIONS,
  createKnowledgeBase,
  knowledgeCatalogueOf,
  knowledgeReadRecordSchema,
  parameterFigures,
  playbookDigest,
  renderMoney,
  renderParameter,
  renderRate,
  resolveCitations,
  type KnowledgeBase,
  type ParameterCitation,
  type ParameterPort,
  type PlaybookPageData,
  type ReviewedPlaybookPage,
} from '../src/index.ts';

const VERSION = `sha256:${'a'.repeat(64)}`;
const EXPECTED_KEYS = [
  'claiming-age',
  'debt-order',
  'emergency-fund',
  'guardrail-withdrawal',
  'rebalancing-with-new-money',
  'subscription-audit',
  'tax-advantaged-order',
  'tax-location',
];

const usd = (whole: string) => ({ minor: `${whole}00`, currency: 'USD' });

function money(key: string, whole: string): ParameterCitation {
  return {
    key,
    kind: 'money',
    value: usd(whole),
    source: `fixture source for ${key}`,
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  };
}
function rate(key: string, value: string): ParameterCitation {
  return {
    key,
    kind: 'rate',
    value,
    source: `fixture source for ${key}`,
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  };
}
function range(key: string, from: string, to: string): ParameterCitation {
  return {
    key,
    kind: 'moneyRange',
    value: { from: usd(from), to: usd(to) },
    source: `fixture source for ${key}`,
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  };
}
function integer(key: string, value: string): ParameterCitation {
  return {
    key,
    kind: 'integer',
    value,
    unit: 'calendar_year',
    source: `fixture for ${key}`,
    asOf: '2026-09-10',
    parametersVersion: VERSION,
  };
}

/** Every key the eight pages use, with the store's 2026 values — and one table, which has no inline form. */
const FIXTURE: readonly ParameterCitation[] = [
  money('tax.us.2026.retirement.elective_deferral', '24500'),
  money('tax.us.2026.retirement.catch_up_age_50', '8000'),
  money('tax.us.2026.retirement.catch_up_age_60_to_63', '11250'),
  money('tax.us.2026.retirement.ira_contribution', '7500'),
  money('tax.us.2026.retirement.ira_catch_up_age_50', '1100'),
  range('tax.us.2026.retirement.roth_ira_phase_out.single_or_hoh', '153000', '168000'),
  range('tax.us.2026.retirement.roth_ira_phase_out.mfj', '242000', '252000'),
  money('tax.us.2026.retirement.mandatory_roth_catch_up_wage_threshold', '150000'),
  money('tax.us.2026.hsa.self_only', '4400'),
  money('tax.us.2026.hsa.family', '8750'),
  money('tax.us.2026.hsa.catch_up_age_55', '1000'),
  rate('tax.us.2026.income_tax.net_investment_income_tax.rate', '0.038'),
  money('tax.us.2026.income_tax.net_investment_income_tax.threshold.single', '200000'),
  money('tax.us.2026.income_tax.net_investment_income_tax.threshold.mfj', '250000'),
  rate('tax.us.2026.social_security.delayed_retirement_credit_per_year', '0.08'),
  rate('tax.us.2026.social_security.cola', '0.028'),
  rate('assumptions.withdrawal_policy.guardrail_reference_rate', '0.045'),
  rate('assumptions.social_security_stress.payable_ratio', '0.75'),
  integer('assumptions.social_security_stress.from_calendar_year', '2034'),
  money('assumptions.market_reference.fdic_insurance_limit', '250000'),
  {
    key: 'tax.us.2026.income_tax.brackets.single',
    kind: 'brackets',
    value: [
      { over: usd('0'), rate: '0.10' },
      { over: usd('12400'), rate: '0.12' },
    ],
    source: 'fixture',
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  },
];

function fakePort(citations: readonly ParameterCitation[] = FIXTURE): ParameterPort {
  const byKey = new Map(citations.map((citation) => [citation.key, citation]));
  return {
    get(key) {
      const citation = byKey.get(key);
      if (citation !== undefined) return { found: true, citation };
      if (/^tax\.us\.(?!2026\.)\d{4}\./.test(key)) {
        return { found: false, reason: 'year_unavailable', detail: 'the store holds 2026' };
      }
      return { found: false, reason: 'unknown', detail: 'no such key' };
    },
  };
}

/** A copy of a page marked reviewed — what Chris's flip produces. Tests only. */
function reviewed(page: PlaybookPageData): PlaybookPageData {
  return { ...page, status: 'reviewed', reviewedBy: 'test reviewer', reviewedOn: '2026-10-28' };
}

function pageOf(key: string): PlaybookPageData {
  const page = PLAYBOOK_PAGES.find((candidate) => candidate.key === key);
  if (page === undefined) throw new Error(`no page ${key}`);
  return page;
}

function refusalOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof KnowledgeRefusal) return error.code;
    throw error;
  }
  return 'served';
}

const reviewedBase = (): KnowledgeBase =>
  createKnowledgeBase({ params: fakePort(), pages: PLAYBOOK_PAGES.map(reviewed) });

describe('WP 11.5a — the generated playbook module', () => {
  it('holds the eight drafted pages, every one a draft, every digest its body', () => {
    expect(PLAYBOOK_PAGES.map((page) => page.key)).toEqual(EXPECTED_KEYS);
    for (const page of PLAYBOOK_PAGES) {
      expect(page.status, page.key).toBe('draft');
      expect(page.reviewedBy, page.key).toBeNull();
      expect(page.reviewedOn, page.key).toBeNull();
      expect(page.version, page.key).toBe(1);
      expect(playbookDigest(page.sections), page.key).toBe(page.digest);
      for (const [name] of PLAYBOOK_SECTIONS)
        expect(page.sections[name].length, `${page.key}.${name}`).toBeGreaterThan(0);
      expect(page.sources.length, page.key).toBeGreaterThan(0);
    }
  });
});

describe('WP 11.5a — the review gate (12 §7 decision 2)', () => {
  it('the knowledge base refuses every draft page: playbook.unreviewed', () => {
    const knowledge = createKnowledgeBase({ params: fakePort() });
    for (const key of EXPECTED_KEYS)
      expect(
        refusalOf(() => knowledge.playbook.get(key)),
        key,
      ).toBe('playbook.unreviewed');
  });

  it('a page marked reviewed without a reviewer or a date is still refused', () => {
    const page = pageOf('debt-order');
    for (const half of [
      { ...page, status: 'reviewed' as const, reviewedBy: null, reviewedOn: '2026-10-28' },
      { ...page, status: 'reviewed' as const, reviewedBy: 'Chris', reviewedOn: null },
      { ...page, status: 'reviewed' as const, reviewedBy: '  ', reviewedOn: '2026-10-28' },
    ]) {
      const knowledge = createKnowledgeBase({ params: fakePort(), pages: [half] });
      expect(refusalOf(() => knowledge.playbook.get('debt-order'))).toBe('playbook.unreviewed');
    }
  });

  it('a reviewed page is served whole, with its version, digest and sources', () => {
    const page = reviewedBase().playbook.get('debt-order');
    expect(page).toMatchObject({
      key: 'debt-order',
      version: 1,
      digest: pageOf('debt-order').digest,
      reviewedBy: 'test reviewer',
    });
    expect(page.text.startsWith('# The order to pay debts down\n\n## The rule\n\n')).toBe(true);
    expect(page.sources.map((source) => source.id)).toEqual(['cfpb-reduce-debt']);
  });

  it('a page whose sections no longer hash to its digest is refused: playbook.digest_mismatch', () => {
    const page = reviewed(pageOf('debt-order'));
    const edited = {
      ...page,
      sections: { ...page.sections, rule: `${page.sections.rule} One more sentence.` },
    };
    const knowledge = createKnowledgeBase({ params: fakePort(), pages: [edited] });
    expect(refusalOf(() => knowledge.playbook.get('debt-order'))).toBe('playbook.digest_mismatch');
  });

  it('an unknown page is refused: playbook.unknown', () => {
    expect(refusalOf(() => reviewedBase().playbook.get('roth-conversion'))).toBe(
      'playbook.unknown',
    );
  });
});

describe('WP 11.5a — placeholders are rendered from the store at read time', () => {
  it('every placeholder in every page is rendered, and none is left', () => {
    const knowledge = reviewedBase();
    for (const key of EXPECTED_KEYS) {
      const page = knowledge.playbook.get(key);
      expect(page.text, key).not.toContain('{{');
      for (const section of Object.values(page.sections)) expect(section, key).not.toContain('{{');
      expect(
        page.params.map((citation) => citation.key),
        key,
      ).toEqual(pageOf(key).params);
    }
  });

  it('a limit reads as the store holds it, with its tax year', () => {
    const page = reviewedBase().playbook.get('tax-advantaged-order');
    expect(page.sections.rule).toContain(
      'up to $7,500 (tax year 2026), plus $1,100 (tax year 2026) from age 50',
    );
    expect(page.sections.rule).toContain('$24,500 (tax year 2026)');
    expect(page.sections.why).toContain('$153,000–$168,000 (tax year 2026)');
    const location = reviewedBase().playbook.get('tax-location');
    expect(location.sections.why).toContain('a further 3.8% (tax year 2026) applies');
    const fund = reviewedBase().playbook.get('emergency-fund');
    expect(fund.sections.why).toContain('insured to $250,000 per depositor');
  });

  it('a changed store value changes the page with no edit to it', () => {
    const moved = FIXTURE.map((citation) =>
      citation.key === 'tax.us.2026.retirement.ira_contribution' // gitleaks:allow — a parameter key, not a secret
        ? money(citation.key, '7600')
        : citation,
    );
    const knowledge = createKnowledgeBase({
      params: fakePort(moved),
      pages: PLAYBOOK_PAGES.map(reviewed),
    });
    expect(knowledge.playbook.get('tax-advantaged-order').sections.rule).toContain(
      'up to $7,600 (tax year 2026)',
    );
  });

  it('a placeholder the store cannot answer refuses the whole page: playbook.param_unavailable', () => {
    const missing = FIXTURE.filter((citation) => citation.key !== 'tax.us.2026.hsa.family');
    const knowledge = createKnowledgeBase({
      params: fakePort(missing),
      pages: PLAYBOOK_PAGES.map(reviewed),
    });
    expect(refusalOf(() => knowledge.playbook.get('tax-advantaged-order'))).toBe(
      'playbook.param_unavailable',
    );
  });

  it('a placeholder naming a table refuses the page: playbook.param_unrenderable', () => {
    const page = reviewed(pageOf('tax-location'));
    const sections = {
      ...page.sections,
      rule: `${page.sections.rule} {{param:tax.us.2026.income_tax.brackets.single}}`,
    };
    const knowledge = createKnowledgeBase({
      params: fakePort(),
      pages: [{ ...page, sections, digest: playbookDigest(sections) }],
    });
    expect(refusalOf(() => knowledge.playbook.get('tax-location'))).toBe(
      'playbook.param_unrenderable',
    );
  });

  it('params.get answers a key, and refuses an unknown key and a year the store does not hold', () => {
    const knowledge = reviewedBase();
    expect(knowledge.params.get('tax.us.2026.hsa.family')).toMatchObject({
      kind: 'money',
      value: { minor: '875000' },
    });
    expect(refusalOf(() => knowledge.params.get('tax.us.2027.retirement.elective_deferral'))).toBe(
      'param.year_unavailable',
    );
    expect(refusalOf(() => knowledge.params.get('assumptions.no_such_thing'))).toBe(
      'param.unknown',
    );
  });
});

describe('WP 11.5a — rendering a parameter', () => {
  it('money, rates and ranges render exactly, from strings', () => {
    expect(renderMoney({ minor: '2450000', currency: 'USD' })).toBe('$24,500');
    expect(renderMoney({ minor: '1899', currency: 'USD' })).toBe('$18.99');
    expect(renderMoney({ minor: '5', currency: 'USD' })).toBe('$0.05');
    expect(renderMoney({ minor: '100', currency: 'EUR' })).toBeNull();
    expect(renderRate('0.038')).toBe('3.8%');
    expect(renderRate('0.0393')).toBe('3.93%');
    expect(renderRate('0.08')).toBe('8%');
    expect(renderRate('0.10')).toBe('10%');
    expect(renderRate('1')).toBe('100%');
    expect(renderRate('-0.05')).toBe('-5%');
    expect(
      renderParameter(range('tax.us.2026.retirement.roth_ira_phase_out.mfj', '242000', '252000')),
    ).toBe('$242,000–$252,000 (tax year 2026)');
    expect(
      renderParameter(rate('assumptions.withdrawal_policy.guardrail_reference_rate', '0.045')),
    ).toBe('4.5%');
    expect(
      renderParameter(integer('assumptions.social_security_stress.from_calendar_year', '2034')),
    ).toBe('2034');
    expect(renderParameter(FIXTURE.at(-1) as ParameterCitation)).toBeNull();
  });

  it('a parameter licenses its rendered figures and nothing derived from them', () => {
    expect(parameterFigures(money('tax.us.2026.retirement.ira_contribution', '7500'))).toEqual([
      '7500',
      '7500.00',
      '2026',
    ]);
    expect(
      parameterFigures(rate('assumptions.withdrawal_policy.guardrail_reference_rate', '0.045')),
    ).toEqual(['4.5%']);
  });
});

describe('WP 11.5a — resolveCitations holds a narration to what was sent', () => {
  const knowledge = reviewedBase();
  const catalogue = knowledgeCatalogueOf(createKnowledgeBase({ params: fakePort() }));
  const order = knowledge.playbook.get('tax-advantaged-order');
  const debt = knowledge.playbook.get('debt-order');
  const ira = knowledge.params.get('tax.us.2026.retirement.ira_contribution');
  const fdic = knowledge.params.get('assumptions.market_reference.fdic_insurance_limit');
  const sent = { pages: [debt], params: [fdic] } as const;

  const verdict = (
    text: string,
    context: {
      pages: readonly ReviewedPlaybookPage[];
      params: readonly ParameterCitation[];
      allowedFigures?: readonly string[];
    } = sent,
  ) => resolveCitations(text, context, catalogue);
  const refusal = (text: string, context?: Parameters<typeof verdict>[1]) => {
    const result = verdict(text, context);
    return result.ok ? 'accepted' : result.refusal;
  };

  it('names its refusal classes', () => {
    expect(CITATION_REFUSAL_CLASSES).toEqual([
      'citation.malformed',
      'citation.unknown',
      'citation.page_not_sent',
      'citation.param_not_sent',
      'numeral',
      'word_figure',
    ]);
  });

  it('accepts a narration citing only what was sent, and records what it read', () => {
    const result = verdict(
      'One common approach keeps every minimum and sends extra money to the highest rate first [playbook:debt-order]. ' +
        'Deposits are insured to $250,000 per bank [param:assumptions.market_reference.fdic_insurance_limit].',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cited).toEqual({
      pages: ['debt-order'],
      params: ['assumptions.market_reference.fdic_insurance_limit'],
    });
    expect(knowledgeReadRecordSchema.parse(result.record)).toEqual(result.record);
    expect(result.record.pages).toEqual([
      { key: 'debt-order', version: 1, digest: pageOf('debt-order').digest },
    ]);
    expect(result.record.params).toEqual([
      {
        key: 'assumptions.market_reference.fdic_insurance_limit',
        kind: 'money',
        rendered: '$250,000',
        asOf: '2026-01-01',
        parametersVersion: VERSION,
      },
    ]);
  });

  it('refuses a citation to a page that exists but was not sent: citation.page_not_sent', () => {
    expect(refusal('An IRA comes after the match [playbook:tax-advantaged-order].')).toBe(
      'citation.page_not_sent',
    );
  });

  it('a draft page can never be cited, because it can never have been sent', () => {
    const drafts = createKnowledgeBase({ params: fakePort() });
    expect(refusalOf(() => drafts.playbook.get('claiming-age'))).toBe('playbook.unreviewed');
    expect(refusal('Waiting raises the benefit [playbook:claiming-age].')).toBe(
      'citation.page_not_sent',
    );
  });

  it('refuses a page key that does not exist: citation.unknown', () => {
    expect(refusal('A conversion fills the bracket [playbook:roth-conversion].')).toBe(
      'citation.unknown',
    );
  });

  it('refuses a parameter that exists but was not sent: citation.param_not_sent', () => {
    expect(refusal('The HSA family limit applies [param:tax.us.2026.hsa.family].')).toBe(
      'citation.param_not_sent',
    );
  });

  it('refuses a parameter for a year the store does not hold: citation.unknown', () => {
    expect(
      refusal('The limit is higher next year [param:tax.us.2027.retirement.ira_contribution].'),
    ).toBe('citation.unknown');
  });

  it('refuses a malformed marker and a raw placeholder: citation.malformed', () => {
    expect(refusal('See [param:Tax.US.2026].')).toBe('citation.malformed');
    expect(refusal('See [playbook:Debt Order].')).toBe('citation.malformed');
    expect(refusal('The limit is {{param:tax.us.2026.retirement.ira_contribution}}.')).toBe(
      'citation.malformed',
    );
  });

  it('refuses a figure neither sent nor allowed: numeral', () => {
    expect(
      refusal(
        'Deposits are insured to $300,000 per bank [param:assumptions.market_reference.fdic_insurance_limit].',
      ),
    ).toBe('numeral');
    expect(refusal('An IRA takes up to $7,500 a year.')).toBe('numeral');
  });

  it('a parameter rendered into a sent page counts as sent, figure and key', () => {
    const context = { pages: [order], params: [] };
    expect(
      refusal(
        'An IRA takes up to $7,500 [param:tax.us.2026.retirement.ira_contribution] [playbook:tax-advantaged-order].',
        context,
      ),
    ).toBe('accepted');
    expect(ira.key).toBe('tax.us.2026.retirement.ira_contribution');
  });

  it('a figure the page itself states is allowed; one it does not is not', () => {
    const claiming = knowledge.playbook.get('claiming-age');
    const context = { pages: [claiming], params: [] };
    expect(
      refusal('Claiming at 62 lowers the benefit by 30% [playbook:claiming-age].', context),
    ).toBe('accepted');
    expect(
      refusal('Claiming at 62 lowers the benefit by 35% [playbook:claiming-age].', context),
    ).toBe('numeral');
  });

  it("the caller's own figures are allowed", () => {
    expect(refusal('Your balance is $1,234.56.', { ...sent, allowedFigures: ['$1,234.56'] })).toBe(
      'accepted',
    );
    expect(refusal('Your balance is $1,234.57.', { ...sent, allowedFigures: ['$1,234.56'] })).toBe(
      'numeral',
    );
  });

  it('refuses a figure spelled out with a currency cue: word_figure', () => {
    expect(refusal('About two thousand dollars sits idle [playbook:debt-order].')).toBe(
      'word_figure',
    );
  });

  it("a marker's own digits are not figures", () => {
    expect(
      refusal('The FDIC limit is cited [param:assumptions.market_reference.fdic_insurance_limit].'),
    ).toBe('accepted');
  });
});
