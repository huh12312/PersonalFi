# Execution log and agent assignment

*Started 2026-09-11. This file records which agent (and which model) owns each work package, why, and what evidence closed it. It is the orchestrator's working ledger; the plan of record is `00-master-implementation-plan.md`.*

## Model assignment policy

**Opus** for work where the cost of a subtle mistake is high and the spec leaves real design latitude: anything holding keys or tokens, the kernel types every other package builds on, the outbox/queue semantics, the sync orchestrator's cursor and dedup logic, the analytics engines whose math is checked against reference calculators, and every phase-end security review.

**Sonnet** for work that is well specified by a memo with concrete snippets and whose correctness is easy to verify mechanically: Dockerfiles and compose from the 06 sketches, CI workflow files, Renovate and license-gate config, the frontend scaffold and design tokens from 05, generated OpenAPI clients, seed generators, conformance-suite boilerplate, Playwright flows, and documentation.

**Rule of thumb:** if the exit criterion is "a test or scan says so," Sonnet. If the exit criterion is "a reviewer has to reason about it," Opus. Every Sonnet package is reviewed by an Opus security or architecture pass before its phase closes.

**Concurrency:** at most four agents in flight at once. The panel run hit a session rate limit at nine concurrent Opus agents; four is the safe ceiling on this account.

## Phase 0 work packages

| WP | Package | Model | Agent type | Depends on | Status |
|---|---|---|---|---|---|
| 0.1 | Monorepo skeleton, kernel types (Money, Quantity, DateOnly, Clock, ids), typed config, Drizzle + migration runner, boundary lint, base CI | Opus | backend-architect | — | pending |
| 0.2 | SecretBox envelope encryption + KEK custody + auth (passkeys, TOTP, recovery codes, sessions, rate limiting) | Opus | security-engineer | 0.1 | pending |
| 0.3 | `domain_events` outbox, consumer pump, pg-boss jobs, scheduler, feature flags | Opus | backend-architect | 0.1 | pending |
| 0.4 | Dockerfiles (Alpine), hardened compose, Caddy, backup/restore + `just restore-drill`, Renovate, license gate, gitleaks, full CI matrix | Sonnet | devops-architect | 0.1 | pending |
| 0.5 | Frontend scaffold: Vite + React 19 + TanStack, Tailwind v4 tokens, shadcn/Base UI vendored, OpenAPI client generation, login/unlock shell, app frame | Sonnet | frontend-architect | 0.1 | pending |
| 0.6 | Test harness: property tests for Money, migration tests, demo-seed generator skeleton, Playwright smoke | Sonnet | quality-engineer | 0.1, 0.3 | pending |
| 0.7 | Phase 0 gate: security review of P0 evidence, boundary/license CI green, simplify pass, RUNBOOK | Opus | security-engineer + refactoring-expert | all | pending |

## Waves

- **Wave A (serial):** 0.1. Establishes conventions; nothing else can start until the package layout, kernel types, and lint rules exist.
- **Wave B (parallel, 4 agents):** 0.2, 0.3, 0.4, 0.5.
- **Wave C:** 0.6, then 0.7.

## Log

- 2026-09-11: repo initialized, MIT license and baseline docs committed. pnpm and just installed via npm global. Wave A dispatched.
