#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The docs drift check (WP 9.12, docs/plan/09-phase-9-dispatch.md §3 "WP 9.12").
 *
 * Documentation that names a command, a variable or a secret the tree no longer
 * has is worse than no documentation: a stranger follows it and the failure is
 * theirs. CF-14 found a RUNBOOK still describing a gap that had been fixed and a
 * README that said "no application functionality yet". This check reads the docs
 * a stranger is given and compares what they name with what the tree holds.
 *
 * ## What it reads
 *
 *   README.md, RUNBOOK.md, docs/RELEASE-NOTES.md
 *
 * ## What it checks (each finding is `file:line: kind: message`)
 *
 *   recipe  Every `just <recipe>` in an inline code span or at command position
 *           in a code fence exists in `justfile` (or a file it `import`s). Prose
 *           that merely uses the word "just" is never read as a recipe.
 *   env     Every environment variable named (an ALL_CAPS_WITH_UNDERSCORE span,
 *           a `NAME=value` assignment, a `${NAME}` reference) either is
 *           documented in `.env.example`, or is operator-surface only — named in
 *           compose.yml, the justfile, scripts/ or docker/ (FORCE_RESTORE,
 *           AGE_IDENTITY_FILE). A name the `@core/config` schema reads but
 *           `.env.example` never documents fails: an operator cannot find it.
 *   secret  Every secret named (`secrets/<name>`, `/run/secrets/<name>`,
 *           `${SECRETS_DIR}/<name>`, or a span that ends in a secret-shaped
 *           suffix) is declared in compose.yml's top-level `secrets:` block.
 *   fence   Code fences balance, and a fence is only ever closed by a bare
 *           closer. A closer with trailing text ("``` It needs ...") is the
 *           defect CF-14 found in the restore-drill sample: it did not close,
 *           the next fence did, and the count still balanced.
 *   link    Every relative markdown link resolves to a file, and a `#anchor`
 *           names a heading in the file it points at.
 *   path    Every repo path named in an inline code span (`scripts/x.sh`,
 *           `docs/security/threat-model.md`) exists.
 *
 *   node scripts/check-docs.ts              # the self-test, then the real tree; exit 1 on a finding
 *   node scripts/check-docs.ts --self-test  # only the rules against in-memory fixtures
 *
 * Every rule is checked against a fixture doc that violates it (the self-test
 * and `scripts/check-docs.test.ts`) before the real tree is read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

export type ProblemKind = 'recipe' | 'env' | 'secret' | 'fence' | 'link' | 'path';

export interface DocProblem {
  readonly file: string;
  readonly line: number;
  readonly kind: ProblemKind;
  readonly message: string;
}

/** What the tree holds, read once. Fixtures build these by hand. */
export interface Facts {
  /** Recipe names in `justfile` and every file it imports. */
  readonly recipes: ReadonlySet<string>;
  /** Names `.env.example` documents (assigned, commented or named in its prose). */
  readonly envExample: ReadonlySet<string>;
  /** Keys of the `@core/config` environment schema. */
  readonly schemaKeys: ReadonlySet<string>;
  /** ALL_CAPS tokens in compose.yml, the justfile, scripts/ and docker/. */
  readonly operatorTokens: ReadonlySet<string>;
  /** Names declared in compose.yml's top-level `secrets:` block. */
  readonly composeSecrets: ReadonlySet<string>;
}

/** The slice of the file system a doc check needs, paths relative to the repo root. */
export interface TreeFs {
  exists(rel: string): boolean;
  read(rel: string): string | null;
}

export interface DocCounts {
  recipes: number;
  env: number;
  secrets: number;
  links: number;
  paths: number;
}

export const DOCS = ['README.md', 'RUNBOOK.md', 'docs/RELEASE-NOTES.md'] as const;

/**
 * ALL_CAPS tokens that appear in the docs and are NOT environment variables.
 * Every entry says why; an entry with no reason does not belong here.
 */
export const NOT_ENV: ReadonlyMap<string, string> = new Map([
  ['TAX_DEFERRED', 'an account tax-treatment enum value, not a variable'],
  ['TAX_FREE', 'an account tax-treatment enum value, not a variable'],
  ['CONFIG_ERROR', 'an error code, not a variable'],
]);

