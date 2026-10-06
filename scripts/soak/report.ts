// SPDX-License-Identifier: MIT
/**
 * The weekly real-use soak report (docs/plan/09-phase-9-dispatch.md §3
 * "WP 9.1", parts 3-5). Run by the orchestrator against the production
 * database through `scripts/soak/run-report.sh` -- never by an agent against
 * `personalfi-prod` (Phase 9 rule 5). The output is committed and pushed to
 * `docs/evidence/phase-9/soak/week-YYYY-Www.md`, which is exactly why every
 * query here is held to one rule, enforced three independent ways:
 *
 *   **Every query selects only aggregates and whitelisted dimensions -- an
 *   ISO week, a connection ordinal, a provider kind, a status, a job kind, a
 *   reason code -- and never an amount, a name, a memo, an institution, a
 *   merchant or a goal.**
 *
 *   1. `assertQueriesAreSafe` parses every select-list in `SOAK_QUERIES` and
 *      refuses a bare column that is not on the whitelist, an expression that
 *      is not an aggregate, and any identifier that names an amount/name/memo
 *      (the structural test, `soak-report.test.ts`).
 *   2. `runSoakQueries` refuses to *return* a result column whose name is not a
 *      whitelisted dimension or an aggregate-shaped alias (`*_count`, `*_ms`,
 *      ...), and runs everything in one READ ONLY transaction.
 *   3. The canary test plants a name, a memo, an institution, a goal and an
 *      amount in the database and asserts none of them is in the rendered
 *      markdown -- through `executeSoakQueries`, the same function without the
 *      first two checks, so the canary is a control independent of them.
 *
 * `SOAK_QUERIES` is the one place a query may exist in this file; `main()`
 * only runs what is in that list, so the structural check and the real report
 * cannot drift apart. Every query takes ONE parameter, `$1`, the as-of
 * instant, so a report is reproducible (and the tests deterministic): nothing
 * here calls `now()`.
 *
 * ## Imports
 *
 * The root `tsconfig` includes `scripts/**` but the root package depends on no
 * workspace package. Like `scripts/advisor-eval.ts`, this file therefore
 * reaches workspace code by RELATIVE path -- and only inside `main()`, by
 * dynamic import, so importing the renderer (the tests do) loads nothing
 * heavy. It uses no `pg` types: a pool is anything with `connect()`.
 *
 * ## Where it runs
 *
 * `docker/api.Dockerfile` deletes `scripts/` from the image, so the report is
 * not shipped by the build. `run-report.sh` bind-mounts this one file into the
 * production `api` container (`/app/scripts/soak/report.ts`), where the
 * relative imports resolve into the image's own `packages/`, and reads the
 * database URL from the container's own `database_url` secret. From a checkout
 * with a reachable database, `DATABASE_URL=... node
 * --experimental-strip-types scripts/soak/report.ts` runs it directly.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CLOCK_PATH = join(REPO_ROOT, 'docs/evidence/phase-9/soak/clock.md');
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'docs/evidence/phase-9/soak');

// ---------------------------------------------------------------------------
// 1. The structural safety check
// ---------------------------------------------------------------------------

export interface SoakQuery {
  readonly name: string;
  readonly section: string;
  readonly description: string;
  /** The only parameter is `$1`, the as-of instant (timestamptz). */
  readonly sql: string;
}

/**
 * Bare columns a select-list may name (optionally table-qualified, optionally
 * re-aliased): opaque identity (never rendered -- `runSoakQueries` also checks
 * the output column names), and the plan's whitelist -- ISO week, connection
 * ordinal, provider kind, status, job kind, reason code -- plus the closed,
 * small-cardinality enum labels the sections need. None is free text about a
 * holder's own data.
 */
export const ALLOWED_BARE_COLUMNS: ReadonlySet<string> = new Set([
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
  'quarantine_reason',
  'verdict',
  'version',
  'trigger',
  'operation',
]);

/**
 * Function/expression heads an item may start with. Each reduces its argument
 * to a count, a rate, a duration or a bucket label.
 */
export const ALLOWED_EXPRESSION_HEADS: ReadonlySet<string> = new Set([
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
  'dense_rank',
  'row_number',
  'rank',
  'case',
  'abs',
  'nullif',
]);

/**
 * Whole underscore-delimited words that fail an identifier anywhere in a
 * select-list item -- inside an otherwise-allowed aggregate too
 * (`max(effective_name)` fails exactly as a bare `effective_name` does). Every
 * column in this schema that holds an amount, a name, a memo, an institution,
 * a merchant or a goal contains one of these as a whole word (CONVENTIONS:
 * money columns are `*_minor`).
 */
export const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
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
  'label',
  'description',
  'amount',
  'minor',
  'balance',
  'price',
  'quantity',
  'value',
  'mask',
  'address',
  'email',
  'phone',
  'credential',
  'secret',
  'token',
  'evidence',
  'manifest',
]);

const SQL_KEYWORDS: ReadonlySet<string> = new Set([
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
  'at',
  'time',
  'zone',
  'date',
  'timestamptz',
  'like',
]);

/**
 * Output column names `runSoakQueries` accepts: a whitelisted dimension, or an
 * alias that is shaped like an aggregate. Checked against the *result's* field
 * names, so a leak that slipped past the select-list parser (an alias hiding
 * an expression) still cannot reach the markdown under a name like
 * `merchant_label`.
 */
