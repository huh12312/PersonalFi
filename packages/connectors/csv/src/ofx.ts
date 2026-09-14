// SPDX-License-Identifier: MIT
/**
 * OFX 1.x (SGML) and OFX 2.x (XML), read by one tokenizer.
 *
 * OFX 1.x is SGML: leaf elements have no end tag.
 *
 * ```text
 * <STMTTRN>
 * <TRNTYPE>DEBIT
 * <DTPOSTED>20260520120000[-5:EST]
 * <TRNAMT>-12.34
 * <FITID>2026052000012
 * <NAME>SQ *BLUE BOTTLE
 * </STMTTRN>
 * ```
 *
 * The usual approach (Actual Budget's `ofx2json`, and every blog post) is to
 * *repair* that into well-formed XML with a pile of regexes and then hand it to
 * an XML library. That needs an XML library, which this package may not have —
 * see `NOTICE`. So the repair is done in the tokenizer instead, as one rule:
 *
 * > **An element that already has text is closed by the next tag, whichever tag
 * > that is.**
 *
 * Which is precisely what SGML's omitted end tags mean. The same rule is inert
 * for OFX 2.x, where the end tags are all present — so both versions parse, with
 * no sniffing, no `<?xml` detection and no second code path.
 *
 * Deliberately not implemented: `INVSTMTMSGSRSV1` (investment statements) and
 * `CREDITCARDMSGSRSV1`'s liability extensions. Investments is a Phase 3 context;
 * an adapter that parsed holdings into nothing would be the silently-empty
 * dataset that `assertSupports` exists to prevent.
 */
import { ImportError } from './errors.ts';

