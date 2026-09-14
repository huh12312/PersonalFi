// SPDX-License-Identifier: MIT
/**
 * The OFX tokenizer's *repair* behaviours, which is where its risk lives.
 *
 * `src/ofx.ts` reads OFX 1.x (SGML, no end tags on leaves) and OFX 2.x (XML,
 * every end tag present) with one code path, by treating "an element that
 * already has text is closed by the next tag" as the grammar. Every rule below
 * exists because some institution's export needed it, and every one of them
 * fails *silently* when it is wrong: a mis-scoped element does not throw, it
 * reparents the rest of the statement and the import lands the wrong amounts
 * under the wrong account. So they are pinned here against hand-written
 * fixtures rather than left to the happy-path file in `parsers.test.ts`.
 *
 * Two shapes of test, on purpose:
 *
 *   * **Documents** live in `fixtures/`, and the multi-account one is pinned
 *     byte-for-byte against `ofx-multi-account.expected.json` — checked in, read
 *     with `node:fs`, compared with `toEqual`. A fixture whose parse silently
 *     drifts is exactly what that file exists to catch.
 *   * **Malformed fragments** are literals here. `MINIMAL_SGML` below is the
 *     smallest document `readOfxStatements` accepts, and each failure case is
 *     that document minus one line: four near-identical fixture files would hide
 *     the single deleted line that is the whole point of the test.
 *
 * No fixture contains a real institution, a real account number or a real
 * balance. "Northwind Mutual" does not exist — see `../NOTICE`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConnectorError } from '@connector/port';
import { describe, expect, it } from 'vitest';
import { ImportError, asInvalidInput } from '../src/errors.ts';
import { importFile } from '../src/import.ts';
import { child, descendants, parseOfx, readOfxStatements, text } from '../src/ofx.ts';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

/** Return what `run` threw, or fail here rather than three frames later. */
function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the malformed document should have thrown');
}

/**
 * Assert the package's own `ImportError` **and** the `ConnectorError` it becomes.
 *
 * `toThrow(ImportError)` alone would pass for an error the orchestrator then
 * retried at 03:15 forever: `kind` is what `retryPolicyFor` branches on, so the
 * mapping is the part that has to hold. A bad file is `invalid_input` /
 * `CONFIG_ERROR` — not retryable, user action required — for every path below.
 */
function expectImportFailure(run: () => unknown, message: RegExp): ImportError {
  const error = failureOf(run);
  expect(error).toBeInstanceOf(ImportError);
  expect((error as ImportError).message).toMatch(message);

  const mapped = asInvalidInput(error, 'statement.ofx');
  expect(mapped).toBeInstanceOf(ConnectorError);
  expect(mapped.kind).toBe('invalid_input');
  expect(mapped.condition).toBe('CONFIG_ERROR');
  expect(mapped.policy()).toMatchObject({ retryable: false, userActionRequired: true });
  return error as ImportError;
}

/** The smallest OFX 1.x document `readOfxStatements` accepts. See the header. */
const MINIMAL_SGML = [
  '<OFX>',
  '<BANKMSGSRSV1>',
  '<STMTTRNRS>',
  '<STMTRS>',
  '<CURDEF>USD',
  '<BANKACCTFROM>',
  '<ACCTID>000999004444',
  '<ACCTTYPE>CHECKING',
  '</BANKACCTFROM>',
  '<BANKTRANLIST>',
  '<STMTTRN>',
  '<TRNTYPE>DEBIT',
  '<DTPOSTED>20260520120000',
  '<TRNAMT>-9.99',
  '<FITID>nw-min-0001',
  '<NAME>HARBOUR HARDWARE',
  '</STMTTRN>',
  '</BANKTRANLIST>',
  '</STMTRS>',
  '</STMTTRNRS>',
  '</BANKMSGSRSV1>',
  '</OFX>',
].join('\n');

/** `MINIMAL_SGML` with the one line that opens `tag` deleted. */
function without(tag: string): string {
  return MINIMAL_SGML.split('\n')
    .filter((line) => !line.startsWith(`<${tag}>`))
    .join('\n');
}

