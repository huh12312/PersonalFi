// SPDX-License-Identifier: MIT
/**
 * The `format` JSON Schema sent with `POST /api/chat` — Ollama's structured
 * output, constraining the model's sampler to the narration shape.
 *
 * **A convenience, never a control** (05-phase-5-dispatch.md §3 WP 5.2). The
 * grammar makes a well-formed reply likely; it proves nothing, and the reply is
 * validated by WP 2.6's `validateResponse` exactly as if no format had been
 * sent. Two consequences are designed in:
 *
 *   * the schema is the *narration* shape (07 §7.5: wording, not advice) —
 *     no impact figures, no derivations, no proposed actions,
 *     `confidence_basis: 'model'`, `requires_review: true` — so a model that
 *     obeys it cannot even express most of what the validator refuses, and a
 *     model that does not is refused anyway;
 *   * only `insights` is asked for. The envelope — `request_id`,
 *     `advisor_id`, `contract_version` — is written by the adapter from the
 *     request (`adapter.ts`), so there is nothing for a model to forge.
 *
 * WP 5.3 owns what a narration may say. **Since WP 9.5 this default *is* the
 * narrator's reply format** (`@ctx/insights`' `NARRATOR_REPLY_FORMAT`,
 * restated here because neither package may import the other, and pinned
 * deep-equal by `apps/api/test/db/narrator-composition.test.ts`). The Phase 5
 * gate's G5-6: the worker built the adapter with no `format`, so production
 * sampled under a generic schema while both live measurements passed the
 * narrow one — different template hashes, different query shapes. With the
 * narrow schema as the default there is one schema and no second to drift to:
 * the worker, the api's preview renderer, the eval and the red team all hash
 * and send the same bytes. `local_model` is a narrating kind only (07 §7.5),
 * so the narrator's shape is the only one this adapter serves. A caller may
 * still pass `format`; nothing in production does.
 *
 * What the narrow shape adds over the generic one, each from the live
 * calibration (wp5.3 §8): `confidence` an enum (Ollama's grammar does not
 * enforce numeric bounds; the model wrote `100`), at most two evidence rows,
 * never `external`, no caveats; and (WP 9.5 option A(a)) no `key`, `type` or
 * `period` — the narrator writes the narration's identity from the request.
 */
const SEVERITIES = ['info', 'notable', 'warning', 'urgent'];
const HORIZONS = ['immediate', 'this_period', 'next_quarter', 'this_year', 'long_term'];

const text = (maxLength: number): Record<string, unknown> => ({ type: 'string', maxLength });

export const NARRATION_FORMAT: Readonly<Record<string, unknown>> = Object.freeze({
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