export const OUTPUT_DIMENSIONS: ReadonlySet<string> = new Set([
  'iso_week',
  'calendar_month',
  'connection_ordinal',
  'provider',
  'status',
  'job_kind',
  'reason_code',
  'quarantine_reason',
  'source',
  'action',
  'verdict',
  'delivery_class',
  'section',
  'max_version',
  'last_iso_week',
]);
export const OUTPUT_AGGREGATE_SUFFIX = /_(count|ms|pct|days|hours|seconds)$/u;

export function isAllowedOutputColumn(name: string): boolean {
  return OUTPUT_DIMENSIONS.has(name) || OUTPUT_AGGREGATE_SUFFIX.test(name);
}

/** Splits `text` on top-level commas: depth 0, outside any `(...)` or `'...'`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (const ch of text) {
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

/**
 * Every select-list in `sql` -- each `SELECT ... FROM`, CTE bodies and
 * subqueries included: from just after a `SELECT` keyword to the next `FROM`
 * at the same parenthesis depth.
 */
export function selectListsOf(sql: string): string[] {
  const text = sql.replace(/'[^']*'/gu, "''");
  const lists: string[] = [];
  const selectRegex = /\bselect\b/giu;
  let match: RegExpExecArray | null;
  while ((match = selectRegex.exec(text)) !== null) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      if (ch === ')') {
        if (depth === 0) break; // closing a paren this SELECT did not open
        depth -= 1;
      }
      if (depth === 0 && /^from\b/iu.test(text.slice(i, i + 5)) && /\W/u.test(text[i - 1] ?? ' ')) {
        end = i;
        break;
      }
    }
    if (end !== -1) lists.push(text.slice(start, end));
  }
  return lists;
}

/** The bare identifiers an item references, excluding SQL keywords. */
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
 * The structural check (exit test `'every query in the soak report selects
 * only aggregates and whitelisted dimensions'`). Returns every violation
 * found across `queries`; empty means every query is safe.
 *
 * Deliberately not a general SQL parser: a depth-aware tokeniser over every
 * select-list, which is exactly the surface these queries use and exactly the
 * surface a sabotage ("add one non-aggregate column") touches.
 */
