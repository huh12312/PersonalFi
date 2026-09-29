// SPDX-License-Identifier: MIT
/**
 * The sanitiser's length caps (`src/caps.ts`) against the published request
 * schema, read from disk: `@core/contracts` exports only the bundle index,
 * and `@ctx/insights` is denied to this layer, so a file read in a test is
 * the one way to hold the two together. When a contract minor adds a
 * free-text string (1.5.0's findings, WP 5.3), this goes red until the table
 * names it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRING_CAP, FREE_TEXT_CAPS, RECORD_KEY_CAP } from '../src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'contracts', 'advisor', 'v1', 'request.schema.json');

interface StringSite {
  readonly field: string;
  readonly maxLength: number | null;
  readonly constrained: boolean;
}

type Node = Record<string, unknown>;

function collect(node: unknown, field: string, sites: StringSite[], keyCaps: number[]): void {
  if (node === null || typeof node !== 'object') return;
  const schema = node as Node;
  for (const alternative of ['anyOf', 'oneOf', 'allOf']) {
    const list = schema[alternative];
    if (Array.isArray(list)) for (const item of list) collect(item, field, sites, keyCaps);
  }
  const type = schema['type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('string')) {
    sites.push({
      field,
      maxLength: typeof schema['maxLength'] === 'number' ? schema['maxLength'] : null,
      constrained:
        schema['pattern'] !== undefined ||
        schema['enum'] !== undefined ||
        schema['const'] !== undefined,
    });
  }
  const properties = schema['properties'];
  if (properties !== null && typeof properties === 'object') {
    for (const [name, child] of Object.entries(properties as Node))
      collect(child, name, sites, keyCaps);
  }
  if (schema['items'] !== undefined) collect(schema['items'], field, sites, keyCaps);
  const additional = schema['additionalProperties'];
  if (additional !== null && typeof additional === 'object')
    collect(additional, field, sites, keyCaps);
  const names = schema['propertyNames'] as Node | undefined;
  if (names !== undefined && typeof names['maxLength'] === 'number')
    keyCaps.push(names['maxLength']);
}

describe('caps', () => {
  it('the sanitiser’s length caps agree with the published request schema', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as { properties: Node };
    const sites: StringSite[] = [];
    const keyCaps: number[] = [];
    collect(schema.properties['snapshot'], 'snapshot', sites, keyCaps);
    collect(schema.properties['findings'], 'findings', sites, keyCaps); // absent until 1.5.0

    const free = sites.filter((site) => !site.constrained);
    expect(free.length).toBeGreaterThan(10);

    // Every free-text field the schema has is in the table, at the schema's cap.
    const schemaCaps = new Map<string, number>();
    for (const site of free) {
      expect(site.maxLength, site.field).not.toBeNull();
      schemaCaps.set(site.field, Math.max(schemaCaps.get(site.field) ?? 0, site.maxLength ?? 0));
    }
    expect(Object.fromEntries([...schemaCaps].sort())).toEqual(
      Object.fromEntries(Object.entries(FREE_TEXT_CAPS).sort()),
    );

    // The one data-keyed record, and the ceiling every other string gets.
    expect(keyCaps).toEqual([RECORD_KEY_CAP]);
    const widest = Math.max(...sites.map((site) => site.maxLength ?? 0));
    expect(DEFAULT_STRING_CAP).toBe(widest);
  });
});