/**
 * A secret-shaped bare name (no `secrets/` prefix) is read as a secret reference
 * when it ends in one of these. Names that merely look like one and are not
 * (SQL columns, JSON fields) are listed in NOT_SECRET with the reason.
 */
const SECRET_SUFFIX =
  /^(?:[a-z0-9]+_)*(?:database_url|master_key|[a-z0-9]+_(?:secret|password|recipient|api_key|private_key|key_id|key_name|client_id)|plaid_env|age_recipient)$/;
export const NOT_SECRET: ReadonlyMap<string, string> = new Map([
  ['private_key', 'a generic word in prose about key types, not a compose secret'],
]);

const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// ------------------------------------------------------------------ facts

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Recipe names in a justfile's text (header lines only, never bodies or assignments). */
export function parseRecipes(text: string): Set<string> {
  const out = new Set<string>();
  const header =
    /^@?([A-Za-z_][A-Za-z0-9_-]*)((?:\s+[*+]?[A-Za-z_][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S+))?)*)\s*:(?!=)/;
  for (const line of text.split('\n')) {
    if (/^\s/.test(line) || line.startsWith('#')) continue;
    const match = header.exec(line);
    if (match?.[1] !== undefined && !['set', 'import', 'alias', 'export', 'mod'].includes(match[1]))
      out.add(match[1]);
  }
  return out;
}

function recipesWithImports(root: string, file: string, seen = new Set<string>()): Set<string> {
  const path = join(root, file);
  if (seen.has(path)) return new Set();
  seen.add(path);
  const text = readIfExists(path);
  const out = parseRecipes(text);
  for (const match of text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[1] ?? ''));
    for (const r of recipesWithImports(root, target, seen)) out.add(r);
  }
  return out;
}

/**
 * Every variable `.env.example` documents: assigned (commented or not) or named
 * in its prose. AUTH_RP_ID and AUTH_ALLOWED_ORIGINS are the second kind — compose
 * derives them from PUBLIC_HOST, so the file explains them and offers no
 * assignment to edit.
 */
export function parseEnvExample(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) out.add(match[0]);
  return out;
}

export function parseSchemaKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s/gm)) if (match[1]) out.add(match[1]);
  return out;
}

export function parseComposeSecrets(text: string): Set<string> {
  const out = new Set<string>();
  let inSecrets = false;
  for (const line of text.split('\n')) {
    if (/^secrets:\s*$/.test(line)) {
      inSecrets = true;
      continue;
    }
    if (inSecrets && /^\S/.test(line) && !line.startsWith('#')) break;
    const match = inSecrets ? /^ {2}([a-z][a-z0-9_]*):/.exec(line) : null;
    if (match?.[1]) out.add(match[1]);
  }
  return out;
}

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, accept, out);
    else if (accept(name)) out.push(path);
  }
  return out;
}

export function loadFacts(root: string): Facts {
  const operatorFiles = [
    join(root, 'compose.yml'),
    join(root, 'justfile'),
    ...walk(join(root, 'scripts'), (n) => /\.(sh|ts|just|mjs|js)$/.test(n)).filter(
      // The checker's own fixtures name made-up variables; they must not count.
      (p) => !/scripts\/check-docs(?:\.test)?\.ts$/.test(relative(root, p).replaceAll('\\', '/')),
    ),
    ...walk(join(root, 'docker'), () => true),
  ];
  const operatorTokens = new Set<string>();
  for (const file of operatorFiles) {
    for (const match of readIfExists(file).matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g))
      operatorTokens.add(match[0]);
  }
  return {
    recipes: recipesWithImports(root, 'justfile'),
    envExample: parseEnvExample(readIfExists(join(root, '.env.example'))),
    schemaKeys: parseSchemaKeys(readIfExists(join(root, 'packages/config/src/schema.ts'))),
    operatorTokens,
    composeSecrets: parseComposeSecrets(readIfExists(join(root, 'compose.yml'))),
  };
}

export function memoryFs(files: Record<string, string>): TreeFs {
  return {
    exists: (rel) => rel in files || Object.keys(files).some((f) => f.startsWith(`${rel}/`)),
    read: (rel) => files[rel] ?? null,
  };
}

