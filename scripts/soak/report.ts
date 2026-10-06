// SPDX-License-Identifier: MIT
/**
 * The weekly real-use soak report (docs/plan/09-phase-9-dispatch.md §3
 * "WP 9.1", part 3). Run inside the production `api` container, against the
 * production database, by the orchestrator — never by an agent against
 * `personalfi-prod` (Phase 9 rule 5). Output is committed to
 * `docs/evidence/phase-9/soak/week-YYYY-Www.md`, which is exactly why every
 * query here is held to one rule, mechanically enforced by
 * `assertQueriesAreSafe` below and by `apps/api/test/db/soak-report.test.ts`:
 *
 *   **Every query selects only aggregates and whitelisted dimensions — an
 *   ISO week, a connection ordinal, a provider kind, a status, a job kind, a
 *   reason code — and never an amount, a name, a memo, an institution, a
 *   merchant or a goal.**
 *
 * `SOAK_QUERIES` is the one place a query is allowed to exist in this file;
 * `main()` only ever runs what is in that list, so the structural check and
 * the real report can never drift apart.
 *
 * ## Why this file imports workspace packages at all
 *
 * `apps/api`'s production image (`docker/api.Dockerfile`) deletes the
 * top-level `scripts/` directory from the final image — this file is not
 * shipped by the normal build. The orchestrator runs it by copying this one
 * file into the running `personalfi-prod` `api` container (or by bind-
 * mounting it for a `docker compose run`) and executing it with the image's
 * own `node`, which already resolves every workspace package this file
 * imports (`@core/config`, `@core/db`, `@core/kernel`, `@ctx/planning`) —
 * they are `apps/api`'s own production dependencies and survive the prune
 * that removes `scripts/`. See "Wiring for the orchestrator" in
 * `docs/evidence/phase-9/wp9.1-soak.md` for the exact command.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@core/config';
import { createPool } from '@core/db';
import { systemClock, type Clock } from '@core/kernel';
import { loadAssumptions } from '@ctx/planning';
import type pg from 'pg';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// 1. The query manifest -- the one place a SQL string may appear
// ---------------------------------------------------------------------------

export interface SoakQuery {
  readonly name: string;
  readonly section: string;
  readonly description: string;
  readonly sql: string;
}

/**
 * Dimensions a query is always allowed to select bare (optionally
 * table-qualified, optionally re-aliased with `AS`): opaque identity (never
 * displayed), and the plan's own named whitelist -- ISO week, connection
 * ordinal, provider kind, status, job kind, reason code -- plus the small
 * set of enum-shaped columns this report's sections actually need
 * (categorisation `source`, security-event `outcome`, notification
 * `delivery_class`, Brief `section`, feedback `action`, migration
 * `version`). None of these is free text about a holder's own data; every
 * one is a closed, small-cardinality label.
 */
const ALLOWED_BARE_COLUMNS = new Set([
  'id',
  'connection_id',
  'connection_ordinal',
  'iso_week',
  'provider',
  'status',
  'kind',
  'job_kind',
  'source',
  'outcome',
  'delivery_class',
  'section',
  'action',
  'reason_code',
  'verdict',
  'version',
  'trigger',
  'operation',
]);

/**
 * Function/expression heads a select-list item may start with. Every one
 * reduces its argument to a count, a rate, a duration or a bucket label --
 * never echoes a row's own text back out. `case`/`dense_rank`/`row_number`
 * are expression/window forms, not plain function calls, and are matched
 * the same way.
 */
const ALLOWED_EXPRESSION_HEADS = new Set([
  'count',
  'sum',
  'max',
  'min',
  'avg',
  'round',
  'floor',
  'coalesce',
  'bool_or',
  'bool_and',
  'percentile_cont',
  'percentile_disc',
  'extract',
  'to_char',
  'date_trunc',
  'now',
  'dense_rank',
  'row_number',
  'rank',
  'case',
  'lag',
]);

/**
 * Tokens that, as a whole underscore-delimited word inside any identifier
 * referenced in a select-list item, fail that item outright -- even inside
 * an otherwise-allowed aggregate (`max(effective_name)` must fail exactly
 * as a bare `effective_name` would). Every column in this schema that holds
 * an amount, a free-text name, a memo, an institution, a merchant or a goal
 * contains one of these words as a whole token (`docs/CONVENTIONS.md`'s own
 * naming rule for money is `*_minor`).
 */
