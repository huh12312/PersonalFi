// SPDX-License-Identifier: MIT
/**
 * The slice of `AdvisorRequest` v1 the adapter reads, stated structurally.
 *
 * `@ctx/insights` owns the schema and this layer may not import it
 * (`scripts/eslint-boundaries.js`, the `advisor-local-model` layer: the
 * composition root binds the adapter to the `Advisor` interface from outside,
 * so `@ctx/insights` never gains an LLM client). `AdvisorRequest` is
 * assignable to this type, which is all the binding needs; nothing here
 * re-validates the request — the service built it and parsed it.
 */
export interface LocalModelRequest {
  readonly contract_version: number;
  readonly request_id: string;
  readonly advisor_id: string;
  readonly advisor_version: string;
  readonly kind: string;
  readonly base_currency: string;
  readonly time_zone: string;
  readonly today: string;
  readonly granted_scopes: readonly string[];
  readonly input_digest: string;
  readonly limits: {
    readonly max_insights: number;
    readonly max_response_bytes: number;
    readonly deadline: string;
  };
  readonly snapshot: object;
  /**
   * Contract 1.5.0's findings envelope (WP 5.3), present only for
   * `narrates_only` advisors. Optional and untyped here on purpose: until 1.5.0
   * lands it does not exist, and when it does it is data like the snapshot —
   * sanitised and rendered into the same block, never into the instructions.
   */
  readonly findings?: unknown;
}
