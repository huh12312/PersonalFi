// SPDX-License-Identifier: MIT
/**
 * The knowledge base: reviewed playbook pages and cited parameters, by key
 * (WP 11.5a; 12 §2.2, §4, §7 decision 2).
 *
 * Retrieval is keyed, not semantic: a caller names the page it needs
 * (`playbook.get('debt-order')`) or the parameter (`params.get(
 * 'tax.us.2026.retirement.ira_contribution')`), and what comes back enters a
 * model's context as *data*, with the version and digest the narration must
 * record (`citations.ts#knowledgeReadRecord`).
 *
 * ## The review gate (decision 2: Chris reviews; enforced here, in code)
 *
 * `playbook.get` refuses — `playbook.unreviewed` — any page whose status is not
 * `reviewed`, or whose `reviewedBy` / `reviewedOn` is missing, so a draft can
 * never enter a model's context. The generator refuses the same page earlier
 * (and a reviewed page whose body moved since its review); this is the
 * runtime half, over whatever the module holds, so a hand-edited module is
 * still gated. It also re-takes the digest over the page's sections and
 * refuses a page that no longer hashes to the digest it carries
 * (`playbook.digest_mismatch`).
 *
 * ## Placeholders
 *
 * Every `{{param:<key>}}` is replaced, at read time, with the store's value
 * (`renderParameter`). A key the store cannot answer — unknown, or a tax year
 * it does not hold — refuses the whole page (`playbook.param_unavailable`); a
 * key whose node has no inline form refuses it too
 * (`playbook.param_unrenderable`). A page is served whole or not at all, and
 * never with a placeholder left in it.
 */
import { PLAYBOOK_PAGES } from '../../data/playbook.ts';
import {
  PARAM_PLACEHOLDER,
  PLAYBOOK_SECTIONS,
  playbookDigest,
  type PlaybookPageData,
  type PlaybookSections,
  type PlaybookSource,
} from './page.ts';
import { renderParameter, type ParameterCitation, type ParameterPort } from './params.ts';

export const KNOWLEDGE_REFUSAL_CODES = [
  'playbook.unknown',
  'playbook.unreviewed',
  'playbook.digest_mismatch',
  'playbook.param_unavailable',
  'playbook.param_unrenderable',
  'param.unknown',
  'param.year_unavailable',
] as const;
export type KnowledgeRefusalCode = (typeof KNOWLEDGE_REFUSAL_CODES)[number];

/** Every refusal of the knowledge base. A class, as the validators' refusals are. */
export class KnowledgeRefusal extends Error {
  override readonly name = 'KnowledgeRefusal';
  readonly code: KnowledgeRefusalCode;
  /** The page or parameter key refused. */
  readonly key: string;

  constructor(code: KnowledgeRefusalCode, key: string, detail: string) {
    super(`${code}: ${key}: ${detail}`);
    this.code = code;
    this.key = key;
  }
}

export function isKnowledgeRefusal(error: unknown): error is KnowledgeRefusal {
  return error instanceof KnowledgeRefusal;
}

/** A reviewed page, rendered — what may enter a model's context. */
export interface ReviewedPlaybookPage {
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly digest: string;
  readonly reviewedBy: string;
  readonly reviewedOn: string;
  readonly sources: readonly PlaybookSource[];
  /** Each section with every placeholder rendered. */
  readonly sections: PlaybookSections;
  /** The whole rendered page: the title, then the four sections under their headings. */
  readonly text: string;
  /** The parameters rendered into it — part of what is sent when the page is sent. */
  readonly params: readonly ParameterCitation[];
}

export interface KnowledgeBase {
  readonly playbook: {
    /** @throws {KnowledgeRefusal} `playbook.unknown`, `playbook.unreviewed`, `playbook.digest_mismatch`, `playbook.param_*`. */
    get(key: string): ReviewedPlaybookPage;
    /** Every page key the module holds, draft or reviewed. Existence only — never a way to read a draft. */
    keys(): readonly string[];
  };
  readonly params: {
    /** @throws {KnowledgeRefusal} `param.unknown`, `param.year_unavailable`. */
    get(key: string): ParameterCitation;
  };
}

