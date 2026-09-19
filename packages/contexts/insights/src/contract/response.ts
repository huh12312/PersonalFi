// SPDX-License-Identifier: MIT
/**
 * `AdvisorResponse` v1 — proposals, and nothing an advisor can act on.
 *
 * Five contract-level rules live in the *shape* here rather than in a check
 * somewhere downstream, because a rule that is a check is a rule somebody can
 * forget to call:
 *
 *   1. **`requires_review` is `true` and nothing else.** `z.literal(true)`, so
 *      `false` is a schema violation and the whole response is rejected. There
 *      is no `status` property at all, and the object is
 *      `additionalProperties: false`, so an advisor that sends one is rejected
 *      rather than ignored. 08 §4.3: "there is no value an advisor can return
 *      that causes an action." `test/pending-review.test.ts` sabotages both
 *      halves.
 *   2. **`proposed_actions[].kind` has four members and none of them acts.**
 *      `suggest_only | open_url | create_goal_draft | create_rule_draft`. There
 *      is no `execute`, no `transfer`, no `trade`: the enum has no such member,
 *      so it cannot be smuggled in.
 *   3. **`evidence` is non-empty at the type level** (`.min(1)`). An insight
 *      with nothing behind it is not an insight, and 04 §5.1's "every insight
 *      must be clickable through to the raw data" starts here.
 *   4. **`confidence` is required** and `confidence_basis` must be honest —
 *      `deterministic` is reserved for `builtin` and the pipeline asserts it.
 *   5. **`summary_md` is capped at 2,000 characters** and sanitised to a
 *      restricted Markdown subset downstream (`markdown.ts`).
 *
 * ## `derivations` — the price of "no invented numbers"
 *
 * The anti-fabrication rule is that **every numeral a human will read must be
 * traceable to a snapshot field or to a declared formula over snapshot fields**.
 * A rule that only allowed literal snapshot values would forbid "$18.99 × 12 =
 * $227.88 a year", which is most of what useful advice *is*. So an advisor may
 * declare a `derivation`: an arithmetic expression over `source_ref` inputs, the
 * value it claims the expression produces, and an id. The validator evaluates
 * the expression itself, against the snapshot we sent, and rejects the insight
 * if the claimed value is not what the arithmetic gives. The advisor therefore
 * cannot introduce a number; it can only introduce *arithmetic*, which we check.
 *
 * That is the whole mechanism, and it is pure validation — not a model, not a
 * heuristic. See `numerals.ts` and `derivations.ts`.
 */
import { z } from 'zod';
import { MoneyJsonSchema } from './snapshot.ts';
import { ADVISOR_CONTRACT_MAJOR } from './version.ts';

/** 08 §4.3, ascending. `severityRank` is the order; the ceiling clamps into it. */
export const SEVERITIES = ['info', 'notable', 'warning', 'urgent'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** 08 §4.3. `deterministic` is reserved for `builtin` and asserted, not trusted. */
export const CONFIDENCE_BASES = ['deterministic', 'heuristic', 'model'] as const;
export type ConfidenceBasis = (typeof CONFIDENCE_BASES)[number];

/**
 * The four non-acting action kinds.
 *
 * Exported as a frozen list so a test can assert the membership rather than
 * assert that somebody read the enum: `'execute'`, `'transfer'` and `'trade'`
 * are not absent by policy, they are absent from the type.
 */
export const PROPOSED_ACTION_KINDS = [
  'suggest_only',
  'open_url',
  'create_goal_draft',
  'create_rule_draft',
] as const;
export type ProposedActionKind = (typeof PROPOSED_ACTION_KINDS)[number];

export const HORIZONS = [
  'immediate',
  'this_period',
  'next_quarter',
  'this_year',
  'long_term',
] as const;

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, 'ISO-8601 UTC instant');

/**
 * A reference into the snapshot we sent, or to an allow-listed external URL.
 *
 * `snapshot:` paths are dotted with bracketed indices —
 * `snapshot:recurring_list.streams[3].typical_amount.minor`. Resolution is
 * `evidence.ts`'s job and is strict: a path that does not resolve to a defined
 * value rejects the insight. There is no partial credit and no "probably meant".
 */
export const SourceRefSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(snapshot:[A-Za-z0-9_]+(\.[A-Za-z0-9_]+|\[\d{1,4}\])*|external:https:\/\/\S+)$/);