const FORBIDDEN_WORDS = new Set([
  'name',
  'memo',
  'merchant',
  'institution',
  'goal',
  'title',
  'summary',
  'body',
  'note',
  'notes',
  'description',
  'amount',
  'minor',
  'address',
  'email',
  'phone',
  'credential',
  'secret',
  'token',
  'evidence',
  'manifest',
]);

const SQL_KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'as',
  'over',
  'partition',
  'by',
  'order',
  'filter',
  'case',
  'when',
  'then',
  'else',
  'end',
  'distinct',
  'within',
  'group',
  'null',
  'true',
  'false',
  'interval',
  'epoch',
  'is',
  'in',
  'between',
  'desc',
  'asc',
  'with',
  'join',
  'on',
  'left',
  'inner',
  'using',
]);

/** Splits `text` on top-level commas -- depth 0, outside any `(...)` or `'...'`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/** Every top-level `SELECT … FROM` select-list in `sql` (the CTE's and the outer query's). */
function selectListsOf(sql: string): string[] {
  const withoutStrings = sql.replace(/'[^']*'/gu, "''");
  const lists: string[] = [];
  const selectRegex = /\bselect\b/giu;
  let match: RegExpExecArray | null;
  while ((match = selectRegex.exec(withoutStrings)) !== null) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = -1;
    for (let i = start; i < withoutStrings.length; i += 1) {
      const ch = withoutStrings[i];
      if (ch === '(') depth += 1;
      if (ch === ')') {
        if (depth === 0) break; // closing a paren we did not open: end of this SELECT's reach
        depth -= 1;
      }
      if (depth === 0 && /\bfrom\b/iu.test(withoutStrings.slice(i, i + 4))) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    lists.push(withoutStrings.slice(start, end));
  }
  return lists;
}

/** The bare identifiers a select-list item references, excluding keywords and the head function name. */
function identifiersIn(item: string): string[] {
  const tokens = item.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
  return tokens.filter((token) => !SQL_KEYWORDS.has(token.toLowerCase()));
}

function lastSegment(identifier: string): string {
  const parts = identifier.split('.');
  return parts[parts.length - 1] ?? identifier;
}

function violatesForbiddenWords(identifier: string): boolean {
  return lastSegment(identifier)
    .toLowerCase()
    .split('_')
    .some((word) => FORBIDDEN_WORDS.has(word));
}

export interface SqlSafetyViolation {
  readonly query: string;
  readonly item: string;
  readonly reason: string;
}

/**
 * The structural check (09 §3 "WP 9.1"; the exit test
 * `'every query in the soak report selects only aggregates and whitelisted
 * dimensions'`). Returns every violation found across every query in
 * `queries` -- empty means every query is safe.
 *
 * Deliberately not a general SQL parser: it is a depth-aware tokeniser over
 * the select-list of every top-level `SELECT … FROM` (including CTEs), which
 * is exactly the surface this report's queries use and exactly the surface
 * a sabotage ("add one non-aggregate column") would touch.
 */
export function assertQueriesAreSafe(queries: readonly SoakQuery[]): SqlSafetyViolation[] {
  const violations: SqlSafetyViolation[] = [];
  for (const query of queries) {
    for (const selectList of selectListsOf(query.sql)) {
      for (const rawItem of splitTopLevel(selectList)) {
        const item = rawItem.trim();
        if (item.length === 0) continue;
        // Strip a trailing `AS alias` / bare alias for the *expression* half;
        // the alias itself is never selected data, so it is never checked.
        const expressionMatch = /^(.*?)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?$/iu.exec(item);
        const expression = (expressionMatch?.[1] ?? item).trim();

        const bareColumnMatch = /^[A-Za-z_][A-Za-z0-9_.]*$/u.exec(expression);
        if (bareColumnMatch !== null) {
          const column = lastSegment(expression).toLowerCase();
          if (!ALLOWED_BARE_COLUMNS.has(column) || violatesForbiddenWords(expression)) {
            violations.push({
              query: query.name,
              item,
              reason: `bare column '${expression}' is not on the whitelist`,
            });
          }
          continue;
        }

        const headMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(expression);
        const head = headMatch?.[1]?.toLowerCase();
        const isCaseExpr = /^case\b/iu.test(expression);
        if ((head === undefined || !ALLOWED_EXPRESSION_HEADS.has(head)) && !isCaseExpr) {
          violations.push({
            query: query.name,
            item,
            reason:
              head === undefined
                ? 'not a bare whitelisted column and not a recognised aggregate/expression'
                : `'${head}(...)' is not an allowed aggregate/expression`,
          });
          continue;
        }

        for (const identifier of identifiersIn(expression)) {
          const lowered = identifier.toLowerCase();
          if (lowered === head) continue; // the function name itself
          if (ALLOWED_EXPRESSION_HEADS.has(lowered)) continue; // a nested allowed function, e.g. extract(epoch from now() - x)
          if (violatesForbiddenWords(identifier)) {
            violations.push({
              query: query.name,
              item,
              reason: `'${identifier}' inside '${head ?? 'case'}(...)' is a forbidden column`,
            });
          }
        }
      }
    }
  }
  return violations;
}

