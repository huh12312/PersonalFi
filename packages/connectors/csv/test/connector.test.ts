// SPDX-License-Identifier: MIT
/**
 * `CsvImportConnector` itself: re-import, paging, and the four typed errors.
 *
 * `parsers.test.ts` proves that parsing the same bytes twice yields the same
 * ids. That is a necessary condition for idempotent re-import and not a
 * sufficient one — the staging layer sits between the parser and the page
 * stream, and it is `addFile`'s `seen` set, not the parser, that decides whether
 * the user's June download re-stages May. So the claim in `CSV_MANIFEST` —
 * "re-importing the same file changes nothing" — is checked here, at the level
 * the user actually experiences it.
 *
 * The overlapping-file case is the one that matters in practice and the one the
 * doc comment on `addFile` describes: nobody downloads exactly the rows they are
 * missing. They download "this year to date" every month.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConnectorError, cursorOf, type ConnectionHandle, type SyncOptions } from '@connector/port';
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { CsvImportConnector } from '../src/connector.ts';
import { IMPORT_PROVIDER, importFile, type TargetAccount } from '../src/import.ts';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

const CHECKING: TargetAccount = {
  providerAccountId: 'acct-checking',
  name: 'Everyday Checking',
  type: 'depository',
  currency: 'USD',
};

/**
 * A handle with no credential, which is the whole of a file import's identity.
 *
 * `secret()` returns null for every name: there is nothing to seal, nothing to
 * leak and nothing to rotate, which is also why `reconnectFlow` is `reupload`.
 */
function handleFor(providerConnectionId: string): ConnectionHandle {
  return {
    connectionId: 'conn-file-0001',
    userId: 'user-0001',
    provider: IMPORT_PROVIDER,
    providerConnectionId,
    secret: () => null,
  };
}

/** `syncTransactions` ignores every field of this, but the port requires one. */
const SYNC: SyncOptions = {
  reason: 'manual',
  historyDays: 730,
  pageSize: 500,
  deadline: new Date('2026-06-01T12:00:30.000Z'),
  signal: new AbortController().signal,
  clock: fixedClock('2026-06-01T12:00:00.000Z'),
};

const HEADER = 'Date,Description,Amount';
const JANUARY = [
  '2026-01-05,HARBOUR HARDWARE 14,-31.50',
  '2026-01-09,PAYROLL NORTHWIND MUTUAL,2100.00',
  // Two identical purchases on one day are a real and common event, and
  // `occurrence` is what keeps them distinct without breaking re-import.
  '2026-01-19,SQ *BLUE BOTTLE 4471,-12.34',
  '2026-01-19,SQ *BLUE BOTTLE 4471,-12.34',
];
const FEBRUARY = [
  '2026-02-03,PORTSIDE WATER CO,-64.20',
  '2026-02-09,PAYROLL NORTHWIND MUTUAL,2100.00',
];

/** The user's download: a header and whichever months they asked the bank for. */
function statement(...months: readonly (readonly string[])[]): string {
  return [HEADER, ...months.flat(), ''].join('\n');
}

function csvFile(name: string, content: string): Parameters<CsvImportConnector['addFile']>[1] {
  return { name, content, profile: 'iso_signed', account: CHECKING };
}

async function stagedIds(
  connector: CsvImportConnector,
  providerConnectionId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor = null as Parameters<CsvImportConnector['syncTransactions']>[1];
  for (;;) {
    const page = await connector.syncTransactions(handleFor(providerConnectionId), cursor, SYNC);
    ids.push(...page.added.map((transaction) => transaction.providerTransactionId));
    if (!page.hasMore) return ids;
    cursor = page.nextCursor;
  }
}

function failureOf(run: () => unknown): ConnectorError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }
  return expect.unreachable('the call should have raised a ConnectorError');
}

async function asyncFailureOf(run: () => Promise<unknown>): Promise<ConnectorError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }
  return expect.unreachable('the call should have raised a ConnectorError');
}