export function diskFs(root: string): TreeFs {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null),
  };
}

// ------------------------------------------------------------- doc parsing

interface Line {
  readonly no: number;
  readonly text: string;
}

interface Parsed {
  /** Lines outside fences, 1-based numbers kept. */
  readonly prose: Line[];
  /** Lines inside fences. */
  readonly fenced: Line[];
  readonly problems: Array<{ line: number; message: string }>;
}

/** A fence may open after a list marker (`7. ```bash`), which CommonMark allows. */
const FENCE_OPEN = /^(\s*(?:(?:[-*+]|\d+[.)])\s+)?)(`{3,}|~{3,})(.*)$/;

/** Split a doc into prose and fenced lines, reporting every malformed fence. */
export function parseFences(text: string): Parsed {
  const prose: Line[] = [];
  const fenced: Line[] = [];
  const problems: Array<{ line: number; message: string }> = [];
  let open: { char: string; length: number; line: number } | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const no = i + 1;
    if (open === null) {
      const match = FENCE_OPEN.exec(raw);
      if (match?.[2] !== undefined) {
        if (match[2].startsWith('`') && (match[3] ?? '').includes('`')) {
          // An inline span that happens to start a line, e.g. ```x``` — not a fence.
          prose.push({ no, text: raw });
          continue;
        }
        open = { char: match[2][0] ?? '`', length: match[2].length, line: no };
        continue;
      }
      if (/\S\s*`{3,}/.test(raw)) {
        problems.push({
          line: no,
          message: 'a fence marker (```) in the middle of a line; a fence starts its own line',
        });
      }
      prose.push({ no, text: raw });
      continue;
    }
    const trimmed = raw.trim();
    const run = new RegExp(`^\\${open.char}{${open.length},}$`).test(trimmed);
    if (run) {
      open = null;
      continue;
    }
    const lead = new RegExp(`^\\${open.char}{3,}`).exec(trimmed);
    if (lead !== null) {
      problems.push({
        line: no,
        message: `a line starting with a fence marker closes nothing: the fence opened at line ${open.line} needs a bare ${open.char.repeat(open.length)} on its own line (text after the marker means it does not close)`,
      });
    } else if (new RegExp(`\\${open.char}{${open.length},}`).test(raw)) {
      problems.push({
        line: no,
        message: `a fence marker in the middle of a line inside the fence opened at line ${open.line}`,
      });
    }
    fenced.push({ no, text: raw });
  }
  if (open !== null)
    problems.push({ line: open.line, message: 'a code fence is opened here and never closed' });
  return { prose, fenced, problems };
}

interface Span {
  readonly line: number;
  readonly text: string;
}

/** Inline code spans, paragraph by paragraph so a span may wrap across lines. */
export function inlineSpans(prose: readonly Line[]): Span[] {
  const spans: Span[] = [];
  let block: Line[] = [];
  const flush = (): void => {
    if (block.length === 0) return;
    const joined = block.map((l) => l.text).join('\n');
    const lineStarts: number[] = [];
    let offset = 0;
    for (const l of block) {
      lineStarts.push(offset);
      offset += l.text.length + 1;
    }
    for (const match of joined.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
      const at = match.index ?? 0;
      let idx = 0;
      for (let k = 0; k < lineStarts.length; k++) if ((lineStarts[k] ?? 0) <= at) idx = k;
      const body = (match[2] ?? '').replace(/\s*\n\s*/g, ' ').trim();
      spans.push({ line: block[idx]?.no ?? 0, text: body });
    }
    block = [];
  };
  for (const l of prose) {
    if (l.text.trim() === '') flush();
    else block.push(l);
  }
  flush();
  return spans;
}

function withoutSpans(text: string): string {
  return text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, ' ');
}

function stripComment(line: string): string {
  // A shell comment line is documentation about the command, not a command.
  return /^\s*#/.test(line) ? '' : line;
}

// ------------------------------------------------------------- the checks

const JUST_AT_COMMAND =
  /(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+|\$\s+)(?:sudo\s+)?(?:[A-Z][A-Z0-9_]*=\S*\s+)*just\s+(?:--?[A-Za-z-]+(?:=\S+)?\s+)*([A-Za-z_][\w-]*)/g;

