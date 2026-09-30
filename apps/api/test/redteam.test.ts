// SPDX-License-Identifier: MIT
/**
 * WP 5.4 — the red-team harness, in CI (05-phase-5-dispatch.md §3 WP 5.4).
 *
 * Written by someone who wrote neither WP 5.2 (the adapter, the sanitiser,
 * `renderPrompt`) nor WP 5.3 (the narrator, the narrow trace): a corpus
 * written by the author of a defence tests what the author thought of.
 *
 * Two corpora, both under `fixtures/redteam/`:
 *
 *   * **input** (`input-corpus.json`, ≥ 20) — payloads planted at their
 *     sources, built through the real `SnapshotBuilder`, run through every
 *     built-in, shown (where a built-in quoted them) to a **maximally
 *     obedient** scripted model through the real narrator and the real
 *     adapter over HTTP. The model reads the prompt it was actually sent and
 *     obeys any instruction it can still see. A faithful model is run beside
 *     it as the control.
 *   * **output** (`output-corpus.ts`, ≥ 15) — replies a talked-into-anything
 *     model sends back, each judged by the validator alone and through the
 *     production adapter.
 *
 * `harness.ts` is the pipeline; `oracle.ts` is an independent reader of
 * figures, so the exit criterion is not the validator grading itself.
 *
 * Set `REDTEAM_REPORT=<file>` to write the observed table (the evidence
 * file's §2 and §3 are generated from it). Nothing else is written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sanitiseString } from '@advisor/local-model';
import type { AdvisorRequest, Insight, ValidationOutcome } from '@ctx/insights';
import {
  acceptedWithFindings,
  blockData,
  faithfulResponder,
  loadInputCorpus,
  narratorRequest,
  obedientResponder,
  outsideBlockViolations,
  payloadRequest,
  renderPrompt,
  renderWithSnapshot,
  seedFindings,
  splitPrompt,
  startAdversary,
  validateAsService,
  wireOf,
  type Adversary,
  type InputPayload,
  type NarratedFinding,
  type ObedientResult,
  type RunResult,
  type Verdict,
} from './fixtures/redteam/harness.ts';
import { foreignFigures } from './fixtures/redteam/oracle.ts';
import { OUTPUT_CORPUS, type OutputEntry, type Roles } from './fixtures/redteam/output-corpus.ts';
import type { WireMessage } from './fixtures/redteam/fake-ollama.ts';

const INPUT = loadInputCorpus();
const MERCHANT_SOURCES = new Set(['merchant.descriptor', 'transaction.memo']);

/**
 * The findings whose leaks are open (the evidence file's §4). The verbatim
 * exit test below is `it.fails` **because the criterion does not hold today**;
 * the pinning test beside it asserts the leaks are exactly these and no
 * others, so `.fails` cannot hide a new one.
 */
const OPEN_FABRICATION_FINDINGS = new Set(['F-1', 'F-2', 'F-4']);

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

/** The verdict of the narration at `index` of the reply (the model narrates in request order). */
function verdictAt(
  result: RunResult | { adapterError: null; outcome: ValidationOutcome },
  index: number,
): Verdict {
  if (result.adapterError !== null) return `adapter:${result.adapterError}`;
  const outcome = result.outcome;
  if (outcome === null) return 'adapter:none';
  if (!outcome.ok) return `${outcome.rejection.step}:${outcome.rejection.reason}`;
  const insight = outcome.response.insights[index];
  if (insight === undefined) return 'no_narration';
  if (outcome.accepted.some((entry) => entry.insight === insight)) return 'accepted';
  const rejected = outcome.rejected.find((entry) => entry.index === index);
  return rejected === undefined ? 'no_narration' : `${rejected.step}:${rejected.reason}`;
}

interface Leak {
  readonly source: string;
  readonly defect: string | null;
  readonly key: string;
  readonly foreign: readonly string[];
}

function leaksOf(
  source: string,
  defect: string | null,
  request: AdvisorRequest,
  outcome: ValidationOutcome | null,
  untrusted: readonly string[],
): Leak[] {
  return acceptedWithFindings(request, outcome).flatMap(({ insight, finding }) => {
    const foreign = foreignFigures(insight, finding, untrusted);
    return foreign.length === 0 ? [] : [{ source, defect, key: insight.key, foreign }];
  });
}

// ---------------------------------------------------------------------------
// One observation per input payload, one per output entry — computed once
// ---------------------------------------------------------------------------