export function assertQueriesAreSafe(queries: readonly SoakQuery[]): SqlSafetyViolation[] {
  const violations: SqlSafetyViolation[] = [];
  for (const query of queries) {
    for (const selectList of selectListsOf(query.sql)) {
      for (const rawItem of splitTopLevel(selectList)) {
        const item = rawItem.replace(/\s+/gu, ' ').trim();
        if (item.length === 0) continue;
        // The trailing `AS alias` is never selected data; check the expression half.
        const expression = (
          /^(.*?)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?$/iu.exec(item)?.[1] ?? item
        ).trim();

        if (/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(expression)) {
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

        const head = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(expression)?.[1]?.toLowerCase();
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
          if (ALLOWED_EXPRESSION_HEADS.has(identifier.toLowerCase())) continue;
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

// ---------------------------------------------------------------------------
// 2. The query manifest -- the one place a SQL string may appear
// ---------------------------------------------------------------------------

/** `$1` as a UTC calendar date. */
const ASOF_DATE = `(($1::timestamptz) AT TIME ZONE 'UTC')::date`;
/** The ISO week (`YYYY-Www`) of a timestamptz column, in UTC. */
const ISO_WEEK = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'IYYY-"W"IW')`;

/**
 * The 'live ledger row inside spend totals' predicate, over alias `t`: not
 * pending, not removed, not superseded as a duplicate, not excluded by the
 * holder, not flagged an internal transfer -- the rows a spending report sums.
 */
const IN_SPEND = (t: string) =>
  `NOT ${t}.pending AND ${t}.removed_at IS NULL AND ${t}.superseded_by_id IS NULL
        AND NOT ${t}.user_excluded AND NOT ${t}.is_transfer`;

export const SOAK_QUERIES: readonly SoakQuery[] = [
  {
    name: 'sync_health',
    section: 'Sync health',
    description:
      'Scheduled sync runs per ISO week and connection ordinal (1 = the oldest connection): counts, re-auth, p95 and max duration.',
    sql: `
      WITH connection_ordinals AS (
        SELECT id AS connection_id, provider,
               dense_rank() OVER (ORDER BY created_at, id) AS connection_ordinal
        FROM connections
      )
      SELECT
        ${ISO_WEEK('sr.started_at')} AS iso_week,
        co.connection_ordinal,
        co.provider,
        sr.status,
        count(*) AS run_count,
        count(*) FILTER (WHERE sr.error_kind = 'auth_required') AS reauth_count,
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY sr.duration_ms)) AS p95_duration_ms,
        max(sr.duration_ms) AS max_duration_ms
      FROM sync_runs sr
      JOIN connection_ordinals co ON co.connection_id = sr.connection_id
      WHERE sr.trigger = 'scheduled' AND sr.started_at <= $1::timestamptz
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 4
    `,
  },
  {
    name: 'connection_schedule_streak',
    section: 'Sync health',
    description:
      'Per connection ordinal: distinct UTC days (of the last 7 complete days) with a successful scheduled sync -- criterion 1 needs 7 on two connections.',
    sql: `
      WITH connection_ordinals AS (
        SELECT id AS connection_id, status,
               dense_rank() OVER (ORDER BY created_at, id) AS connection_ordinal
        FROM connections
      )
      SELECT
        co.connection_ordinal,
        co.status,
        count(DISTINCT (sr.started_at AT TIME ZONE 'UTC')::date) FILTER (
          WHERE sr.status = 'success'
            AND (sr.started_at AT TIME ZONE 'UTC')::date BETWEEN ${ASOF_DATE} - 7 AND ${ASOF_DATE} - 1
        ) AS successful_days_count
      FROM connection_ordinals co
      LEFT JOIN sync_runs sr ON sr.connection_id = co.connection_id AND sr.trigger = 'scheduled'
      GROUP BY 1, 2
      ORDER BY 1
    `,
  },
  {
    name: 'ledger_pending',
    section: 'Ledger invariants',
    description: 'Pending transactions older than 10 days (a pending row should post or vanish).',
    sql: `
      SELECT count(*) AS pending_over_10_days_count
      FROM transactions t
      WHERE t.pending AND t.removed_at IS NULL AND t.effective_date < ${ASOF_DATE} - 10
    `,
  },
  {
    name: 'ledger_duplicate_dedup_keys',
    section: 'Ledger invariants',
    description:
      'Dedup keys claimed by more than one live (not superseded, not removed) transaction -- should always be zero.',
    sql: `
      SELECT count(*) AS duplicate_dedup_key_count
      FROM (
        SELECT count(*) AS live_claims
        FROM ledger_dedup_keys k
        JOIN transactions t ON t.id = k.transaction_id
        WHERE t.superseded_by_id IS NULL AND t.removed_at IS NULL
        GROUP BY k.user_id, k.dedup_key
        HAVING count(*) > 1
      ) duplicated
    `,
  },
  {
    name: 'spend_rows_by_month',
    section: 'Ledger invariants',
    description:
      'Live spend rows per calendar month (a month with none is not "a month of real data").',
    sql: `
      SELECT
        to_char(t.effective_date, 'YYYY-MM') AS calendar_month,
        count(*) AS spend_row_count
      FROM transactions t
      WHERE ${IN_SPEND('t')} AND t.effective_date <= ${ASOF_DATE}
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'residual_transfer_pairs_by_month',
    section: 'Ledger invariants',
    description:
      'Internal transfers inside spend totals, per calendar month: pairs of live spend rows in two different accounts, equal and opposite amounts, within 5 days -- legs the ledger did not flag `is_transfer`. Criterion 2 needs a complete month at zero.',
    sql: `
      SELECT
        to_char(a.effective_date, 'YYYY-MM') AS calendar_month,
        count(DISTINCT a.id) AS residual_transfer_pair_count
      FROM transactions a
      JOIN transactions b
        ON b.user_id = a.user_id
       AND b.account_id <> a.account_id
       AND b.effective_currency = a.effective_currency
       AND b.effective_amount_minor = -a.effective_amount_minor
       AND abs(b.effective_date - a.effective_date) <= 5
      WHERE a.effective_amount_minor > 0
        AND ${IN_SPEND('a')} AND ${IN_SPEND('b')}
        AND a.effective_date <= ${ASOF_DATE}
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'categorisation_30d',
    section: 'Categorisation',
    description:
      'Current category assignments decided in the trailing 30 days: automatic (rule, provider, classifier, merchant default) versus holder-set. Target: auto >= 90 % after 30 days (09 §8.1).',
    sql: `
      SELECT
        count(*) FILTER (WHERE source <> 'user') AS auto_count,
        count(*) FILTER (WHERE source = 'user') AS holder_corrected_count,
        round(100.0 * count(*) FILTER (WHERE source <> 'user') / nullif(count(*), 0), 1) AS auto_rate_pct
      FROM category_assignments
      WHERE is_current AND decided_at > $1::timestamptz - interval '30 days' AND decided_at <= $1::timestamptz
    `,
  },
  {
    name: 'review_burden',
    section: 'Review burden',
    description:
      'Holder overlay writes (assignments with source = user) per ISO week. Target: < 5 by v1.0 (09 §8.3).',
    sql: `
      SELECT
        ${ISO_WEEK('decided_at')} AS iso_week,
        count(*) AS overlay_write_count
      FROM category_assignments
      WHERE source = 'user' AND decided_at <= $1::timestamptz
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'brief_weekly',
    section: 'The Brief',
    description: 'Briefs published per ISO week, with ranked and attention item counts.',
    sql: `
      SELECT
        b.iso_week,
        count(DISTINCT b.id) AS published_count,
        count(bi.id) FILTER (WHERE bi.section = 'ranked') AS ranked_count,
        count(bi.id) FILTER (WHERE bi.section = 'attention') AS attention_count
      FROM advisory_briefs b
      LEFT JOIN advisory_brief_items bi ON bi.brief_id = b.id
      WHERE b.published_at <= $1::timestamptz
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'insight_feedback_by_week',
    section: 'The Brief',
    description:
      'Holder responses to insights per ISO week: accepted, dismissed, snoozed, reopened -- dismissals and snoozes by reason code (09 §8.2: >= 60 % useful).',
    sql: `
      SELECT
        ${ISO_WEEK('created_at')} AS iso_week,
        action,
        coalesce(reason_code, '(none)') AS reason_code,
        count(*) AS feedback_count
      FROM insight_feedback
      WHERE created_at <= $1::timestamptz
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `,
  },
  {
    name: 'brief_first_four',
    section: 'The Brief',
    description:
      'The first four published Briefs (the Brief criterion): how many exist, their items, how many items were accepted.',
    sql: `
      WITH first_four AS (
        SELECT id, iso_week FROM advisory_briefs WHERE published_at <= $1::timestamptz ORDER BY published_at ASC LIMIT 4
      )
      SELECT
        count(DISTINCT f.id) AS brief_count,
        count(bi.id) AS item_count,
        count(bi.id) FILTER (WHERE i.status = 'accepted') AS accepted_count,
        max(f.iso_week) AS last_iso_week
      FROM first_four f
      LEFT JOIN advisory_brief_items bi ON bi.brief_id = f.id
      LEFT JOIN insights i ON i.id = bi.insight_id
    `,
  },
  {
    name: 'notifications_by_week',
    section: 'Notifications',
    description:
      'Notifications queued per ISO week by delivery class. Target: <= 3 non-critical (PROMPT + DIGEST) per week.',
    sql: `
      SELECT
        ${ISO_WEEK('queued_at')} AS iso_week,
        count(*) FILTER (WHERE delivery_class = 'P0_SAFETY') AS critical_count,
        count(*) FILTER (WHERE delivery_class = 'PROMPT') AS prompt_count,
        count(*) FILTER (WHERE delivery_class = 'DIGEST') AS digest_count,
        count(*) FILTER (WHERE delivery_class <> 'P0_SAFETY') AS noncritical_count
      FROM notification_outbox
      WHERE queued_at <= $1::timestamptz
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'jobs_failed_dead',
    section: 'Jobs',
    description: 'Failed or dead jobs per ISO week by job kind.',
    sql: `
      SELECT
        ${ISO_WEEK('updated_at')} AS iso_week,
        kind AS job_kind,
        status,
        count(*) AS job_count
      FROM jobs
      WHERE status IN ('failed', 'dead') AND updated_at <= $1::timestamptz
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
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
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'auth_by_week',
    section: 'Auth',
    description:
      'Per ISO week: days with a successful sign-in, failed sign-ins, lockouts, step-ups (security_events).',
    sql: `
      SELECT
        ${ISO_WEEK('occurred_at')} AS iso_week,
        count(DISTINCT (occurred_at AT TIME ZONE 'UTC')::date) FILTER (
          WHERE kind ~ '^auth[.](webauthn|totp|recovery_code)[.]' AND outcome = 'success'
        ) AS authenticated_days_count,
        count(*) FILTER (
          WHERE kind ~ '^auth[.](webauthn|totp|recovery_code)[.]' AND outcome = 'failure'
        ) AS failed_login_count,
        count(*) FILTER (WHERE kind = 'auth.locked_out') AS lockout_count,
        count(*) FILTER (WHERE kind = 'auth.step_up' AND outcome = 'success') AS step_up_count
      FROM security_events
      WHERE occurred_at <= $1::timestamptz
      GROUP BY 1
      ORDER BY 1
    `,
  },
  {
    name: 'backup_attempts_by_week',
    section: 'Backups and drills',
    description: 'Backup attempts per ISO week by status (ops_backup_runs).',
    sql: `
      SELECT
        ${ISO_WEEK('finished_at')} AS iso_week,
        status,
        count(*) AS backup_attempt_count
      FROM ops_backup_runs
      WHERE finished_at <= $1::timestamptz
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  },
  {
    name: 'backup_latest_ok',
    section: 'Backups and drills',
    description: 'Hours since the newest successful backup (no row: none has succeeded).',
    sql: `
      SELECT floor(extract(epoch from ($1::timestamptz - max(finished_at))) / 3600) AS last_ok_backup_age_hours
      FROM ops_backup_runs
      WHERE status = 'ok' AND finished_at <= $1::timestamptz
    `,
  },
  {
    name: 'restore_drills_by_week',
    section: 'Backups and drills',
    description: 'Restore drills per ISO week by verdict (ops_restore_drills).',
    sql: `
      SELECT
        ${ISO_WEEK('ran_at')} AS iso_week,
        verdict,
        count(*) AS drill_count
      FROM ops_restore_drills
      WHERE ran_at <= $1::timestamptz
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  },
  {
    name: 'restore_drill_latest',
    section: 'Backups and drills',
    description: 'The newest restore drill: verdict and age in days. Overdue past 35 days.',
    sql: `
      SELECT
        verdict,
        floor(extract(epoch from ($1::timestamptz - ran_at)) / 86400) AS last_drill_age_days
      FROM ops_restore_drills
      WHERE ran_at <= $1::timestamptz
      ORDER BY ran_at DESC
      LIMIT 1
    `,
  },
  {
    name: 'upgrades_by_week',
    section: 'Upgrades',
    description:
      'Migrations applied per ISO week (schema_migrations.applied_at) and the highest version then.',
    sql: `
      SELECT
        ${ISO_WEEK('applied_at')} AS iso_week,
        count(*) AS migrations_applied_count,
        max(version) AS max_version
      FROM schema_migrations
      WHERE applied_at <= $1::timestamptz
      GROUP BY 1
      ORDER BY 1
    `,
  },
];

// ---------------------------------------------------------------------------
// 3. Running the queries
// ---------------------------------------------------------------------------

/** Anything with `connect()`: a `pg.Pool`, structurally -- no `pg` import here. */
export interface SoakPool {
  connect(): Promise<SoakClient>;
}
export interface SoakClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields?: readonly { name: string }[] }>;
  release(): void;
}

export interface SoakQueryResult {
  readonly query: SoakQuery;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Runs `queries` in one READ ONLY transaction at `asOf`, with no safety
 * checks. Exported so the canary test can exercise the queries independently
 * of the select-list parser and the output-column check; production code calls
 * `runSoakQueries`.
 */
export async function executeSoakQueries(
  pool: SoakPool,
  asOf: Date,
  queries: readonly SoakQuery[] = SOAK_QUERIES,
): Promise<SoakQueryResult[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const results: SoakQueryResult[] = [];
    for (const query of queries) {
      // A query that never mentions `$1` (it is a current-state count) is sent without it.
      const result = await client.query(
        query.sql,
        query.sql.includes('$1') ? [asOf.toISOString()] : [],
      );
      const columns =
        result.fields?.map((field) => field.name) ?? Object.keys(result.rows[0] ?? {});
      results.push({ query, columns, rows: result.rows });
    }
    return results;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** The production entry: the structural check, a READ ONLY run, then the output-column check. */
export async function runSoakQueries(pool: SoakPool, asOf: Date): Promise<SoakQueryResult[]> {
  const violations = assertQueriesAreSafe(SOAK_QUERIES);
  if (violations.length > 0) {
    throw new Error(
      `soak report: refusing to run -- unsafe select-list item(s): ${JSON.stringify(violations)}`,
    );
  }
  const results = await executeSoakQueries(pool, asOf);
  for (const result of results) {
    const bad = result.columns.filter((column) => !isAllowedOutputColumn(column));
    if (bad.length > 0) {
      throw new Error(
        `soak report: refusing to render -- query '${result.query.name}' returned non-whitelisted column(s): ${bad.join(', ')}`,
      );
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 4. The clock (part 5), parsed from docs/evidence/phase-9/soak/clock.md
// ---------------------------------------------------------------------------

export type ClockEvent =
  | 'day_one'
  | 'attest'
  | 'fallback'
  | 'outage_start'
  | 'outage_end'
  | 'data_loss'
  | 'upgrade'
  | 'criterion';

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
  'criterion',
]);

/**
 * Events that are Chris attesting the state of the week. `upgrade` (a record
 * of `just upgrade`) and `criterion` (a judged line) are bookkeeping: a week
 * containing only those is still a gap.
 */
const ATTESTATION_EVENTS: ReadonlySet<ClockEvent> = new Set([
  'day_one',
  'attest',
  'fallback',
  'outage_start',
  'outage_end',
  'data_loss',
]);

/**
 * Parses the `| date | event | note |` rows of `clock.md`. A row that does not
 * match (a typo, the header, the divider, an unknown event) is ignored, never
 * thrown on: a hand-edited file degrades to "fewer rows read" -- which the
 * report then prints as a gap, never as clean.
 */
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
  // Stable: rows on one date keep their file order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.date.localeCompare(b.row.date) || a.index - b.index)
    .map(({ row }) => row);
}

const DAY_MS = 86_400_000;

function dateMs(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

function dateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** ISO 8601 week of a `YYYY-MM-DD` date, as `YYYY-Www`. */
export function isoWeekOf(dateStr: string): string {
  const date = new Date(dateMs(dateStr));
  const isoDow = ((date.getUTCDay() + 6) % 7) + 1; // Monday = 1
  // The Thursday of this date's ISO week decides the ISO year.
  const thursday = new Date(date.getTime() + (4 - isoDow) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS);
  return `${isoYear}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')}`;
}

function mondayOf(dateStr: string): string {
  const isoDow = ((new Date(dateMs(dateStr)).getUTCDay() + 6) % 7) + 1;
  return dateOf(new Date(dateMs(dateStr) - (isoDow - 1) * DAY_MS));
}

export interface ClockWeek {
  readonly isoWeek: string;
  /** The attestation rows dated inside the week; empty = a gap. */
  readonly attestations: readonly ClockRow[];
}

export interface ClockState {
  /** `null` exactly when there is no (unreset) `day_one`, or day one is still ahead. */
  readonly dayNumber: number | null;
  readonly anchorDate: string | null;
  /** The event that set the anchor: `day_one`, `fallback` or `data_loss`. */
  readonly anchorEvent: ClockEvent | null;
  readonly pausedDays: number;
  readonly resetCount: number;
  /** True when no attestation falls inside the as-of week -- printed as a gap, never as clean (§6 Q6). */
  readonly isGapWeek: boolean;
  readonly asOfIsoWeek: string;
  /** Every ISO week from the anchor's through the as-of week. */
  readonly weeks: readonly ClockWeek[];
}

/**
 * The clock rules (09 §6 Q6): the clock **resets** at the latest `fallback` or
 * `data_loss`; **pauses** for an outage longer than 24 h (an `outage_start`
 * with no `outage_end` yet pauses through the as-of date); an `upgrade` row
 * never resets or pauses anything; a week with no attestation is a gap.
 * Day one is day 1.
 */
export function computeClockState(rows: readonly ClockRow[], asOfDate: Date): ClockState {
  const asOfDay = dateOf(asOfDate);
  const asOfIsoWeek = isoWeekOf(asOfDay);
  const attestationRows = rows.filter((row) => ATTESTATION_EVENTS.has(row.event));
  const isGapWeek = !attestationRows.some((row) => isoWeekOf(row.date) === asOfIsoWeek);

  const resets = rows.filter(
    (row) => row.event === 'day_one' || row.event === 'fallback' || row.event === 'data_loss',
  );
  const lastReset = resets.filter((row) => row.date <= asOfDay).at(-1);
  if (lastReset === undefined) {
    return {
      dayNumber: null,
      anchorDate: null,
      anchorEvent: null,
      pausedDays: 0,
      resetCount: 0,
      isGapWeek,
      asOfIsoWeek,
      weeks: [],
    };
  }

  let pausedDays = 0;
  for (const start of rows.filter(
    (row) => row.event === 'outage_start' && row.date >= lastReset.date && row.date <= asOfDay,
  )) {
    const end = rows.find((row) => row.event === 'outage_end' && row.date >= start.date);
    const endDate = end !== undefined && end.date <= asOfDay ? end.date : asOfDay;
    const durationDays = (dateMs(endDate) - dateMs(start.date)) / DAY_MS;
    if (durationDays > 1) pausedDays += durationDays;
  }

  const elapsedDays = Math.floor((dateMs(asOfDay) - dateMs(lastReset.date)) / DAY_MS) + 1;

  const weeks: ClockWeek[] = [];
  for (
    let monday = mondayOf(lastReset.date);
    monday <= asOfDay;
    monday = dateOf(new Date(dateMs(monday) + 7 * DAY_MS))
  ) {
    const isoWeek = isoWeekOf(monday);
    weeks.push({
      isoWeek,
      attestations: attestationRows.filter(
        (row) => isoWeekOf(row.date) === isoWeek && row.date >= lastReset.date,
      ),
    });
  }

  return {
    dayNumber: Math.max(1, elapsedDays - pausedDays),
    anchorDate: lastReset.date,
    anchorEvent: lastReset.event,
    pausedDays,
    resetCount: resets.filter((row) => row.date <= asOfDay).length - 1,
    isGapWeek,
    asOfIsoWeek,
    weeks,
  };
}

// ---------------------------------------------------------------------------
// 5. The criteria ledger (part 4)
// ---------------------------------------------------------------------------

export type CriterionState =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'observing_since'; readonly date: string; readonly note?: string }
  | { readonly kind: 'met'; readonly date: string; readonly evidence: string }
  | { readonly kind: 'failed'; readonly date: string; readonly why: string };