describe('re-importing the same file', () => {
  it('stages nothing the second time and skips every row', async () => {
    const connector = new CsvImportConnector();
    const content = statement(JANUARY);
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', content)],
    });

    // The same bytes, uploaded again — the user forgot they had already done it.
    expect(connector.addFile(providerConnectionId, csvFile('january.csv', content))).toEqual({
      staged: 0,
      skipped: JANUARY.length,
    });
    // And again under a different file name, because the name is provenance and
    // never identity: `importFile`'s ids are hashes of the row's own content.
    expect(connector.addFile(providerConnectionId, csvFile('january (1).csv', content))).toEqual({
      staged: 0,
      skipped: JANUARY.length,
    });

    expect(await stagedIds(connector, providerConnectionId)).toHaveLength(JANUARY.length);
  });

  it('stages only the new month when the second file overlaps the first', async () => {
    // The case `addFile`'s doc comment describes, and the one that actually
    // happens: the user's monthly download is "year to date", not "since last
    // time". Only February is new.
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });
    const before = await stagedIds(connector, providerConnectionId);

    const result = connector.addFile(
      providerConnectionId,
      csvFile('january-february.csv', statement(JANUARY, FEBRUARY)),
    );
    expect(result).toEqual({ staged: FEBRUARY.length, skipped: JANUARY.length });

    const after = await stagedIds(connector, providerConnectionId);
    expect(after).toHaveLength(JANUARY.length + FEBRUARY.length);
    // Append-only, and January's ids are the same objects in the same order —
    // the cursor is an index into this array, so restaging would have shifted
    // every page boundary the orchestrator had already committed.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
  });

  it('keeps both of two identical rows in one file, and still skips both on re-import', async () => {
    // January has the same coffee twice on the same day. Both must stage — they
    // are two real purchases, and `ledger_dedup_keys` deliberately ignores
    // same-provider fingerprint collisions for exactly this reason — and neither
    // must stage a second time. `occurrence` is what makes both true at once.
    const connector = new CsvImportConnector();
    const content = statement(JANUARY);
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', content)],
    });

    const ids = await stagedIds(connector, providerConnectionId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    expect(connector.addFile(providerConnectionId, csvFile('january.csv', content))).toEqual({
      staged: 0,
      skipped: 4,
    });
    expect(await stagedIds(connector, providerConnectionId)).toEqual(ids);
  });

  it('is stable for OFX, where the ids are the file’s own FITIDs', async () => {
    const connector = new CsvImportConnector();
    const content = fixture('ofx-multi-account.ofx');
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [{ name: 'may.ofx', content }],
    });

    expect(connector.addFile(providerConnectionId, { name: 'may.ofx', content })).toEqual({
      staged: 0,
      skipped: 4,
    });
    // The parser's own guarantee, which the staging layer above depends on.
    const parse = (): string[] =>
      importFile({ name: 'may.ofx', content }).transactions.map((t) => t.providerTransactionId);
    expect(parse()).toEqual(parse());
    expect(await stagedIds(connector, providerConnectionId)).toEqual(parse());
  });

  it('is stable for QIF, where nothing in the file identifies a row', async () => {
    // QIF carries no transaction id at all, so the id is a content hash. This is
    // the format where a re-import would duplicate history if the hash were not
    // stable — a `Date.now()` or a row index in the input would both break it.
    const connector = new CsvImportConnector();
    const file = { name: 'quicken.qif', content: fixture('sample.qif'), account: CHECKING };
    const { providerConnectionId } = await connector.connect({
      displayName: 'Quicken export',
      files: [file],
    });

    expect(connector.addFile(providerConnectionId, file)).toEqual({ staged: 0, skipped: 4 });
    const parse = (): string[] =>
      importFile(file).transactions.map((transaction) => transaction.providerTransactionId);
    expect(parse()).toEqual(parse());
    expect(await stagedIds(connector, providerConnectionId)).toEqual(parse());
  });

  it('does not restage rows already returned to the orchestrator, across pages', async () => {
    // A small page size so the re-import lands in the middle of the stream
    // rather than at a boundary the test chose.
    const connector = new CsvImportConnector({ pageSize: 3 });
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    const handle = handleFor(providerConnectionId);
    const first = await connector.syncTransactions(handle, null, SYNC);
    expect(first.added).toHaveLength(3);
    expect(first.hasMore).toBe(true);

    connector.addFile(providerConnectionId, csvFile('january.csv', statement(JANUARY)));

    // The cursor the orchestrator is holding still means row 3, because nothing
    // was inserted behind it.
    const second = await connector.syncTransactions(handle, first.nextCursor, SYNC);
    expect(second.added).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.modified).toEqual([]);
    expect(second.removed).toEqual([]);
  });
});

