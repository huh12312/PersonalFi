// SPDX-License-Identifier: MIT
/**
 * The parsers' own error, and its one-line translation to the port's taxonomy.
 *
 * A bad file is `invalid_input`: retrying the identical bytes cannot help, the
 * orchestrator must not back off and try again at 03:15, and the user is the
 * only one who can fix it. Keeping a local error type means the parsers stay
 * pure string-in/structure-out functions that a golden test can call directly,
 * and only the connector boundary knows what a `ConnectorError` is.
 */
import { ConnectorError } from '@connector/port';

export class ImportError extends Error {
  override readonly name = 'ImportError';
  /** 1-based, when the failure is attributable to one row. */
  readonly line: number | null;

  constructor(message: string, line: number | null = null) {
    super(message);
    this.line = line;
  }

  at(line: number): ImportError {
    return new ImportError(this.message, line);
  }
}

/**
 * Wrap for the orchestrator.
 *
 * `redactedContext` carries the line number and nothing else. The failing *row*
 * is deliberately absent: it is the user's financial data, it ends up in
 * `sync_runs.last_error`, and that column is rendered in a UI and copied into
 * bug reports.
 */
export function asInvalidInput(error: unknown, file: string): ConnectorError {
  const line = error instanceof ImportError ? error.line : null;
  const message = error instanceof Error ? error.message : String(error);
  // `CONFIG_ERROR` rather than `MALFORMED_RESPONSE`: both describe "the bytes
  // were wrong", but only the former maps to `invalid_input`, and a file the user
  // chose is their input, not a provider breaking its contract.
  return ConnectorError.fromCondition('CONFIG_ERROR', `${file}: ${message}`, {
    redactedContext: { file, line },
    cause: error,
  });
}