export function renderCriterionState(state: CriterionState): string {
  switch (state.kind) {
    case 'not_started':
      return 'not started';
    case 'observing_since':
      return `observing since ${state.date}${state.note === undefined ? '' : ` (${state.note})`}`;
    case 'met':
      return `met on ${state.date} (${state.evidence})`;
    case 'failed':
      return `failed on ${state.date} (${state.why})`;
  }
}

/** 06 "What only Chris can close" items 1-8, the Brief's first month, the narrator, "only finance tool". */
export const CRITERIA: readonly {
  readonly id: number;
  readonly name: string;
  readonly judged: boolean;
}[] = [
  { id: 1, name: '06-1 Two institutions linked and syncing on schedule', judged: false },
  {
    id: 2,
    name: '06-2 A complete month with zero internal transfers in spend totals',
    judged: false,
  },
  {
    id: 3,
    name: "06-3 The recurring gold set against Chris's confirmed subscriptions",
    judged: true,
  },
  { id: 4, name: "06-4 A real brokerage's holdings reconciling to its statement", judged: true },
  {
    id: 5,
    name: '06-5 A projection run against real balances with real tax treatment per account',
    judged: true,
  },
  { id: 6, name: '06-6 A view-only Coinbase CDP key exercised', judged: true },
  { id: 7, name: '06-7 Stated-default decisions recorded', judged: true },
  {
    id: 8,
    name: '06-8 Phase 0 hand actions (LUKS2, Tailscale HTTPS, real secrets, B2 object lock)',
    judged: true,
  },
  {
    id: 9,
    name: "The Brief's first month (accepted items across the first four published Briefs)",
    judged: false,
  },
  { id: 10, name: 'The narrator at >= 95 % (only if Chris enables it)', judged: true },
  { id: 11, name: 'PersonalFi is the only finance tool in use', judged: true },
];