describe('OFX tokenizer repair', () => {
  it('ignores a close tag that matches nothing on the stack', () => {
    // `</NOTATAG>` in the fixture closes an element that was never opened.
    // Popping the whole stack for it — the obvious implementation — would
    // reparent every remaining element of the file under the document root, and
    // the statement would parse to *something* rather than to nothing, which is
    // the failure mode `popTo`'s `at <= 0` guard exists to prevent.
    const document = parseOfx(fixture('ofx-quirks.ofx'));
    const [transaction] = descendants(document, 'STMTTRN');

    expect(transaction).toBeDefined();
    // MEMO is still inside the STMTTRN, not a sibling of OFX.
    expect(text(transaction ?? null, 'MEMO')).toMatch(/^Nails/);
    expect(descendants(document, 'STMTTRN')).toHaveLength(1);
  });

  it('concatenates text that a stray tag interrupted, rather than losing half of it', () => {
    // `<NAME>HARBOUR HARDWARE</NOTATAG> STORE 14` — the close tag pops nothing,
    // so NAME is still the open element when " STORE 14" arrives. Overwriting
    // would silently truncate the payee to the part before the stray tag.
    const statements = readOfxStatements(parseOfx(fixture('ofx-quirks.ofx')));
    expect(statements[0]?.transactions[0]?.name).toBe('HARBOUR HARDWARE STORE 14');
  });

  it('does not push a self-closing tag, so the next element is its sibling', () => {
    // `<CHECKNUM/>` is how OFX 2.x writes an empty element. If it were pushed,
    // NAME and MEMO would become its *children* and `text(entry, 'NAME')` would
    // return null — the transaction would import with an empty payee and no
    // error anywhere.
    const [transaction] = descendants(parseOfx(fixture('ofx-quirks.ofx')), 'STMTTRN');
    expect(transaction).toBeDefined();
    expect(child(transaction!, 'CHECKNUM')?.value).toBeNull();
    expect(child(transaction!, 'NAME')).not.toBeNull();
    expect(child(transaction!, 'MEMO')).not.toBeNull();
    expect(
      readOfxStatements(parseOfx(fixture('ofx-quirks.ofx')))[0]?.transactions[0],
    ).toMatchObject({ checkNumber: null, fitId: 'nw-qk-0001' });
  });

  it('skips comments and declarations without reading their text as element content', () => {
    // The fixture opens with an SGML comment before `<OFX>`. `<!`/`<?` are not
    // elements, and treating one as a tag would give the document a child named
    // `!--` and then fail `root.children.length === 0` in the wrong direction.
    const document = parseOfx(fixture('ofx-quirks.ofx'));
    expect(document.children.map((node) => node.name)).toEqual(['OFX']);
  });

  it('decodes numeric, hexadecimal and named entities and leaves unknown ones alone', () => {
    // `&#38;` → &, `&#x2014;` → em dash, `&hellip;` → not in the table, so it
    // survives verbatim. Dropping an unrecognised entity would quietly edit the
    // user's memo; expanding it to the wrong character would be worse.
    const statements = readOfxStatements(parseOfx(fixture('ofx-quirks.ofx')));
    expect(statements[0]?.transactions[0]?.memo).toBe('Nails & a hinge — sale ends&hellip;');
  });
});

describe('OFX multi-account statements', () => {
  it('reads every STMTRS and CCSTMTRS in one file, in that order', () => {
    // A bank export of three accounts is one file with three statements (08
    // §2.6), which is why the importer maps to accounts rather than asking the
    // user which account the file belongs to. Pinned against the checked-in
    // expectation so a change to the tokenizer cannot quietly drop a statement.
    const statements = readOfxStatements(parseOfx(fixture('ofx-multi-account.ofx')));
    const expected: unknown = JSON.parse(fixture('ofx-multi-account.expected.json'));
    expect(statements).toEqual(expected);
  });

  it('maps all three statements to accounts, transactions and balances', () => {
    const result = importFile({
      name: 'ofx-multi-account.ofx',
      content: fixture('ofx-multi-account.ofx'),
    });

    expect(result.accounts.map((account) => account.providerAccountId)).toEqual([
      '000999001111',
      '000999002222',
      '400000XXXXXX7788',
    ]);
    expect(result.accounts.map((account) => account.type)).toEqual([
      'depository',
      'depository',
      'credit',
    ]);
    // The credit-card statement carries no LEDGERBAL, so it claims no balance.
    expect(result.balances.map((balance) => balance.providerAccountId)).toEqual([
      '000999001111',
      '000999002222',
    ]);
    expect(result.transactions).toHaveLength(4);
    // Every row keeps the account it was printed under. A statement whose rows
    // landed on the neighbouring account is the bug this file mainly guards.
    expect(result.transactions.map((t) => t.providerAccountId)).toEqual([
      '000999001111',
      '000999001111',
      '000999002222',
      '400000XXXXXX7788',
    ]);
  });

  it('falls back from NAME to PAYEE/NAME, and then to MEMO', () => {
    // Some institutions put the payee in NAME; others leave NAME out entirely
    // and use the structured `<PAYEE>` aggregate. A transaction with neither
    // still has a memo more often than not, and an empty `name` would import as
    // a nameless row that no merchant rule can ever match.
    const statements = readOfxStatements(parseOfx(fixture('ofx-multi-account.ofx')));
    expect(statements[0]?.transactions[0]?.name).toBe('ROOFLINE & GUTTER CO');
    expect(statements[0]?.transactions[1]?.name).toBe('PAYROLL NORTHWIND MUTUAL');
    expect(statements[2]?.transactions[0]?.name).toBe('HARBOURSIDE NEWS — MAGAZINE');
  });

  it('keeps CHECKNUM when the institution prints one', () => {
    // A cheque number is the only identifier a paper cheque has; it goes into
    // `raw` so a user searching for "cheque 1042" can find the row.
    const statements = readOfxStatements(parseOfx(fixture('ofx-multi-account.ofx')));
    expect(statements[0]?.transactions[0]?.checkNumber).toBe('1042');
    expect(statements[0]?.transactions[1]?.checkNumber).toBeNull();

    const result = importFile({
      name: 'ofx-multi-account.ofx',
      content: fixture('ofx-multi-account.ofx'),
    });
    expect(result.transactions[0]?.raw).toMatchObject({ checkNumber: '1042' });
  });
});