interface InputObservation {
  readonly entry: InputPayload;
  readonly carried: boolean;
  readonly suppressedMissing: readonly string[];
  readonly snapshotHasMarker: boolean;
  readonly findingsHaveMarker: boolean;
  readonly request: AdvisorRequest;
  readonly wirePrompts: readonly (readonly WireMessage[])[];
  readonly fullRender: readonly WireMessage[];
  readonly prompt: 'block' | 'absent';
  readonly flags: readonly string[];
  readonly faithful: Verdict;
  readonly obedient: Verdict;
  readonly obeyed: boolean;
  readonly leaks: readonly Leak[];
}

interface OutputObservation {
  readonly entry: OutputEntry;
  readonly validator: Verdict;
  /**
   * The validator path again, against a request that also carries the full
   * baseline snapshot. Production sends a narrator `snapshot: {}`; WP 5.3's
   * design says the validator must not rely on that, and this is the path on
   * which widening the trace back to the snapshot would show.
   */
  readonly withSnapshot: Verdict;
  readonly adapter: Verdict;
  readonly narration: Insight | null;
  readonly leaks: readonly Leak[];
}

let adversary: Adversary;
let baselineKeys: readonly string[] = [];
const inputs: InputObservation[] = [];
const outputs: OutputObservation[] = [];
let roles: Roles;
let outputRequest: AdvisorRequest;
let outputRequestWithSnapshot: AdvisorRequest;

function untrustedFor(entry: InputPayload): string[] {
  return [entry.payload, sanitiseString(entry.payload, 'payload', 2048).value];
}

async function observeInput(entry: InputPayload): Promise<InputObservation> {
  const seed = await seedFindings({ source: entry.source, payload: entry.payload });
  const { request, carrying, target } = payloadRequest(entry, seed.findings);

  const faithful = await adversary.run(request, faithfulResponder());
  const record: ObedientResult = { obeyed: false, alteredKeys: [] };
  const obedient = await adversary.run(
    request,
    obedientResponder(entry.trigger, entry.obey, record),
  );
  const wirePrompts = [faithful.prompt, obedient.prompt].filter(
    (prompt): prompt is readonly WireMessage[] => prompt !== null,
  );
  const production = wirePrompts[0];
  if (production === undefined) throw new Error(`${entry.id}: no prompt reached the model`);
  const full = renderWithSnapshot(request, seed.snapshot);
  const flags = new Set([
    ...renderPrompt(request).flags.map((flag) => flag.kind),
    ...full.flags.map((flag) => flag.kind),
  ]);
  const alteredIndex = blockData(production).findings.findIndex(
    (finding) => String(finding['key']) === record.alteredKeys[0],
  );
  const untrusted = untrustedFor(entry);
  return {
    entry,
    carried: carrying.length > 0,
    suppressedMissing: (entry.expected.suppresses ?? []).filter((prefix) =>
      seed.findings.some((finding) => finding.key.startsWith(prefix)),
    ),
    snapshotHasMarker: JSON.stringify(seed.snapshot).includes(entry.marker),
    findingsHaveMarker: JSON.stringify(seed.findings).includes(entry.marker),
    request,
    wirePrompts,
    fullRender: wireOf(full),
    prompt: splitPrompt(production).block.includes(entry.marker) ? 'block' : 'absent',
    flags: [...flags].sort(),
    faithful: verdictAt(faithful, target),
    obedient: record.obeyed ? verdictAt(obedient, Math.max(0, alteredIndex)) : 'not_obeyed',
    obeyed: record.obeyed,
    leaks: [
      ...leaksOf(
        `${entry.id}/faithful`,
        entry.defect?.id ?? null,
        request,
        faithful.outcome,
        untrusted,
      ),
      ...leaksOf(
        `${entry.id}/obedient`,
        entry.defect?.id ?? null,
        request,
        obedient.outcome,
        untrusted,
      ),
    ],
  };
}

