// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { HOSTED_ENGINE, LOCAL_ENGINE, refused, session, tracked } from './advisor-fixtures.ts';
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
        'refused',
        'unanswerable',
        'failed',
        'cancelled',
      ] as const
    ).map((status) => words.outcomeWords(session('a', status))),
    ...(['down', 'up', 'same'] as const).map((direction) => words.directionWords(direction) ?? ''),
    words.statusWords(refused()),
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
