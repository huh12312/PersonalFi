// SPDX-License-Identifier: MIT
/**
 * The classification `soak-canary-coverage.test.ts` enforces (G-29, WP 9.14). Not a test file.
 *
 * Every text-like column of every table the weekly soak report's SQL reads is one of:
 *  - SEEDED: `soak-report.test.ts` puts a `CANARY-…` value in it (through the real sync where a route can
 *    write it, by `seedCanaryColumns` where only the module that owns the table could) and proves, after
 *    seeding, that the value is there. The report's leak canary then covers it.
 *  - NOT_FREE_TEXT: a code, enum, id, hash, key, version or sealed blob that cannot carry what a holder
 *    typed — with the reason.
 */

/** Columns the soak seed fills with a canary; the proof is `soak-report.test.ts`'s. */
export const SEEDED: Readonly<Record<string, true>> = {
  'transactions.effective_name': true,
  'transactions.user_merchant_name': true,
  'transactions.user_note': true,
  'ledger_dedup_keys.name_key': true,
  'connections.display_name': true,
  'connections.config': true,
  'connections.last_error': true,
  'sync_runs.error_detail': true,
  'sync_runs.cursor_before': true,
  'sync_runs.cursor_after': true,
  'category_assignments.evidence': true,
  'advisors.advisor_id': true,
  'advisors.display_name': true,
  'advisors.purpose': true,
  'advisors.manifest': true,
  'insights.advisor_id': true,
  'insights.title': true,
  'insights.summary_md': true,
  'insights.caveats': true,
  'insights.derivations': true,
  'advisory_briefs.cold_start_note': true,
  'advisory_brief_items.advisor_id': true,
  'advisory_brief_items.title': true,
  'advisory_brief_items.summary_md': true,
  'advisory_brief_items.evidence': true,
  'advisory_brief_items.retirement_effect': true,
  // WP 11.5e (0062): a plan's progress as the Brief said it — carries a finding's title, which can quote a goal name.
  'advisory_brief_items.progress': true,
  'insight_feedback.advisor_id': true,
  'insight_feedback.reason': true,
  'jobs.payload': true,
  'jobs.last_error': true,
  'notification_outbox.title': true,
  'notification_outbox.body_md': true,
  'notification_outbox.actions': true,
  'notification_outbox.deep_link': true,
  'security_events.detail': true,
  'ops_backup_runs.reason': true,
};

