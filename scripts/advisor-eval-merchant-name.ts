// SPDX-License-Identifier: MIT
/**
 * `--merchant-name` (WP 11.6; 11 §4's evaluation row for `merchant.name`): does a
 * suggestion stay a substring-preserving cleanup, and is it a good name when it
 * does? The golden set (`advisor-eval-merchant-name.golden.json`) holds bank
 * descriptors — noise and not — with the outcome the production pieces must
 * reach: `not_noise` (the model is never asked), a suggestion (with a holder's
 * judgement whether it is a *good* name), an abstention, or a refusal class; and
 * for every noise descriptor a recorded reply.
 *
 * Each entry goes through the production pieces in production order:
 * `detectMerchantNoise` (the ledger's detector over the raw descriptor) → for
 * noise only, `buildMerchantNameRequest` (the residue and the prefix hint) → the
 * reply → `validateMerchantNameReply`. The validator is a pure function of the
 * reply, so replaying recorded replies measures exactly what a run would have done
 * with them (CI's run, over the Ollama fake, in `advisor-eval-merchant-name.test.ts`).
 *
 * Reported: the outcome agreement, how many descriptors reached the model,
 * **precision of accepted suggestions** (the share of names the validator let
 * through that a holder would call right), the **refusal rate** (refused over
 * asked), the abstention rate, and the refusal classes. Never a descriptor or a
 * reply on stdout; a live run's replies go to `--out` (the golden descriptors are
 * synthetic).
 *
 *     node scripts/advisor-eval.ts --merchant-name                 # replay the recorded replies
 *     node scripts/advisor-eval.ts --merchant-name --live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/merchant-name.jsonl
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLocalMerchantNameAdapter,
  type LocalModelTransport,
} from '../packages/advisors/local-model/src/index.ts';
import { detectMerchantNoise } from '../packages/contexts/ledger/src/merchant-noise.ts';
import { MERCHANT_NAME_MANIFEST } from '../packages/contexts/insights/src/advisors/merchant-name/manifest.ts';
import { buildMerchantNameRequest } from '../packages/contexts/insights/src/advisors/merchant-name/request.ts';
import {
  validateMerchantNameReply,
  type MerchantNameVerdict,
} from '../packages/contexts/insights/src/advisors/merchant-name/reply.ts';

export const MERCHANT_NAME_GOLDEN_PATH = join(
  import.meta.dirname,
  'advisor-eval-merchant-name.golden.json',
);

export type MerchantNameGoldenExpected =
  | { readonly not_noise: 'clean' | 'no_merchant' | 'provider_named' }
  | { readonly suggestion: string; readonly good: boolean }
  | { readonly abstain: true }
  | { readonly refused: string };

export interface MerchantNameGoldenEntry {
  readonly id: string;
  /** The raw bank descriptor, as a sync would bring it. */
  readonly descriptor: string;
  readonly expected: MerchantNameGoldenExpected;
  /** The recorded reply; absent exactly when the descriptor is not noise (no model is asked). */
  readonly reply?: unknown;
  readonly note?: string;
}

export interface MerchantNameGolden {
  readonly format: 'personalfi.merchant-name-golden/1';
  readonly replies_source: string;
  readonly entries: readonly MerchantNameGoldenEntry[];
}

export function loadMerchantNameGolden(path = MERCHANT_NAME_GOLDEN_PATH): MerchantNameGolden {
  return JSON.parse(readFileSync(path, 'utf8')) as MerchantNameGolden;
}

const FIXED_NOW = new Date('2026-10-29T12:00:00.000Z');

/** The request a noise descriptor is sent, or `null` when it is not noise. */
export function merchantNameGoldenRequest(descriptor: string) {
  const verdict = detectMerchantNoise({ name: descriptor });
  if (!verdict.noise) return { verdict, built: null };
  return {
    verdict,
    built: buildMerchantNameRequest({
      descriptor: verdict.descriptor,
      strippedPrefix: verdict.strippedPrefix,
      now: FIXED_NOW,
      timeoutMs: MERCHANT_NAME_MANIFEST.limits.timeout_ms,
      maxResponseBytes: MERCHANT_NAME_MANIFEST.limits.max_response_bytes,
    }),
  };
}

export type MerchantNameOutcome =
  { readonly kind: 'not_noise'; readonly reason: string } | MerchantNameVerdict;

export interface MerchantNameJudged {
  readonly id: string;
  readonly asked: boolean;
  readonly outcome: MerchantNameOutcome;
  /** The whole outcome was the expected one. */
  readonly correct: boolean;
  /** For an accepted suggestion: the golden set's judgement that it is a good name. */
  readonly good: boolean | null;
}

/** Judge one entry against a reply (the recorded one, or a live model's). Pure. */
export function judgeMerchantNameEntry(
  entry: MerchantNameGoldenEntry,
  reply: unknown,
): MerchantNameJudged {
  const { verdict, built } = merchantNameGoldenRequest(entry.descriptor);
  const expected = entry.expected;
  if (built === null) {
    const reason = verdict.noise ? 'noise' : verdict.reason;
    return {
      id: entry.id,
      asked: false,
      outcome: { kind: 'not_noise', reason },
      correct: 'not_noise' in expected && expected.not_noise === reason,
      good: null,
    };
  }
  const outcome = validateMerchantNameReply(reply, { descriptor: built.request.descriptor });
  let correct: boolean;
  let good: boolean | null = null;
  if (outcome.verdict === 'suggested') {
    correct = 'suggestion' in expected && expected.suggestion === outcome.displayName;
    // A name the golden set did not expect is not one a holder has judged good.
    good = 'suggestion' in expected && correct ? expected.good : false;
  } else if (outcome.verdict === 'abstained') {
    correct = 'abstain' in expected;
  } else {
    correct = 'refused' in expected && expected.refused === outcome.refusal;
  }
  return { id: entry.id, asked: true, outcome, correct, good };
}

