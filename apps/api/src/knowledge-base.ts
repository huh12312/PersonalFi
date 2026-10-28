// SPDX-License-Identifier: MIT
/**
 * The advisor's knowledge base, bound (WP 11.5a; 12 §2.2).
 *
 * `@ctx/insights` declares a `ParameterPort` in its own vocabulary because it
 * may not import `@ctx/planning` (08 §1.6; `personalfi/layer-imports`). This
 * is the composition root's half: Planning's parameter citations
 * (`parameterByKey`, over WP 4.2's cited, hashed assumptions file) behind that
 * port, with Planning's two refusals — an unknown key, a tax year the file
 * does not hold — turned into the port's `found: false` answers rather than
 * thrown. Nothing calls it at runtime yet: 11.5b's advisory catalogue and
 * 11.5c–d's query types build on it. `test/knowledge-base.test.ts` proves the
 * binding is the identity over every key in the file and renders every
 * placeholder in every playbook page.
 */
import {
  createKnowledgeBase,
  type KnowledgeBase,
  type ParameterCitation,
  type ParameterPort,
  type PlaybookPageData,
} from '@ctx/insights';
import {
  isParameterRefusal,
  loadAssumptions,
  parameterByKey,
  type Assumptions,
} from '@ctx/planning';

/** Planning's parameter store as Insights' `ParameterPort`. */
export function createKnowledgeParameterPort(
  assumptions: Assumptions = loadAssumptions(),
): ParameterPort {
  return {
    get(key) {
      try {
        // The two shapes are the same, field for field; the test pins it.
        const citation: ParameterCitation = parameterByKey(key, assumptions);
        return { found: true, citation };
      } catch (error) {
        if (!isParameterRefusal(error)) throw error;
        return {
          found: false,
          reason:
            error.code === 'planning.assumptions_year_unavailable' ? 'year_unavailable' : 'unknown',
          detail: error.message,
        };
      }
    },
  };
}

/** The knowledge base over the checked-in playbook and the current assumptions file. */
export function createAdvisorKnowledgeBase(
  options: {
    readonly assumptions?: Assumptions;
    readonly pages?: readonly PlaybookPageData[];
  } = {},
): KnowledgeBase {
  return createKnowledgeBase({
    params: createKnowledgeParameterPort(options.assumptions),
    ...(options.pages === undefined ? {} : { pages: options.pages }),
  });
}
