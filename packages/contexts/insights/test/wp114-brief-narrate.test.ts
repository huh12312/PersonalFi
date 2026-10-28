// SPDX-License-Identifier: MIT
/**
 * WP 11.4 — `brief.narrate`, pure: the request carries exactly the Brief's
 * overview figures, its ranked items (title, wording, headline figure,
 * carried) and last week's outcomes as counts, with the union of the items'
 * own scopes inside the ceiling; a reply is accepted only when every figure is
 * one of the Brief's or the items' figures, it names only the items the Brief
 * chose (G5-15), in the Brief's order, carries no advice, link or markup, and
 * is the reply format; the approval shape is this advisor's own.
 */
import { describe, expect, it } from 'vitest';
import { checkManifest } from '../src/registry.ts';
import {
  BRIEF_NARRATE_MANIFEST,
  BRIEF_NARRATE_REFUSAL_CLASSES,
  NARRATOR_SCOPES,
  briefNarrateShape,
  briefNarrateTargetOf,
  briefOpeningOf,
  buildBriefNarrateRequest,
  insightExplainShape,
  normaliseTitle,
  validateBriefNarrateReply,
  type BriefNarrateItemSource,
  type BriefNarrateTarget,
} from '../src/index.ts';
import { queryShape } from '../src/preview.ts';

const NOW = new Date('2026-10-27T12:00:00.000Z');

const RAISE = 'Your streaming plan price went up';
const CASH = 'Cash beyond three months of spending is earning little';
const GOAL = 'Your goal Pay off Visa 4532 is behind schedule';
const RAW = 'A charge looks duplicated';
const FOREIGN = 'Dining spending is above your usual month';

function item(over: Partial<BriefNarrateItemSource> & { title: string }): BriefNarrateItemSource {
  return {
    summaryMd: `${over.title}: a built-in summary with $7,200.00 and 2.4 months.`,
    narrationText: null,
    annualizedImpact: null,
    oneTimeImpact: null,
    carried: false,
    evidence: [],
    scopes: ['cash.summary'],
    ...over,
  };
}

function target(overrides: Partial<Parameters<typeof briefNarrateTargetOf>[0]> = {}) {
  return briefNarrateTargetOf({
    briefId: '01934d6e-0000-7000-8000-000000000001',
    isoWeek: '2026-W43',
    week: {
      week: '2026-W43',
      rankedCount: '3',
      attentionCount: '1',
      healthScore: '72.5 / 100',
      milestones: [{ label: 'Net worth reached', value: '$100,000.00', on: '2026-10-20' }],
    },
    ranked: [
      item({
        title: RAISE,
        annualizedImpact: { minor: '84000', currency: 'USD' },
        scopes: ['recurring.list'],
        narrationText: 'The plan rose from $15.99 (Previous price) to $22.99 (New price).',
      }),
      item({
        title: CASH,
        annualizedImpact: { minor: '42000', currency: 'USD' },
        carried: true,
        scopes: ['cash.summary', 'cashflow.monthly'],
      }),
      item({
        title: GOAL,
        oneTimeImpact: { minor: '-120000', currency: 'USD' },
        scopes: ['goals.list'],
        evidence: [
          {
            label: 'Goal',
            value: 'Pay off Visa 4532',
            sourceRef: 'snapshot:goals_list.goals[0].name',
            resolvedDisplay: null,
          },
        ],
      }),
      item({
        title: RAW,
        oneTimeImpact: { minor: '5000', currency: 'USD' },
        scopes: ['transactions.raw'],
      }),
    ],
    lastWeek: { accepted: 2, dismissed: 1, carried: 1 },
    allowedScopes: [...NARRATOR_SCOPES],
    foreignTitles: [FOREIGN, RAISE],
    ...overrides,
  });
}

function built(t: BriefNarrateTarget = target()) {
  return buildBriefNarrateRequest({
    target: t,
    now: NOW,
    timeoutMs: 300_000,
    maxResponseBytes: 16_384,
  });
}

const GOAL_REDACTED = 'Your goal Pay off Visa is behind schedule';

const GOOD = {
  narration:
    `${RAISE} leads the week at $840.00 a year, then ${CASH} at $420.00 a year, carried from last week, ` +
    `and ${GOAL_REDACTED} at $1,200.00 one-time. Last week 2 actions were accepted and 1 dismissed.`,
  recap:
    'Week 2026-W43 has 3 ranked actions and 1 item needing attention, a health score of 72.5 / 100, ' +
    'and net worth reached $100,000.00 on 2026-10-20.',
};