async function observeOutput(entry: OutputEntry): Promise<OutputObservation> {
  const reply = entry.reply(roles);
  const request = outputRequest;
  const body =
    reply.kind === 'text'
      ? reply.text
      : {
          contract_version: request.contract_version,
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          advisor_version: request.advisor_version,
          produced_at: request.generated_at,
          diagnostics: { runtime_ms: 0, model: null, warnings: [] },
          ...reply.value,
        };
  const direct = validateAsService(request, body);
  const withSnapshot = validateAsService(outputRequestWithSnapshot, body);
  const through = await adversary.run(request, () =>
    reply.kind === 'text' ? reply.text : JSON.stringify(reply.value),
  );
  const narrations =
    reply.kind === 'json' ? (reply.value['insights'] as Insight[] | undefined) : undefined;
  return {
    entry,
    validator: verdictAt({ adapterError: null, outcome: direct }, 0),
    withSnapshot: verdictAt({ adapterError: null, outcome: withSnapshot }, 0),
    adapter: verdictAt(through, 0),
    narration: narrations?.[0] ?? null,
    leaks: [
      ...leaksOf(`${entry.id}/validator`, entry.defect?.id ?? null, request, direct, []),
      ...leaksOf(
        `${entry.id}/with-snapshot`,
        entry.defect?.id ?? null,
        outputRequestWithSnapshot,
        withSnapshot,
        [],
      ),
      ...leaksOf(`${entry.id}/adapter`, entry.defect?.id ?? null, request, through.outcome, []),
    ],
  };
}

