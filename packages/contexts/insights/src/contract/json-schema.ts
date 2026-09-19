// SPDX-License-Identifier: MIT
/**
 * The published JSON Schema documents, emitted from the zod definitions.
 *
 * ## Which direction generation runs, and why it is this one
 *
 * 08 §4.4 says the JSON Schema files are normative and "the TypeScript types are
 * generated from them, not vice versa". The intent behind that sentence is
 * **one definition and a mechanical check that the published artefact matches
 * it** — so that a sidecar author reading `response.schema.json` and a
 * TypeScript caller reading `Insight` cannot be looking at two different
 * contracts.
 *
 * This build inverts the *direction* and keeps the *property*. The reason is
 * concrete rather than aesthetic: generating TypeScript from JSON Schema needs a
 * code generator in the dependency graph, and `@ctx/insights`'s validator has to
 * run against the schema at runtime, which needs a JSON Schema validator (Ajv).
 * Both are new third-party dependencies, and this work package may not add one —
 * docs/CONVENTIONS.md puts every addition behind a seven-day `minimumReleaseAge`
 * and a licence gate, and the orchestrator owns the dependency batch. zod 4 ships
 * `z.toJSONSchema`, which closes the gap with what is already installed.
 *
 * What keeps the property is `test/contract-parity.test.ts`: it re-emits every
 * document from the zod definitions and asserts byte-for-byte equality with the
 * file checked into `packages/contracts/advisor/v1/`. A zod edit that is not
 * reflected in the published schema fails, and a hand-edit of the published
 * schema fails too. Drift is therefore a red test rather than a discovery in
 * Phase 5. **Carried:** if Ajv lands in a later dependency batch, the honest
 * follow-up is to validate the *wire* with Ajv against these files and keep zod
 * for the internal shapes — the files do not change, only the validator does.
 *
 * ## Determinism
 *
 * `z.toJSONSchema` is called with `reused: 'inline'` so a shared sub-schema
 * (`MoneyJsonSchema`, used eleven times) expands identically everywhere instead
 * of producing `$ref`s whose numbering depends on traversal order. The emitter
 * must be deterministic or the parity test becomes a coin flip.
 */
import { z } from 'zod';
import { AdvisorManifestSchema } from './manifest.ts';
import { AdvisorRequestSchema } from './request.ts';
import { AdvisorResponseSchema } from './response.ts';
import { ADVISOR_CONTRACT_MAJOR, ADVISOR_SCHEMA_BASE } from './version.ts';

/**
 * The artefact version. Mirrors `@core/contracts`' `ADVISOR_CONTRACT_VERSION`.
 *
 * Duplicated rather than imported because `@core/contracts` is *data* — its
 * eslint layer allows `@core/kernel` and nothing else, and a context importing
 * a constant from it is fine, but the emitter also has to run in the parity
 * test where the contracts package is read from disk. The parity test asserts
 * the two agree, so the duplication is checked rather than hoped about.
 */
export const ADVISOR_ARTEFACT_VERSION = '1.0.0' as const;

export interface SchemaDocument {
  /** File name under `packages/contracts/advisor/v1/`. */
  readonly file: string;
  readonly document: Record<string, unknown>;
}

function emit(
  schema: z.ZodType,
  input: { readonly file: string; readonly title: string; readonly description: string },
): SchemaDocument {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    reused: 'inline',
    io: 'input',
  }) as Record<string, unknown>;
  // `description` is pulled out and discarded: the top-level zod `.describe()`
  // is a one-line hint for a TypeScript reader, and the published document
  // deserves the longer statement of the rules, which `input.description`
  // carries. Spreading `rest` last would silently reinstate the short one.
  const { $schema, description: _zodDescription, ...rest } = generated;
  return {
    file: input.file,
    // Key order is fixed here rather than left to the generator: the parity test
    // compares serialised text, so "same document, different order" must not be
    // a failure and must not be achievable by accident either.
    document: {
      $schema,
      $id: `${ADVISOR_SCHEMA_BASE}/${input.file}`,
      title: input.title,
      description: input.description,
      contractVersion: ADVISOR_CONTRACT_MAJOR,
      artefactVersion: ADVISOR_ARTEFACT_VERSION,
      ...rest,
    },
  };
}

/** The three normative documents, in the order the bundle lists them. */
export function advisorSchemaDocuments(): readonly SchemaDocument[] {
  return [
    emit(AdvisorRequestSchema, {
      file: 'request.schema.json',
      title: 'PersonalFi AdvisorRequest v1',
      description:
        'What crosses the boundary to an advisor: a minimised, read-only snapshot with one key ' +
        'per granted scope, the digest we stored, and the limits we enforce. One-way — there is ' +
        'no return channel, no token and no handle (08 §4.1).',
    }),
    emit(AdvisorResponseSchema, {
      file: 'response.schema.json',
      title: 'PersonalFi AdvisorResponse v1',
      description:
        'Proposed insights. requires_review is the literal true and there is no status field, so ' +
        'no return value can cause an action; proposed_actions[].kind has four non-acting ' +
        'members; evidence is non-empty at the type level and every source_ref must resolve ' +
        'into the snapshot we sent (08 §4.3).',
    }),
    emit(AdvisorManifestSchema, {
      file: 'manifest.schema.json',
      title: 'PersonalFi AdvisorManifest v1',
      description:
        'What an advisor declares at registration: the scopes it may read, the capabilities it ' +
        'claims (deterministic is reserved for builtin and is checked), its severity ceiling, ' +
        'the limits we floor against the platform ceiling, and its egress allow-list.',
    }),
  ];
}

/** Stable serialisation. Two spaces and a trailing newline, like every JSON here. */
export function serialiseSchema(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