describe('the manifest and the shape', () => {
  it('is a narrates-only local_model query type bounded by the narrator’s scopes, never transactions.raw', () => {
    expect(checkManifest(BRIEF_NARRATE_MANIFEST).ok).toBe(true);
    expect(BRIEF_NARRATE_MANIFEST.advisor_id).toBe('brief.narrate');
    expect(BRIEF_NARRATE_MANIFEST.kind).toBe('local_model');
    expect(BRIEF_NARRATE_MANIFEST.requires_scopes).toEqual([...NARRATOR_SCOPES]);
    expect(BRIEF_NARRATE_MANIFEST.requires_scopes).not.toContain('transactions.raw');
    expect(BRIEF_NARRATE_MANIFEST.capabilities.narrates_only).toBe(true);
    expect(BRIEF_NARRATE_MANIFEST.capabilities.produces_impact).toBe(false);
  });

  it('has its own approval shape: never the narrator’s, never explain’s', () => {
    const hash = 'sha256:template';
    expect(briefNarrateShape(hash)).toBe(
      queryShape({
        advisorId: 'brief.narrate',
        advisorVersion: '1.0.0',
        kind: 'local_model',
        scopes: NARRATOR_SCOPES,
        promptTemplateHash: hash,
      }),
    );
    expect(briefNarrateShape(hash)).not.toBe(insightExplainShape(hash));
    expect(briefNarrateShape(hash)).not.toBe(briefNarrateShape('sha256:other'));
  });

  it('names its refusal classes', () => {
    expect([...BRIEF_NARRATE_REFUSAL_CLASSES]).toEqual([
      'schema',
      'empty',
      'too_long',
      'sentences',
      'markup',
      'link',
      'numeral',
      'word_figure',
      'item_reference',
      'order',
      'copy',
    ]);
  });
});