export function recipeRefs(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(JUST_AT_COMMAND)) {
    const name = match[1];
    if (name !== undefined && !name.endsWith('-')) out.push(name);
  }
  return out;
}

const ENV_ASSIGN = /(?:^|[\s;&|(]|export\s+)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=/g;
const ENV_BRACE = /\$\{([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?::?[-+=?][^}]*)?\}/g;

export function envRefs(command: string): string[] {
  const out = new Set<string>();
  for (const match of command.matchAll(ENV_ASSIGN)) if (match[1]) out.add(match[1]);
  for (const match of command.matchAll(ENV_BRACE)) if (match[1]) out.add(match[1]);
  return [...out];
}

const SECRET_PATH =
  /(?:secrets\/|\$\{SECRETS_DIR\}\/|\$SECRETS_DIR\/|SECRETS_DIR\}\/)([a-z][a-z0-9_]*)(?![\w/-])/g;

export function secretRefs(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(SECRET_PATH)) if (match[1]) out.add(match[1]);
  return [...out];
}

const REPO_PATH =
  /^(?:\.\/)?((?:docs|scripts|docker|packages|apps|\.github|test)\/[A-Za-z0-9_.@/-]*[A-Za-z0-9_@/-]|compose(?:\.dev)?\.yml|justfile|README\.md|RUNBOOK\.md|\.env\.example|THIRD_PARTY\.md|renovate\.json)(?::\d+(?:[-–]\d+)?)?$/;

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  const { prose } = parseFences(markdown);
  for (const { text } of prose) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
    if (match?.[1] === undefined) continue;
    const base = match[1]
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

