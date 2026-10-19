// SPDX-License-Identifier: MIT
/**
 * Entity mentions on an insight card (WP 10.15, V8; Monarch's equivalent title / body / contextLine as
 * `{ text, entityType, entityId }`).
 *
 * **A mention comes from the insight's own evidence, or not at all.** `mentionCandidatesOf` reads only the rows
 * the insight already cites (`insight_evidence`, as stored when the insight was proposed) and admits a row only
 * when its `sourceRef` ends in one of the three entity leaves the snapshot carries as a real id —
 * `category_ref`, `account_ref`, `transaction_ref` — and the value the server resolved for it
 * (`resolvedDisplay ?? value`) is a UUID. Nothing is looked up by name, guessed from the wording, or taken from
 * another insight; an id the caller cannot name (a deleted category, an account it does not hold) is dropped by
 * the route, never invented.
 *
 * Why only those three: `snapshot/tokens.ts`' table. For an in-process advisor, account, category and transaction
 * cross as their own uuids precisely so the app can link back to them; a **merchant always crosses as a
 * `MERCHANT_<12 hex>` keyed one-way pseudonym** (D22) and is never reversed, so `merchant_ref` never yields a
 * mention (the web's vocabulary still knows `merchant`, for a source that someday carries a merchant id); and
 * for an `external` advisor every ref is a token, so its rows yield none either.
 *
 * `segmentText` then splits a title, a body or a context line on exact occurrences of the mentions' display names,
 * so the card can render those words as links. It adds no words and drops none: the segments' texts concatenate to
 * the input.
 */
import { isUuid } from '@core/kernel';

export const MENTION_ENTITY_TYPES = ['category', 'merchant', 'account', 'transaction'] as const;
export type MentionEntityType = (typeof MENTION_ENTITY_TYPES)[number];

/** The evidence fields a mention is read from (`read.ts`'s `EvidenceView`). */
export interface MentionEvidence {
  readonly position: number;
  readonly label: string;
  readonly value: string | null;
  readonly sourceRef: string | null;
  readonly resolvedDisplay: string | null;
}

export interface MentionCandidate {
  readonly entityType: 'category' | 'account' | 'transaction';
  readonly entityId: string;
  /** The evidence row it came from — the client re-resolves it against the insight's own evidence. */
  readonly evidencePosition: number;
  readonly sourceRef: string;
  /** The evidence row's label (a transaction's display text: it has no name of its own). */
  readonly label: string;
}

const LEAF_ENTITY: Readonly<Record<string, MentionCandidate['entityType']>> = {
  category_ref: 'category',
  account_ref: 'account',
  transaction_ref: 'transaction',
};

function leafOf(sourceRef: string): string | null {
  if (!sourceRef.startsWith('snapshot:')) return null;
  const match = /\.([A-Za-z0-9_]+)$/u.exec(sourceRef);
  return match?.[1] ?? null;
}

/**
 * The entities an insight's evidence names, in evidence order, each entity once (its first citation). See the
 * header for what is admitted.
 */
export function mentionCandidatesOf(evidence: readonly MentionEvidence[]): MentionCandidate[] {
  const seen = new Set<string>();
  const out: MentionCandidate[] = [];
  for (const row of [...evidence].sort((a, b) => a.position - b.position)) {
    if (row.sourceRef === null) continue;
    const leaf = leafOf(row.sourceRef);
    if (leaf === null) continue;
    const entityType = LEAF_ENTITY[leaf];
    if (entityType === undefined) continue;
    const resolved = (row.resolvedDisplay ?? row.value ?? '').trim();
    if (!isUuid(resolved)) continue;
    const entityId = resolved.toLowerCase();
    const identity = `${entityType}:${entityId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      entityType,
      entityId,
      evidencePosition: row.position,
      sourceRef: row.sourceRef,
      label: row.label,
    });
  }
  return out;
}

export interface NamedMention {
  readonly text: string;
  readonly entityType: MentionEntityType;
  readonly entityId: string;
}

export interface TextSegment {
  readonly text: string;
  readonly entityType?: MentionEntityType;
  readonly entityId?: string;
}

/**
 * Split `text` on exact, case-sensitive occurrences of the mentions' `text`, longest name first at each position
 * (so "Groceries & Household" is not cut at "Groceries"). Every occurrence becomes a linked segment; the rest stays
 * plain. `segmentText(t, m).map(s => s.text).join('') === t`, always.
 */
export function segmentText(text: string, mentions: readonly NamedMention[]): TextSegment[] {
  const names = mentions
    .filter((mention) => mention.text.length > 0)
    .slice()
    .sort((a, b) => b.text.length - a.text.length);
  if (names.length === 0 || text.length === 0) return text.length === 0 ? [] : [{ text }];
  const segments: TextSegment[] = [];
  let plain = '';
  let cursor = 0;
  while (cursor < text.length) {
    const hit = names.find((mention) => text.startsWith(mention.text, cursor));
    if (hit === undefined) {
      plain += text[cursor] ?? '';
      cursor += 1;
      continue;
    }
    if (plain.length > 0) segments.push({ text: plain });
    plain = '';
    segments.push({ text: hit.text, entityType: hit.entityType, entityId: hit.entityId });
    cursor += hit.text.length;
  }
  if (plain.length > 0) segments.push({ text: plain });
  return segments;
}

/** At most this many transactions are linked from the context line; the rest are counted. */
export const CONTEXT_LINE_TRANSACTIONS = 5;

/**
 * The card's context line, deterministic in evidence order:
 *
 *   "About Groceries, Checking · transaction 1, transaction 2 and 3 more"
 *
 * Named entities (categories, accounts, merchants) by their names; transactions — which have no name — as
 * "transaction 1", "transaction 2" … (at most `CONTEXT_LINE_TRANSACTIONS` linked, the rest counted). Every named
 * piece is a link segment. `null` when the insight names no entity: no line rather than an empty one.
 */
export function contextLineOf(mentions: readonly NamedMention[]): TextSegment[] | null {
  const named = mentions.filter((mention) => mention.entityType !== 'transaction');
  const transactions = mentions.filter((mention) => mention.entityType === 'transaction');
  if (named.length === 0 && transactions.length === 0) return null;
  const segments: TextSegment[] = [];
  if (named.length > 0) {
    segments.push({ text: 'About ' });
    named.forEach((mention, index) => {
      if (index > 0) segments.push({ text: ', ' });
      segments.push({
        text: mention.text,
        entityType: mention.entityType,
        entityId: mention.entityId,
      });
    });
  }
  if (transactions.length > 0) {
    segments.push({ text: named.length > 0 ? ' · ' : 'Cites ' });
    const linked = transactions.slice(0, CONTEXT_LINE_TRANSACTIONS);
    linked.forEach((mention, index) => {
      if (index > 0) segments.push({ text: ', ' });
      segments.push({
        text: `transaction ${String(index + 1)}`,
        entityType: 'transaction',
        entityId: mention.entityId,
      });
    });
    const rest = transactions.length - linked.length;
    if (rest > 0) segments.push({ text: ` and ${String(rest)} more` });
  }
  return segments;
}
