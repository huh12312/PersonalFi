#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Publish the advisory catalogue's description (WP 11.5b; 12 §2.1: "its
 * OpenAPI is the contract the compiler is shown").
 *
 * `catalogueDescription()` is generated from the definitions `callCatalogue`
 * runs; this writes it to `packages/contracts/advisor/catalogue/<file>` for the
 * current `CATALOGUE_VERSION`, formatted by the repo's prettier, and prints
 * the digest `CATALOGUE_DESCRIPTION_DIGEST` must carry.
 * `packages/contexts/insights/test/catalogue-pin.test.ts` holds both pins;
 * `--check` is the same comparison without a test runner.
 *
 *   node scripts/advisor-catalogue-gen.ts           # write the file, print the digest
 *   node scripts/advisor-catalogue-gen.ts --check   # exit 1 if file or digest drifted
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as prettier from 'prettier';
import {
  CATALOGUE_DESCRIPTION_DIGEST,
  CATALOGUE_DESCRIPTION_FILE,
  catalogueDescription,
  catalogueDescriptionDigest,
  serialiseCatalogueDescription,
} from '../packages/contexts/insights/src/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
export const CATALOGUE_DIR = join(REPO_ROOT, 'packages', 'contracts', 'advisor', 'catalogue');

/** The description as the file holds it: serialised, then prettier's JSON formatting. */
export async function emittedCatalogueFile(): Promise<string> {
  const target = join(CATALOGUE_DIR, CATALOGUE_DESCRIPTION_FILE);
  const config = (await prettier.resolveConfig(target)) ?? {};
  return prettier.format(serialiseCatalogueDescription(catalogueDescription()), {
    ...config,
    filepath: target,
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const target = join(CATALOGUE_DIR, CATALOGUE_DESCRIPTION_FILE);
  const where = relative(REPO_ROOT, target);
  const emitted = await emittedCatalogueFile();
  const digest = catalogueDescriptionDigest(catalogueDescription());
  if (argv.includes('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== emitted || digest !== CATALOGUE_DESCRIPTION_DIGEST) {
      console.error(
        `catalogue: ${where} or CATALOGUE_DESCRIPTION_DIGEST has drifted from the definitions ` +
          `(digest now ${digest}). Bump CATALOGUE_VERSION, or move the pin deliberately: ` +
          '`node scripts/advisor-catalogue-gen.ts` and update the digest.',
      );
      return 1;
    }
    console.log(`catalogue: ${where} matches the definitions (${digest})`);
    return 0;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, emitted);
  console.log(`catalogue: wrote ${where}\nCATALOGUE_DESCRIPTION_DIGEST = '${digest}'`);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exit(await main(process.argv.slice(2)));
}