export function checkDoc(
  file: string,
  text: string,
  facts: Facts,
  fs: TreeFs,
): { problems: DocProblem[]; counts: DocCounts } {
  const problems: DocProblem[] = [];
  const counts: DocCounts = { recipes: 0, env: 0, secrets: 0, links: 0, paths: 0 };
  const add = (line: number, kind: ProblemKind, message: string): void => {
    problems.push({ file, line, kind, message });
  };

  const parsed = parseFences(text);
  for (const p of parsed.problems) add(p.line, 'fence', p.message);
  const spans = inlineSpans(parsed.prose);

  // "command" text: inline spans and fenced lines (comments excluded).
  const commands: Array<{ line: number; text: string }> = [
    ...spans.map((s) => ({ line: s.line, text: s.text })),
    ...parsed.fenced.map((l) => ({ line: l.no, text: stripComment(l.text) })),
  ];

  const seenRecipe = new Set<string>();
  const seenEnv = new Set<string>();
  const seenSecret = new Set<string>();

  for (const c of commands) {
    for (const name of recipeRefs(c.text)) {
      counts.recipes++;
      const key = `${c.line}:${name}`;
      if (seenRecipe.has(key)) continue;
      seenRecipe.add(key);
      if (!facts.recipes.has(name))
        add(
          c.line,
          'recipe',
          `\`just ${name}\` is named here but the justfile has no recipe ${name}`,
        );
    }
  }

  // Environment variables: whole-span names plus assignments and ${NAME} refs.
  const envNamed: Array<{ line: number; name: string }> = [];
  for (const s of spans) {
    if (ENV_NAME.test(s.text)) envNamed.push({ line: s.line, name: s.text });
    for (const name of envRefs(s.text)) envNamed.push({ line: s.line, name });
  }
  for (const l of parsed.fenced) {
    for (const name of envRefs(stripComment(l.text))) envNamed.push({ line: l.no, name });
  }
  for (const { line, name } of envNamed) {
    const key = `${line}:${name}`;
    if (seenEnv.has(key)) continue;
    seenEnv.add(key);
    counts.env++;
    if (NOT_ENV.has(name)) continue;
    if (facts.envExample.has(name)) continue;
    if (facts.schemaKeys.has(name)) {
      add(
        line,
        'env',
        `${name} is read by the @core/config schema but .env.example never documents it; an operator cannot find it`,
      );
    } else if (!facts.operatorTokens.has(name)) {
      add(
        line,
        'env',
        `${name} is named here but is not in .env.example, the @core/config schema, compose.yml, the justfile, scripts/ or docker/`,
      );
    }
  }

  // Secrets: paths anywhere in command text and prose spans, plus bare names.
  const secretText: Array<{ line: number; text: string }> = [
    ...commands,
    ...parsed.fenced.map((l) => ({ line: l.no, text: l.text })),
  ];
  for (const c of secretText) {
    for (const name of secretRefs(c.text)) {
      const key = `${c.line}:${name}`;
      if (seenSecret.has(key)) continue;
      seenSecret.add(key);
      counts.secrets++;
      if (!facts.composeSecrets.has(name))
        add(
          c.line,
          'secret',
          `secret ${name} is named here but compose.yml declares no secret ${name}`,
        );
    }
  }
  for (const s of spans) {
    if (!/^[a-z][a-z0-9_]*$/.test(s.text) || !SECRET_SUFFIX.test(s.text)) continue;
    if (NOT_SECRET.has(s.text)) continue;
    const key = `${s.line}:${s.text}`;
    if (seenSecret.has(key)) continue;
    seenSecret.add(key);
    counts.secrets++;
    if (!facts.composeSecrets.has(s.text))
      add(
        s.line,
        'secret',
        `secret ${s.text} is named here but compose.yml declares no secret ${s.text}`,
      );
  }

  // Repo paths named in inline code.
  for (const s of spans) {
    const match = REPO_PATH.exec(s.text);
    if (match?.[1] === undefined) continue;
    counts.paths++;
    if (!fs.exists(match[1]))
      add(s.line, 'path', `${match[1]} is named here but does not exist in the tree`);
  }

  // Relative links, outside code.
  const proseText = parsed.prose.map((l) => l.text);
  const selfSlugs = headingSlugs(text);
  for (let i = 0; i < parsed.prose.length; i++) {
    const line = parsed.prose[i];
    if (line === undefined) continue;
    const clean = withoutSpans(proseText[i] ?? '');
    const targets: string[] = [];
    for (const match of clean.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
      if (match[1]) targets.push(match[1]);
    const ref = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(clean);
    if (ref?.[1]) targets.push(ref[1]);
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
      counts.links++;
      const [pathPart = '', anchor] = target.split('#', 2);
      if (pathPart === '') {
        if (anchor !== undefined && anchor !== '' && !selfSlugs.has(anchor))
          add(line.no, 'link', `#${anchor} is not a heading in ${file}`);
        continue;
      }
      const resolved = posix.normalize(
        posix.join(posix.dirname(file), decodeURIComponent(pathPart)),
      );
      if (resolved.startsWith('..') || !fs.exists(resolved)) {
        add(line.no, 'link', `${target} does not resolve to a file (${resolved})`);
        continue;
      }
      if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')) {
        const body = fs.read(resolved);
        if (body !== null && !headingSlugs(body).has(anchor))
          add(line.no, 'link', `#${anchor} is not a heading in ${resolved}`);
      }
    }
  }

  problems.sort((a, b) => a.line - b.line);
  return { problems, counts };
}

export interface TreeResult {
  docs: string[];
  problems: DocProblem[];
  counts: DocCounts;
}

export function checkTree(root: string, facts: Facts = loadFacts(root)): TreeResult {
  const fs = diskFs(root);
  const result: TreeResult = {
    docs: [],
    problems: [],
    counts: { recipes: 0, env: 0, secrets: 0, links: 0, paths: 0 },
  };
  for (const doc of DOCS) {
    const text = fs.read(doc);
    if (text === null) {
      result.problems.push({ file: doc, line: 0, kind: 'path', message: `${doc} does not exist` });
      continue;
    }
    result.docs.push(doc);
    const one = checkDoc(doc, text, facts, fs);
    result.problems.push(...one.problems);
    for (const key of Object.keys(result.counts) as Array<keyof DocCounts>)
      result.counts[key] += one.counts[key];
  }
  return result;
}

// --------------------------------------------------------------- self-test

const FIXTURE_FACTS: Facts = {
  recipes: new Set(['up', 'backup', 'upgrade']),
  envExample: new Set(['PUBLIC_HOST']),
  schemaKeys: new Set(['PUBLIC_HOST', 'WORKER_CONCURRENCY']),
  operatorTokens: new Set(['FORCE_RESTORE', 'PUBLIC_HOST']),
  composeSecrets: new Set(['master_key', 'database_url']),
};