describe('connect', () => {
  it('refuses input that is not an object', async () => {
    const connector = new CsvImportConnector();
    for (const input of [null, undefined, 'january.csv', 42]) {
      const error = await asyncFailureOf(() => connector.connect(input));
      expect(error.kind).toBe('invalid_input');
      expect(error.condition).toBe('CONFIG_ERROR');
    }
  });

  it('refuses a connection with no display name and one with no files', async () => {
    const connector = new CsvImportConnector();
    const files = [csvFile('january.csv', statement(JANUARY))];

    expect((await asyncFailureOf(() => connector.connect({ files }))).condition).toBe(
      'CONFIG_ERROR',
    );
    expect(
      (await asyncFailureOf(() => connector.connect({ displayName: 'Northwind', files: [] })))
        .condition,
    ).toBe('CONFIG_ERROR');
    // An empty upload is a user mistake, not a provider outage: not retryable.
    const error = await asyncFailureOf(() =>
      connector.connect({ displayName: 'Northwind', files: [] }),
    );
    expect(error.policy()).toMatchObject({ retryable: false, userActionRequired: true });
  });

  it('holds no credential and generates its own id when the caller gives none', async () => {
    const connector = new CsvImportConnector();
    const result = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    expect(result.credentials).toEqual({});
    expect(result.consentExpiresAt).toBeNull();
    expect(result.providerConnectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.accounts.map((account) => account.providerAccountId)).toEqual([
      CHECKING.providerAccountId,
    ]);
  });

  it('honours a providerConnectionId the caller supplied', async () => {
    const connector = new CsvImportConnector();
    const result = await connector.connect({
      displayName: 'Northwind Mutual',
      providerConnectionId: 'upload-2026-06-01',
      files: [csvFile('january.csv', statement(JANUARY))],
    });
    expect(result.providerConnectionId).toBe('upload-2026-06-01');
  });
});

describe('resolveProfile', () => {
  it('refuses a preset id that names nothing', async () => {
    const connector = new CsvImportConnector();
    const error = await asyncFailureOf(() =>
      connector.connect({
        displayName: 'Northwind Mutual',
        files: [
          {
            name: 'january.csv',
            content: statement(JANUARY),
            profile: 'us_sgined',
            account: CHECKING,
          },
        ],
      }),
    );
    expect(error.kind).toBe('invalid_input');
    expect(error.condition).toBe('CONFIG_ERROR');
    expect(error.message).toMatch(/no import preset named "us_sgined"/);
  });

  it('refuses a profile object that is not a valid profile', async () => {
    // The stored-profile path (see `config.ts`): a `CsvProfile` handed to the
    // connector is user data that came back out of JSONB, whatever the type
    // annotation on the call site claims.
    const connector = new CsvImportConnector();
    const error = await asyncFailureOf(() =>
      connector.connect({
        displayName: 'Northwind Mutual',
        files: [
          {
            name: 'january.csv',
            content: statement(JANUARY),
            profile: { id: 'broken', label: 'Broken' } as never,
            account: CHECKING,
          },
        ],
      }),
    );
    expect(error.condition).toBe('CONFIG_ERROR');
    expect(error.message).toMatch(/not valid/);
  });

  it('wraps a parse failure with the file name and the spreadsheet line', async () => {
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    const error = failureOf(() =>
      connector.addFile(
        providerConnectionId,
        csvFile(
          'february.csv',
          [HEADER, '2026-02-03,OK,-1.00', '2026-02-04,BAD,nope', ''].join('\n'),
        ),
      ),
    );
    expect(error.condition).toBe('CONFIG_ERROR');
    // The failing row itself is deliberately absent: it is the user's financial
    // data and this context is written into `sync_runs.last_error`.
    expect(error.redactedContext).toEqual({ file: 'february.csv', line: 3 });
    expect(JSON.stringify(error.redactedContext)).not.toContain('BAD');
  });
});