describe('OFX malformed documents', () => {
  it('refuses a tag that is never closed', () => {
    expectImportFailure(() => parseOfx('<OFX>\n<STMTRS'), /tag is never closed/);
  });

  it('refuses a tag with no name', () => {
    expectImportFailure(() => parseOfx('<OFX>\n<>\n</OFX>'), /tag has no name/);
  });

  it('refuses a document that has declarations but no elements', () => {
    // `<?xml?>`/`<?OFX?>` are skipped, so a file of nothing but declarations
    // parses to an empty tree. Returning that tree would make
    // `readOfxStatements` report "no statement" for a file that is not OFX at
    // all, which sends the user looking in the wrong place.
    expectImportFailure(
      () => parseOfx('<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200"?>'),
      /no elements/,
    );
  });

  it('refuses a document with no tags at all', () => {
    expectImportFailure(() => parseOfx('Datum;Verwendungszweck;Betrag'), /no tags found/);
  });

  it('refuses a statement with no ACCTID, because there is no account to import into', () => {
    expectImportFailure(
      () => readOfxStatements(parseOfx(without('ACCTID'))),
      /STMTRS has no ACCTID/,
    );
  });

  it('refuses a transaction with no FITID', () => {
    // FITID is the id the ledger's natural-key upsert uses for an OFX row.
    // Without it the row would need a content hash, and mixing the two id
    // schemes inside one account is how a re-import duplicates history.
    expectImportFailure(
      () => readOfxStatements(parseOfx(without('FITID'))),
      /STMTTRN has no FITID/,
    );
  });

  it('refuses a transaction with no DTPOSTED, naming the row', () => {
    expectImportFailure(
      () => readOfxStatements(parseOfx(without('DTPOSTED'))),
      /nw-min-0001 has no DTPOSTED/,
    );
  });

  it('refuses a transaction with no TRNAMT, naming the row', () => {
    expectImportFailure(
      () => readOfxStatements(parseOfx(without('TRNAMT'))),
      /nw-min-0001 has no TRNAMT/,
    );
  });

  it('refuses a malformed date rather than inventing one', () => {
    const broken = MINIMAL_SGML.replace('20260520120000', '2026052');
    expectImportFailure(() => readOfxStatements(parseOfx(broken)), /is malformed/);
  });

  it('reports the same failures through importFile, as a ConnectorError', () => {
    // The connector boundary is where an `ImportError` becomes something the
    // orchestrator can act on. Asserted end to end so the mapping cannot be
    // correct in `errors.ts` and unreached in `connector.ts`.
    const error = failureOf(() => importFile({ name: 'bad.ofx', content: without('ACCTID') }));
    expect(error).toBeInstanceOf(ImportError);
    const mapped = asInvalidInput(error, 'bad.ofx');
    expect(mapped.message).toMatch(/^bad\.ofx: /);
    expect(mapped.redactedContext).toEqual({ file: 'bad.ofx', line: null });
  });
});