/** `to_char(<timestamptz column>, 'IYYY-"W"IW')` -- the ISO week, as `YYYY-Www`. */
const ISO_WEEK = (column: string) => `to_char(date_trunc('week', ${column})::date, 'IYYY-"W"IW')`;

export const SOAK_QUERIES: readonly SoakQuery[] = [
  {
    name: 'sync_health',
    section: 'Sync health',
    description: 'Scheduled sync runs per connection ordinal: counts, p95/max duration.',
    sql: `
      WITH connection_ordinals AS (
        SELECT id AS connection_id, provider,
               dense_rank() OVER (ORDER BY created_at) AS connection_ordinal
        FROM connections
      )
      SELECT
        ${ISO_WEEK('sr.started_at')} AS iso_week,
        co.connection_ordinal,
        co.provider,
        sr.status,
        count(*) AS run_count,
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY sr.duration_ms)) AS p95_duration_ms,
        max(sr.duration_ms) AS max_duration_ms
      FROM sync_runs sr
      JOIN connection_ordinals co ON co.connection_id = sr.connection_id
      WHERE sr.trigger = 'scheduled'
      GROUP BY iso_week, co.connection_ordinal, co.provider, sr.status
      ORDER BY iso_week, co.connection_ordinal
    `,
  },
  {
    name: 'connection_schedule_streak',
    section: 'Sync health',
    description:
      'Per connection ordinal, successful scheduled syncs on each of the last 7 days (criterion 1).',
    sql: `
      WITH connection_ordinals AS (
        SELECT id AS connection_id,
               dense_rank() OVER (ORDER BY created_at) AS connection_ordinal
        FROM connections
      )
      SELECT
        co.connection_ordinal,
        count(DISTINCT sr.started_at::date) FILTER (
          WHERE sr.status = 'success' AND sr.started_at >= now() - interval '7 days'
        ) AS successful_days_last_7
      FROM connection_ordinals co
      LEFT JOIN sync_runs sr ON sr.connection_id = co.connection_id AND sr.trigger = 'scheduled'
      GROUP BY co.connection_ordinal
      ORDER BY co.connection_ordinal
    `,
  },
  {
    name: 'ledger_invariants',
    section: 'Ledger invariants',
    description:
      'Internal transfers still inside spend totals, duplicate dedup keys, pending > 10 days.',
    sql: `
      SELECT
        count(*) FILTER (
          WHERE t.is_transfer AND NOT t.user_excluded AND NOT t.pending AND t.removed_at IS NULL
            AND t.effective_date >= date_trunc('month', now() - interval '1 month')::date
            AND t.effective_date < date_trunc('month', now())::date
        ) AS internal_transfers_in_spend_last_complete_month,
        count(*) FILTER (WHERE t.pending AND t.effective_date < (now() - interval '10 days')::date) AS pending_over_10_days
      FROM transactions t
    `,
  },
  {
    name: 'duplicate_dedup_keys',
    section: 'Ledger invariants',
    description: 'dedup_key values claimed by more than one transaction -- should always be zero.',
    sql: `
      SELECT count(*) AS duplicate_dedup_key_count
      FROM (
        SELECT dedup_key FROM ledger_dedup_keys GROUP BY dedup_key HAVING count(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'categorisation_rate',
    section: 'Categorisation',
    description:
      'Auto vs holder-corrected category assignments over the trailing 30 days, by source.',
    sql: `
      SELECT
        source,
        count(*) AS assignment_count
      FROM category_assignments
      WHERE is_current AND decided_at >= now() - interval '30 days'
      GROUP BY source
      ORDER BY source
    `,
  },
  {
    name: 'review_burden',
    section: 'Review burden',
    description: 'Holder overlay writes (source = user) per ISO week.',
    sql: `
      SELECT
        ${ISO_WEEK('decided_at')} AS iso_week,
        count(*) AS overlay_write_count
      FROM category_assignments
      WHERE source = 'user'
      GROUP BY iso_week
      ORDER BY iso_week
    `,
  },
  {
    name: 'brief_weekly',
    section: 'The Brief',
    description: 'Briefs published per ISO week, with ranked/attention item counts.',
    sql: `
      SELECT
        b.iso_week,
        count(*) FILTER (WHERE bi.section = 'ranked') AS ranked_count,
        count(*) FILTER (WHERE bi.section = 'attention') AS attention_count
      FROM advisory_briefs b
      LEFT JOIN advisory_brief_items bi ON bi.brief_id = b.id
      GROUP BY b.iso_week
      ORDER BY b.iso_week
    `,
  },
  {
    name: 'brief_dismissals_by_reason',
    section: 'The Brief',
    description: 'Dismissed feedback by reason_code, per ISO week.',
    sql: `
      SELECT
        ${ISO_WEEK('created_at')} AS iso_week,
        reason_code,
        count(*) AS dismissal_count
      FROM insight_feedback
      WHERE action = 'dismiss'
      GROUP BY iso_week, reason_code
      ORDER BY iso_week, reason_code
    `,
  },
  {
    name: 'brief_first_four_accepted',
    section: 'The Brief',
    description: 'Accepted items across the first four published Briefs (the Brief criterion).',
    sql: `
      WITH first_four AS (
        SELECT id FROM advisory_briefs ORDER BY published_at ASC LIMIT 4
      )
      SELECT
        count(*) FILTER (WHERE i.status = 'accepted') AS accepted_count,
        count(*) AS item_count
      FROM advisory_brief_items bi
      JOIN first_four f ON f.id = bi.brief_id
      LEFT JOIN insights i ON i.id = bi.insight_id
    `,
  },
  {
    name: 'notifications_by_class',
    section: 'Notifications',
    description: 'Notifications queued per ISO week, by delivery class.',
    sql: `
      SELECT
        ${ISO_WEEK('queued_at')} AS iso_week,
        delivery_class,
        count(*) AS notification_count
      FROM notification_outbox
      GROUP BY iso_week, delivery_class
      ORDER BY iso_week, delivery_class
    `,
  },
  {
    name: 'jobs_failed_dead',
    section: 'Jobs',
    description: 'Failed/dead jobs by kind.',
    sql: `
      SELECT
        kind AS job_kind,
        status,
        count(*) AS job_count
      FROM jobs
      WHERE status IN ('failed', 'dead')
      GROUP BY job_kind, status
      ORDER BY job_kind, status
    `,
  },
  {
    name: 'advisor_quarantines',
    section: 'Jobs',
    description: 'Advisors currently quarantined, by quarantine reason.',
    sql: `
      SELECT
        quarantine_reason,
        count(*) AS quarantined_count
      FROM advisors
      WHERE quarantined_at IS NOT NULL
      GROUP BY quarantine_reason
      ORDER BY quarantine_reason
    `,
  },
  {
    name: 'auth_counts',
    section: 'Auth',
    description: 'Successful auth, failures and step-ups per ISO week, from security_events.',
    sql: `
      SELECT
        ${ISO_WEEK('occurred_at')} AS iso_week,
        count(DISTINCT occurred_at::date) FILTER (WHERE kind LIKE 'auth.%' AND outcome = 'success') AS authenticated_days,
        count(*) FILTER (WHERE kind LIKE 'auth.%' AND outcome = 'failure') AS failed_logins,
        count(*) FILTER (WHERE kind = 'auth.locked_out') AS lockouts,
        count(*) FILTER (WHERE kind = 'auth.step_up') AS step_ups
      FROM security_events
      GROUP BY iso_week
      ORDER BY iso_week
    `,
  },
  {
    name: 'backups_and_drills',
    section: 'Backups and drills',
    description: 'Backup attempts and restore drills per ISO week, by status/verdict.',
    sql: `
      SELECT
        ${ISO_WEEK('finished_at')} AS iso_week,
        status,
        count(*) AS backup_attempt_count
      FROM ops_backup_runs
      GROUP BY iso_week, status
      ORDER BY iso_week, status
    `,
  },
  {
    name: 'restore_drills',
    section: 'Backups and drills',
    description: 'Restore drills per ISO week, by verdict.',
    sql: `
      SELECT
        ${ISO_WEEK('ran_at')} AS iso_week,
        verdict,
        count(*) AS drill_count
      FROM ops_restore_drills
      GROUP BY iso_week, verdict
      ORDER BY iso_week, verdict
    `,
  },
  {
    name: 'upgrades_applied',
    section: 'Upgrades',
    description: 'Migrations applied per ISO week, from schema_migrations.applied_at.',
    sql: `
      SELECT
        ${ISO_WEEK('applied_at')} AS iso_week,
        count(*) AS migrations_applied,
        max(version) AS max_version
      FROM schema_migrations
      GROUP BY iso_week
      ORDER BY iso_week
    `,
  },
];

// ---------------------------------------------------------------------------
// 2. The clock (part 5) -- parsed from docs/evidence/phase-9/soak/clock.md
// ---------------------------------------------------------------------------

export type ClockEvent =
  'day_one' | 'attest' | 'fallback' | 'outage_start' | 'outage_end' | 'data_loss' | 'upgrade';

export interface ClockRow {
  readonly date: string; // YYYY-MM-DD
  readonly event: ClockEvent;
  readonly note: string;
}

const CLOCK_EVENTS: ReadonlySet<string> = new Set([
  'day_one',
  'attest',
  'fallback',
  'outage_start',
  'outage_end',
  'data_loss',
  'upgrade',
]);

/** Parses the `| date | event | note |` table rows out of `clock.md`'s text. Unknown rows are ignored, never thrown on -- a hand-edited file with a typo degrades to "fewer rows read", not a crash. */
export function parseClockRows(markdown: string): ClockRow[] {
  const rows: ClockRow[] = [];
  const rowPattern = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([a-z_]+)\s*\|\s*(.*?)\s*\|\s*$/u;
  for (const line of markdown.split('\n')) {
    const match = rowPattern.exec(line.trim());
    if (match === null) continue;
    const [, date, event, note] = match;
    if (date === undefined || event === undefined || !CLOCK_EVENTS.has(event)) continue;
    rows.push({ date, event: event as ClockEvent, note: note ?? '' });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export interface ClockState {
  /** `null` exactly when there is no `day_one` (or later reset) attestation yet. */
  readonly dayNumber: number | null;
  readonly anchorDate: string | null;
  readonly pausedDays: number;
  /** True when no row falls inside `asOfIsoWeek` -- printed as a gap, never as clean (§6 Q6). */
  readonly isGapWeek: boolean;
}

function isoWeekOf(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const target = new Date(date.getTime());
  const dayNumber = (date.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The clock rules (§6 Q6): reset on the latest `fallback`/`data_loss` after
 * `day_one`; pause for any `outage_start`/`outage_end` pair over 24h; an
 * `upgrade` row never resets or pauses anything; a week with no row at all
 * is a gap, never read as clean.
 */
export function computeClockState(rows: readonly ClockRow[], asOfDate: Date): ClockState {
  const asOfIsoWeek = isoWeekOf(asOfDate.toISOString().slice(0, 10));
  const isGapWeek = !rows.some((row) => isoWeekOf(row.date) === asOfIsoWeek);

  const resets = rows.filter(
    (row) => row.event === 'day_one' || row.event === 'fallback' || row.event === 'data_loss',
  );
  const lastReset = resets.at(-1);
  if (lastReset === undefined) {
    return { dayNumber: null, anchorDate: null, pausedDays: 0, isGapWeek };
  }

  const anchor = new Date(`${lastReset.date}T00:00:00.000Z`);
  const elapsedMs = asOfDate.getTime() - anchor.getTime();
  const elapsedDays = Math.max(0, Math.floor(elapsedMs / 86_400_000)) + 1; // day_one itself is day 1

  let pausedDays = 0;
  const outageStarts = rows.filter(
    (row) => row.event === 'outage_start' && row.date >= lastReset.date,
  );
  for (const start of outageStarts) {
    const end = rows.find((row) => row.event === 'outage_end' && row.date > start.date);
    if (end === undefined) continue;
    const startMs = new Date(`${start.date}T00:00:00.000Z`).getTime();
    const endMs = new Date(`${end.date}T00:00:00.000Z`).getTime();
    const durationDays = (endMs - startMs) / 86_400_000;
    if (durationDays > 1) {
      pausedDays += Math.floor(durationDays);
    }
  }

  return {
    dayNumber: Math.max(1, elapsedDays - pausedDays),
    anchorDate: lastReset.date,
    pausedDays,
    isGapWeek,
  };
}

// ---------------------------------------------------------------------------
// 3. The criteria ledger (part 4)
// ---------------------------------------------------------------------------

export type CriterionState =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'observing_since'; readonly date: string }
  | { readonly kind: 'met'; readonly date: string; readonly evidence: string }
  | { readonly kind: 'failed'; readonly date: string; readonly why: string };

function renderCriterionState(state: CriterionState): string {
  switch (state.kind) {
    case 'not_started':
      return 'not started';
    case 'observing_since':
      return `observing since ${state.date}`;
    case 'met':
      return `met on ${state.date} (${state.evidence})`;
    case 'failed':
      return `failed on ${state.date} (${state.why})`;
  }
}

/** 06 "What only Chris can close" items 1-8, the Brief's first month, the narrator, and "only finance tool" -- judged lines stay Chris's. */
const CRITERIA_NAMES = [
  '1. Two institutions linked and syncing on schedule',
  '2. A complete month with zero internal transfers in spend totals',
  "3. The recurring gold set against Chris's own confirmed subscriptions",
  "4. A real brokerage's holdings reconciling to its statement",
  '5. A projection run against real balances with real tax treatment per account',
  '6. A view-only Coinbase CDP key exercised',
  '7. Stated-default decisions recorded (return-series licence, pseudonym construction, plan terms, local model)',
  '8. Hand actions from Phase 0 (LUKS2, Tailscale HTTPS, real secrets, B2 object lock)',
  "9. The Brief's first month (>= 3 useful Briefs; the first four published Briefs' accepted rate)",
  '10. The narrator >= 95% (only if Chris has enabled it)',
  '11. PersonalFi is the only finance tool in use',
] as const;

// ---------------------------------------------------------------------------
// 4. Running the queries and rendering markdown
// ---------------------------------------------------------------------------

export interface SoakQueryResult {
  readonly query: SoakQuery;
  readonly rows: readonly Record<string, unknown>[];
}

export async function runSoakQueries(pool: pg.Pool): Promise<SoakQueryResult[]> {
  const violations = assertQueriesAreSafe(SOAK_QUERIES);
  if (violations.length > 0) {
    throw new Error(
      `soak report: refusing to run -- unsafe select-list item(s): ${JSON.stringify(violations)}`,
    );
  }
  const results: SoakQueryResult[] = [];
  for (const query of SOAK_QUERIES) {
    const result = await pool.query(query.sql);
    results.push({ query, rows: result.rows as Record<string, unknown>[] });
  }
  return results;
}

function renderTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '_(no rows)_\n';
  const columns = Object.keys(rows[0] ?? {});
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((row) => `| ${columns.map((column) => String(row[column] ?? '')).join(' | ')} |`)
    .join('\n');
  return `${header}\n${divider}\n${body}\n`;
}

/** Every cited node's `asOf` string, walked recursively out of the loaded assumptions file -- the same generic walk `apps/api/src/routes/assumptions.ts#toWire` uses, read-only here. */
function collectAsOfDates(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAsOfDates(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['asOf'] === 'string') out.push(record['asOf']);
    for (const inner of Object.values(record)) collectAsOfDates(inner, out);
  }
}

export function renderSoakReport(options: {
  readonly isoWeek: string;
  readonly results: readonly SoakQueryResult[];
  readonly clockRows: readonly ClockRow[];
  readonly asOfDate: Date;
  readonly assumptionsAsOfDates: readonly string[];
  readonly criteria: Readonly<Record<string, CriterionState>>;
}): string {
  const { isoWeek, results, clockRows, asOfDate, assumptionsAsOfDates, criteria } = options;
  const clock = computeClockState(clockRows, asOfDate);

  const sections = new Map<string, SoakQueryResult[]>();
  for (const result of results) {
    const list = sections.get(result.query.section) ?? [];
    list.push(result);
    sections.set(result.query.section, list);
  }

  const lines: string[] = [];
  lines.push(`# Soak report -- ${isoWeek}`);
  lines.push('');
  lines.push(
    clock.isGapWeek
      ? '**The 90-day clock: GAP -- no attestation recorded for this week (docs/evidence/phase-9/soak/clock.md).**'
      : clock.dayNumber === null
        ? '**The 90-day clock: not started -- no day-one attestation yet.**'
        : `**The 90-day clock: day ${clock.dayNumber} of 90** (anchor ${clock.anchorDate ?? '?'}, ${clock.pausedDays} paused day(s)).`,
  );
  lines.push('');

  for (const [section, sectionResults] of sections) {
    lines.push(`## ${section}`);
    lines.push('');
    for (const result of sectionResults) {
      lines.push(`### ${result.query.description}`);
      lines.push('');
      lines.push(renderTable(result.rows));
    }
  }

  lines.push('## The assumptions file');
  lines.push('');
  if (assumptionsAsOfDates.length === 0) {
    lines.push('_(no cited `asOf` dates found)_');
  } else {
    const oldest = assumptionsAsOfDates.slice().sort()[0];
    const oldestAgeDays =
      oldest === undefined
        ? null
        : Math.floor((asOfDate.getTime() - new Date(oldest).getTime()) / 86_400_000);
    lines.push(`Oldest cited \`asOf\`: ${oldest ?? '?'} (${oldestAgeDays ?? '?'} days old).`);
  }
  lines.push('');

  lines.push('## Criteria ledger');
  lines.push('');
  lines.push('| Criterion | State |');
  lines.push('| --- | --- |');
  for (const name of CRITERIA_NAMES) {
    const state = criteria[name] ?? { kind: 'not_started' as const };
    lines.push(`| ${name} | ${renderCriterionState(state)} |`);
  }
  lines.push('');
  lines.push(
    "_Judgements (useful, only tool, fallback) are Chris's own lines, recorded in `clock.md`._",
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 5. Entry point -- only runs when executed directly, never on import
// ---------------------------------------------------------------------------

function currentIsoWeek(now: Date): string {
  return isoWeekOf(now.toISOString().slice(0, 10));
}

async function main(clock: Clock): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    databaseUrl: config.databaseUrl.reveal(),
    max: 4,
    applicationName: 'personalfi-soak-report',
  });
  try {
    const results = await runSoakQueries(pool);

    const clockPath = join(REPO_ROOT, 'docs/evidence/phase-9/soak/clock.md');
    let clockRows: ClockRow[] = [];
    try {
      clockRows = parseClockRows(readFileSync(clockPath, 'utf8'));
    } catch {
      clockRows = [];
    }

    const asOfDates: string[] = [];
    try {
      collectAsOfDates(loadAssumptions(), asOfDates);
    } catch {
      // A malformed assumptions file is `main.ts`'s problem to refuse the
      // process over, not this report's -- it still writes everything else.
    }

    const now = clock.now();
    const isoWeek = currentIsoWeek(now);
    const markdown = renderSoakReport({
      isoWeek,
      results,
      clockRows,
      asOfDate: now,
      assumptionsAsOfDates: asOfDates,
      criteria: {},
    });

    const outDir = join(REPO_ROOT, 'docs/evidence/phase-9/soak');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `week-${isoWeek}.md`);
    writeFileSync(outPath, markdown, 'utf8');
    console.log(`soak-report: wrote ${outPath}`);
  } finally {
    await pool.end();
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(systemClock).catch((error: unknown) => {
    console.error('soak-report: failed', error);
    process.exitCode = 1;
  });
}
