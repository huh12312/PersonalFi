#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The playbook generator (WP 11.5a; 12 §2.2, §7 decision 2).
 *
 * The advisor's playbook is written, and reviewed by Chris, as markdown under
 * `docs/advisor/playbook/<key>.md` (the format is in that directory's
 * README). The api image ships no `docs/`, so — the OpenAPI precedent — this
 * script parses the pages into a checked-in module,
 * `packages/contexts/insights/data/playbook.ts`, which is all the runtime
 * reads. **This script is the only reader of the markdown.**
 *
 *   pnpm run playbook               # parse, validate, write the module
 *   pnpm run playbook -- --check    # parse, validate, and fail if the module has drifted
 *   pnpm run playbook -- --digest   # print each page's digest (what `reviewed_digest` records)
 *
 * ## What a page must satisfy, or nothing is written
 *
 *   * **Frontmatter**: `key` (the file name), `title`, `version` (a positive
 *     integer), `status` (`draft` | `reviewed`) and `sources` — a list of
 *     `{ id, title, url_or_citation, accessed }`. No other field.
 *   * **The review gate**: `reviewed` requires `reviewed_by`, `reviewed_on` (a
 *     date) and `reviewed_digest` equal to the body's digest — so a page edited
 *     after its review is refused until it goes back to `draft` with its
 *     version bumped. A `draft` carries none of the three.
 *   * **The body**: exactly `## The rule`, `## Why`, `## When it does not
 *     apply`, `## Sources`, in that order, and nothing else — no other heading,
 *     nothing before the first.
 *   * **Every number is cited**: a numeral (or a figure spelled out with a
 *     scale or currency word) in the first three sections is either a
 *     `{{param:<key>}}` placeholder — the key must resolve in the parameter
 *     store and have an inline form — or sits in a sentence carrying a
 *     `[^id]` marker that names a frontmatter source.
 *   * **Sources**: the `## Sources` section defines exactly the frontmatter's
 *     ids (`[^id]: …`), and every marker names one of them.
 *   * **The language rules** (07 §7.2): the insight copy linter on every
 *     section, plus "must" and "guaranteed", which a page never says.
 *   * **Length**: 150–600 words across the first three sections.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as prettier from 'prettier';
import { lintAdviceCopy } from '../packages/contexts/insights/src/advisors/copy-lint.ts';
import {
  canonicalBody,
  PARAM_PLACEHOLDER,
  PLAYBOOK_KEY_PATTERN,
  PLAYBOOK_SECTIONS,
  playbookDigest,
  placeholderKeys,
  SOURCE_ID_PATTERN,
  SOURCE_MARKER,
  type PlaybookPageData,
  type PlaybookSections,
  type PlaybookSource,
  type PlaybookStatus,
} from '../packages/contexts/insights/src/knowledge/page.ts';
import {
  PARAMETER_KEY_PATTERN,
  renderParameter,
  type ParameterCitation,
} from '../packages/contexts/insights/src/knowledge/params.ts';
import {
  extractNumerals,
  extractWordFigures,
} from '../packages/contexts/insights/src/validate/numerals.ts';
import {
  isParameterRefusal,
  parameterByKey,
} from '../packages/contexts/planning/src/parameters.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
export const PLAYBOOK_DIR = join(REPO_ROOT, 'docs', 'advisor', 'playbook');
export const PLAYBOOK_MODULE = join(
  REPO_ROOT,
  'packages',
  'contexts',
  'insights',
  'data',
  'playbook.ts',
);

export const MIN_WORDS = 150;
export const MAX_WORDS = 600;

/** What a page may never say, beyond the copy linter's list. */
const PAGE_BANNED: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'must', pattern: /\bmust\b/i },
  { name: 'guaranteed', pattern: /\bguarantee(?:d|s)?\b/i },
];

export type ProblemCode =
  | 'frontmatter'
  | 'field'
  | 'review_gate'
  | 'source'
  | 'structure'
  | 'placeholder'
  | 'unsourced_number'
  | 'marker'
  | 'copy'
  | 'length';

export interface PageProblem {
  readonly code: ProblemCode;
  readonly message: string;
}

export class PlaybookPageError extends Error {
  override readonly name = 'PlaybookPageError';
  readonly file: string;
  readonly problems: readonly PageProblem[];

  constructor(file: string, problems: readonly PageProblem[]) {
    super(
      `${file}:\n${problems.map((problem) => `  ${problem.code}: ${problem.message}`).join('\n')}`,
    );
    this.file = file;
    this.problems = problems;
  }
}