export const EvidenceSchema = z.strictObject({
  kind: z.enum(['metric', 'transaction', 'series', 'budget_line', 'external']),
  label: z.string().min(1).max(160),
  /**
   * What the advisor says is at `source_ref`, rendered for display.
   *
   * Checked against the resolved value, not trusted: an evidence row whose
   * `value` disagrees with the snapshot is a fabrication wearing a citation,
   * which is the failure mode a citation-shaped field invites.
   */
  value: z.string().max(160).nullable(),
  source_ref: SourceRefSchema.nullable(),
  /** Only for `kind: 'external'`, and only inside the advisor's allow-list. */
  url: z.string().max(2048).nullable(),
});

/**
 * An arithmetic claim the validator re-computes.
 *
 * `expression` is a restricted grammar — `$ref0`-style input placeholders,
 * decimal literals, `+ - * /`, parentheses — with no identifiers, no calls and
 * no property access, so there is nothing to evaluate but arithmetic. See
 * `derivations.ts` for the parser, which is a parser and not an `eval`.
 */
export const DerivationSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  /** `$0 * $1` — `$n` is `inputs[n]`. */
  expression: z.string().min(1).max(512),
  inputs: z.array(SourceRefSchema).min(1).max(16),
  /**
   * The value the advisor claims. A decimal string, in the same units as the
   * expression's operands — minor units when the inputs are `*.minor`.
   */
  value: z.string().regex(/^-?\d+(\.\d+)?$/),
  /** Free-text for the UI's "how was this computed?" line. Never parsed. */
  note: z.string().max(240).nullable(),
});

export const ProposedActionSchema = z.strictObject({
  kind: z.enum(PROPOSED_ACTION_KINDS),
  label: z.string().min(1).max(160),
  rationale_md: z.string().max(1000),
  /** Only meaningful for `open_url`, and only inside the advisor's allow-list. */
  url: z.string().max(2048).nullable(),
});

export const ImpactSchema = z.strictObject({
  /** Recurring saving or cost, annualised. `null` when the insight has none. */
  annualized: MoneyJsonSchema.nullable(),
  /** A one-off. Ranked at half a recurring one of equal size (WP 2.7). */
  one_time: MoneyJsonSchema.nullable(),
  /** How the figure was reached, in one line, for the UI. */
  basis: z.string().max(240),
  /** The `derivations[].id` that produced it, when one did. */
  derivation_id: z.string().max(64).nullable(),
});

export const InsightSchema = z.strictObject({
  /**
   * Stable across runs ⇒ idempotent upsert, not duplicates. Combined with
   * `period` and `advisor_id` it is the natural key `insights` upserts on.
   */
  key: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  /**
   * The period this insight is *about* — `2026-09`, `2026-Q3`, or `all_time`.
   * Part of the upsert key, so last month's "dining is over budget" is a
   * different row from this month's rather than an overwrite of it.
   */
  period: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  type: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1).max(160),
  summary_md: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  confidence_basis: z.enum(CONFIDENCE_BASES),
  horizon: z.enum(HORIZONS),
  /**
   * `true`, always, and the advisor has no other option.
   *
   * Not "the advisor asks for review" — the advisor *acknowledges* that review
   * is what happens. The persisted `status` is `'pending_review'` regardless;
   * this field exists so that an advisor built against the schema cannot even
   * express the other case, and so the sabotage test has something to flip.
   */
  requires_review: z.literal(true),
  impact: ImpactSchema,
  evidence: z.array(EvidenceSchema).min(1).max(32),
  derivations: z.array(DerivationSchema).max(32),
  proposed_actions: z.array(ProposedActionSchema).max(8),
  caveats: z.array(z.string().max(240)).max(8),
  expires_at: instant.nullable(),
});

export const AdvisorResponseSchema = z
  .strictObject({
    contract_version: z.literal(ADVISOR_CONTRACT_MAJOR),
    /** MUST echo `AdvisorRequest.request_id`; a mismatch drops the response. */
    request_id: z.uuid(),
    advisor_id: z.string().min(1).max(64),
    advisor_version: z.string().min(1).max(32),
    produced_at: instant,
    diagnostics: z.strictObject({
      runtime_ms: z.number().int().min(0),
      model: z.string().max(96).nullable(),
      warnings: z.array(z.string().max(240)).max(16),
    }),
    insights: z.array(InsightSchema).max(100),
  })
  .describe('Proposals. Every one lands as pending_review; none of them can act.');

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Derivation = z.infer<typeof DerivationSchema>;
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type Impact = z.infer<typeof ImpactSchema>;
export type Insight = z.infer<typeof InsightSchema>;
export type AdvisorResponse = z.infer<typeof AdvisorResponseSchema>;