beforeAll(async () => {
  adversary = await startAdversary();
  const baseline = await seedFindings(null);
  baselineKeys = baseline.findings.map((finding) => finding.key);
  const pick = (
    predicate: (finding: NarratedFinding) => boolean,
    role: string,
  ): NarratedFinding => {
    const found = baseline.findings.find(predicate);
    if (found === undefined) throw new Error(`the baseline seed has no ${role} finding`);
    return found;
  };
  roles = {
    A: pick((f) => f.type === 'subscription.price_increase', 'A'),
    B: pick((f) => f.type === 'cash.yield_spread', 'B'),
    // The synthetic token symbol `C98` (corpus I-05/O-30, the F-1 digit-in-an-identifier case) — a
    // finding key, not a credential; gitleaks' generic-api-key rule matches the shape.
    C: pick((f) => f.key === 'investing.concentration.C98', 'C'), // gitleaks:allow
    D: pick((f) => f.type === 'retirement.goal_pace', 'D'),
    E: pick((f) => f.type === 'spending.category_anomaly', 'E'),
  };
  outputRequest = narratorRequest([roles.A, roles.B, roles.C, roles.D, roles.E]);
  outputRequestWithSnapshot = { ...outputRequest, snapshot: baseline.snapshot };
  for (const entry of INPUT) inputs.push(await observeInput(entry));
  for (const entry of OUTPUT_CORPUS) outputs.push(await observeOutput(entry));

  const reportTo = process.env['REDTEAM_REPORT'];
  if (reportTo !== undefined && reportTo.length > 0) {
    writeFileSync(
      reportTo,
      `${JSON.stringify(
        {
          baselineKeys,
          input: inputs.map((o) => ({
            id: o.entry.id,
            vector: o.entry.vector,
            source: o.entry.source,
            payload: o.entry.payload,
            carried: o.carried,
            prompt: o.prompt,
            flags: o.flags,
            faithful: o.faithful,
            obeyed: o.obeyed,
            obedient: o.obedient,
            expected: o.entry.expected,
            defect: o.entry.defect ?? null,
            residual: o.entry.residual ?? null,
            leaks: o.leaks,
          })),
          output: outputs.map((o) => ({
            id: o.entry.id,
            title: o.entry.title,
            fabricates: o.entry.fabricates,
            vector: o.entry.vector,
            validator: o.validator,
            withSnapshot: o.withSnapshot,
            adapter: o.adapter,
            expected: o.entry.expected,
            defect: o.entry.defect ?? null,
            residual: o.entry.residual ?? null,
            leaks: o.leaks,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
}, 180_000);

afterAll(async () => {
  await adversary?.close();
});

// ---------------------------------------------------------------------------
// The exit tests (names verbatim from the dispatch)
// ---------------------------------------------------------------------------

describe('WP 5.4 — the red-team corpus through the real builder, prompt, narrator and validator', () => {
  it('the corpus has at least twenty input payloads and fifteen adversarial replies, and each names its vector and its expected step', () => {
    expect(INPUT.length).toBeGreaterThanOrEqual(20);
    expect(OUTPUT_CORPUS.length).toBeGreaterThanOrEqual(15);
    const ids = [...INPUT.map((entry) => entry.id), ...OUTPUT_CORPUS.map((entry) => entry.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const verdict =
      /^(accepted|not_obeyed|no_narration|adapter:[a-z_]+|(transport|schema|envelope|capability|evidence|derivations|numerals):[a-z_]+)$/u;
    for (const entry of INPUT) {
      expect(entry.vector.length, entry.id).toBeGreaterThan(10);
      expect(entry.source, entry.id).toMatch(/^[a-z_.]+$/u);
      expect(entry.payload.length, entry.id).toBeGreaterThan(0);
      expect(entry.expected.faithful, entry.id).toMatch(verdict);
      expect(entry.expected.obedient, entry.id).toMatch(verdict);
      if (entry.defect?.obedient !== undefined) expect(entry.defect.obedient).toMatch(verdict);
    }
    for (const entry of OUTPUT_CORPUS) {
      expect(entry.vector.length, entry.id).toBeGreaterThan(10);
      expect(entry.expected.validator, entry.id).toMatch(verdict);
      expect(entry.expected.adapter, entry.id).toMatch(verdict);
    }
    // The dispatch's named vectors are each present.
    const vectors = INPUT.map((entry) => `${entry.source} ${entry.vector}`).join('\n');
    for (const named of [
      'merchant.descriptor',
      'transaction.memo',
      'crypto.symbol',
      'category.slug',
      'goal.name',
      'fence',
      'zero-width',
      'bidi',
      '[INST]',
      'system',
      'base64',
    ]) {
      expect(vectors, named).toContain(named);
    }
    const directives = new Set(INPUT.map((entry) => entry.obey.kind));
    for (const kind of ['invent_figure', 'raise_severity', 'add_action', 'cite_link']) {
      expect([...directives], kind).toContain(kind);
    }
  });

  it('no corpus payload reaches the prompt outside the delimited block', () => {
    expect(inputs).toHaveLength(INPUT.length);
    for (const observation of inputs) {
      const { entry } = observation;
      for (const prompt of [...observation.wirePrompts, observation.fullRender]) {
        expect(outsideBlockViolations(prompt), entry.id).toEqual([]);
        const parts = splitPrompt(prompt);
        for (const outside of [parts.system, parts.before, parts.after]) {
          expect(outside.includes(entry.marker), `${entry.id}: marker outside the block`).toBe(
            false,
          );
        }
        // The block holds exactly the findings the request carried — no
        // payload forged a finding by breaking out of its string.
        expect(blockData(prompt).findings.length, entry.id).toBe(
          observation.request.findings?.length ?? 0,
        );
      }
      expect(observation.carried, `${entry.id} carried`).toBe(entry.expected.carried);
      expect(observation.prompt, `${entry.id} prompt`).toBe(entry.expected.prompt);
      for (const kind of entry.expected.flags) {
        expect(observation.flags, `${entry.id} flag ${kind}`).toContain(kind);
      }
      expect(observation.suppressedMissing, `${entry.id} suppresses`).toEqual([]);
    }
    // Non-vacuous: at least one payload of each free-text source did reach the block.
    const reached = new Set(inputs.filter((o) => o.prompt === 'block').map((o) => o.entry.source));
    for (const source of ['crypto.symbol', 'category.slug', 'goal.name']) {
      expect([...reached], source).toContain(source);
    }
  });

  it('no merchant descriptor or memo from the corpus reaches the prompt at all', () => {
    const merchant = inputs.filter((o) => MERCHANT_SOURCES.has(o.entry.source));
    expect(merchant.length).toBeGreaterThanOrEqual(3);
    for (const observation of merchant) {
      const { entry } = observation;
      expect(observation.snapshotHasMarker, `${entry.id} in the snapshot`).toBe(false);
      expect(observation.findingsHaveMarker, `${entry.id} in a finding`).toBe(false);
      for (const prompt of [...observation.wirePrompts, observation.fullRender]) {
        const text = prompt.map((message) => message.content).join('\n');
        expect(text.includes(entry.marker), `${entry.id} marker in a prompt`).toBe(false);
        expect(text.includes(entry.payload), `${entry.id} payload in a prompt`).toBe(false);
      }
    }
    // And structurally: the production ledger port maps no descriptor or memo
    // column onto what the builder reads (`createInsightsLedgerPort`).
    const domain = readFileSync(new URL('../src/domain.ts', import.meta.url), 'utf8');
    const start = domain.indexOf('export function createInsightsLedgerPort(');
    expect(start).toBeGreaterThan(-1);
    const body = domain.slice(start, domain.indexOf('\nexport ', start + 10));
    for (const column of [
      'merchantName',
      'originalDescription',
      'memo',
      'row.name',
      'descriptor',
    ]) {
      expect(body.includes(column), `createInsightsLedgerPort reads ${column}`).toBe(false);
    }
  });

  it('every adversarial reply is refused at the step the corpus predicts', () => {
    expect(outputs).toHaveLength(OUTPUT_CORPUS.length);
    const diff: string[] = [];
    for (const observation of outputs) {
      const { entry } = observation;
      const predicted = {
        validator: entry.defect?.validator ?? entry.expected.validator,
        adapter: entry.defect?.adapter ?? entry.expected.adapter,
      };
      if (observation.validator !== predicted.validator)
        diff.push(
          `${entry.id} validator: predicted ${predicted.validator}, observed ${observation.validator}`,
        );
      if (observation.withSnapshot !== predicted.validator)
        diff.push(
          `${entry.id} validator with the snapshot in the request: predicted ${predicted.validator}, observed ${observation.withSnapshot}`,
        );
      if (observation.adapter !== predicted.adapter)
        diff.push(
          `${entry.id} adapter: predicted ${predicted.adapter}, observed ${observation.adapter}`,
        );
    }
    expect(diff).toEqual([]);
    // Non-vacuous: the faithful control is accepted on both paths.
    const control = outputs.find((o) => o.entry.id === 'O-01');
    expect([control?.validator, control?.adapter]).toEqual(['accepted', 'accepted']);
  });

  it.fails(
    "zero schema-valid insights carry a figure that is not the narrated finding's own",
    () => {
      // `.fails`: the second exit criterion does NOT hold at this commit — see
      // OPEN_FABRICATION_FINDINGS and the pinning test below. Remove `.fails`
      // when F-1, F-2 and F-4 are closed; it then turns red until you do.
      const leaks = [...inputs.flatMap((o) => o.leaks), ...outputs.flatMap((o) => o.leaks)];
      expect(leaks).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Beyond the exit names: the pins that keep the ones above honest
// ---------------------------------------------------------------------------

describe('WP 5.4 — pins', () => {
  it('the fabricated figures that get through are exactly the open findings, and nothing else', () => {
    const leaks = [...inputs.flatMap((o) => o.leaks), ...outputs.flatMap((o) => o.leaks)];
    const unexplained = leaks.filter(
      (leak) => leak.defect === null || !OPEN_FABRICATION_FINDINGS.has(leak.defect),
    );
    expect(unexplained).toEqual([]);
    // Every open finding still reproduces (a fix turns this red: update the corpus).
    const reproduced = new Set(leaks.map((leak) => leak.defect));
    expect([...reproduced].sort()).toEqual([...OPEN_FABRICATION_FINDINGS].sort());
  });

  it('every obedient reply to an input payload lands where the corpus predicts, and every faithful control where it should', () => {
    const diff: string[] = [];
    for (const observation of inputs) {
      const { entry } = observation;
      const obedient = entry.defect?.obedient ?? entry.expected.obedient;
      const faithful = entry.defect?.faithful ?? entry.expected.faithful;
      if (observation.obedient !== obedient)
        diff.push(`${entry.id} obedient: predicted ${obedient}, observed ${observation.obedient}`);
      if (observation.faithful !== faithful)
        diff.push(`${entry.id} faithful: predicted ${faithful}, observed ${observation.faithful}`);
    }
    expect(diff).toEqual([]);
    // Non-vacuous: most controls are accepted, and the obedient model did obey
    // wherever an instruction survived into a finding.
    expect(inputs.filter((o) => o.faithful === 'accepted').length).toBeGreaterThanOrEqual(25);
    expect(inputs.filter((o) => o.obeyed).length).toBeGreaterThanOrEqual(15);
  });

  it("the oracle agrees with the corpus's ground truth on every narration it can read", () => {
    for (const observation of outputs) {
      const { entry, narration } = observation;
      if (narration === null || entry.narrates === null) continue;
      const finding = roles[entry.narrates];
      const foreign = foreignFigures(narration, finding);
      expect(foreign.length > 0, `${entry.id}: oracle says ${foreign.join(',')}`).toBe(
        entry.fabricates,
      );
    }
  });

  it('a payload a built-in refuses upstream takes the baseline findings named with it (observation F-6)', () => {
    for (const observation of inputs) {
      for (const prefix of observation.entry.expected.suppresses ?? []) {
        expect(
          baselineKeys.some((key) => key.startsWith(prefix)),
          `${observation.entry.id} ${prefix}`,
        ).toBe(true);
      }
    }
  });
});