describe('the cursor', () => {
  it('refuses a cursor past the end of the staged rows', async () => {
    // The staged rows live in memory. A cursor beyond them means the process
    // restarted, and a full re-pull is both the honest recovery and a safe one,
    // because every id is a content hash — hence `from_null`, not `resume`.
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    const error = await asyncFailureOf(() =>
      connector.syncTransactions(handleFor(providerConnectionId), cursorOf('900'), SYNC),
    );
    expect(error.condition).toBe('CURSOR_EXPIRED');
    expect(error.kind).toBe('transient');
    expect(error.policy()).toMatchObject({ retryable: true, restart: 'from_null' });
  });

  it('refuses a cursor that is not a whole non-negative number', async () => {
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    for (const value of ['-1', '1.5', 'page-two', 'NaN']) {
      const error = await asyncFailureOf(() =>
        connector.syncTransactions(handleFor(providerConnectionId), cursorOf(value), SYNC),
      );
      expect(error.condition).toBe('CURSOR_EXPIRED');
    }
  });

  it('reads a blank cursor as the start of the stream, not as a failure', async () => {
    // Recorded because it is surprising, not because it was designed: `Number('')`
    // is 0, so a blank cursor replays from the beginning instead of raising
    // `CURSOR_EXPIRED`. Harmless here — a full re-pull is the documented
    // recovery and every id is a content hash, so the replay upserts to nothing
    // — but it is behaviour, and a future `parseCursor` that rejected a blank
    // string would be a change this test would notice.
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    const page = await connector.syncTransactions(
      handleFor(providerConnectionId),
      cursorOf(''),
      SYNC,
    );
    expect(page.added).toHaveLength(JANUARY.length);
  });

  it('accepts a cursor exactly at the end and returns an empty final page', async () => {
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    const page = await connector.syncTransactions(
      handleFor(providerConnectionId),
      cursorOf(String(JANUARY.length)),
      SYNC,
    );
    expect(page.added).toEqual([]);
    expect(page.hasMore).toBe(false);
    // Accounts only on the first page of a run; this one resumed from a cursor.
    expect(page.accounts).toEqual([]);
  });
});

describe('disconnect', () => {
  it('drops the staged rows, and every later call says so', async () => {
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });
    const handle = handleFor(providerConnectionId);
    expect(await connector.listAccounts(handle)).toHaveLength(1);

    await connector.disconnect(handle);

    // `AUTH_REQUIRED` and not an empty list: an empty list would look like a
    // connection with nothing in it, and the orchestrator would record a
    // successful sync that imported zero rows.
    const error = await asyncFailureOf(() => connector.listAccounts(handle));
    expect(error.condition).toBe('AUTH_REQUIRED');
    expect(error.kind).toBe('auth_required');
    expect(error.policy()).toMatchObject({ retryable: false, userActionRequired: true });
    expect(error.message).toMatch(/upload the file again/);
  });

  it('is idempotent: disconnecting twice is not an error', async () => {
    const connector = new CsvImportConnector();
    const { providerConnectionId } = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });
    const handle = handleFor(providerConnectionId);

    await expect(connector.disconnect(handle)).resolves.toBeUndefined();
    await expect(connector.disconnect(handle)).resolves.toBeUndefined();
  });

  it('raises AUTH_REQUIRED for a connection that was never opened', async () => {
    const connector = new CsvImportConnector();
    const handle = handleFor('upload-that-never-happened');

    for (const call of [
      () => connector.listAccounts(handle),
      () => connector.syncTransactions(handle, null, SYNC),
      () => connector.syncBalances(handle, SYNC),
      () => Promise.resolve(connector.addFile(handle.providerConnectionId, csvFile('x.csv', ''))),
    ]) {
      const error = await asyncFailureOf(call);
      expect(error.condition).toBe('AUTH_REQUIRED');
      // The id is debugging context, not a credential.
      expect(error.redactedContext).toEqual({
        providerConnectionId: 'upload-that-never-happened',
      });
    }
  });
});

describe('balances', () => {
  it('reports OFX ledger balances and stays silent for CSV', async () => {
    const connector = new CsvImportConnector();
    const ofx = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [{ name: 'may.ofx', content: fixture('ofx-multi-account.ofx') }],
    });
    const csv = await connector.connect({
      displayName: 'Northwind Mutual',
      files: [csvFile('january.csv', statement(JANUARY))],
    });

    expect(
      (await connector.syncBalances(handleFor(ofx.providerConnectionId), SYNC)).map(
        (balance) => balance.providerAccountId,
      ),
    ).toEqual(['000999001111', '000999002222']);
    // Empty because the file genuinely stated no balance, not because we failed.
    expect(await connector.syncBalances(handleFor(csv.providerConnectionId), SYNC)).toEqual([]);
  });
});
