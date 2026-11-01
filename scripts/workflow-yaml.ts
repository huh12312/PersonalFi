// SPDX-License-Identifier: MIT
/**
 * A small YAML reader for this repository's GitHub Actions workflows (WP 12.2).
 *
 * The root package has no YAML dependency, and adding one for a test is the
 * kind of dependency 06 §5.4 says to prefer not adding. Workflow files use a
 * narrow slice of YAML, and this reads exactly that slice:
 *
 *   - block mappings (`key: value`, `key:` + an indented block) and block
 *     sequences (`- item`, `- key: value` + continuation keys), including a
 *     sequence written at its parent key's own indent;
 *   - literal and folded block scalars (`|`, `|-`, `>`, …), kept verbatim;
 *   - plain, single- and double-quoted scalars, and one-line flow sequences
 *     (`[a, 'b']`);
 *   - full-line and trailing comments (` # …`, outside quotes).
 *
 * Every scalar stays a string (`false` is `'false'`): the tests compare text.
 * Anything outside the slice — anchors, multi-line flow collections, a line
 * indented deeper than its block allows — throws with the line number rather
 * than guessing. WP 12.2's evidence compares this reader's output for
 * `.github/workflows/release.yml` against the `yaml` package's, value for value.
 */

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue } | null;

const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;
const SEQ_ITEM = /^-(?: |$)/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Drops a trailing ` # comment` that is outside single and double quotes. */
export function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] ?? '')))
      return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return text;
}

function scalar(text: string, lineNo: number): YamlValue {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`line ${lineNo}: multi-line flow sequence`);
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => unquote(part.trim()));
  }
  if (text.startsWith('{') || text.startsWith('&') || text.startsWith('*')) {
    throw new Error(`line ${lineNo}: flow mappings, anchors and aliases are outside the slice`);
  }
  return unquote(text);
}

const MAP_ENTRY = /^('[^']*'|"[^"]*"|[^\s'"#\-[{][^:]*?|-[^\s:][^:]*?):(?:[ \t]+(.*))?$/;

export function parseWorkflowYaml(source: string): YamlValue {
  const lines = source.split('\n');
  let i = 0;

  const skip = (): void => {
    while (i < lines.length && BLANK_OR_COMMENT.test(lines[i] ?? '')) i++;
  };

  const blockScalar = (keyIndent: number, header: string): string => {
    const body: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
      body.push(line);
      i++;
    }
    while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
    const first = body.find((line) => line.trim() !== '');
    const strip = first === undefined ? 0 : indentOf(first);
    const text = body.map((line) => line.slice(strip)).join(header.startsWith('>') ? ' ' : '\n');
    return header.endsWith('-') ? text : `${text}\n`;
  };

  const parseBlock = (minIndent: number): YamlValue => {
    skip();
    if (i >= lines.length) return null;
    const line = lines[i] ?? '';
    const indent = indentOf(line);
    if (indent < minIndent) return null;
    return SEQ_ITEM.test(line.trim()) ? parseSeq(indent) : parseMap(indent);
  };

  const parseSeq = (indent: number): YamlValue[] => {
    const out: YamlValue[] = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const line = lines[i] ?? '';
      if (indentOf(line) !== indent || !SEQ_ITEM.test(line.trim())) {
        if (indentOf(line) > indent) throw new Error(`line ${i + 1}: unexpected indent`);
        break;
      }
      const afterDash = line.trimStart().slice(1);
      const rest = afterDash.trimStart();
      if (stripComment(rest) === '') {
        i++;
        out.push(parseBlock(indent + 1));
        continue;
      }
      const restIndent = indent + 1 + (afterDash.length - rest.length);
      if (MAP_ENTRY.test(stripComment(rest))) {
        // `- key: value` opens a mapping whose keys sit at the item's column.
        lines[i] = ' '.repeat(restIndent) + rest;
        out.push(parseMap(restIndent));
      } else {
        const lineNo = i + 1;
        i++;
        out.push(scalar(stripComment(rest), lineNo));
      }
    }
    return out;
  };

  const parseMap = (indent: number): { [key: string]: YamlValue } => {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const line = lines[i] ?? '';
      const lineIndent = indentOf(line);
      if (lineIndent > indent) throw new Error(`line ${i + 1}: unexpected indent`);
      if (lineIndent < indent || SEQ_ITEM.test(line.trim())) break;
      const entry = MAP_ENTRY.exec(stripComment(line.trim()));
      if (entry === null) throw new Error(`line ${i + 1}: not a mapping entry: ${line.trim()}`);
      const key = unquote(entry[1] ?? '');
      if (Object.hasOwn(out, key)) throw new Error(`line ${i + 1}: duplicate key ${key}`);
      const value = (entry[2] ?? '').trim();
      const lineNo = i + 1;
      i++;
      if (value === '') {
        skip();
        const next = lines[i] ?? '';
        if (i < lines.length && indentOf(next) > indent) out[key] = parseBlock(indent + 1);
        else if (i < lines.length && indentOf(next) === indent && SEQ_ITEM.test(next.trim())) {
          out[key] = parseSeq(indent);
        } else out[key] = null;
      } else if (/^[|>][-+]?$/.test(value)) {
        out[key] = blockScalar(indent, value);
      } else {
        out[key] = scalar(value, lineNo);
      }
    }
    return out;
  };

  const doc = parseBlock(0);
  skip();
  if (i < lines.length) throw new Error(`line ${i + 1}: content after the document`);
  return doc;
}
