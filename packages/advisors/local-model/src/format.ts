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
 * WP 5.3 owns what a narration may say and may pass its own, narrower schema
 * through `createLocalModelAdapter`'s `format` option.
 */
const SEVERITIES = ['info', 'notable', 'warning', 'urgent'];
const HORIZONS = ['immediate', 'this_period', 'next_quarter', 'this_year', 'long_term'];
const EVIDENCE_KINDS = ['metric', 'transaction', 'series', 'budget_line', 'external'];

const text = (maxLength: number): Record<string, unknown> => ({ type: 'string', maxLength });
const nullableText = (maxLength: number): Record<string, unknown> => ({
  anyOf: [{ type: 'string', maxLength }, { type: 'null' }],
});

export const NARRATION_FORMAT: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'period',
          'type',
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
          key: text(160),
          period: text(32),
          type: text(64),
          severity: { type: 'string', enum: SEVERITIES },
          title: text(160),
          summary_md: text(2000),
          confidence: { type: 'number', minimum: 0, maximum: 1 },
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
              basis: text(240),
              derivation_id: { type: 'null' },
            },
          },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'label', 'value', 'source_ref', 'url'],
              properties: {
                kind: { type: 'string', enum: EVIDENCE_KINDS },
                label: text(160),
                value: nullableText(160),
                source_ref: nullableText(512),
                url: { type: 'null' },
              },
            },
          },
          derivations: { type: 'array', maxItems: 0 },
          proposed_actions: { type: 'array', maxItems: 0 },
          caveats: { type: 'array', maxItems: 8, items: text(240) },
          expires_at: { type: 'null' },
        },
      },
    },
  },
});
