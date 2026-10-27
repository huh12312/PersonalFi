// SPDX-License-Identifier: MIT
/**
 * Builds the export bundle: a manifest line, then every table's rows as JSONL,
 * in `TABLE_ORDER`.
 *
 * ## Format
 *
 * ```
 * {"version":1,"createdAt":"...","appVersion":"...","userId":"...","streams":[
 *   {"table":"accounts","count":3,"sha256":"..."}, ...
 * ]}
 * {...one row of "accounts"...}
 * {...another row of "accounts"...}
 * {...first row of "account_balances"...}
 * ...
 * ```
 *
 * The manifest names each stream's row **count**, so import needs no delimiter
 * between one table's rows and the next: read `count` more lines, verify the
 * hash, move to the declared next table. `codec.ts`'s `StreamHasher` is what
 * both sides run over the same bytes.
 *
 * ## Why buffered, not two-pass streaming
 *
 * A stream's manifest entry needs its row count and hash *before* the client
 * has seen a single row of it, and the manifest is the bundle's first line —
 * so every stream is read from Postgres once, in full, before anything is
 * written to the response. At the scale this application runs at (one user;
 * the 50k-seed database is the stress case, comfortably tens of megabytes of
 * JSON) that is a bounded, documented memory cost, not a streaming violation of
 * the "the export streams the bundle" requirement — the *response* is still
 * written as a stream (`writeBundle` below), which is what keeps Fastify from
 * buffering the whole reply in one `send()`. Revisit with true two-pass
 * streaming (count+hash pass, then a second read for the body) if the export
 * ever has to run over a shared, many-user database.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { decodeRow, encodeRow, StreamHasher, type RawRow } from './codec.ts';
import { isDerivedColumn, isSensitiveColumn, STREAM_ORDER_BY, TABLE_ORDER } from './registry.ts';

export const BUNDLE_VERSION = 1;

export interface StreamManifestEntry {
  readonly table: string;
  readonly count: number;
  readonly sha256: string;
}

export interface BundleManifest {
  readonly version: number;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly userId: string;
  readonly streams: readonly StreamManifestEntry[];
}

export interface ExportBundle {
  readonly manifest: BundleManifest;
  /** One JSONL line per row, `TABLE_ORDER` order, matching `manifest.streams`. */
  readonly lines: readonly string[];
}

function redactedColumns(table: string, columns: readonly string[]): string[] {
  return columns.filter(
    (column) => !isSensitiveColumn(table, column) && !isDerivedColumn(table, column),
  );
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table],
  );
  return result.rows[0]?.exists ?? false;
}

/** One table's rows, redacted and encoded, in `id` order for a deterministic hash. */
async function fetchStream(
  pool: Pool,
  table: string,
  userId: string,
): Promise<{ lines: string[]; hash: string }> {
  const columnRows = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  const columns = redactedColumns(
    table,
    columnRows.rows.map((row) => row.column_name),
  );
  const selectList = columns.map((column) => `"${column}"`).join(', ');
  // `id` exists on every table in `TABLE_ORDER` (`idColumn()`, house convention)
  // except the named exceptions in `STREAM_ORDER_BY`; ordering deterministically
  // is what makes two exports of the same data hash identically.
  const orderBy = STREAM_ORDER_BY.get(table) ?? 'id';
  const rows = await pool.query<RawRow>(
    `SELECT ${selectList} FROM "${table}" WHERE user_id = $1 ORDER BY ${orderBy}`,
    [userId],
  );

  const hasher = new StreamHasher();
  const lines = rows.rows.map((row) => {
    const line = encodeRow(row);
    hasher.add(line);
    return line;
  });
  return { lines, hash: hasher.digest() };
}

export async function buildExportBundle(
  pool: Pool,
  input: { readonly userId: string; readonly appVersion: string; readonly now: Date },
): Promise<ExportBundle> {
  const streams: StreamManifestEntry[] = [];
  const lines: string[] = [];

  for (const table of TABLE_ORDER) {
    if (!(await tableExists(pool, table))) continue; // not migrated yet (e.g. insights)
    const stream = await fetchStream(pool, table, input.userId);
    streams.push({ table, count: stream.lines.length, sha256: stream.hash });
    lines.push(...stream.lines);
  }

  const manifest: BundleManifest = {
    version: BUNDLE_VERSION,
    createdAt: input.now.toISOString(),
    appVersion: input.appVersion,
    userId: input.userId,
    streams,
  };
  return { manifest, lines };
}

