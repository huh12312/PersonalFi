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

  /**
   * WP 4.9's bump, named as the dispatch names it. 1.2.0 was taken by WP 4.12b's
   * C-10 (`excluded_currencies`), so `plan.projection` is 1.3.0 — the dispatch
   * table's "1.2.0" was written before C-10 landed. What the test holds is the
   * same: the files on disk are exactly what the zod definitions emit *at this
   * version*, and the version-bearing artefacts all say the same version.
   */
  it('the published schemas match the source at 1.3.0 (historical)', () => {
    // Superseded by 1.4.0 below; kept as the record of what 1.3.0 added,
    // checked against fields that are still present and unmoved.
    const request = readContract('v1', 'request.schema.json');
    expect(request).toContain('"plan.projection"');
    expect(request).toContain('"plan_projection"');
    expect(request).toContain('"success_probability"');
    expect(request).toContain('"required_monthly"');
  });

  /**
   * WP 5.7's bump. `transactions.anomalies` and `fees.summary` — S1, S5 and
   * the fee hunter's scopes — land in the same commit as migration 0029,
   * which widens `snapshot_grants_scope_check` to match (05 §4's
   * non-negotiable pairing). Strictly additive over 1.3.0: both scopes are
   * appended after `plan.projection`, so every position a 1.3.0 reader relied
   * on is where it was.
   */
  it('the published schemas match the source at 1.4.0 (historical)', () => {
    // Superseded by 1.5.0 below; kept as the record of what 1.4.0 added,
    // checked against fields that are still present and unmoved.
    // The additions 1.4.0 is for, present in the published request schema:
    // the two scopes in the wire enum and their blocks.
    const request = readContract('v1', 'request.schema.json');
    expect(request).toContain('"transactions.anomalies"');
    expect(request).toContain('"transactions_anomalies"');
    expect(request).toContain('"deviation_multiple"');
    expect(request).toContain('"first_seen_merchant"');
    expect(request).toContain('"fees.summary"');
    expect(request).toContain('"fees_summary"');
    expect(request).toContain('"expense_ratio_drag"');
    // Strictly additive: the two scopes are the enum's last two members, in
    // the order they were appended, so every position a 1.3.0 reader relied
    // on is where it was.
    // Positions, not `length - n`: 1.7.0 appended one more member after them,
    // and "where it was" is exactly what an append preserves.
    expect(ADVISOR_SCOPES[16]).toBe('transactions.anomalies');
    expect(ADVISOR_SCOPES[17]).toBe('fees.summary');
  });

  /**
   * WP 5.3's bump. `AdvisorRequest.findings` — the narration envelope a
   * `narrates_only` advisor is handed — is an **envelope field, not a scope**,
   * so 1.5.0 ships alone: no migration widens `snapshot_grants_scope_check`,
   * and the scope enum is exactly 1.4.0's (the second half below). Strictly
   * additive: `findings` is optional, so every 1.4.0 request is a 1.5.0
   * request.
   */
  it('the published schemas match the source at 1.5.0 (historical)', () => {
    // Superseded by 1.6.0 below; kept as the record of what 1.5.0 added,
    // checked against fields that are still present and unmoved.

    // The envelope, as a sidecar author would read it off the published file:
    // optional (not in `required`), at most five, each finding a strict object
    // carrying what a narration must match.
    const request = JSON.parse(readContract('v1', 'request.schema.json')) as {
      properties: Record<string, Record<string, unknown>>;
      required: readonly string[];
    };
    const findings = request.properties['findings'] as {
      type: string;
      minItems: number;
      maxItems: number;
      items: { required: readonly string[]; additionalProperties: boolean };
    };
    expect(findings.type).toBe('array');
    expect(findings.minItems).toBe(1);
    expect(findings.maxItems).toBe(5);
    expect(request.required).not.toContain('findings');
    expect(findings.items.additionalProperties).toBe(false);
    for (const field of ['key', 'period', 'type', 'severity', 'evidence', 'derived', 'impact']) {
      expect(findings.items.required, field).toContain(field);
    }

    // An envelope field, not a scope: the wire enum is 1.4.0's, unchanged,
    // which is why there is no 0029-style migration beside this bump
    // (`apps/api/test/phase3-registration.test.ts` tracks scopes only). The
    // first eighteen members are still 1.4.0's; 1.7.0 appended a nineteenth.
    expect(ADVISOR_SCOPES.slice(0, 18)).toHaveLength(18);
    expect(ADVISOR_SCOPES[17]).toBe('fees.summary');
  });

  /**
   * WP 9.5's bump (option B, the Phase 5 gate's R-2): the narration envelope's
   * figure slots. `findings[].placed_figures` (the literal `true`) and
   * `findings[].evidence[].slot` (`e1`…`e99`) are both optional and written by
   * the app, never by an advisor, so every 1.5.0 request is a 1.6.0 request.
   * An envelope change, not a scope: no migration, the scope enum unchanged.
   */
  it('the published schemas match the source at 1.6.0 (historical)', () => {
    // Superseded by 1.7.0 below; kept as the record of what 1.6.0 added,
    // checked against fields that are still present and unmoved.
    const request = JSON.parse(readContract('v1', 'request.schema.json')) as {
      properties: Record<string, Record<string, unknown>>;
    };
    const finding = (
      request.properties['findings'] as {
        items: {
          required: readonly string[];
          properties: Record<string, Record<string, unknown>>;
        };
      }
    ).items;
    expect(finding.properties['placed_figures']).toEqual({ type: 'boolean', const: true });
    expect(finding.required).not.toContain('placed_figures');
    const row = (
      finding.properties['evidence'] as {
        items: { required: readonly string[]; properties: Record<string, Record<string, unknown>> };
      }
    ).items;
    expect(row.properties['slot']?.['pattern']).toBe('^e[1-9][0-9]?$');
    expect(row.required).not.toContain('slot');
    // An envelope change: the first eighteen scope members are 1.4.0's.
    expect(ADVISOR_SCOPES[17]).toBe('fees.summary');
  });

  /**
   * WP 11.1's bump. `categorization.rule_candidates` — the rule-suggestion
   * advisor's input — and its `rule_candidates` block land in the same change
   * as migration 0054, which widens `snapshot_grants_scope_check` to match.
   * Strictly additive over 1.6.0: the scope is appended as the enum's
   * nineteenth member and the block is an optional snapshot property, so
   * every 1.6.0 request is a 1.7.0 request.
   */
  it('the published schemas match the source at 1.7.0 (historical)', () => {
    // Superseded by 1.8.0 below; kept as the record of what 1.7.0 added.
    expect(ADVISOR_SCOPES[18]).toBe('categorization.rule_candidates');

    const request = JSON.parse(readContract('v1', 'request.schema.json')) as {
      properties: {
        snapshot: {
          properties: Record<string, Record<string, unknown>>;
          required?: readonly string[];
        };
      };
    };
    const snapshot = request.properties.snapshot;
    expect(snapshot.required ?? []).not.toContain('rule_candidates');
    const block = snapshot.properties['rule_candidates'] as {
      additionalProperties: boolean;
      properties: {
        merchants: {
          maxItems: number;
          items: {
            additionalProperties: boolean;
            required: readonly string[];
            properties: Record<string, Record<string, unknown>>;
          };
        };
      };
    };
    expect(block.additionalProperties).toBe(false);
    expect(block.properties.merchants.maxItems).toBe(64);
    const row = block.properties.merchants.items;
    expect(row.additionalProperties).toBe(false);
    expect([...row.required].sort()).toEqual(
      [
        'category_ref',
        'category_slug',
        'confirmations',
        'covered_by_rule',
        'locked_default',
        'merchant_ref',
        'transactions',
      ].sort(),
    );
    expect(row.properties['transactions']?.['maxItems']).toBe(8);
    // No amount, no date, no name: the block's whole minimisation, readable off the file.
    expect(Object.keys(row.properties).sort()).toEqual([...row.required].sort());
  });

  /**
   * WP 11.2's bump. `transactions.residue` — `categorize.suggest`'s input —
   * lands in the same change as migration 0056, which widens
   * `snapshot_grants_scope_check`. Strictly additive over 1.7.0: the scope is
   * appended as the enum's twentieth member, and it has **no** snapshot block
   * (the suggestion payload is built per run from the merchant cache, not by
   * `SnapshotBuilder`), so every 1.7.0 request is a 1.8.0 request.
   */
  it('the published schemas match the source at 1.8.0', () => {
    expect(ADVISOR_ARTEFACT_VERSION).toBe('1.8.0');
    for (const document of advisorSchemaDocuments()) {
      const onDisk = JSON.parse(readContract('v1', document.file)) as Record<string, unknown>;
      expect(onDisk['artefactVersion'], document.file).toBe('1.8.0');
      expect(serialiseSchema(document.document), document.file).toBe(serialiseSchema(onDisk));
    }
    const index = JSON.parse(readContract('advisor.schema.json')) as Record<string, unknown>;
    expect(index['artefactVersion']).toBe('1.8.0');
    expect(ADVISOR_SCOPES).toHaveLength(20);
    expect(ADVISOR_SCOPES[19]).toBe('transactions.residue');
    const request = JSON.parse(readContract('v1', 'request.schema.json')) as {
      properties: { snapshot: { properties: Record<string, unknown> } };
    };
    expect(request.properties.snapshot.properties['transactions_residue']).toBeUndefined();
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