/** Columns that cannot carry what a holder typed, with the reason. */
export const NOT_FREE_TEXT: Readonly<Record<string, string>> = {
  'transactions.effective_currency': 'ISO 4217 code, CHECK-constrained',
  'transactions.superseded_reason': 'a system code written by the pending-to-posted supersession',
  'ledger_dedup_keys.currency': 'ISO 4217 code, CHECK-constrained',
  'ledger_dedup_keys.dedup_key': 'a sha256 hex digest of the row, not reversible to its name',
  'ledger_dedup_keys.provider': 'the provider enum (plaid, manual, ...)',
  'connections.provider': 'the provider enum',
  'connections.provider_connection_id':
    'an opaque provider-assigned id (a Plaid item id, a manual uuid)',
  'connections.status': 'the connection status enum',
  'connections.capabilities': 'the connector capability flags the adapter reports; no holder text',
  'connections.sealed_credentials': 'an XChaCha20-Poly1305 envelope; ciphertext only',
  'connections.transactions_cursor':
    'an opaque provider sync cursor, read by no report query as text',
  'sync_runs.error_code': 'a provider error code from the connector error taxonomy',
  'sync_runs.error_kind': 'one of the six ConnectorError kinds',
  'sync_runs.operation': 'the sync operation enum',
  'sync_runs.status': 'the sync run status enum',
  'sync_runs.trigger': 'the sync trigger enum',
  'category_assignments.source': 'the assignment source enum (rule, classifier, user, ...)',
  'advisors.egress_allowlist': 'a list of hostnames the manifest allows; no holder text',
  'advisors.enabled_source': 'the enablement source enum',
  'advisors.quarantine_reason':
    'CHECK-constrained to a closed set of reason codes (advisors_quarantine_reason_check)',
  'advisors.kind': 'the advisor kind enum',
  'advisors.max_severity': 'the severity enum',
  'advisors.requires_scopes': 'a list of scope names from the closed scope enum',
  'advisors.version': 'a semver string',
  'insights.advisor_version': 'a semver string',
  'insights.confidence_basis': 'the confidence-basis enum',
  'insights.feedback': 'the feedback enum (helpful | not_helpful), CHECK-constrained (WP 10.15)',
  'insights.feedback_reason': 'the dismiss-reason enum, CHECK-constrained (WP 10.15)',
  'transactions.auto_tier':
    'the automatic-categorisation tier enum (merchant_default | provider | classifier), CHECK-constrained (WP 11.2b)',
  'insights.horizon': 'the horizon enum',
  'insights.impact_basis': 'the impact-basis enum',
  'insights.impact_currency': 'ISO 4217 code',
  'insights.impact_derivation_id': 'a derivation id (uuid or hash), no text',
  'insights.input_digest': 'a sha256 digest',
  'insights.key': 'a dedupe key built from ids and periods by the advisor',
  'insights.period': 'a period label (YYYY-MM)',
  'insights.severity': 'the severity enum',
  'insights.status': 'the review status enum',
  'insights.type': 'the insight type code',
  'advisory_briefs.currency': 'ISO 4217 code',
  'advisory_briefs.input_digest': 'a sha256 digest',
  'advisory_briefs.iso_week': 'an ISO week label',
  'advisory_brief_items.horizon': 'the horizon enum',
  'advisory_brief_items.impact_currency': 'ISO 4217 code',
  'advisory_brief_items.insight_key': 'a dedupe key built from ids and periods by the advisor',
  'advisory_brief_items.insight_type': 'the insight type code',
  'advisory_brief_items.primary_action': 'the action enum, CHECK-constrained (migration 0038)',
  'advisory_brief_items.section': 'the section enum',
  'advisory_brief_items.score_factors':
    'numeric ranking factors; CHECK-tied to the score (advisory_brief_items_score_matches_factors)',
  'advisory_brief_items.severity': 'the severity enum',
  'insight_feedback.action': 'the feedback action enum',
  'insight_feedback.insight_key': 'a dedupe key built from ids and periods by the advisor',
  'insight_feedback.reason_code': 'the dismissal reason code enum',
  'jobs.dedupe_key': 'built from the job kind and an id by the enqueuer',
  'jobs.kind': 'the job kind, a registered dotted name',
  'jobs.locked_by': 'a worker id (uuid)',
  'jobs.singleton_key': 'built from the job kind and an id by the enqueuer',
  'jobs.status': 'the job status enum',
  'notification_outbox.dedupe_key': 'built from ids by the notifier',
  'notification_outbox.delivery_class': 'the delivery class enum',
  'notification_outbox.group_key': 'built from the rule and period by the notifier',
  'notification_outbox.held_reason': 'the hold reason code enum',
  'notification_outbox.last_failure_code': 'a delivery failure code from the adapter taxonomy',
  'notification_outbox.priority': 'the priority enum',
  'notification_outbox.source_event_type': 'a registered event type name',
  'notification_outbox.status': 'the delivery status enum',
  'ops_backup_runs.status': 'the backup run status enum (ok, fail)',
  'ops_restore_drills.max_migration': 'a migration number',
  'ops_restore_drills.verdict': 'the drill verdict enum (pass, fail)',
  'schema_migrations.checksum': 'a sha256 digest of a migration file',
  'schema_migrations.previous_checksum':
    'a sha256 hex digest kept when a migration is re-stamped (the migrator, 2026-10-28)',
  'schema_migrations.name': 'a migration file name from the repository',
  'schema_migrations.version': 'a migration number',
  'security_events.correlation_id': 'a request correlation id (uuid text)',
  'security_events.kind': 'the security event kind enum',
  'security_events.outcome': 'the outcome enum',
  'security_events.user_agent_hash': 'a hash of the user agent, not the string',
};

/**
 * Tables the soak report does **not** read, named so the decision is visible (WP 11.5c). A table here holds
 * free text a holder typed or a model wrote, so the day the report's SQL reads one of them,
 * `soak-canary-coverage.test.ts` fails until each of its text columns is classified SEEDED (and seeded) or
 * NOT_FREE_TEXT above — and the table moves out of this list.
 */
export const NOT_READ_BY_THE_REPORT: Readonly<Record<string, string>> = {
  ask_sessions:
    "Ask PersonalFi's question log (WP 11.5c): question and narration_text are free text (the holder's question, a model's wording); the weekly report counts none of it.",
  advisor_sessions:
    "The advisor's session log (WP 11.5d): question, answers and the JSONB of clarification, options, trade-offs and plan are free text (the holder's words, a model's wording); WP 11.5e's origin_title is a finding's title as the holder saw it; the weekly report counts none of it.",
  advisor_session_steps:
    'One row per advisor model call (WP 11.5d): run ids, digests, provider and model, and the knowledge-read record; the weekly report counts none of it.',
  merchant_name_suggestions:
    "Merchant name suggestions (WP 11.6): descriptor and stripped_prefix are the bank's text as the normaliser left it, display_name is a local model's validated cleanup of it, refusal_class a code; the weekly report counts none of it.",
  advisor_settings:
    "The advisor's own hosted consent (WP 11.5d): a provider name and the sha256 of a consent text, no holder free text; the weekly report counts none of it.",
};
