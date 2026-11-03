// SPDX-License-Identifier: MIT
/**
 * The licence policy, read once and applied the same way to every ecosystem
 * (memo 06 §5.4, master plan D15). `licenses.policy.yaml` is the single list;
 * `check-licenses.ts` applies it to the npm tree and `python-licenses.ts`
 * (WP 12.6) to the yahoo sidecar's pinned Python closure. One classifier, so
 * the two trees cannot drift into two readings of the same policy.
 *
 * No YAML dependency (D14): the policy file uses exactly one flat-list shape,
 * parsed by hand below.
 */
import { readFileSync } from 'node:fs';

export interface Policy {
  readonly allow: string[];
  readonly reviewRequired: string[];
  readonly deny: string[];
  readonly denyPackages: string[];
}

export type Classification = 'allow' | 'review' | 'deny' | 'unknown';

/**
 * Parses exactly the shape `licenses.policy.yaml` uses: top-level
 * `key:` followed by `  - item` lines. Not a general YAML parser.
 */
export function parseSimpleYamlLists(text: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let currentKey: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;

    const listItemMatch = /^\s*-\s*(.+)$/.exec(line);
    if (listItemMatch) {
      if (currentKey === null) {
        throw new Error(`licenses.policy.yaml: list item with no preceding key: "${rawLine}"`);
      }
      const value = listItemMatch[1]?.trim();
      if (value !== undefined && value.length > 0) {
        result[currentKey]?.push(value);
      }
      continue;
    }

    const keyMatch = /^([A-Za-z][\w-]*):\s*$/.exec(line);
    if (keyMatch?.[1] !== undefined) {
      currentKey = keyMatch[1];
      result[currentKey] = [];
      continue;
    }

    throw new Error(`licenses.policy.yaml: could not parse line: "${rawLine}"`);
  }

  return result;
}

export function loadPolicy(path: string): Policy {
  const raw = parseSimpleYamlLists(readFileSync(path, 'utf8'));
  return {
    allow: raw['allow'] ?? [],
    reviewRequired: raw['reviewRequired'] ?? [],
    deny: raw['deny'] ?? [],
    denyPackages: raw['denyPackages'] ?? [],
  };
}

/** Splits an SPDX-ish compound expression ("MIT AND ISC", "(MIT OR CC0-1.0)") into parts. */
export function splitLicenseExpression(expression: string): string[] {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|and|or)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Prefix match so a deny entry like `GPL-2.0` also catches `GPL-2.0-only` / `GPL-2.0-or-later`. */
export function matchesAny(id: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => id === candidate || id.startsWith(candidate));
}

export function classifyExpression(expression: string, policy: Policy): Classification {
  const parts = splitLicenseExpression(expression);
  if (parts.length === 0) return 'unknown';

  const classifications = parts.map((part): Classification => {
    if (matchesAny(part, policy.deny)) return 'deny';
    if (matchesAny(part, policy.allow)) return 'allow';
    if (matchesAny(part, policy.reviewRequired)) return 'review';
    return 'unknown';
  });

  if (classifications.includes('deny')) return 'deny';
  if (classifications.includes('unknown')) return 'unknown';
  if (classifications.includes('review')) return 'review';
  return 'allow';
}