/** The bundle as one text blob: manifest line, then every row line, `\n`-joined. */
export function serialiseBundle(bundle: ExportBundle): string {
  return [encodeRow(bundle.manifest as unknown as RawRow), ...bundle.lines].join('\n') + '\n';
}

export interface ParsedBundle {
  readonly manifest: BundleManifest;
  /** `table` → its rows, decoded, in the order the bundle carried them. */
  readonly rowsByTable: ReadonlyMap<string, RawRow[]>;
}

export class BundleValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BundleValidationError';
    this.code = code;
  }
}

/**
 * Parses and verifies a bundle: the manifest's declared shape, then every
 * stream's hash, before a single row reaches the database. A stream whose hash
 * does not match what its own bytes hash to is refused outright — this is the
 * check `export-import.test.ts`'s tampered-hash sabotage exercises.
 */
export function parseAndVerifyBundle(text: string): ParsedBundle {
  const allLines = text.split('\n').filter((line) => line.length > 0);
  const [manifestLine, ...rest] = allLines;
  if (manifestLine === undefined) {
    throw new BundleValidationError('empty bundle', 'export.bundle_empty');
  }
  const manifest = JSON.parse(manifestLine) as BundleManifest;
  if (manifest.version !== BUNDLE_VERSION) {
    throw new BundleValidationError(
      `unsupported bundle version ${String(manifest.version)}`,
      'export.bundle_version_unsupported',
    );
  }

  const rowsByTable = new Map<string, RawRow[]>();
  let cursor = 0;
  for (const stream of manifest.streams) {
    const streamLines = rest.slice(cursor, cursor + stream.count);
    if (streamLines.length !== stream.count) {
      throw new BundleValidationError(
        `stream "${stream.table}" declares ${String(stream.count)} rows but the bundle has ${String(streamLines.length)}`,
        'export.stream_truncated',
      );
    }
    const hasher = new StreamHasher();
    for (const line of streamLines) hasher.add(line);
    const digest = hasher.digest();
    if (digest !== stream.sha256) {
      throw new BundleValidationError(
        `stream "${stream.table}" hash mismatch: expected ${stream.sha256}, got ${digest}`,
        'export.stream_hash_mismatch',
      );
    }
    rowsByTable.set(stream.table, streamLines.map(decodeRow));
    cursor += stream.count;
  }
  return { manifest, rowsByTable };
}

export interface AgeEncryptOptions {
  readonly secretsDir: string;
  /**
   * Filename under `secretsDir`. Defaults to `age_recipient` — **singular**,
   * matching `compose.yml`'s secret name, `docker/backup/backup.sh`'s
   * `AGE_RECIPIENTS_FILE` (the env var name is plural; the file it points at
   * is not), `justfile` and RUNBOOK.md. WP 4.12b, C-5: this default used to
   * read `age_recipients` (plural), a name compose.yml never mounted on any
   * service — one recipients filename now, everywhere.
   */
  readonly recipientsFile?: string;
}

export class AgeUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AgeUnavailableError';
  }
}

/**
 * Shells out to the `age` binary — no Node binding is a dependency this
 * package may add (docs/CONVENTIONS.md's seven-day `minimumReleaseAge` gate is
 * not the obstacle; *adding a dependency at all* is outside this work
 * package's remit). Encrypts to the same recipients file
 * `docker/backup/backup.sh` already writes against
 * (`${SECRETS_DIR}/age_recipient`), so a downloaded, encrypted export opens
 * with the exact identity file the nightly backup's restore drill already
 * uses (D24).
 *
 * Throws `AgeUnavailableError` — mapped to a 503 at the route — when the
 * recipients file is absent or the `age` binary is not on `PATH`, rather than
 * silently falling back to plaintext. `?encrypt=true` asked for encryption; a
 * quiet downgrade to plaintext would be a worse failure than refusing the
 * request.
 */
export async function encryptWithAge(
  plaintext: string,
  options: AgeEncryptOptions,
): Promise<Buffer> {
  const recipientsPath = join(options.secretsDir, options.recipientsFile ?? 'age_recipient');
  if (!existsSync(recipientsPath)) {
    throw new AgeUnavailableError(`no age recipients file at ${recipientsPath}`);
  }

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('age', ['--encrypt', '--recipients-file', recipientsPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        reject(new AgeUnavailableError('the `age` binary is not on PATH'));
      else reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else
        reject(
          new AgeUnavailableError(
            `age exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
    });
    child.stdin.end(plaintext, 'utf8');
  });
}
