// SPDX-License-Identifier: MIT
/**
 * The playbook page as data (WP 11.5a; 12 §2.2 "The playbook").
 *
 * The pages are written and reviewed as markdown under `docs/advisor/playbook/`
 * — public, human-readable, what Chris reads. The api image ships no `docs/`,
 * so `scripts/playbook-gen.ts` (the only reader of the markdown) parses them
 * into `../../data/playbook.ts`, and everything at runtime reads that module.
 * `pnpm run playbook -- --check` fails when the module has drifted from the
 * markdown; CI runs it in the lint job.
 *
 * This file holds what both sides share: the shape of a parsed page, the four
 * sections and their headings, the canonical body and its digest, and the two
 * inline syntaxes a page may carry:
 *
 *   * `{{param:<key>}}` — a parameter placeholder, rendered from the store at
 *     read time (`params.ts#renderParameter`), so a page never types a limit;
 *   * `[^<id>]` — a source marker, naming one of the page's frontmatter
 *     sources. Every other number in a page sits in a sentence with one.
 *
 * The digest is over the canonical body only — the four sections assembled
 * by `canonicalBody` — so it moves when the text Chris reviewed moves, and not
 * when a frontmatter field (the status, the reviewer) does. A reviewed page
 * records the digest it was reviewed at (`reviewed_digest`), and the
 * generator refuses a reviewed page whose body no longer hashes to it: an edit
 * after review sends the page back to draft and its version up.
 */
import { configHash } from '@core/platform';

export const PLAYBOOK_STATUSES = ['draft', 'reviewed'] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

/** The four sections, in order, with the heading each is written under. */
export const PLAYBOOK_SECTIONS = [
  ['rule', 'The rule'],
  ['why', 'Why'],
  ['whenItDoesNotApply', 'When it does not apply'],
  ['sources', 'Sources'],
] as const;
export type PlaybookSectionName = (typeof PLAYBOOK_SECTIONS)[number][0];
export type PlaybookSections = Readonly<Record<PlaybookSectionName, string>>;

export interface PlaybookSource {
  readonly id: string;
  readonly title: string;
  /** A URL, or a printed citation (a statute, a regulation, a journal article). */
  readonly urlOrCitation: string;
  /** The date the drafter last checked the source (YYYY-MM-DD). */
  readonly accessed: string;
}

/** One page as the generator emits it. */
export interface PlaybookPageData {
  readonly key: string;
  readonly title: string;
  /** A positive integer. Bumped whenever the body changes after a review. */
  readonly version: number;
  readonly status: PlaybookStatus;
  /** Both `null` on a draft; both set on a reviewed page (the generator refuses otherwise). */
  readonly reviewedBy: string | null;
  readonly reviewedOn: string | null;
  readonly sources: readonly PlaybookSource[];
  /** Raw markdown per section, placeholders unrendered. */
  readonly sections: PlaybookSections;
  /** Every `{{param:…}}` key the page uses, in first-use order, each once. */
  readonly params: readonly string[];
  /** `sha256:` + SHA-256 over the canonical JSON of `{ body: canonicalBody(sections) }`. */
  readonly digest: string;
}

/** `emergency-fund`, `tax-advantaged-order`. */
export const PLAYBOOK_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A source id: `irs-notice-2025-67`. */
export const SOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `{{param:<key>}}`. The key's grammar is checked separately, so a malformed one is named, not missed. */
export const PARAM_PLACEHOLDER = /\{\{param:([^{}\s]*)\}\}/g;
/** `[^<id>]` in running text (a definition line `[^id]:` is the Sources section's). */
export const SOURCE_MARKER = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * The body every digest is taken over: each section under its heading, one
 * blank line between blocks, one trailing newline. The generator requires the
 * markdown body to be exactly this (after prettier), so the module's sections
 * and the reviewed text are the same bytes.
 */
export function canonicalBody(sections: PlaybookSections): string {
  return `${PLAYBOOK_SECTIONS.map(([name, heading]) => `## ${heading}\n\n${sections[name].trim()}`).join('\n\n')}\n`;
}

/** The page digest. Shared by the generator (which records it) and the knowledge base (which re-checks it). */
export function playbookDigest(sections: PlaybookSections): string {
  return `sha256:${configHash({ body: canonicalBody(sections) })}`;
}

/** The `{{param:…}}` keys in `text`, in first-use order, each once. */
export function placeholderKeys(text: string): readonly string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(PARAM_PLACEHOLDER)) {
    const key = match[1] ?? '';
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}