export interface OfxNode {
  readonly name: string;
  /** The element's text, for a leaf. `null` for a container. */
  value: string | null;
  readonly children: OfxNode[];
}

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replaceAll(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Parse an OFX document into a tree.
 *
 * Everything before the first `<` that starts a real element — the
 * `OFXHEADER:100` block in 1.x, the `<?xml?>`/`<?OFX?>` declarations in 2.x — is
 * skipped. We do not read the header: `CHARSET:1252` is routinely wrong, and the
 * file has already been decoded to a string by the time it gets here.
 */
export function parseOfx(text: string): OfxNode {
  const root: OfxNode = { name: '#document', value: null, children: [] };
  const stack: OfxNode[] = [root];
  const top = (): OfxNode => stack[stack.length - 1] ?? root;

  let index = text.indexOf('<');
  if (index === -1) throw new ImportError('not an OFX document: no tags found');

  while (index < text.length && index !== -1) {
    const close = text.indexOf('>', index);
    if (close === -1) throw new ImportError('an OFX tag is never closed');
    const rawTag = text.slice(index + 1, close).trim();

    // `<?xml ...?>`, `<?OFX ...?>`, `<!-- -->`: declarations, not elements.
    if (rawTag.startsWith('?') || rawTag.startsWith('!')) {
      index = text.indexOf('<', close + 1);
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    // Attributes are not used anywhere in OFX's schema; the name is the first word.
    const name = (selfClosing ? rawTag.slice(0, -1) : rawTag).split(/\s+/)[0] ?? '';
    if (name === '') throw new ImportError('an OFX tag has no name');

    if (name.startsWith('/')) {
      popTo(stack, name.slice(1).toUpperCase());
    } else {
      // The SGML repair, in two lines: a leaf that already has text is closed by
      // whatever tag comes next.
      while (stack.length > 1 && top().value !== null) stack.pop();
      const node: OfxNode = { name: name.toUpperCase(), value: null, children: [] };
      top().children.push(node);
      if (!selfClosing) stack.push(node);
    }

    const nextTag = text.indexOf('<', close + 1);
    const body = decodeEntities(
      text.slice(close + 1, nextTag === -1 ? text.length : nextTag),
    ).trim();
    if (body !== '' && stack.length > 1) {
      const node = top();
      node.value = node.value === null ? body : `${node.value} ${body}`;
    }
    index = nextTag;
  }

  if (root.children.length === 0) throw new ImportError('not an OFX document: no elements');
  return root;
}

/**
 * Pop until `name` has been popped.
 *
 * A close tag legitimately closes several elements at once in SGML — `</STMTTRN>`
 * arrives while `<MEMO>` is still open. A close tag that matches *nothing* on the
 * stack is a malformed document, and popping the whole stack for it would silently
 * reparent the rest of the file, so it is ignored instead.
 */
function popTo(stack: OfxNode[], name: string): void {
  const at = stack.findLastIndex((node) => node.name === name);
  if (at <= 0) return;
  stack.length = at;
}

export function child(node: OfxNode, name: string): OfxNode | null {
  return node.children.find((candidate) => candidate.name === name) ?? null;
}

export function text(node: OfxNode | null, name: string): string | null {
  if (node === null) return null;
  return child(node, name)?.value ?? null;
}

/** Every descendant with this name, depth-first, document order. */
export function descendants(node: OfxNode, name: string): OfxNode[] {
  const found: OfxNode[] = [];
  const walk = (current: OfxNode): void => {
    for (const candidate of current.children) {
      if (candidate.name === name) found.push(candidate);
      walk(candidate);
    }
  };
  walk(node);
  return found;
}

export interface OfxTransaction {
  readonly type: string | null;
  readonly fitId: string;
  /** `YYYY-MM-DD`, taken from the first eight characters. See `ofxDate`. */
  readonly postedOn: string;
  readonly amount: string;
  readonly name: string;
  readonly memo: string | null;
  readonly checkNumber: string | null;
}

export interface OfxStatement {
  readonly accountId: string;
  /** `CHECKING`, `SAVINGS`, `CREDITLINE`, `CREDITCARD`, ... */
  readonly accountType: string;
  readonly currency: string;
  readonly transactions: readonly OfxTransaction[];
  readonly ledgerBalance: { readonly amount: string; readonly asOf: string } | null;
}

/**
 * `20260520120000.000[-5:EST]` → `2026-05-20`.
 *
 * The first eight characters, and nothing else. OFX's timestamp is in the
 * institution's zone, and converting it through anything is how a 2026-03-01
 * transaction becomes 2026-02-28 (docs/CONVENTIONS.md, "Time"). The clock and
 * the zone are discarded on purpose: a posted date is a calendar date.
 */
export function ofxDate(raw: string): string {
  const digits = raw.trim().slice(0, 8);
  if (!/^\d{8}$/.test(digits))
    throw new ImportError(`OFX date ${JSON.stringify(raw)} is malformed`);
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * Every bank/credit-card statement in the document.
 *
 * One OFX file can carry several — a bank export of three accounts is one file
 * with three `<STMTRS>` — which is why the importer maps to accounts rather than
 * asking the user which account the file belongs to.
 */
export function readOfxStatements(document: OfxNode): OfxStatement[] {
  const statements: OfxStatement[] = [];

  for (const kind of ['STMTRS', 'CCSTMTRS'] as const) {
    for (const node of descendants(document, kind)) {
      const account = child(node, 'BANKACCTFROM') ?? child(node, 'CCACCTFROM');
      const accountId = text(account, 'ACCTID');
      if (accountId === null) {
        throw new ImportError(`an OFX ${kind} has no ACCTID; there is no account to import into`);
      }

      const list = child(node, 'BANKTRANLIST');
      const transactions = (list === null ? [] : descendants(list, 'STMTTRN')).map((entry) =>
        readTransaction(entry),
      );

      const balance = child(node, 'LEDGERBAL');
      const balanceAmount = text(balance, 'BALAMT');
      const balanceAsOf = text(balance, 'DTASOF');

      statements.push({
        accountId,
        accountType: text(account, 'ACCTTYPE') ?? (kind === 'CCSTMTRS' ? 'CREDITCARD' : 'CHECKING'),
        currency: text(node, 'CURDEF') ?? 'USD',
        transactions,
        ledgerBalance:
          balanceAmount === null || balanceAsOf === null
            ? null
            : { amount: balanceAmount, asOf: ofxDate(balanceAsOf) },
      });
    }
  }

  if (statements.length === 0) {
    throw new ImportError('the OFX file contains no bank or credit-card statement');
  }
  return statements;
}

function readTransaction(entry: OfxNode): OfxTransaction {
  const fitId = text(entry, 'FITID');
  const posted = text(entry, 'DTPOSTED');
  const amount = text(entry, 'TRNAMT');
  if (fitId === null) throw new ImportError('an OFX STMTTRN has no FITID');
  if (posted === null) throw new ImportError(`OFX transaction ${fitId} has no DTPOSTED`);
  if (amount === null) throw new ImportError(`OFX transaction ${fitId} has no TRNAMT`);

  return {
    type: text(entry, 'TRNTYPE'),
    fitId,
    postedOn: ofxDate(posted),
    amount,
    // Some institutions put the payee in NAME, others leave NAME blank and use
    // PAYEE/NAME. A transaction with neither still has a memo more often than not.
    name: text(entry, 'NAME') ?? text(child(entry, 'PAYEE'), 'NAME') ?? text(entry, 'MEMO') ?? '',
    memo: text(entry, 'MEMO'),
    checkNumber: text(entry, 'CHECKNUM'),
  };
}
