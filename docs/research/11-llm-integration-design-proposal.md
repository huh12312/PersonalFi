<!-- SPDX-License-Identifier: MIT -->

# Where a language model belongs in PersonalFi, and where it never will: a design proposal

**Request (Chris, verbatim, 2026-10-19):** "i think i need more LLM integration for the Insights Advisor, and then also to help with any non-deterministic categorization or enrichment needs. do some deeper research there on what can be made deterministic for those actions and what shouldn't be. then come up with a design proposal for my review"

**Status.** Proposal for review. Nothing here is built. Where a sentence states what the code does today it was read from the tree at `687f42d`; where it states what Monarch does it comes from the public product and its documentation (`10-visual-design-notes.md`).

---

## 1. Where we stand

**One model use exists**: the narrator (`@ctx/insights` → `@advisor/local-model`, WP 5.2/5.3/9.5/10.6). It rewords one Brief finding at a time, receives a minimised, previewed and approved payload, must answer in a pinned reply format, may not introduce a number absent from the snapshot (`validate/numerals.ts`), runs behind a four-level kill ladder, on local Ollama by default or on OpenAI / OpenRouter / Anthropic with the holder's key and a recorded consent (D30). WP 10.16 is adding a self-test that proves those controls against the live instance.

**Everything that produces a number is deterministic** and must stay so: the built-in advisors (anomaly, fees, cash, spending, subscriptions, debt, investing, retirement — all `confidence_basis: deterministic`), the health score, the projection engine, recurring detection, transfer pairing, the budget and cash-flow figures, the ranking of insights by dollar impact.

**Categorisation is six ordered deterministic tiers** (`@ctx/categorization`): the user's own edit, a user rule, a merchant default (locked or learned from ≥ 3 confirmations), Plaid's PFC through a mapping we control, a per-user naive Bayes classifier that abstains below a calibrated floor, and *uncategorised, said out loud*. Every tier records what it did; `explainAssignment` answers "why?" by token. Merchant normalisation is a staged, golden-tested pipeline. The PRD's rule stands: "All categorization runs locally … no transaction text is sent to a third-party model unless Chris explicitly enables an LLM feature and names the endpoint", and 04 §5.2's "**never silently apply**".

