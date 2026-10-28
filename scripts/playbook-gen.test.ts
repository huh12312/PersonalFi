// SPDX-License-Identifier: MIT
/**
 * WP 11.5a — the playbook generator's rules, each watched failing on a fixture
 * page, then the real tree: the eight pages parse, and the checked-in module is
 * exactly what they generate (the drift check's vitest half; CI's lint job runs
 * `pnpm run playbook -- --check`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_WORDS,
  MIN_WORDS,
  PLAYBOOK_MODULE,
  PlaybookPageError,
  bodyWordCount,
  emitPlaybookModule,
  main,
  parsePlaybookPage,
  readPlaybook,
  storeResolver,
  type ParamResolver,
  type ProblemCode,
} from './playbook-gen.ts';
import { playbookDigest } from '../packages/contexts/insights/src/knowledge/page.ts';

const FILLER = (
  'This sentence is padding so that the page reaches the minimum length the generator asks for, ' +
  'and it carries no figure of any kind, only words about the rule and why it holds for a household. '
).repeat(2);

const fakeResolver: ParamResolver = (key) =>
  key === 'tax.us.2026.retirement.ira_contribution' // gitleaks:allow — a parameter key, not a secret
    ? {
        ok: true,
        citation: {
          key,
          kind: 'money',
          value: { minor: '750000', currency: 'USD' },
          source: 'fixture',
          asOf: '2026-01-01',
          parametersVersion: `sha256:${'b'.repeat(64)}`,
        },
      }
    : key === 'tax.us.2026.income_tax.brackets.single'
      ? {
          ok: true,
          citation: {
            key,
            kind: 'brackets',
            value: [{ over: { minor: '0', currency: 'USD' }, rate: '0.10' }],
            source: 'fixture',
            asOf: '2026-01-01',
            parametersVersion: `sha256:${'b'.repeat(64)}`,
          },
        }
      : { ok: false, detail: `no parameter ${key}` };

interface Fixture {
  front?: string;
  rule?: string;
  why?: string;
  whenNot?: string;
  sources?: string;
  headings?: readonly string[];
}

function page(fixture: Fixture = {}): string {
  const front =
    fixture.front ??
    [
      'key: fixture-page',
      'title: A fixture page',
      'version: 1',
      'status: draft',
      'sources:',
      '  - id: irs-pub-590a',
      "    title: 'IRS Publication 590-A'",
      '    url_or_citation: https://www.irs.gov/publications/p590a',
      '    accessed: 2026-10-28',
    ].join('\n');
  const headings = fixture.headings ?? ['The rule', 'Why', 'When it does not apply', 'Sources'];
  const bodies = [
    fixture.rule ??
      `One common approach is an IRA, up to {{param:tax.us.2026.retirement.ira_contribution}}. ${FILLER}`,
    fixture.why ?? `The limit is set each year by the IRS[^irs-pub-590a]. ${FILLER}`,
    fixture.whenNot ?? `- **Not when.** A household without earned income has no room. ${FILLER}`,
    fixture.sources ?? '[^irs-pub-590a]: IRS Publication 590-A (accessed 2026-10-28).',
  ];
  return `---\n${front}\n---\n\n${headings.map((heading, index) => `## ${heading}\n\n${bodies[index] ?? ''}`).join('\n\n')}\n`;
}

function codesOf(markdown: string, resolver: ParamResolver = fakeResolver): readonly ProblemCode[] {
  try {
    parsePlaybookPage(markdown, 'fixture-page.md', resolver);
    return [];
  } catch (error) {
    if (error instanceof PlaybookPageError) return error.problems.map((problem) => problem.code);
    throw error;
  }
}

const DRAFT_FRONT =
  page()
    .split('\n---\n')[0]
    ?.replace(/^---\n/, '') ?? '';
const digestOfFixture = (): string =>
  parsePlaybookPage(page(), 'fixture-page.md', fakeResolver).digest;

function reviewedFront(extra: readonly string[]): string {
  return DRAFT_FRONT.replace('status: draft', ['status: reviewed', ...extra].join('\n'));
}

describe('WP 11.5a — the generator accepts a well-formed page', () => {
  it('parses the fixture: key, version, status, sources, params, digest', () => {
    const parsed = parsePlaybookPage(page(), 'fixture-page.md', fakeResolver);
    expect(parsed).toMatchObject({
      key: 'fixture-page',
      version: 1,
      status: 'draft',
      reviewedBy: null,
      reviewedOn: null,
      params: ['tax.us.2026.retirement.ira_contribution'],
    });
    expect(parsed.sources).toEqual([
      {
        id: 'irs-pub-590a',
        title: 'IRS Publication 590-A',
        urlOrCitation: 'https://www.irs.gov/publications/p590a',
        accessed: '2026-10-28',
      },
    ]);
    expect(parsed.digest).toBe(playbookDigest(parsed.sections));
  });
});

describe('WP 11.5a — the review gate, at generation', () => {
  it('refuses `reviewed` without reviewed_by', () => {
    const front = reviewedFront([
      'reviewed_on: 2026-11-02',
      `reviewed_digest: ${digestOfFixture()}`,
    ]);
    expect(codesOf(page({ front }))).toEqual(['review_gate']);
  });

  it('refuses `reviewed` without reviewed_on, or with a date that is not one', () => {
    expect(
      codesOf(
        page({
          front: reviewedFront(['reviewed_by: Chris', `reviewed_digest: ${digestOfFixture()}`]),
        }),
      ),
    ).toEqual(['review_gate']);
    expect(
      codesOf(
        page({
          front: reviewedFront([
            'reviewed_by: Chris',
            'reviewed_on: 2026-02-30',
            `reviewed_digest: ${digestOfFixture()}`,
          ]),
        }),
      ),
    ).toEqual(['review_gate']);
  });

  it('refuses `reviewed` whose body has moved since the digest it was reviewed at', () => {
    expect(
      codesOf(page({ front: reviewedFront(['reviewed_by: Chris', 'reviewed_on: 2026-11-02']) })),
    ).toEqual(['review_gate']);
    const stale = reviewedFront([
      'reviewed_by: Chris',
      'reviewed_on: 2026-11-02',
      `reviewed_digest: sha256:${'0'.repeat(64)}`,
    ]);
    expect(codesOf(page({ front: stale }))).toEqual(['review_gate']);
  });

  it('accepts `reviewed` with all three, and carries the reviewer and date', () => {
    const front = reviewedFront([
      'reviewed_by: Chris',
      'reviewed_on: 2026-11-02',
      `reviewed_digest: ${digestOfFixture()}`,
    ]);
    expect(parsePlaybookPage(page({ front }), 'fixture-page.md', fakeResolver)).toMatchObject({
      status: 'reviewed',
      reviewedBy: 'Chris',
      reviewedOn: '2026-11-02',
    });
  });

  it('refuses a draft that carries review fields', () => {
    expect(codesOf(page({ front: `${DRAFT_FRONT}\nreviewed_by: Chris` }))).toEqual(['review_gate']);
  });
});

describe('WP 11.5a — every number is cited', () => {
  it('refuses a numeral with neither a placeholder nor a source marker', () => {
    expect(codesOf(page({ rule: `An IRA takes up to $7,500 a year. ${FILLER}` }))).toEqual([
      'unsourced_number',
    ]);
  });

  it('accepts the same numeral in a sentence with a marker', () => {
    expect(
      codesOf(page({ rule: `An IRA takes up to $7,500 a year[^irs-pub-590a]. ${FILLER}` })),
    ).toEqual([]);
  });

  it('refuses a figure spelled out with a currency word', () => {
    expect(
      codesOf(page({ rule: `An IRA takes up to seven thousand dollars a year. ${FILLER}` })),
    ).toEqual(['unsourced_number']);
  });

  it('refuses a marker naming no frontmatter source, and a Sources section out of step with the frontmatter', () => {
    expect(codesOf(page({ why: `The limit is set each year[^irs-pub-999]. ${FILLER}` }))).toContain(
      'marker',
    );
    expect(codesOf(page({ sources: '[^irs-pub-590a]: one.\n\n[^extra]: two.' }))).toEqual([
      'source',
    ]);
    expect(codesOf(page({ sources: 'Some prose instead of definitions.' }))).toContain('source');
  });

  it('refuses a placeholder the store does not hold, one with no inline form, and a malformed one', () => {
    expect(
      codesOf(page({ rule: `Up to {{param:tax.us.2026.retirement.nothing}}. ${FILLER}` })),
    ).toEqual(['placeholder']);
    expect(
      codesOf(
        page({ rule: `Rates are {{param:tax.us.2026.income_tax.brackets.single}}. ${FILLER}` }),
      ),
    ).toEqual(['placeholder']);
    expect(codesOf(page({ rule: `Up to {{param:Tax.US}}. ${FILLER}` }))).toEqual(['placeholder']);
    expect(codesOf(page({ rule: `Up to {{ira}}. ${FILLER}` }))).toEqual(['placeholder']);
  });

  it('refuses a 2027 placeholder against the real store', () => {
    const markdown = page({
      rule: `Up to {{param:tax.us.2027.retirement.ira_contribution}}. ${FILLER}`,
    });
    expect(codesOf(markdown, storeResolver)).toEqual(['placeholder']);
    expect(codesOf(page(), storeResolver)).toEqual([]);
  });
});

describe('WP 11.5a — structure, language and length', () => {
  it('refuses sections out of order, a missing section and an extra heading', () => {
    expect(
      codesOf(page({ headings: ['Why', 'The rule', 'When it does not apply', 'Sources'] })),
    ).toContain('structure');
    expect(codesOf(page({ headings: ['The rule', 'Why', 'Sources'] }))).toContain('structure');
    expect(
      codesOf(
        page({ why: `### A sub-heading\n\nThe limit is set each year[^irs-pub-590a]. ${FILLER}` }),
      ),
    ).toContain('structure');
  });

  it('refuses the language a page never uses', () => {
    expect(codesOf(page({ rule: `You should open an IRA first. ${FILLER}` }))).toContain('copy');
    expect(codesOf(page({ rule: `A household must fund the IRA first. ${FILLER}` }))).toContain(
      'copy',
    );
    expect(codesOf(page({ rule: `The match is a guaranteed gain. ${FILLER}` }))).toContain('copy');
    expect(codesOf(page({ whenNot: `- Pay the card off first. ${FILLER}` }))).toContain('copy');
  });

  it('refuses a page too short or too long', () => {
    expect(
      codesOf(page({ rule: 'Short.', why: 'Short[^irs-pub-590a].', whenNot: 'Short.' })),
    ).toEqual(['length']);
    expect(codesOf(page({ rule: FILLER.repeat(20) }))).toEqual(['length']);
  });

  it('refuses unknown fields, a bad version and a key that is not the file name', () => {
    expect(codesOf(page({ front: `${DRAFT_FRONT}\nauthor: someone` }))).toEqual(['field']);
    expect(codesOf(page({ front: DRAFT_FRONT.replace('version: 1', 'version: 0') }))).toEqual([
      'field',
    ]);
    expect(
      codesOf(page({ front: DRAFT_FRONT.replace('key: fixture-page', 'key: other-page') })),
    ).toEqual(['field']);
  });
});

describe('WP 11.5a — the real playbook', () => {
  it('the eight pages parse against the real store, all drafts, each within the length', () => {
    const pages = readPlaybook();
    expect(pages.map((parsed) => parsed.key)).toEqual([
      'claiming-age',
      'debt-order',
      'emergency-fund',
      'guardrail-withdrawal',
      'rebalancing-with-new-money',
      'subscription-audit',
      'tax-advantaged-order',
      'tax-location',
    ]);
    for (const parsed of pages) {
      expect(parsed.status, parsed.key).toBe('draft');
      const words = bodyWordCount(parsed.sections);
      expect(words, parsed.key).toBeGreaterThanOrEqual(MIN_WORDS);
      expect(words, parsed.key).toBeLessThanOrEqual(MAX_WORDS);
    }
  });

  it('the checked-in module is exactly what the markdown generates (the drift check)', async () => {
    expect(await emitPlaybookModule(readPlaybook())).toBe(readFileSync(PLAYBOOK_MODULE, 'utf8'));
    expect(await main(['--check'])).toBe(0);
  });
});
