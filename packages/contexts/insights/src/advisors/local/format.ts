// SPDX-License-Identifier: MIT
/**
 * `NARRATOR_REPLY_FORMAT` — the JSON Schema `local.narrator` asks Ollama to
 * sample under (`POST /api/chat`'s `format`), passed to WP 5.2's adapter as its
 * `format` option by the composition root.
 *
 * **A convenience, never a control** (wp5.2 §2, `format.ts`'s header). The
 * validator runs on every reply exactly as if no format had been sent; this
 * only makes a well-formed first attempt likelier, and it is measured, not
 * assumed (`scripts/advisor-eval.ts`).
 *
 * Why the narrator narrows WP 5.2's generic `NARRATION_FORMAT`, each from the
 * live calibration request on this host (the evidence file's §8):
 *
 *   * **`confidence` is an enum**, not `minimum 0 / maximum 1`. Ollama's
 *     grammar does not enforce numeric bounds, and the pinned model wrote
 *     `100` — a step-2 refusal the bounds were supposed to prevent. An enum is
 *     a grammar the sampler does enforce.
 *   * **At most two evidence rows, never `external`, no `url`.** The model
 *     restated every row of its finding, at ≈2.5 tokens a second; a narration
 *     cites a subset of its finding's refs (step 5), and two is plenty.
 *   * **No caveats, no actions, no derivations, an all-null impact.** Every one
 *     is refused for a narrator at step 4 (or would add figures step 7 must
 *     trace); a grammar that cannot express them costs no tokens on them.
 *
 *   * **No `key`, `type` or `period` (WP 9.5 option A(a)).** The narration's
 *     identity is written by the narrator from the request (`narrator.ts`),
 *     so the model is never asked to copy an opaque key — 26 of the Phase 5
 *     gate's 38 refusals were exactly that copy failing.
 *
 * **One schema, two homes, pinned equal.** `@advisor/local-model`'s
 * `NARRATION_FORMAT` — the adapter's *default* `format` — is this same
 * schema, so every construction of the adapter (the worker's, the api's
 * preview renderer, the eval's, the red team's) samples under it and hashes
 * it into the same template hash, whether or not a caller passes it
 * (the Phase 5 gate's G5-6: the worker passed nothing, and sampled under a
 * generic schema the measurement never used). This package may not import
 * that one and it may not import this; `apps/api/test/db/narrator-composition.test.ts`
 * asserts the two are deep-equal and that the worker's own construction sends it.
 *
 * Nothing here is per-request: the schema is fixed per deployment, so it is
 * part of the adapter's `templateHash` and therefore of WP 5.1's query shape —
 * changing it is a new shape that needs a new approval.
 */
const SEVERITIES = ['info', 'notable', 'warning', 'urgent'];
const HORIZONS = ['immediate', 'this_period', 'next_quarter', 'this_year', 'long_term'];

const text = (maxLength: number): Record<string, unknown> => ({ type: 'string', maxLength });

export const NARRATOR_REPLY_FORMAT: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'title',
          'summary_md',
          'confidence',
          'confidence_basis',
          'horizon',
          'requires_review',
          'impact',
          'evidence',
          'derivations',
          'proposed_actions',
          'caveats',
          'expires_at',
        ],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          title: text(120),
          summary_md: text(600),
          confidence: { type: 'number', enum: [0.5, 0.6, 0.7, 0.8, 0.9] },
          confidence_basis: { type: 'string', enum: ['model'] },
          horizon: { type: 'string', enum: HORIZONS },
          requires_review: { type: 'boolean', enum: [true] },
          impact: {
            type: 'object',
            additionalProperties: false,
            required: ['annualized', 'one_time', 'basis', 'derivation_id'],
            properties: {
              annualized: { type: 'null' },
              one_time: { type: 'null' },
              basis: text(160),
              derivation_id: { type: 'null' },
            },
          },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'label', 'value', 'source_ref', 'url'],
              properties: {
                kind: { type: 'string', enum: ['metric', 'transaction', 'series', 'budget_line'] },
                label: text(160),
                value: { anyOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }] },
                source_ref: text(512),
                url: { type: 'null' },
              },
            },
          },
          derivations: { type: 'array', maxItems: 0 },
          proposed_actions: { type: 'array', maxItems: 0 },
          caveats: { type: 'array', maxItems: 0 },
          expires_at: { type: 'null' },
        },
      },
    },
  },
});
