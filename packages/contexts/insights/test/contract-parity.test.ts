// SPDX-License-Identifier: MIT
/**
 * The published artefact and the running validator cannot drift.
 *
 * 08 §4.4 says the JSON Schema files are normative and "the TypeScript types
 * are generated from them, not vice versa". `contract/json-schema.ts`'s header
 * explains why this build inverts the *direction* — generating TypeScript from
 * JSON Schema needs a code generator, and validating the wire against the files
 * at runtime needs Ajv; both are dependencies this work package may not add.
 *
 * This test is what keeps the *property* the sentence was protecting. It
 * re-emits every document from the zod definitions and compares it, byte for
 * byte, with the file checked into `packages/contracts/advisor/v1/`. A zod edit
 * that is not reflected in the published schema fails. A hand-edit of the
 * published schema fails too. Drift is a red test rather than a discovery in
 * Phase 5.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADVISOR_CONTRACT_MAJOR,
  ADVISOR_SCHEMA_BASE,
  SUPPORTED_CONTRACT_MAJORS,
} from '../src/contract/version.ts';
import {
  ADVISOR_ARTEFACT_VERSION,
  advisorSchemaDocuments,
  serialiseSchema,
} from '../src/contract/json-schema.ts';
import { ADVISOR_SCOPES } from '../src/contract/scopes.ts';

const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', '..', 'contracts', 'advisor');

function readContract(...parts: string[]): string {
  return readFileSync(join(CONTRACTS_DIR, ...parts), 'utf8');
}

describe('contract parity', () => {
  it('every published document is exactly what the zod definitions emit', () => {
    for (const document of advisorSchemaDocuments()) {
      const emitted = serialiseSchema(document.document);
      // Both sides go through `serialiseSchema`, which is the canonical form,
      // and the on-disk file is re-serialised rather than read as text. The
      // reason is mechanical: the published files are under prettier (only
      // `openapi/openapi.json` is in `.prettierignore`), and prettier collapses
      // a short `"enum": [...]` onto one line where `JSON.stringify(…, 2)` does
      // not. Comparing raw bytes would make `pnpm lint:format` and this test
      // demand different files.
      //
      // What the comparison still catches is everything that matters: any
      // change to a key, a value, a type, a constraint — and **key order**,
      // because `JSON.parse` preserves insertion order for non-numeric keys and
      // `JSON.stringify` re-emits it. The only difference it now tolerates is
      // line breaking, which is precisely prettier's business and nobody
      // else's.
      const onDisk = serialiseSchema(
        JSON.parse(readContract('v1', document.file)) as Record<string, unknown>,
      );
      expect(emitted, document.file).toBe(onDisk);
    }
  });

  it('the bundle index names the three documents and the wire major', () => {
    const index = JSON.parse(readContract('advisor.schema.json')) as Record<string, unknown>;
    expect(index['contractVersion']).toBe(ADVISOR_CONTRACT_MAJOR);
    expect(index['artefactVersion']).toBe(ADVISOR_ARTEFACT_VERSION);
    expect(index['supportedContractVersions']).toEqual([...SUPPORTED_CONTRACT_MAJORS]);

    const documents = index['documents'] as Record<string, { $ref: string }>;
    for (const document of advisorSchemaDocuments()) {
      const name = document.file.replace('.schema.json', '');
      expect(documents[name]?.$ref, name).toBe(`${ADVISOR_SCHEMA_BASE}/${document.file}`);
    }
  });

  it('the two version numbers agree, and disagree about the right thing', () => {
    // `@core/contracts` is *data* — its boundary layer allows `@core/kernel` and
    // nothing else — so the constants are read from the file rather than
    // imported, which is also what makes this test able to catch a hand-edit.
    const source = readFileSync(join(CONTRACTS_DIR, '..', 'src', 'index.ts'), 'utf8');
    expect(source).toContain(
      `export const ADVISOR_CONTRACT_VERSION = '${ADVISOR_ARTEFACT_VERSION}'`,
    );
    expect(source).toContain(
      `export const ADVISOR_CONTRACT_MAJOR = ${String(ADVISOR_CONTRACT_MAJOR)}`,
    );
    // The wire major must be the semver's leading component, or a sidecar
    // pinning `1` and a checkout publishing `2.0.0` would both believe they
    // agreed.
    expect(ADVISOR_ARTEFACT_VERSION.split('.')[0]).toBe(String(ADVISOR_CONTRACT_MAJOR));
  });

  it('the published scope enum is the catalogue', () => {
    const request = JSON.parse(readContract('v1', 'request.schema.json')) as Record<
      string,
      unknown
    >;
    const serialised = JSON.stringify(request);
    for (const scope of ADVISOR_SCOPES) {
      expect(serialised, scope).toContain(`"${scope}"`);
    }
  });

  it('the published response schema forbids a status property and pins requires_review', () => {
    const response = JSON.parse(readContract('v1', 'response.schema.json')) as Record<
      string,
      unknown
    >;
    const serialised = JSON.stringify(response);
    // The two sentences a sidecar author must be able to read off the file.
    expect(serialised).toContain('"requires_review"');
    expect(serialised).toContain('"const":true');
    expect(serialised).toContain('"additionalProperties":false');
    expect(serialised).not.toContain('"status"');
    for (const forbidden of ['"execute"', '"transfer"', '"trade"']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });
});
