// SPDX-License-Identifier: MIT
/**
 * Domain errors → RFC 9457 problem details.
 *
 * 08 §6.4 keeps three taxonomies apart and this file is where they meet HTTP:
 *
 * | Thrown by                | Family      | Meaning                                  |
 * | ------------------------ | ----------- | ---------------------------------------- |
 * | `LedgerError`            | `domain`    | the system of record refuses the write   |
 * | `ConnectionsError`       | `domain`    | no such connection, unknown provider     |
 * | `ConnectorError`         | `connector` | something outside our boundary failed    |
 * | `CategorizationError`    | mixed       | no such rule/category, or an invariant   |
 *
 * `CategorizationError` (WP 2.5) is the newest addition. Every route this WP
 * added — `/rules`, `/categories`'s writes, `/transactions/{id}/rule` — calls
 * into `@ctx/categorization` through `mapDomainErrors`, and before this map
 * existed every one of those errors fell through to the generic `internal` 500
 * `toProblem` gives an unrecognised exception (docs/CONVENTIONS.md: "An
 * unrecognised exception is `internal`") — a 500 for "no rule with that id" is
 * exactly the wrong-signal shape this file exists to prevent.
 *
 * Two rules hold throughout:
 *
 * - **The `code` is the domain's own code, unchanged.** `ledger.splits_do_not_sum`
 *   reaches the client as `ledger.splits_do_not_sum`. Clients switch on `code`,
 *   and re-spelling it here would mean two vocabularies for one condition.
 * - **A `ConnectorError`'s message never reaches the client.** It is a provider's
 *   prose and may name an institution, a token prefix, or an internal endpoint.
 *   What crosses the wire is the typed `kind`, the provider's own code, and a
 *   sentence we wrote — plus `retryable`, which is the only thing the UI has to
 *   decide between "try again" and "this needs you".
 */
import {
  isCategorizationError,
  type CategorizationErrorCode,
} from '@ctx/categorization';
import { ConnectorError, isConnectionsError, type ConnectionsErrorCode } from '@ctx/connections';
import { isLedgerError, type LedgerErrorCode } from '@ctx/ledger';
import { AppError } from '../problem.ts';

/**
 * Ledger codes that are a *bad request*, not a broken invariant.
 *
 * A cursor that does not decode arrived in a query string the client built; a
 * split set that does not sum is the user's arithmetic. Everything else — a
 * missing account, a closed account, a currency mismatch — is the ledger
 * refusing to violate an invariant, which is 409/422 and a `warn`.
 */
const LEDGER_STATUS: Readonly<Record<LedgerErrorCode, number>> = {
  'ledger.account_not_found': 404,
  'ledger.transaction_not_found': 404,
  'ledger.cursor_invalid': 400,
  'ledger.splits_do_not_sum': 422,
  'ledger.account_closed': 409,
  'ledger.currency_mismatch': 409,
  'ledger.transfer_same_account': 409,
  'ledger.transfer_already_paired': 409,
};

const CONNECTIONS_STATUS: Readonly<Record<ConnectionsErrorCode, number>> = {
  'connections.not_found': 404,
  'connections.account_not_linked': 404,
  'connections.already_disconnected': 409,
  'connections.locked': 503,
  'connections.unknown_provider': 400,
  'connections.sync_exhausted': 503,
};

/**
 * WP 2.5. `not_found` codes are 404s a client can act on directly; the rest are
 * the engine or a `CHECK` constraint refusing something the request asked for.
 * `category_not_assignable` also covers "this category belongs to someone
 * else" — `rules-routes.test.ts`'s "a rule may not be created for another
 * user's category" — because the lookup that produces it is already scoped to
 * `user_id` (`categoryIdsByKey`), so a cross-user id is indistinguishable from
 * a non-existent one, and a 404/422 says so without confirming the other
 * user's category exists at all.
 */
const CATEGORIZATION_STATUS: Readonly<Record<CategorizationErrorCode, number>> = {
  'categorization.category_not_found': 404,
  'categorization.rule_not_found': 404,
  'categorization.assignment_not_found': 404,
  'categorization.rule_invalid': 400,
  'categorization.category_not_assignable': 422,
  'categorization.category_third_level_refused': 422,
  'categorization.taxonomy_not_seeded': 409,
  'categorization.system_category_immutable': 409,
};

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function titleOf(status: number): string {
  return TITLES[status] ?? 'Error';
}

/**
 * `ConnectorError.kind` → HTTP.
 *
 * `invalid_input` is the interesting one: a CSV whose columns do not match the
 * mapping profile is the *caller's* problem and a 400, even though it arrives
 * wrapped in the same error type as "the institution is down".
 */
function connectorStatus(kind: ConnectorError['kind']): number {
  switch (kind) {
    case 'invalid_input':
      return 400;
    case 'auth_required':
      return 409;
    case 'rate_limited':
      return 429;
    case 'provider_unavailable':
      return 503;
    default:
      return 502;
  }
}

/**
 * Translate a domain failure, or hand back anything else untouched.
 *
 * Returns rather than throws so a call site reads `throw toDomainProblem(error)`
 * and the compiler can still see that the line ends the control flow.
 */
export function toDomainProblem(error: unknown): unknown {
  if (isLedgerError(error)) {
    const status = LEDGER_STATUS[error.code] ?? 409;
    return new AppError({
      status,
      code: error.code,
      title: titleOf(status),
      detail: error.message,
      family: status === 400 || status === 404 ? 'user' : 'domain',
    });
  }

  if (isConnectionsError(error)) {
    const status = CONNECTIONS_STATUS[error.code] ?? 409;
    return new AppError({
      status,
      code: error.code,
      title: titleOf(status),
      detail: error.message,
      family: status === 503 ? 'internal' : status === 404 || status === 400 ? 'user' : 'domain',
    });
  }

  if (isCategorizationError(error)) {
    const status = CATEGORIZATION_STATUS[error.code] ?? 409;
    return new AppError({
      status,
      code: error.code,
      title: titleOf(status),
      detail: error.message,
      family: status === 404 || status === 400 || status === 422 ? 'user' : 'domain',
    });
  }

  if (error instanceof ConnectorError) {
    const status = connectorStatus(error.kind);
    const policy = error.policy();
    return new AppError({
      status,
      // `connector.auth_required`, not the provider's own string. The UI's
      // reconnect affordance keys off this and must not have to know that Plaid
      // spells it ITEM_LOGIN_REQUIRED.
      code: `connector.${error.kind}`,
      title: titleOf(status),
      detail: connectorDetail(error, policy.userActionRequired),
      family: 'connector',
    });
  }

  return error;
}

/**
 * What we are willing to say about a provider failure.
 *
 * The provider's `condition` (a code from our own enum) and its `providerCode`
 * (a code from theirs) are both safe: they are identifiers, not prose. The
 * message is not, and is omitted.
 */
function connectorDetail(error: ConnectorError, userActionRequired: boolean): string {
  const code = error.providerCode ?? error.condition ?? error.kind;
  return userActionRequired
    ? `The provider needs your attention (${code}). Reconnect the connection to continue.`
    : `The provider could not be reached (${code}). This will be retried automatically.`;
}

/** `await mapDomainErrors(() => …)` around any call into a context. */
export async function mapDomainErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDomainProblem(error);
  }
}