export interface KnowledgeBaseOptions {
  readonly params: ParameterPort;
  /**
   * The pages to serve. Defaults to the generated module and should be left
   * alone outside tests: the gate applies to whatever is passed, but a test's
   * copy is where a reviewed page can be made without Chris.
   */
  readonly pages?: readonly PlaybookPageData[];
}

function paramOrRefuse(port: ParameterPort, key: string): ParameterCitation {
  const lookup = port.get(key);
  if (lookup.found) return lookup.citation;
  throw new KnowledgeRefusal(
    lookup.reason === 'year_unavailable' ? 'param.year_unavailable' : 'param.unknown',
    key,
    lookup.detail,
  );
}

function render(page: PlaybookPageData, port: ParameterPort): ReviewedPlaybookPage {
  const used = new Map<string, ParameterCitation>();
  const renderText = (text: string): string =>
    text.replace(PARAM_PLACEHOLDER, (_whole, key: string) => {
      const lookup = port.get(key);
      if (!lookup.found) {
        throw new KnowledgeRefusal(
          'playbook.param_unavailable',
          page.key,
          `{{param:${key}}}: ${lookup.detail}`,
        );
      }
      const rendered = renderParameter(lookup.citation);
      if (rendered === null) {
        throw new KnowledgeRefusal(
          'playbook.param_unrenderable',
          page.key,
          `{{param:${key}}} is a ${lookup.citation.kind}, which has no inline form`,
        );
      }
      used.set(key, lookup.citation);
      return rendered;
    });
  const sections = Object.fromEntries(
    PLAYBOOK_SECTIONS.map(([name]) => [name, renderText(page.sections[name])]),
  ) as Record<keyof PlaybookSections, string>;
  const text = `# ${page.title}\n\n${PLAYBOOK_SECTIONS.map(
    ([name, heading]) => `## ${heading}\n\n${sections[name].trim()}`,
  ).join('\n\n')}\n`;
  if (text.includes('{{')) {
    // Belt and braces: a placeholder the pattern did not match (a malformed
    // one the generator should have refused) never reaches a model.
    throw new KnowledgeRefusal(
      'playbook.param_unavailable',
      page.key,
      'a placeholder was left unrendered',
    );
  }
  return Object.freeze({
    key: page.key,
    title: page.title,
    version: page.version,
    digest: page.digest,
    reviewedBy: page.reviewedBy ?? '',
    reviewedOn: page.reviewedOn ?? '',
    sources: page.sources,
    sections: Object.freeze(sections),
    text,
    params: Object.freeze([...used.values()]),
  });
}

/** Build the knowledge base over a parameter port (and, in tests only, a set of pages). */
export function createKnowledgeBase(options: KnowledgeBaseOptions): KnowledgeBase {
  const pages: readonly PlaybookPageData[] = options.pages ?? PLAYBOOK_PAGES;
  const byKey = new Map(pages.map((page) => [page.key, page]));
  return {
    playbook: {
      get(key: string): ReviewedPlaybookPage {
        const page = byKey.get(key);
        if (page === undefined) {
          throw new KnowledgeRefusal('playbook.unknown', key, 'no playbook page has this key');
        }
        if (
          page.status !== 'reviewed' ||
          page.reviewedBy === null ||
          page.reviewedBy.trim() === '' ||
          page.reviewedOn === null ||
          page.reviewedOn.trim() === ''
        ) {
          throw new KnowledgeRefusal(
            'playbook.unreviewed',
            key,
            `version ${String(page.version)} is ${page.status === 'reviewed' ? 'marked reviewed without a reviewer and a date' : 'a draft'}; ` +
              'nothing in the playbook reaches a model until Chris has reviewed it',
          );
        }
        const digest = playbookDigest(page.sections);
        if (digest !== page.digest) {
          throw new KnowledgeRefusal(
            'playbook.digest_mismatch',
            key,
            `the page hashes to ${digest}, not the ${page.digest} it carries — regenerate the module (pnpm run playbook)`,
          );
        }
        return render(page, options.params);
      },
      keys: () => [...byKey.keys()],
    },
    params: {
      get: (key: string) => paramOrRefuse(options.params, key),
    },
  };
}