/** How the generator asks the parameter store about a key. Injected so the rules test without the store. */
export type ParamResolver = (
  key: string,
) =>
  | { readonly ok: true; readonly citation: ParameterCitation }
  | { readonly ok: false; readonly detail: string };

/** The real store: `@ctx/planning`'s parameter citations. */
export const storeResolver: ParamResolver = (key) => {
  try {
    return { ok: true, citation: parameterByKey(key) as ParameterCitation };
  } catch (error) {
    if (isParameterRefusal(error)) return { ok: false, detail: error.message };
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Frontmatter: a deliberately small YAML subset — scalars and one list of maps
// ---------------------------------------------------------------------------

type Scalar = string;
interface Frontmatter {
  readonly fields: Map<string, Scalar>;
  readonly sources: readonly Map<string, Scalar>[] | null;
}

function scalar(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Error(`unterminated string ${text}`);
    return JSON.parse(text) as string;
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`unterminated string ${text}`);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function parseFrontmatter(lines: readonly string[], problems: PageProblem[]): Frontmatter {
  const fields = new Map<string, Scalar>();
  let sources: Map<string, Scalar>[] | null = null;
  let current: Map<string, Scalar> | null = null;
  let inSources = false;
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const top = /^([a-z_]+):(.*)$/.exec(line);
    if (top !== null) {
      const [, name = '', rest = ''] = top;
      inSources = false;
      current = null;
      if (name === 'sources') {
        if (rest.trim() !== '')
          problems.push({
            code: 'frontmatter',
            message: '`sources:` is a list on the lines below it',
          });
        sources = [];
        inSources = true;
        continue;
      }
      if (fields.has(name))
        problems.push({ code: 'frontmatter', message: `\`${name}\` appears twice` });
      try {
        fields.set(name, scalar(rest));
      } catch (error) {
        problems.push({ code: 'frontmatter', message: `\`${name}\`: ${(error as Error).message}` });
      }
      continue;
    }
    const item = /^ {2}- ([a-z_]+):(.*)$/.exec(line);
    const continued = /^ {4}([a-z_]+):(.*)$/.exec(line);
    if (
      inSources &&
      sources !== null &&
      (item !== null || (continued !== null && current !== null))
    ) {
      const [, name = '', rest = ''] = item ?? continued ?? [];
      if (item !== null) {
        current = new Map();
        sources.push(current);
      }
      if (current === null) continue;
      if (current.has(name))
        problems.push({ code: 'source', message: `a source repeats \`${name}\`` });
      try {
        current.set(name, scalar(rest));
      } catch (error) {
        problems.push({ code: 'source', message: `\`${name}\`: ${(error as Error).message}` });
      }
      continue;
    }
    problems.push({
      code: 'frontmatter',
      message: `unreadable frontmatter line: ${JSON.stringify(line)}`,
    });
  }
  return { fields, sources };
}

function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

const FIELDS = new Set([
  'key',
  'title',
  'version',
  'status',
  'reviewed_by',
  'reviewed_on',
  'reviewed_digest',
]);
const SOURCE_FIELDS = ['id', 'title', 'url_or_citation', 'accessed'] as const;

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** LF, no trailing spaces, no leading blank lines, one trailing newline. */
function normalise(text: string): string {
  return `${text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')}\n`;
}

function splitSections(body: string, problems: PageProblem[]): PlaybookSections | null {
  const headings = [...body.matchAll(/^(#{1,6}) (.*)$/gm)];
  const expected = PLAYBOOK_SECTIONS.map(([, heading]) => heading);
  const found = headings.map((match) => `${match[1] ?? ''} ${match[2] ?? ''}`);
  const wanted = expected.map((heading) => `## ${heading}`);
  if (found.length !== wanted.length || found.some((heading, index) => heading !== wanted[index])) {
    problems.push({
      code: 'structure',
      message: `the body's headings must be exactly ${wanted.map((heading) => `"${heading}"`).join(', ')} in that order; found ${found.map((heading) => `"${heading}"`).join(', ') || 'none'}`,
    });
    return null;
  }
  const sections: Partial<Record<keyof PlaybookSections, string>> = {};
  PLAYBOOK_SECTIONS.forEach(([name], index) => {
    const start = (headings[index]?.index ?? 0) + (headings[index]?.[0].length ?? 0);
    const end = headings[index + 1]?.index ?? body.length;
    sections[name] = body.slice(start, end).trim();
  });
  const complete = sections as PlaybookSections;
  for (const [name, heading] of PLAYBOOK_SECTIONS) {
    if (complete[name] === '')
      problems.push({ code: 'structure', message: `"## ${heading}" is empty` });
  }
  if (canonicalBody(complete) !== body) {
    problems.push({
      code: 'structure',
      message:
        'the body is not in canonical form (text before the first heading, or blank-line spacing ' +
        'around a heading) — run prettier on the page and keep one blank line around each heading',
    });
  }
  return complete;
}

/** Sentences, list items and paragraphs — the unit a source marker covers. */
function sentencesOf(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function wordCount(text: string): number {
  return text
    .replace(PARAM_PLACEHOLDER, 'X')
    .replace(SOURCE_MARKER, '')
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

/** The number of words in a page's first three sections — the figure the length rule reads. */
export function bodyWordCount(sections: PlaybookSections): number {
  return wordCount([sections.rule, sections.why, sections.whenItDoesNotApply].join('\n\n'));
}

/**
 * Parse and validate one page. Throws `PlaybookPageError` naming every
 * problem at once — a page with one wrong thing is not written at all.
 */
export function parsePlaybookPage(
  markdown: string,
  fileName: string,
  resolveParam: ParamResolver = storeResolver,
): PlaybookPageData {
  const problems: PageProblem[] = [];
  const text = markdown.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new PlaybookPageError(fileName, [
      { code: 'frontmatter', message: 'a page starts with a `---` frontmatter block' },
    ]);
  }
  const front = parseFrontmatter((match[1] ?? '').split('\n'), problems);
  const body = normalise(match[2] ?? '');

  // --- fields ---------------------------------------------------------------
  for (const name of front.fields.keys()) {
    if (!FIELDS.has(name)) problems.push({ code: 'field', message: `unknown field \`${name}\`` });
  }
  const key = front.fields.get('key') ?? '';
  const expectedKey = fileName.replace(/\.md$/, '');
  if (!PLAYBOOK_KEY_PATTERN.test(key))
    problems.push({ code: 'field', message: `\`key\` ${JSON.stringify(key)} is not a page key` });
  else if (key !== expectedKey)
    problems.push({ code: 'field', message: `\`key\` ${key} is not the file name ${expectedKey}` });
  const title = front.fields.get('title') ?? '';
  if (title.trim() === '') problems.push({ code: 'field', message: '`title` is required' });
  const versionText = front.fields.get('version') ?? '';
  if (!/^[1-9]\d*$/.test(versionText)) {
    problems.push({ code: 'field', message: '`version` is a positive integer, starting at 1' });
  }
  const statusText = front.fields.get('status') ?? '';
  if (statusText !== 'draft' && statusText !== 'reviewed') {
    problems.push({ code: 'field', message: '`status` is `draft` or `reviewed`' });
  }
  const status: PlaybookStatus = statusText === 'reviewed' ? 'reviewed' : 'draft';

  // --- sources --------------------------------------------------------------
  const sources: PlaybookSource[] = [];
  if (front.sources === null || front.sources.length === 0) {
    problems.push({ code: 'source', message: 'a page lists at least one source under `sources:`' });
  }
  for (const [index, raw] of (front.sources ?? []).entries()) {
    for (const name of raw.keys()) {
      if (!(SOURCE_FIELDS as readonly string[]).includes(name)) {
        problems.push({
          code: 'source',
          message: `source ${String(index + 1)}: unknown field \`${name}\``,
        });
      }
    }
    const missing = SOURCE_FIELDS.filter((name) => (raw.get(name) ?? '').trim() === '');
    if (missing.length > 0) {
      problems.push({
        code: 'source',
        message: `source ${String(index + 1)} lacks ${missing.join(', ')}`,
      });
      continue;
    }
    const id = raw.get('id') ?? '';
    if (!SOURCE_ID_PATTERN.test(id))
      problems.push({ code: 'source', message: `source id ${id} is not lower-kebab` });
    if (sources.some((source) => source.id === id))
      problems.push({ code: 'source', message: `source id ${id} repeats` });
    const accessed = raw.get('accessed') ?? '';
    if (!isCalendarDate(accessed))
      problems.push({
        code: 'source',
        message: `source ${id}: \`accessed\` is a date (YYYY-MM-DD)`,
      });
    sources.push({
      id,
      title: raw.get('title') ?? '',
      urlOrCitation: raw.get('url_or_citation') ?? '',
      accessed,
    });
  }
  const sourceIds = new Set(sources.map((source) => source.id));

  // --- the body -------------------------------------------------------------
  const sections = splitSections(body, problems);
  const digest = sections === null ? '' : playbookDigest(sections);

  // --- the review gate ------------------------------------------------------
  const reviewedBy = front.fields.get('reviewed_by');
  const reviewedOn = front.fields.get('reviewed_on');
  const reviewedDigest = front.fields.get('reviewed_digest');
  if (status === 'reviewed') {
    if (reviewedBy === undefined || reviewedBy.trim() === '') {
      problems.push({ code: 'review_gate', message: '`status: reviewed` requires `reviewed_by`' });
    }
    if (reviewedOn === undefined || !isCalendarDate(reviewedOn)) {
      problems.push({
        code: 'review_gate',
        message: '`status: reviewed` requires `reviewed_on`, a date (YYYY-MM-DD)',
      });
    }
    if (reviewedDigest !== digest) {
      problems.push({
        code: 'review_gate',
        message:
          reviewedDigest === undefined
            ? `\`status: reviewed\` requires \`reviewed_digest: ${digest}\` — the body you reviewed`
            : `the body has changed since it was reviewed (reviewed at ${reviewedDigest}, now ${digest}): ` +
              'set `status: draft`, bump `version`, drop the reviewed_* fields, and review it again',
      });
    }
  } else if (reviewedBy !== undefined || reviewedOn !== undefined || reviewedDigest !== undefined) {
    problems.push({
      code: 'review_gate',
      message: 'a draft carries no reviewed_by, reviewed_on or reviewed_digest',
    });
  }

  // --- what the sections say ------------------------------------------------
  const params: string[] = [];
  if (sections !== null) {
    const prose = [sections.rule, sections.why, sections.whenItDoesNotApply];
    for (const section of prose) {
      for (const leftover of section.matchAll(/\{\{(?!param:[^{}\s]*\}\})[^}]*\}?\}?/g)) {
        problems.push({ code: 'placeholder', message: `not a placeholder: ${leftover[0]}` });
      }
      for (const key of placeholderKeys(section)) {
        if (!params.includes(key)) params.push(key);
      }
      for (const marker of section.matchAll(SOURCE_MARKER)) {
        if (!sourceIds.has(marker[1] ?? '')) {
          problems.push({
            code: 'marker',
            message: `[^${marker[1] ?? ''}] names no frontmatter source`,
          });
        }
      }
      for (const sentence of sentencesOf(section)) {
        const bare = sentence.replace(PARAM_PLACEHOLDER, ' ').replace(SOURCE_MARKER, ' ');
        const numerals = extractNumerals(bare).map((numeral) => numeral.raw);
        const words = extractWordFigures(bare).map((figure) => figure.raw);
        const sourced = [...sentence.matchAll(SOURCE_MARKER)].length > 0;
        if ((numerals.length > 0 || words.length > 0) && !sourced) {
          problems.push({
            code: 'unsourced_number',
            message: `${[...numerals, ...words].join(', ')} in "${sentence.slice(0, 100)}" — use a {{param:…}} placeholder or add a [^source] marker`,
          });
        }
      }
      const plain = section.replace(PARAM_PLACEHOLDER, 'the figure').replace(SOURCE_MARKER, '');
      for (const violation of lintAdviceCopy(plain, 'summary_md')) {
        problems.push({ code: 'copy', message: `${violation.rule}: ${violation.detail}` });
      }
      for (const banned of PAGE_BANNED) {
        if (banned.pattern.test(plain))
          problems.push({ code: 'copy', message: `a page never says "${banned.name}"` });
      }
    }
    for (const key of params) {
      if (!PARAMETER_KEY_PATTERN.test(key)) {
        problems.push({ code: 'placeholder', message: `{{param:${key}}} is not a parameter key` });
        continue;
      }
      const resolved = resolveParam(key);
      if (!resolved.ok) {
        problems.push({ code: 'placeholder', message: `{{param:${key}}}: ${resolved.detail}` });
      } else if (renderParameter(resolved.citation) === null) {
        problems.push({
          code: 'placeholder',
          message: `{{param:${key}}} is a ${resolved.citation.kind}, which has no inline form`,
        });
      }
    }
    const defined = [...sections.sources.matchAll(/^\[\^([^\]]+)\]:\s*\S/gm)].map(
      (definition) => definition[1] ?? '',
    );
    for (const line of sections.sources.split('\n').filter((entry) => entry.trim() !== '')) {
      if (!/^\[\^[^\]]+\]:\s*\S/.test(line) && !/^\s{2,}\S/.test(line)) {
        problems.push({
          code: 'source',
          message: `the Sources section holds only [^id]: definitions; found ${JSON.stringify(line.slice(0, 60))}`,
        });
      }
    }
    const definedSet = new Set(defined);
    for (const id of sourceIds) {
      if (!definedSet.has(id))
        problems.push({ code: 'source', message: `source ${id} is not defined in "## Sources"` });
    }
    for (const id of defined) {
      if (!sourceIds.has(id))
        problems.push({
          code: 'source',
          message: `"## Sources" defines [^${id}], which is not in the frontmatter`,
        });
    }
    if (defined.length !== definedSet.size)
      problems.push({ code: 'source', message: '"## Sources" defines an id twice' });
    const words = bodyWordCount(sections);
    if (words < MIN_WORDS || words > MAX_WORDS) {
      problems.push({
        code: 'length',
        message: `${String(words)} words; a page is ${String(MIN_WORDS)}–${String(MAX_WORDS)}`,
      });
    }
  }

  if (problems.length > 0 || sections === null) throw new PlaybookPageError(fileName, problems);
  return {
    key,
    title: title.trim(),
    version: Number(versionText),
    status,
    reviewedBy: status === 'reviewed' ? (reviewedBy ?? null) : null,
    reviewedOn: status === 'reviewed' ? (reviewedOn ?? null) : null,
    sources,
    sections,
    params,
    digest,
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const HEADER = `// SPDX-License-Identifier: MIT
// GENERATED by scripts/playbook-gen.ts from docs/advisor/playbook/*.md — do not edit.
// Regenerate with \`pnpm run playbook\`; CI's lint job fails when this file drifts
// from the markdown (\`pnpm run playbook -- --check\`). The runtime gate is in
// src/knowledge/playbook.ts: a page that is not \`reviewed\` is never served.
import type { PlaybookPageData } from '../src/knowledge/page.ts';
`;

/** The module's text, prettier-formatted with the repository's own config. */
export async function emitPlaybookModule(
  pages: readonly PlaybookPageData[],
  target: string = PLAYBOOK_MODULE,
): Promise<string> {
  const ordered = [...pages].sort((left, right) => (left.key < right.key ? -1 : 1));
  const source = `${HEADER}\nexport const PLAYBOOK_PAGES: readonly PlaybookPageData[] = ${JSON.stringify(ordered, null, 2)};\n`;
  const options = (await prettier.resolveConfig(target)) ?? {};
  return prettier.format(source, { ...options, filepath: target });
}

/** Every page file in `directory` (not the README), parsed. Collects every page's problems before throwing. */
export function readPlaybook(
  directory: string = PLAYBOOK_DIR,
  resolveParam: ParamResolver = storeResolver,
): readonly PlaybookPageData[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();
  const pages: PlaybookPageData[] = [];
  const errors: PlaybookPageError[] = [];
  for (const name of files) {
    try {
      pages.push(
        parsePlaybookPage(readFileSync(join(directory, name), 'utf8'), name, resolveParam),
      );
    } catch (error) {
      if (error instanceof PlaybookPageError) errors.push(error);
      else throw error;
    }
  }
  if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'));
  return pages;
}

export async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  let pages: readonly PlaybookPageData[];
  try {
    pages = readPlaybook();
  } catch (error) {
    console.error(`playbook: refused\n${(error as Error).message}`);
    return 1;
  }
  if (argv.includes('--digest')) {
    for (const page of pages)
      console.log(`${page.key}\tversion ${String(page.version)}\t${page.status}\t${page.digest}`);
    return 0;
  }
  const emitted = await emitPlaybookModule(pages);
  const where = relative(REPO_ROOT, PLAYBOOK_MODULE);
  if (check) {
    const current = existsSync(PLAYBOOK_MODULE) ? readFileSync(PLAYBOOK_MODULE, 'utf8') : '';
    if (current !== emitted) {
      console.error(
        `playbook: ${where} has drifted from docs/advisor/playbook/*.md — run \`pnpm run playbook\` and commit the result`,
      );
      return 1;
    }
    console.log(`playbook: ${where} matches the markdown (${String(pages.length)} pages)`);
    return 0;
  }
  writeFileSync(PLAYBOOK_MODULE, emitted);
  console.log(`playbook: wrote ${where} (${String(pages.length)} pages)`);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exit(await main(process.argv.slice(2)));
}
