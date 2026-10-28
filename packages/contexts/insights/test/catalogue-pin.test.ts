// SPDX-License-Identifier: MIT
/**
 * The catalogue's published description cannot drift from the definitions the
 * runtime runs (WP 11.5b; 12 §2.1: "the catalogue is versioned and its OpenAPI
 * is the contract the compiler is shown").
 *
 * Two pins, both over `catalogueDescription()`:
 *
 *   1. it is exactly the checked-in
 *      `packages/contracts/advisor/catalogue/catalogue-<n>.json` for the
 *      current `CATALOGUE_VERSION` (compared parsed and re-serialised, so
 *      prettier's line breaking is not a difference — `contract-parity.test.ts`'s
 *      rule);
 *   2. its digest is `CATALOGUE_DESCRIPTION_DIGEST`.
 *
 * A change to any function's name, scopes, words, parameters or result shape
 * turns both red. The way back is a decision: bump the version (a new file) or
 * move the pin in the same diff (`node scripts/advisor-catalogue-gen.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  catalogueDescription,
  catalogueDescriptionDigest,
  serialiseCatalogueDescription,
  type CatalogueDescription,
} from '../src/catalogue/catalogue.ts';
import {
  CATALOGUE_DESCRIPTION_DIGEST,
  CATALOGUE_DESCRIPTION_FILE,
  CATALOGUE_VERSION,
} from '../src/catalogue/version.ts';

const PUBLISHED = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'advisor',
  'catalogue',
  CATALOGUE_DESCRIPTION_FILE,
);

describe('the catalogue description pin', () => {
  it('names its version in the file it is published as', () => {
    expect(CATALOGUE_VERSION).toBe('catalogue/1');
    expect(CATALOGUE_DESCRIPTION_FILE).toBe(
      `catalogue-${CATALOGUE_VERSION.split('/')[1] ?? ''}.json`,
    );
  });

  it('the published file is exactly what the definitions describe', () => {
    const onDisk = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as CatalogueDescription;
    expect(serialiseCatalogueDescription(catalogueDescription())).toBe(
      serialiseCatalogueDescription(onDisk),
    );
  });

  it('the description’s digest is the pinned one — change a definition and this goes red', () => {
    expect(catalogueDescriptionDigest(catalogueDescription())).toBe(CATALOGUE_DESCRIPTION_DIGEST);
  });

  it('is generated deterministically', () => {
    expect(serialiseCatalogueDescription(catalogueDescription())).toBe(
      serialiseCatalogueDescription(catalogueDescription()),
    );
  });

  it('describes every function with its scopes, parameters and result, the shared shapes once', () => {
    const description = catalogueDescription();
    expect(description.functions).toHaveLength(19);
    expect(Object.keys(description.$defs)).toEqual(
      expect.arrayContaining(['DateFigure', 'DecimalFigure', 'Finding', 'Money', 'MoneyFigure']),
    );
    for (const entry of description.functions) {
      expect(entry.scopes.length, entry.name).toBeGreaterThan(0);
      expect(entry.parameters['type'], entry.name).toBe('object');
      expect(entry.result['type'], entry.name).toBe('object');
    }
    expect(description.envelope['properties']).toHaveProperty('inputs');
  });
});
