// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  HOSTED_ENGINE,
  LOCAL_ENGINE,
  completed,
  fromFinding,
  refused,
  session,
  tracked,
} from './advisor-fixtures.ts';
import { advisorErrorWords } from './useAdvisor.ts';
import * as words from './advisor-words.ts';

/** 07 section 7.2: the words the advisor says never advise, promise or tell the holder to act. */
const BANNED = [
  /\byou should\b/iu,
  /\bwe recommend\b/iu,
  /\bbuy\b/iu,
  /\bsell\b/iu,
  /\bguaranteed?\b/iu,
  /\bwill (grow|earn|return)\b/iu,
  /\brisk-free\b/iu,
];
const IMPERATIVE_OPENERS = /^(Buy|Cancel|Close|Invest|Move|Open|Pay|Sell|Stop|Switch|Transfer)\b/u;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence !== '');
}

const ERROR_CODES = [
  'insights.advisor_finding_not_found',
  'insights.advisor_finding_not_supported',
  'insights.advisor_finding_not_granted',
  'insights.advisor_brief_unknown',
  'insights.advisor_question_or_origin',
] as const;

describe('WP 11.5d advisor copy (07 section 7.2)', () => {
  const strings: string[] = [
    ...Object.values(words).filter((value): value is string => typeof value === 'string'),
    words.egressWords(LOCAL_ENGINE),
    words.egressWords(HOSTED_ENGINE),
    words.runsOnLabel(HOSTED_ENGINE),
    words.withheldWords(2),
    words.optionsDroppedWords(1),
    words.optionsDroppedWords(3),
    words.latestWords(tracked().tracked!),
    ...(['gathering', 'options', 'tradeoffs', 'planning', 'clarifying'] as const).map((status) =>
      words.stepWords(session('a', status)),
    ),
    ...(
      [
        'clarifying',
        'awaiting_pick',
        'tracked',
        'completed',
        'refused',
        'unanswerable',
        'failed',
        'cancelled',
      ] as const
    ).map((status) => words.outcomeWords(session('a', status))),
    ...(['down', 'up', 'same'] as const).map((direction) => words.directionWords(direction) ?? ''),
    words.statusWords(refused()),
    words.statusWords(completed()),
    words.originWords(fromFinding().origin!),
    words.originWords({ ...fromFinding().origin!, briefWeek: null }),
    words.pregatheredWords(fromFinding()) ?? '',
    ...ERROR_CODES.map((code) => advisorErrorWords({ code })),
  ];

  it('never says what the holder should do, promises a result or calls anything risk-free', () => {
    expect(strings.length).toBeGreaterThan(20);
    for (const text of strings) {
      for (const banned of BANNED) expect(text, text).not.toMatch(banned);
    }
  });

  it('opens no sentence with an imperative aimed at the reader', () => {
    for (const text of strings) {
      for (const sentence of sentencesOf(text)) {
        expect(sentence, sentence).not.toMatch(IMPERATIVE_OPENERS);
      }
    }
  });
});

describe('WP 11.5e advisor words', () => {
  it('names an ISO week as "week 43 of 2026" and leaves anything else as it came', () => {
    expect(words.weekLabel('2026-W43')).toBe('week 43 of 2026');
    expect(words.weekLabel('2026-W05')).toBe('week 5 of 2026');
    expect(words.weekLabel('last week')).toBe('last week');
    expect(words.isIsoWeek('2026-W43')).toBe(true);
    expect(words.isIsoWeek('2026-43')).toBe(false);
  });

  it('the origin header names the finding, and the Brief it came from when there is one', () => {
    const origin = fromFinding().origin!;
    expect(words.originWords(origin)).toBe(
      'About: Your cash covers 2.4 months of spending, from the Brief of week 43 of 2026',
    );
    expect(words.originWords({ ...origin, briefWeek: null })).toBe(
      'About: Your cash covers 2.4 months of spending',
    );
  });

  it('says what was gathered first: the labels the "I looked at" line uses where it has them, else the names humanised', () => {
    expect(words.pregatheredWords(fromFinding())).toBe(
      "Gathered first: Cash emergency fund and the finding's own figures.",
    );
    expect(
      words.pregatheredWords(
        fromFinding('s', {
          lookedAt: {
            line: 'I looked at: emergency fund runway.',
            items: [
              {
                function: 'cash.emergency_fund',
                label: 'Emergency-fund cover (target 3 months)',
                status: 'ok',
                asOf: null,
                figures: [],
                screen: { path: '/health', label: 'Financial health' },
              },
            ],
          },
        }),
      ),
    ).toBe("Gathered first: Emergency-fund cover (target 3 months) and the finding's own figures.");
    expect(
      words.pregatheredWords(
        fromFinding('s', { pregathered: { seeded: ['cash.emergency_fund'], finding: null } }),
      ),
    ).toBe('Gathered first: Cash emergency fund.');
    expect(
      words.pregatheredWords(fromFinding('s', { pregathered: { seeded: [], finding: null } })),
    ).toBeNull();
    expect(words.pregatheredWords(session('s', 'clarifying'))).toBeNull();
  });

  it('a completed session is finished, in every table of words', () => {
    const done = completed();
    expect(words.isWorking(done)).toBe(false);
    expect(words.isWaiting(done)).toBe(false);
    expect(words.isEnded('completed')).toBe(true);
    expect(words.statusWords(done)).toBe('Target reached');
    expect(words.stepWords(done)).toBe('');
    expect(words.outcomeWords(done)).toBe(
      "The plan's target is reached and the plan is no longer followed.",
    );
    expect(words.REACHED_WORDS).toBe(
      "Reached: the plan's target is met; this plan is no longer followed.",
    );
    expect(words.pickedOnWords('2026-10-28')).toBe('Picked on 2026-10-28');
    expect(words.pickedOnWords(null)).toBeNull();
  });

  it('each new problem code has its own sentence, and an unknown one falls back to the generic', () => {
    const sentences = ERROR_CODES.map((code) => advisorErrorWords({ code }));
    expect(new Set(sentences.slice(0, 4)).size).toBe(4);
    expect(advisorErrorWords({ code: 'insights.advisor_finding_not_found' })).toBe(
      words.FINDING_NOT_FOUND_WORDS,
    );
    expect(advisorErrorWords({ code: 'insights.advisor_question_or_origin' })).toBe(
      words.REQUEST_FAILED_WORDS,
    );
    expect(advisorErrorWords(new Error('x'))).toBe(words.REQUEST_FAILED_WORDS);
  });
});