interface Fixture {
  readonly name: string;
  readonly doc: string;
  /** The kinds the check must report, sorted; empty means it must pass. */
  readonly expect: readonly ProblemKind[];
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'a clean doc passes',
    doc: [
      'Run `just up`.',
      '',
      '```bash',
      'PUBLIC_HOST=x.lan just upgrade',
      'FORCE_RESTORE=1 just backup',
      '```',
      '',
      'It reads `secrets/master_key`. See [self](#fixture).',
      '',
      '# Fixture',
    ].join('\n'),
    expect: [],
  },
  {
    name: 'a recipe the justfile lacks',
    doc: 'Run `just nothing-like-this`.\n',
    expect: ['recipe'],
  },
  {
    name: 'a recipe in a fence',
    doc: '```bash\nsudo just nothing-like-this\n```\n',
    expect: ['recipe'],
  },
  { name: 'a variable nothing defines', doc: 'Set `NOTHING_LIKE_THIS=1`.\n', expect: ['env'] },
  {
    name: 'a variable the schema reads but .env.example omits',
    doc: 'Set `WORKER_CONCURRENCY=2`.\n',
    expect: ['env'],
  },
  {
    name: 'a secret compose.yml does not declare',
    doc: 'Write `secrets/nothing_like`.\n',
    expect: ['secret'],
  },
  {
    name: 'a bare secret name compose.yml does not declare',
    doc: 'The optional `migrator_database_url` secret.\n',
    expect: ['secret'],
  },
  { name: 'an unclosed fence', doc: '```bash\njust up\n', expect: ['fence'] },
  {
    name: 'a closer with trailing text, balanced later (the CF-14 restore-drill sample)',
    doc: '````\nsample\n``` It needs the stack\nmore\n````\n',
    expect: ['fence'],
  },
  { name: 'a link to a missing file', doc: 'See [x](docs/nope.md).\n', expect: ['link'] },
  { name: 'a link to a missing anchor', doc: '# A\n\nSee [x](#b).\n', expect: ['link'] },
  { name: 'a code path that does not exist', doc: 'Read `docs/nope.md`.\n', expect: ['path'] },
  {
    name: 'prose that uses the word just',
    doc: 'Just wait, it is just a moment, just before the restart.\n',
    expect: [],
  },
];

export function runSelfTest(): { failures: string[] } {
  const failures: string[] = [];
  const fs = memoryFs({});
  for (const fx of FIXTURES) {
    const kinds = checkDoc('fixture.md', fx.doc, FIXTURE_FACTS, fs)
      .problems.map((p) => p.kind)
      .sort();
    const want = [...fx.expect].sort();
    if (kinds.join(',') !== want.join(','))
      failures.push(`${fx.name}: expected [${want.join(', ')}], got [${kinds.join(', ')}]`);
  }
  return { failures };
}

// -------------------------------------------------------------------- main

function selfTest(): number {
  const { failures } = runSelfTest();
  if (failures.length > 0) {
    for (const f of failures) console.error(`check-docs: SELF-TEST FAILED: ${f}`);
    return 1;
  }
  console.log(`check-docs: self-test PASS (${FIXTURES.length} fixtures, every rule seen to fail)`);
  return 0;
}

function main(argv: readonly string[]): number {
  // The rules are checked against fixtures that violate them first, so a pass
  // on the real tree is never a control nobody has watched fail.
  if (selfTest() !== 0) return 1;
  if (argv.includes('--self-test')) return 0;
  const root = dirname(import.meta.dirname);
  const result = checkTree(root);
  for (const p of result.problems) console.error(`${p.file}:${p.line}: ${p.kind}: ${p.message}`);
  if (result.problems.length > 0) {
    console.error(
      `check-docs: FAIL (${result.problems.length} finding(s) in ${result.docs.join(', ')})`,
    );
    return 1;
  }
  const c = result.counts;
  console.log(
    `check-docs: PASS (${result.docs.join(', ')}: ${c.recipes} recipe, ${c.env} variable, ${c.secrets} secret, ${c.links} link, ${c.paths} path reference(s))`,
  );
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exit(main(process.argv.slice(2)));
}