export interface MerchantNameEvalReport {
  readonly entries: number;
  readonly correct: number;
  /** Descriptors the detector left alone: the model was never asked. */
  readonly notNoise: number;
  /** Noise descriptors: one call each. */
  readonly asked: number;
  readonly suggested: number;
  readonly good: number;
  /** good / suggested: the share of names the validator let through that are right. */
  readonly precision: number | null;
  readonly abstained: number;
  readonly refused: number;
  /** refused / asked. */
  readonly refusalRate: number | null;
  readonly abstentionRate: number | null;
  readonly refusals: Readonly<Record<string, number>>;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function summariseMerchantName(
  judged: readonly MerchantNameJudged[],
): MerchantNameEvalReport {
  const refusals: Record<string, number> = {};
  let suggested = 0;
  let good = 0;
  let abstained = 0;
  let refused = 0;
  for (const entry of judged) {
    if (!entry.asked) continue;
    const outcome = entry.outcome;
    if ('kind' in outcome) continue;
    if (outcome.verdict === 'suggested') {
      suggested += 1;
      if (entry.good === true) good += 1;
    } else if (outcome.verdict === 'abstained') {
      abstained += 1;
    } else {
      refused += 1;
      refusals[outcome.refusal] = (refusals[outcome.refusal] ?? 0) + 1;
    }
  }
  const asked = judged.filter((entry) => entry.asked).length;
  return {
    entries: judged.length,
    correct: judged.filter((entry) => entry.correct).length,
    notNoise: judged.length - asked,
    asked,
    suggested,
    good,
    precision: ratio(good, suggested),
    abstained,
    refused,
    refusalRate: ratio(refused, asked),
    abstentionRate: ratio(abstained, asked),
    refusals: Object.fromEntries(Object.entries(refusals).sort()),
  };
}

/** Replay: every entry against its recorded reply. Pure; what CI and the default CLI run. */
export function replayMerchantNameGolden(golden: MerchantNameGolden = loadMerchantNameGolden()): {
  readonly judged: readonly MerchantNameJudged[];
  readonly report: MerchantNameEvalReport;
} {
  const judged = golden.entries.map((entry) => judgeMerchantNameEntry(entry, entry.reply ?? null));
  return { judged, report: summariseMerchantName(judged) };
}

export interface MerchantNameEvalModelOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly digest: string;
  readonly timeoutMs: number;
  /** Tests only: the fake Ollama's transport. */
  readonly transport?: LocalModelTransport;
  /** Each reply is appended here, one JSON line per entry (`{ id, reply }`), when set. */
  readonly out?: string;
}

/**
 * Through the shipped merchant-name adapter: one call per noise descriptor, none
 * for the rest, first attempt only. CI points it at the Ollama fake answering
 * the recorded replies, which proves the adapter and the replay agree; the live
 * run points it at the pinned model.
 */
export async function merchantNameGoldenOverModel(
  options: MerchantNameEvalModelOptions,
  golden: MerchantNameGolden = loadMerchantNameGolden(),
): Promise<{
  readonly judged: readonly MerchantNameJudged[];
  readonly report: MerchantNameEvalReport;
  readonly calls: number;
}> {
  const adapter = createLocalMerchantNameAdapter(
    {
      endpoint: options.endpoint,
      name: options.model,
      digest: options.digest,
      timeoutMs: options.timeoutMs,
      allowRemote: true,
    },
    options.transport === undefined ? {} : { transport: options.transport },
  );
  const judged: MerchantNameJudged[] = [];
  let calls = 0;
  for (const entry of golden.entries) {
    const { built } = merchantNameGoldenRequest(entry.descriptor);
    if (built === null) {
      judged.push(judgeMerchantNameEntry(entry, null));
      continue;
    }
    const request = {
      ...built.request,
      deadline: new Date(Date.now() + options.timeoutMs + 60_000).toISOString(),
    };
    let reply: unknown;
    try {
      calls += 1;
      reply = (await adapter.run(request, new AbortController().signal)).reply;
    } catch {
      reply = null;
    }
    if (options.out !== undefined)
      appendFileSync(options.out, `${JSON.stringify({ id: entry.id, reply })}\n`);
    judged.push(judgeMerchantNameEntry(entry, reply));
  }
  return { judged, report: summariseMerchantName(judged), calls };
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** The report as lines: counts and rates only, never a descriptor or a reply. */
export function formatMerchantNameReport(report: MerchantNameEvalReport): readonly string[] {
  return [
    `entries ${String(report.entries)} · outcome right ${String(report.correct)}/${String(report.entries)} · not noise (never asked) ${String(report.notNoise)} · asked ${String(report.asked)}`,
    `accepted suggestions ${String(report.suggested)} · good ${String(report.good)} · precision ${pct(report.precision)}`,
    `refused ${String(report.refused)}/${String(report.asked)} (refusal rate ${pct(report.refusalRate)}) · abstained ${String(report.abstained)} (${pct(report.abstentionRate)})`,
    `validator refusals: ${
      Object.entries(report.refusals)
        .map(([refusal, count]) => `${refusal} × ${String(count)}`)
        .join(', ') || 'none'
    }`,
  ];
}