**What Monarch does with models** (from the public product and its documentation): an AI Assistant (chat over the household's data, with starter prompts, feedback, rate limits and "can make mistakes" copy), AI-generated Insights with helpful / not-helpful feedback, a Weekly Recap, merchant and transaction enrichment, "Magic Import" (receipt photos → line items), and AI parsing of equity-grant and tax-lot documents. Their opt-in is household-wide ("Enable AI Assistant, Insights, and Weekly Recap") with a separate model-training opt-in.

---

## 2. The dividing line

A model is the right tool when the input is **unstructured or ambiguous language** and the output is **a choice from a closed set, or prose**. It is the wrong tool whenever the output is **a number, a ranking, a detection, or an action**.

| Keep deterministic (forever) | Let a model propose (never apply) |
|---|---|
| Any figure shown to the holder: totals, rates, scores, projections, impacts | Wording: narration, explanation, summaries of deterministic findings |
| Ranking and prioritisation of insights (dollar impact, severity, cooldowns) | Choosing a category from the taxonomy for a descriptor the six tiers could not place |
| Recurring detection, transfer pairing, anomaly detection, price-change detection | A readable display name for a descriptor the normaliser left as noise |
| Applying a category, writing a rule, splitting a transaction, any write | Turning a free-text question into a call against a closed catalogue of report functions |
| The evidence set an insight cites | Extracting structure from a document or image the holder supplied (receipt, statement), to be reconciled deterministically before it is offered |
| Validation of every model output | Suggesting a rule the holder might want, as a draft |

Three rules make the right-hand column safe, and they are the same three the narrator already lives under:

1. **Closed outputs.** A category suggestion is an enum over the holder's taxonomy; a question is compiled to a typed call; an explanation is checked against the evidence it may cite. Free prose is allowed only where it cannot carry a figure the app did not compute.
2. **Suggest, never apply.** Every model output lands as a suggestion with a chip naming its source, and a confirmation by the holder is what writes — and that confirmation feeds the deterministic tiers (a confirmed suggestion becomes a `classifier_example` and a merchant profile), so the model's share of the work shrinks over time.
3. **Same gate, same ladder, same evidence.** Each new model use is a new *query type* with its own manifest, scopes, payload preview and approval, kill-switch kind, run inspector rows, evaluation corpus and red-team probes, and a check in the 10.16 self-test. Local model first; a hosted provider only under the WP 10.6 consent, per query type, with the payload named in the consent.

---

## 3. Candidate uses, with a verdict on each

### 3.1 Categorisation and enrichment

| Task | Today | Verdict | Why |
|---|---|---|---|
| Tiers 1–4 (user, rule, merchant default, provider PFC) | deterministic | **keep** | Exact, auditable, fast. |
| Tier 5 classifier | naive Bayes, abstains | **keep, improve deterministically** | Accuracy at a few hundred examples is feature engineering: add the MCC family, the Plaid PFC primary as a feature, the account's own kind, day-of-month. No model needed. |
| **The abstained residue** (tier 6) | uncategorised | **model suggestion, local by default** | The only place ambiguity is real. Input: normalised payee tokens, MCC family, amount bucket, account kind, direction — the classifier's own features, never the memo, never an account id. Output: one category key from the holder's taxonomy + a one-line reason, or `abstain`. Lands in the Inbox as "Suggested by the model" with the reason; confirm writes tiers 3/5. Cache by merchant key so a merchant is asked about once. Measure on a gold set replayed from the holder's confirmations; refuse to enable below a stated precision. |
| Merchant display name for noise descriptors | clusterer; noise stays raw | **model suggestion, narrow** | Only when the deterministic normaliser's output is a known-noise shape (processor prefixes, hashes, truncated tokens). The model proposes a display name shown beside the raw descriptor; never replaces `effective_name` without confirmation. Hallucinated brand names are the risk, so the suggestion must be a substring-preserving cleanup, validated as such, not an invention. |
| Transfer pairing, recurring detection, price-change detection, splits of known patterns | deterministic | **keep** | Already correct and explainable; a model adds nothing but doubt. |
| Receipt → line items (Monarch "Magic Import") | none | **model extraction, phase 2** | Vision model (local `llava`-class or hosted with consent) extracts line items into a schema; **the deterministic check is that the lines sum to the posted transaction** (tolerance = tax/tip line) before a split is offered. Needs an attachments pipeline first; valuable for grocery/dining splits; later. |
| Statements and documents → lots, grants, balances | none | **model extraction, phase 2** | Same shape: extract to schema, reconcile deterministically (lots sum to the holding; balances match the account), offer as a draft. Later. |
| Rule suggestions ("you've confirmed Chewy → Pets 4 times; make it a rule?") | none | **deterministic** | A count, not a model. Build as a built-in advisor. |

### 3.2 The Insights advisor

| Task | Today | Verdict | Why |
|---|---|---|---|
| Finding the insight (the rules) | built-in, deterministic | **keep** | Numbers, thresholds, evidence. Non-negotiable per 07 §7.3. |
| Ranking | dollar impact + severity + cooldowns | **keep; feedback feeds it deterministically** | V8's Helpful / Not helpful should move the cooldown ladder (a rule), not a model's opinion. |
| Narrating one finding | the narrator | **keep; extend to the Brief as a whole** | G5-15: "the Brief's narration does not narrate the Brief." A composition narration over the ranked list, same reply format, same numerals check. |
| **"Explain this"** on an insight, a transaction, a health pillar | the evidence panel (data only) | **model, grounded** | Input: the rule text, the evidence rows the panel already resolves, the minimised payload. Output: prose under the numerals check against *that evidence set*. Cached per (entity, evidence digest). Local first. This is the cheapest, safest extension. |
| **Ask PersonalFi** (natural-language questions, Monarch's Assistant) | none | **model as a compiler, not an oracle** | The model never reads the ledger. It translates the question into one or more calls from a **closed catalogue of the deterministic report functions that already exist** (cash flow by period, spending by category/merchant, pace, budget status, net worth by type, recurring, holdings, health pillars), with typed arguments (tool-use / JSON schema). The app executes them, shows "I looked at: spending by category, Sep 2026" as evidence, and the model narrates the result under the numerals check: every figure in the answer must appear in the tool results. Questions outside the catalogue get "I can't compute that yet" and a link to the nearest screen. `transactions.raw` stays local-only; a hosted provider sees the question and aggregates, never rows. |
| Anomaly summarisation, "what changed this week" | built-in anomaly rules + recap blocks (V8) | **narrate, do not detect** | Detection stays deterministic; the recap's narration is the narrator's job. |
| Goal and plan advice in prose | deterministic engine + 07 §7.2 language rules | **narrate only, with the copy linter** | The banned-phrase linter must run on model prose exactly as on templates. |

### 3.3 What Monarch does that we should not copy

- Household-wide "enable AI" switch: ours stays **per query type** with the payload named, because the payloads differ in sensitivity (a category suggestion carries a merchant name; a Brief narration does not).
- Model-ranked or model-generated insights with no evidence: 07 §7.3 forbids it ("if a rule can't populate evidence, it doesn't ship").
- Training on user data: never; a model-training opt-in has no analogue here.

---

## 4. Architecture

**One contract, many query types.** The AdvisorRequest/AdvisorResponse contract (08 §4) already carries `advisor_id`, scopes, a snapshot, a digest and typed outputs. Each new use is an advisor manifest with its own `requires_scopes`, a reply schema, and a kind on the kill ladder:

| Query type | advisor id | scopes | reply schema | ladder kind |
|---|---|---|---|---|
| Category suggestion | `categorize.suggest` | `transactions.summary` (merchant tokens + features; no memo) | `{category_key ∈ taxonomy \| abstain, reason ≤ 140 chars}` | `local_model` (hosted only under its own consent) |
| Merchant display name | `merchant.name` | the descriptor only | `{display_name: substring-preserving, or abstain}` | same |
| Explain this | `insight.explain` | the entity's evidence set + rule text | narration format, numerals-checked against the evidence | same as narrator |
| Ask PersonalFi | `ask.compile` then `ask.narrate` | the question; then the tool results | compile: `{calls: [{fn ∈ catalogue, args}]}`; narrate: narration format, numerals-checked against results | same as narrator |
| Brief narration | existing `narrator` | existing | existing | existing |

**Validation, per reply, before anything is stored:** schema pin (`additionalProperties: false`), closed-enum membership (taxonomy keys, catalogue function names), the numerals check against the allowed figure set, the copy linter, length caps, the 08 §4.3 rule that every cited reference resolves. A reply that fails is recorded as a refusal class, never shown.

**Where it runs.** The worker, through `createNarratorRuntime`'s provider resolution (WP 10.6), so local/hosted, keys, consent, budgets and the badge are shared. Latency matters for categorisation: batch the residue, cache by merchant key, run after sync, never in the request path. A smaller local model may serve classification than serves narration; the pin/digest discipline applies to each.

**Evaluation, per query type, before enablement and in CI:** a gold set (categorisation: the holder's confirmed assignments replayed; explain/ask: a corpus with expected cited figures), a refusal-rate measurement, and red-team probes (merchant-name injection, questions that try to pull raw rows, replies that smuggle numbers). WP 10.16's self-test gains one check per query type.

**Surfaces.** Inbox: suggestion chips with reasons and a one-tap confirm. Insight card and health pillar: "Explain this". A new Ask screen (or a command-palette entry) with the evidence line under every answer. Settings → Language model: per-query-type switches and consents, with the payload preview for each.

---

## 5. Packages, in order

| # | Package | Depends on | Size |
|---|---|---|---|
| 11.1 | **Deterministic classifier improvements + rule-suggestion advisor** (no model): MCC family, PFC and account-kind features; "make this a rule?" from ≥ 3 confirmations; gold-set replay harness that every later package reuses. **Built:** [WP 11.1 evidence](../evidence/phase-11/wp11.1-classifier-and-gold-set.md) | — | S |
| 11.2 | **Category suggestions for the residue** (`categorize.suggest`): manifest, local-model adapter path, batch + cache, Inbox chip, confirm → tiers 3/5, gold-set precision gate, red-team probes, self-test check. **Built:** [WP 11.2 evidence](../evidence/phase-11/wp11.2-category-suggestions.md) | 11.1 | M |
| 11.3 | **Explain this** (`insight.explain`): grounded explanations on insights and health pillars, cached per evidence digest | — | S |
| 11.4 | **Brief-level narration** (G5-15) and the recap narration over V8 blocks | — | S |
| 11.5 | **Ask PersonalFi** (`ask.compile` + `ask.narrate`): the report-function catalogue as a typed tool set, the compile step, execution, the evidence line, the narrated answer, refusals, an Ask surface | 11.3 | L |
| 11.6 | **Merchant display-name suggestions** (`merchant.name`), narrow | 11.2 | S |
| 11.7 | **Receipt and document extraction** with deterministic reconciliation (needs attachments + a vision-capable local model or hosted consent) | later | L |

---

## 6. Decisions for Chris

1. **Local-only by default for categorisation and merchant names?** Both payloads carry merchant names, which D22 keeps off hosted providers. Recommendation: local only, with a separate hosted consent naming "merchant names leave this machine" if you ever want it.
2. **Which local model for classification?** The narrator's pinned model works but is slow for batches; a smaller instruct model pinned separately is the practical choice. Recommendation: let 11.2 measure both on the gold set and pick by precision at a latency budget.
3. **Is Ask PersonalFi wanted now?** It is the largest piece and the most Monarch-like. The compile-not-oracle design keeps it honest, but it is a new surface. Recommendation: after 11.2 and 11.3 have proven the pattern.
4. **Precision gate for enabling suggestions.** Recommendation: the suggestion kind stays off until the gold-set replay shows ≥ 85 % precision on the holder's own history, and the chip always shows the reason.

---

## 7. Risks, stated

- **Prompt injection through merchant names** is live (03 §8.2). Closed enums make a successful injection inert (the worst outcome is a wrong *suggestion*), the fence and sanitiser stay, and the red-team corpus gains categorisation probes.
- **Over-trust.** Suggestions must look like suggestions; the "never silently apply" rule is enforced by construction (the model has no write port).
- **Drift and cost.** Pinned digests per query type; hosted budgets per provider already exist; batching keeps local cost bounded.
- **Latency on first sync.** Thousands of residue rows: run after sync, cache by merchant, show progress; never block the ledger.
- **Scope creep toward an oracle.** The catalogue is the boundary: a question the catalogue cannot answer is refused, not improvised.