function rowsOf(
  results: readonly SoakQueryResult[],
  name: string,
): readonly Record<string, unknown>[] {
  return results.find((result) => result.query.name === name)?.rows ?? [];
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstOfNextMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, '0')}-01`;
}

/**
 * Criterion 2 (06 item 2): a complete calendar month before the as-of month,
 * with live spend rows, and a zero count of residual internal-transfer pairs.
 * Reads the most recent such month: one planted transfer in it turns the
 * criterion back to observing.
 */
export function evaluateCriterionTwo(
  results: readonly SoakQueryResult[],
  asOfDate: Date,
): CriterionState {
  const asOfMonth = dateOf(asOfDate).slice(0, 7);
  const monthsWithRows = rowsOf(results, 'spend_rows_by_month')
    .map((row) => ({ month: String(row['calendar_month']), rows: num(row['spend_row_count']) }))
    .filter((entry) => entry.rows > 0);
  const residual = new Map(
    rowsOf(results, 'residual_transfer_pairs_by_month').map((row) => [
      String(row['calendar_month']),
      num(row['residual_transfer_pair_count']),
    ]),
  );
  const complete = monthsWithRows.filter((entry) => entry.month < asOfMonth);
  const latest = complete.at(-1);
  if (latest === undefined) {
    return monthsWithRows.length === 0
      ? { kind: 'not_started' }
      : {
          kind: 'observing_since',
          date: `${asOfMonth}-01`,
          note: 'no complete month with spend rows yet',
        };
  }
  const pairs = residual.get(latest.month) ?? 0;
  if (pairs === 0) {
    return {
      kind: 'met',
      date: firstOfNextMonth(latest.month),
      evidence: `${latest.month}: ${latest.rows} spend rows, 0 internal-transfer pairs in spend totals`,
    };
  }
  return {
    kind: 'observing_since',
    date: firstOfNextMonth(latest.month),
    note: `${latest.month} had ${pairs} internal-transfer pair(s) inside spend totals`,
  };
}

function evaluateCriterionOne(results: readonly SoakQueryResult[], asOfDate: Date): CriterionState {
  const connections = rowsOf(results, 'connection_schedule_streak').filter(
    (row) => row['status'] !== 'disconnected',
  );
  if (connections.length === 0) return { kind: 'not_started' };
  const full = connections.filter((row) => num(row['successful_days_count']) >= 7).length;
  const asOfDay = dateOf(asOfDate);
  if (full >= 2) {
    return {
      kind: 'met',
      date: asOfDay,
      evidence: `${full} of ${connections.length} connections with a successful scheduled sync on each of the last 7 complete days`,
    };
  }
  return {
    kind: 'observing_since',
    date: asOfDay,
    note: `${full} of ${connections.length} connection(s) at 7/7 days; 2 needed`,
  };
}

function evaluateBriefCriterion(
  results: readonly SoakQueryResult[],
  asOfDate: Date,
): CriterionState {
  const row = rowsOf(results, 'brief_first_four')[0];
  const briefs = num(row?.['brief_count']);
  if (briefs === 0) return { kind: 'not_started' };
  const accepted = num(row?.['accepted_count']);
  const items = num(row?.['item_count']);
  const week = String(row?.['last_iso_week'] ?? '');
  if (briefs < 4) {
    return {
      kind: 'observing_since',
      date: dateOf(asOfDate),
      note: `${briefs} of 4 Briefs published; ${accepted} accepted of ${items} items`,
    };
  }
  return accepted >= 3
    ? {
        kind: 'met',
        date: week,
        evidence: `${accepted} accepted of ${items} items across the first four Briefs`,
      }
    : {
        kind: 'failed',
        date: week,
        why: `${accepted} accepted of ${items} items across the first four Briefs; 3 needed`,
      };
}

const JUDGED_ROW = /^(\d{1,2})\s*:\s*(met|failed|observing)\b\s*[-:\u2014]?\s*(.*)$/iu;

/**
 * Every criterion's state. Criteria 1, 2 and 9 are computed from the queries;
 * the rest are Chris's judgements, read from `criterion` rows in `clock.md`
 * (`| 2026-11-02 | criterion | 3: met - gold set matched my list |`), the latest
 * row per criterion winning. Criterion 11 reads as observing from the clock's
 * anchor unless Chris says otherwise.
 */
export function evaluateCriteria(options: {
  readonly results: readonly SoakQueryResult[];
  readonly clockRows: readonly ClockRow[];
  readonly asOfDate: Date;
}): Record<number, CriterionState> {
  const { results, clockRows, asOfDate } = options;
  const states: Record<number, CriterionState> = {};
  for (const { id } of CRITERIA) states[id] = { kind: 'not_started' };

  states[1] = evaluateCriterionOne(results, asOfDate);
  states[2] = evaluateCriterionTwo(results, asOfDate);
  states[9] = evaluateBriefCriterion(results, asOfDate);

  const clock = computeClockState(clockRows, asOfDate);
  if (clock.anchorDate !== null) {
    states[11] = { kind: 'observing_since', date: clock.anchorDate };
  }

  for (const row of clockRows) {
    if (row.event !== 'criterion') continue;
    const match = JUDGED_ROW.exec(row.note);
    const id = Number(match?.[1]);
    const verdict = match?.[2]?.toLowerCase();
    const text = (match?.[3] ?? '').trim();
    if (match === null || !CRITERIA.some((c) => c.id === id && c.judged)) continue;
    states[id] =
      verdict === 'met'
        ? { kind: 'met', date: row.date, evidence: text === '' ? 'attested' : text }
        : verdict === 'failed'
          ? { kind: 'failed', date: row.date, why: text === '' ? 'attested' : text }
          : { kind: 'observing_since', date: row.date, ...(text === '' ? {} : { note: text }) };
  }
  return states;
}

// ---------------------------------------------------------------------------
// 6. Rendering markdown
// ---------------------------------------------------------------------------

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderTable(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '_(no rows)_\n';
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(' | ')} |`);
  return `${[header, divider, ...body].join('\n')}\n`;
}