describe('the payload (scope minimisation)', () => {
  it('carries exactly the overview figures, the ranked items and last week as counts — pinned', () => {
    const request = built();
    expect(request.payload).toEqual({
      granted_scopes: ['cash.summary', 'cashflow.monthly', 'recurring.list', 'goals.list'],
      snapshot: {
        brief: {
          attention_count: '1',
          health_score: '72.5 / 100',
          items: [
            {
              carried: false,
              figure: '$840.00 a year',
              title: RAISE,
              wording: 'The plan rose from $15.99 (Previous price) to $22.99 (New price).',
            },
            {
              carried: true,
              figure: '$420.00 a year',
              title: CASH,
              wording: `${CASH}: a built-in summary with $7,200.00 and 2.4 months.`,
            },
            {
              carried: false,
              figure: '$1,200.00 one-time',
              title: GOAL_REDACTED,
              wording: `${GOAL_REDACTED}: a built-in summary with $7,200.00 and 2.4 months.`,
            },
          ],
          last_week: { accepted: '2', carried: '1', dismissed: '1' },
          milestones: [{ label: 'Net worth reached', on: '2026-10-20', value: '$100,000.00' }],
          ranked_count: '3',
          week: '2026-W43',
        },
      },
    });
    const text = JSON.stringify(request.payload);
    // No id, no goal-name digits, no evidence row, no foreign title, no raw-derived item.
    expect(text).not.toContain('01934d6e');
    expect(text).not.toContain('4532');
    expect(text).not.toContain('sourceRef');
    expect(text).not.toContain(FOREIGN);
    expect(text).not.toContain(RAW);
    expect(request.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('the scope ceiling: an item outside it (raw rows, an ungranted scope, an unknown run) is left out and counted', () => {
    expect(target().omitted).toBe(1);
    const narrower = target({ allowedScopes: ['cash.summary', 'cashflow.monthly'] });
    expect(narrower.subject.items.map((row) => row.title)).toEqual([CASH]);
    expect(narrower.scopes).toEqual(['cash.summary', 'cashflow.monthly']);
    expect(narrower.omitted).toBe(3);
    const unknown = target({
      ranked: [item({ title: CASH, scopes: null })],
    });
    expect(unknown.subject.items).toEqual([]);
    expect(unknown.omitted).toBe(1);
    for (const t of [target(), narrower]) {
      expect(t.scopes).not.toContain('transactions.raw');
      for (const scope of t.scopes) expect(NARRATOR_SCOPES).toContain(scope);
    }
  });

  it('a title the Brief chose is never a foreign title, and a property a caller adds does not ride along', () => {
    const t = target();
    expect(t.foreignTitles).toEqual([FOREIGN]);
    const smuggled = {
      ...t,
      subject: { ...t.subject, account: 'Checking 4532', items: t.subject.items },
    } as unknown as BriefNarrateTarget;
    expect(JSON.stringify(built(smuggled).payload)).not.toContain('Checking');
  });
});

describe('the opening (deterministic)', () => {
  it('names the count, the largest by its title and figure, and the attention count', () => {
    expect(
      briefOpeningOf({
        nothingMaterial: false,
        ranked: [
          {
            title: RAISE,
            annualizedImpact: { minor: '84000', currency: 'USD' },
            oneTimeImpact: null,
          },
          {
            title: CASH,
            annualizedImpact: { minor: '42000', currency: 'USD' },
            oneTimeImpact: null,
          },
        ],
        attentionCount: 1,
      }),
    ).toBe(
      `2 ranked actions this week, in order of dollar impact. The largest is “${RAISE}”, $840.00 a year. 1 item needs attention.`,
    );
    expect(briefOpeningOf({ nothingMaterial: true, ranked: [], attentionCount: 0 })).toBe(
      'No ranked actions this week.',
    );
  });
});

describe('the validator', () => {
  const check = built().check;
  const verdict = (reply: unknown) => validateBriefNarrateReply(reply, check);

  it('accepts a reply that names the chosen items in the Brief’s order with the Brief’s own figures', () => {
    expect(verdict(GOOD)).toEqual({ ok: true, narration: GOOD.narration, recap: GOOD.recap });
  });

  it('G5-15: every item title an accepted reply mentions maps to a ranked item the Brief chose', () => {
    const accepted = verdict(GOOD);
    expect(accepted.ok).toBe(true);
    const chosen = check.chosenTitles.map(normaliseTitle);
    const everyTitle = [...check.chosenTitles, ...check.foreignTitles, RAW];
    const mentioned = everyTitle.filter((title) =>
      normaliseTitle(`${GOOD.narration} ${GOOD.recap}`).includes(normaliseTitle(title)),
    );
    expect(mentioned.length).toBeGreaterThan(0);
    for (const title of mentioned) expect(chosen).toContain(normaliseTitle(title));
  });

  it('G5-15: a reply naming a finding the Brief did not choose is refused (item_reference)', () => {
    expect(
      verdict({ ...GOOD, recap: `${GOOD.recap.slice(0, -1)}, and ${FOREIGN.toLowerCase()}.` }),
    ).toMatchObject({ ok: false, refusal: 'item_reference', field: 'recap' });
    expect(
      verdict({
        ...GOOD,
        narration: `“${RAISE}” leads the week, ahead of “A duplicated insurance charge”.`,
      }),
    ).toMatchObject({ ok: false, refusal: 'item_reference', field: 'narration' });
  });

  it('refuses a figure outside the Brief and the items (numeral), and a figure in words (word_figure)', () => {
    expect(
      verdict({ ...GOOD, narration: `${RAISE} leads at $840.00 a year, worth $9,999.00 in all.` }),
    ).toMatchObject({ ok: false, refusal: 'numeral', field: 'narration' });
    // A total the model computed is a figure no block shows.
    expect(
      verdict({ ...GOOD, narration: `${RAISE} and ${CASH} together come to $1,260.00 a year.` }),
    ).toMatchObject({ ok: false, refusal: 'numeral' });
    // A figure that appears only inside a summary is not one this composition may state.
    expect(
      verdict({ ...GOOD, recap: 'Cash covers 2.4 months of spending this week.' }),
    ).toMatchObject({ ok: false, refusal: 'numeral', field: 'recap' });
    expect(
      verdict({ ...GOOD, recap: 'The actions are worth about five thousand dollars.' }),
    ).toMatchObject({ ok: false, refusal: 'word_figure' });
  });

  it('refuses a reply that reorders the week (by an invented figure or none), or does not name the first action first', () => {
    expect(
      verdict({
        ...GOOD,
        narration: `${CASH} is the largest at $4,200.00 a year, ahead of ${RAISE}.`,
      }),
    ).toMatchObject({ ok: false, refusal: 'numeral' });
    expect(
      verdict({ ...GOOD, narration: `${CASH} comes first this week, then ${RAISE}.` }),
    ).toMatchObject({ ok: false, refusal: 'order' });
    expect(
      verdict({ ...GOOD, narration: 'Three actions this week, the largest first.' }),
    ).toMatchObject({ ok: false, refusal: 'order' });
  });

  it('refuses advice (copy), markup, links, length, sentences, emptiness and anything outside the format', () => {
    expect(
      verdict({ ...GOOD, recap: 'Cancel the streaming plan before the next bill.' }),
    ).toMatchObject({ ok: false, refusal: 'copy' });
    expect(verdict({ ...GOOD, recap: 'A **bold** week.' })).toMatchObject({ refusal: 'markup' });
    expect(verdict({ ...GOOD, recap: 'See {{e1}} for more.' })).toMatchObject({
      refusal: 'markup',
    });
    expect(verdict({ ...GOOD, recap: 'Read more at example.com today.' })).toMatchObject({
      refusal: 'link',
    });
    expect(verdict({ ...GOOD, recap: 'x'.repeat(601) })).toMatchObject({ refusal: 'too_long' });
    expect(verdict({ ...GOOD, narration: `${RAISE} leads.${' It is.'.repeat(3)}` })).toMatchObject({
      refusal: 'sentences',
    });
    expect(verdict({ ...GOOD, narration: '   ' })).toMatchObject({ refusal: 'empty' });
    expect(verdict({ narration: GOOD.narration })).toMatchObject({ refusal: 'schema' });
    expect(verdict({ ...GOOD, extra: 'x' })).toMatchObject({ refusal: 'schema' });
    expect(verdict('not json')).toMatchObject({ refusal: 'schema' });
  });
});