/** Every cited node's `asOf` string, walked out of the loaded assumptions file. */
export function collectAsOfDates(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectAsOfDates(item, out);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['asOf'] === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(record['asOf'])) {
      out.push(record['asOf']);
    }
    for (const inner of Object.values(record)) collectAsOfDates(inner, out);
  }
  return out;
}

export interface RenderOptions {
  readonly results: readonly SoakQueryResult[];
  readonly clockRows: readonly ClockRow[];
  readonly asOfDate: Date;
  /** `null` = the assumptions file could not be read (printed as unknown, not as fresh). */
  readonly assumptionsAsOfDates: readonly string[] | null;
  /** E.g. "DRY RUN from seed -- not real data". Printed under the title. */
  readonly label?: string;
}

export function renderSoakReport(options: RenderOptions): string {
  const { results, clockRows, asOfDate, assumptionsAsOfDates, label } = options;
  const clock = computeClockState(clockRows, asOfDate);
  const criteria = evaluateCriteria({ results, clockRows, asOfDate });
  const lines: string[] = [];

  lines.push('<!-- SPDX-License-Identifier: MIT -->');
  lines.push('');
  lines.push(`# Soak report -- ${clock.asOfIsoWeek}`);
  lines.push('');
  lines.push(
    `_Generated by \`scripts/soak/report.ts\` as of ${asOfDate.toISOString()}. Aggregates and whitelisted dimensions only: no amount, name, memo, institution, merchant or goal is selected by any query._`,
  );
  lines.push('');
  if (label !== undefined) {
    lines.push(`**${label}**`);
    lines.push('');
  }

  // The clock.
  lines.push('## The 90-day clock');
  lines.push('');
  if (clock.anchorDate === null) {
    lines.push('**Not started -- no `day_one` attestation in `clock.md` yet.**');
  } else if (clock.dayNumber !== null) {
    const complete = clock.dayNumber >= 90 ? ' The 90 days are complete.' : '';
    lines.push(
      `**Day ${clock.dayNumber} of 90** (anchor ${clock.anchorDate}, from \`${clock.anchorEvent}\`; ${clock.pausedDays} paused day(s); ${clock.resetCount} reset(s)).${complete}`,
    );
  }
  lines.push('');
  if (clock.isGapWeek) {
    lines.push(
      `**GAP: no attestation is recorded for ${clock.asOfIsoWeek} in \`docs/evidence/phase-9/soak/clock.md\`. A week with no attestation is not a clean week.**`,
    );
    lines.push('');
  }
  if (clock.weeks.length > 0) {
    lines.push('| ISO week | Attestation |');
    lines.push('| --- | --- |');
    for (const week of clock.weeks) {
      lines.push(
        week.attestations.length === 0
          ? `| ${week.isoWeek} | **GAP** -- no attestation |`
          : `| ${week.isoWeek} | ${week.attestations.map((row) => `${row.event} ${row.date}`).join(', ')} |`,
      );
    }
    lines.push('');
  }

  // The criteria ledger.
  lines.push('## Criteria ledger');
  lines.push('');
  lines.push('| Id | Criterion | State |');
  lines.push('| --- | --- | --- |');
  for (const criterion of CRITERIA) {
    const state = criteria[criterion.id] ?? { kind: 'not_started' as const };
    lines.push(
      `| ${criterion.id} | ${criterion.name}${criterion.judged ? ' _(Chris judges)_' : ''} | ${cell(renderCriterionState(state))} |`,
    );
  }
  lines.push('');
  lines.push(
    '_Criteria 1, 2 and 9 are computed. The rest are Chris\'s own lines, read from `criterion` rows in `clock.md`. "met on D" is the as-of date of the first weekly file that read it so: see the earlier weeks._',
  );
  lines.push('');

  // The query sections, in manifest order.
  const sections = new Map<string, SoakQueryResult[]>();
  for (const result of results) {
    sections.set(result.query.section, [...(sections.get(result.query.section) ?? []), result]);
  }
  for (const [section, sectionResults] of sections) {
    lines.push(`## ${section}`);
    lines.push('');
    for (const result of sectionResults) {
      lines.push(`### ${result.query.name}`);
      lines.push('');
      lines.push(`_${result.query.description}_`);
      lines.push('');
      lines.push(renderTable(result.columns, result.rows));
    }
  }

  // The assumptions file's age (05 §2: macro constants go stale quarterly).
  lines.push('## The assumptions file');
  lines.push('');
  if (assumptionsAsOfDates === null || assumptionsAsOfDates.length === 0) {
    lines.push(
      '**Unknown** -- the assumptions file could not be read, so its age is not asserted.',
    );
  } else {
    const oldest = assumptionsAsOfDates.slice().sort()[0] ?? '';
    const newest = assumptionsAsOfDates.slice().sort().at(-1) ?? '';
    const ageDays = Math.floor((dateMs(dateOf(asOfDate)) - dateMs(oldest)) / DAY_MS);
    lines.push(
      `Oldest cited \`asOf\`: ${oldest} (${ageDays} days old); newest: ${newest}. ${ageDays > 92 ? '**Stale: macro constants go stale quarterly.**' : 'Within a quarter.'}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 7. Entry point -- only runs when executed directly, never on import
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly clockPath: string;
  readonly out: string;
  readonly asOf: Date;
  readonly label: string | undefined;
}

export function parseArgs(argv: readonly string[], now: Date): CliOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const asOfText = value('--as-of');
  const asOf = asOfText === undefined ? now : new Date(asOfText);
  if (Number.isNaN(asOf.getTime())) throw new Error(`--as-of '${asOfText}' is not a date`);
  return {
    clockPath: value('--clock') ?? DEFAULT_CLOCK_PATH,
    // '-' = stdout, which is what run-report.sh uses (the api container's mounts are read-only).
    out: value('--out') ?? DEFAULT_OUT_DIR,
    asOf,
    label: value('--label'),
  };
}

function databaseUrl(): string {
  const fromEnv = process.env['DATABASE_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const secretsDir = process.env['SECRETS_DIR'] ?? '/run/secrets';
  return readFileSync(join(secretsDir, 'database_url'), 'utf8').trim();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), new Date());

  // Relative imports, dynamically: see the header's "Imports".
  const { createPool } = await import('../../packages/db/src/index.ts');
  const pool = createPool({
    databaseUrl: databaseUrl(),
    max: 2,
    applicationName: 'personalfi-soak-report',
  });
  try {
    const results = await runSoakQueries(pool as unknown as SoakPool, options.asOf);

    let clockRows: ClockRow[] = [];
    try {
      clockRows = parseClockRows(readFileSync(options.clockPath, 'utf8'));
    } catch {
      // No clock.md: every week prints as a gap and the clock as not started.
    }

    let assumptionsAsOfDates: string[] | null = null;
    try {
      const { loadAssumptions } = await import('../../packages/contexts/planning/src/index.ts');
      assumptionsAsOfDates = collectAsOfDates(loadAssumptions());
    } catch {
      // Printed as "unknown", never as fresh.
    }

    const markdown = renderSoakReport({
      results,
      clockRows,
      asOfDate: options.asOf,
      assumptionsAsOfDates,
      ...(options.label === undefined ? {} : { label: options.label }),
    });

    if (options.out === '-') {
      process.stdout.write(markdown);
    } else {
      mkdirSync(options.out, { recursive: true });
      const outPath = join(options.out, `week-${isoWeekOf(dateOf(options.asOf))}.md`);
      writeFileSync(outPath, markdown, 'utf8');
      console.error(`soak-report: wrote ${outPath}`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('soak-report: failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
