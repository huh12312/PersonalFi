<!-- SPDX-License-Identifier: MIT -->

# Phase 9 dispatch — polish and harden: v0.9, and the 90 days to v1.0

*Written 2026-10-05 at `1417b36` on `main`, while the Opus Phase 5 gate runs. That gate started at `68b3c1a`, and it owns `docs/evidence/phase-5/gate-security-review.md` and the compose stack. When this was written, the gate document's §0, §2 and §4–§7 read NOT STARTED and §1 and §3 read IN PROGRESS. This file touches neither the document nor the stack. It is a companion to [`01-execution-log.md`](01-execution-log.md), which stays the orchestrator's ledger; this file is the Phase 9 breakdown into work packages, the wave plan and the gate standard. The plan of record remains [`00-master-implementation-plan.md`](00-master-implementation-plan.md), and the standing status is [`06-path-to-v1.md`](06-path-to-v1.md).*

---

## 1. Goal, exit criteria, rung

**Goal (master plan §5, verbatim).** *"Phase 9 — Polish and harden (runs across phases, converges before v0.9/v1.0). WCAG 2.2 AA pass, performance pass, external-style security review against ASVS 5.0 L2 (L3 on credential storage and auth), docs (install, upgrade, backup, restore, threat model), 90-day real-use soak, multi-version upgrade test."*

**Exit criteria: the two rungs (§2.3), verbatim.**

> **v0.9** Polish and harden — Performance targets met, WCAG 2.2 AA checks pass, security review closed, a stranger can install from the README.
> **v1.0** PersonalFi 1.0 — 90 days as Chris's only finance tool; unattended upgrade from v0.1 works.

**The performance targets (§3.4, verbatim).** *"Transactions list p95 under 200 ms at 50k rows; 10k Monte Carlo paths ≤ 800 ms p95 with byte-identical output for a fixed seed; nightly sync completes in under 5 minutes; backup RPO 24 h, RTO 1 h; whole stack under 2 GB RAM without the LLM profile; WCAG 2.2 AA; zero-touch migrations on upgrade."*

**Each clause and the instrument that proves it.**

| Clause | Instrument | WP |
|---|---|---|
| Performance targets met | Each §3.4 budget is re-measured on the target hardware with the load average printed. The 50k list is measured **over HTTP** (today it is only measured in-process, §2b CF-12). Nightly sync, RTO and RAM have **no measurement at all** today (CF-13). | 9.9 |
| WCAG 2.2 AA checks pass | axe runs with the WCAG 2.2 tag set and `target-size` enabled (CF-6). Portals are scanned (CF-7). Every route is checked in both themes with zero exclusions (CF-8). Keyboard-only journeys, reduced motion, reflow, and a manual checklist for every success criterion axe cannot see. | 9.8 |
| Security review closed | An ASVS 5.0 L1+L2 map, with L3 for V6/V7/V11/V13.3, where every row has its evidence. Gaps are fixed by a different agent, or accepted by Chris in writing. | 9.10 → 9.11 |
| A stranger can install from the README | A fresh agent in a disposable host, holding nothing but the README, reaches a passkey login, an import, a backup and a passing restore drill. | 9.12 → 9.13 |
| Unattended upgrade from v0.1 works | v0.1 (`d04669e`) is installed cold and loaded through its own API. It then reaches HEAD by the documented single command, both as a direct jump and as a chain through every gate commit. The run proves migrations, data, keyring, passkey, TOTP, and backups restorable across the boundary. | 9.4 |
| 90 days as Chris's only finance tool | A production install isolated from every agent; a weekly soak report built from aggregates only; Chris's weekly attestation; the clock rules in §6 Q6. | 9.1 (instrument); **Chris** (the 90 days) |

**The critical path is the 90-day clock, and nothing an agent does shortens it.** v1.0 can be declared no earlier than soak day 91, and day one is a hand action: Chris links at least two real institutions on a production install, and they sync on schedule. On the default schedule (§6 Q2: production install by 2026-10-09, links by 2026-10-12), **the earliest v1.0 date is 2027-01-10.** Every work package below is sequenced to overlap the soak rather than precede it.

- **The production install does not wait for Wave A.** It can be installed at the Phase 5 verdict commit, under §4's isolation rules.
- The soak report arrives with Wave A and backfills from day one, because the data is already in the database.
- Two things *must* happen before day one, because they become expensive afterwards:
  - **C-15**, the pseudonym-construction decision (§6 Q3). Re-pseudonymising after real evidence rows exist orphans every `MERCHANT_…` reference.
  - **The prerequisites for the tax-treatment override** (WP 9.2). The first real projection is the fifth real-data criterion.

**Rungs.**
- **v0.9 is declared at the Phase 9 gate.**
- **v1.0 is declared by the orchestrator on soak day 91, not by any gate.** It takes the "v1.0 close" (§4): the upgrade test re-run at the release commit, the day-90 soak report clean, and Chris's sign-off.
- The real-data criteria carried since Phase 1 (06 "What only Chris can close", items 1–6, plus the Brief's first month) are all observed *during* the soak. The soak report tracks each one by date.

**What Phase 9 does not do.**
- Phase 6 (Vibe-Trading) — optional, after 1.0.
- The bitemporal store (05 §6 Q4).
- The Monte Carlo bootstrap re-centring, and the shared `@core/projection-kernel` hoist. Both change stored outputs or move files mid-soak (§6 Q11).
- Multi-user anything.
- i18n catalogues (09 §5.6 "readiness" — recorded, not built).
- New product features beyond the carried screens (C-8, C-10).

**Five cut lines, drawn now.**

1. **The soak is instrumented, never automated into a verdict.** The report counts; Chris judges "useful", "only tool" and "fallback". The report prints a missing attestation as a gap, never as clean.
2. **The stranger is an agent in a disposable host, not a human.** That is weaker than the rung's word "stranger", and the evidence says so. §6 Q7 offers a human or VM pass.
3. **"WCAG 2.2 AA checks pass" means automated plus scripted-manual.** A screen-reader listening session (Orca) is recorded as a manual item for Chris (§6 Q10), not claimed.
4. **"External-style" means an independent agent that wrote none of the reviewed code**, not a third party. It does not fix what it finds. Its fixes are another agent's, and the gate re-verifies both.
5. **Cut order if the phase runs long:**
   1. 9.7's goal/questionnaire/fork screens (C-10). C-8's honesty half is never cut.
   2. Narrator option B.
   3. 9.6's grant history.
   4. 9.9's informational 250k-row measurements.

   **Never cut:** soak instrumentation, the upgrade test, backup/restore, the security review's closure, the stranger install.

---

## 2. Carried rows Phase 9 must absorb

| Item | Source | Disposition |
|---|---|---|
| **The Phase 5 gate verdict and its conditions** — not written when this file was | Phase 5 gate, in flight at `68b3c1a` | **WP 9.3 does not dispatch until the conditions are written** (the 04/05 precedent). They land in §2a. A **HIGH** promotes 9.3 into Wave A, and 9.2 slides to Wave B (§4). |
| **The narrator's third exit criterion: 66.1 % against ≥ 95 %** | wp5.14 §4.1 (orchestrator re-run at `f24160f`); execution log 2026-10-04 23:40 | **WP 9.5, behind a decision gate**: the Phase 5 gate's ruling (its §5 R-1, in flight) and §6 Q4. The narrator stays off by default (kill level 2) until a live run reads ≥ 95 % through steps 1–7. |
| **The Phase 5 gate's in-flight re-judgement** — every one of 38 refusals is the model failing to echo an opaque key (26) or the envelope withholding a displayed value (12). **None is a fabricated figure.** | `gate-security-review.md` §1.1 (G5-1, R-1), observed 2026-10-05 | **WP 9.5's option A** is built on this classification. If the verdict reads differently, the verdict rules. |
| **C-8**: the plan screen's honesty — problem codes in words (G4-10); the engine named, and a deterministic run never phrased "% of plans succeed" (G4-13); stale status shown (G4-16); the preview seeded from the sealed net worth (G4-11); O-5 | Phase 4 gate §6; still open (`PlanScreen.tsx:162–176`, CF-15) | **WP 9.7.** Never cut. |
| **C-10**: goal CRUD, the questionnaire and forking on screen | Phase 4 gate §6 (G4-12); 05 §2 deferred it here | **Decision for Chris (§6 Q5), default build** → WP 9.7. First on the cut order. Earmarks stay out: `cash_earmarks` has no route (wp4.8). |
| **C-14 remainder** — O-3, O-4, O-6, O-7 (copy); O-9 (grant history); O-10 (`worker-host.ts` "512 MB"); O-11 (import re-validates plan rows) | wp5.14 §1, §8 item 30 | O-3/4/6/7 → **9.8** (shared `Money.tsx` and banners, which are in 9.8's exclusive web wave). O-9 → **9.6** (migration 0038). O-10 → **9.9**. O-11 → **9.11** (input validation, ASVS V2). |
| **C-15**: the `@core/secretbox` pseudonym swap, carried five phases | Phase 4 gate §6; 05 §6 Q5 | **Chris, §6 Q3 — decided before soak day one**, or recorded as a permanent decision (D27) by the stated date. |
| **C-16**: hand items on this host (`sudo just harden-secrets`) | Phase 4 gate §6 | **Chris, §6 Q2's prerequisites** — on the production install, before day one. |
| **wp5.14 §8 items 12, 15, 16, 17**: no route surfaces a Brief item's narration; `BriefItem` has no action data; no GET for kill levels 1–2; the feed does not say consent is why it is empty; the api binds no `PromptRenderer` | wp5.14 §8; execution log 2026-10-04 11:40 | **WP 9.6.** Item 17 is worse than "deferred": CF-1. |
| **wp5.14 §8 item 13**: `features/health/types.ts`'s hand-typed wire type and cast | wp5.14 §8 | **WP 9.6** (CF-25). |
| **wp5.14 §8 items 14, 18**: the `InsightsScreen.test.tsx` dismiss test; the hand-added `ollama` paragraph | wp5.14 §8 | **Verify-first in 9.14.** Both look closed at `1417b36`: the test sends `reasonCode: 'NOT_ACTIONABLE'` (`InsightsScreen.test.tsx:207`), and `scripts/check-licenses.ts:261–263` carries the paragraph. |
| **wp5.14 §8 item 19**: `packages/platform/src/index.ts`'s egress export block | wp5.2 §10 item 1 | **9.14** records keep-or-move. |
| **wp5.14 §8 item 20**: the local-endpoint transport duplicated (two dials, two `pinnedLookup`s) | wp5.2 §10 item 3 | **9.10 rates, 9.11 fixes.** 03 §5.2's lesson — the second implementation of an allow-list is where the hole is — makes this a security property, not a refactor. |
| **wp5.14 §8 item 21**: `compose.yml`'s stale header, `.env.example`'s placeholder digest, the RUNBOOK resource-envelope row, `@advisor/local-model`'s workspace dependency | wp5.2 §10 items 4–7 | **9.12** (docs and config text); envelope numbers come from 9.9. |
| **wp5.14 §8 item 22**: `advisor-golden.test.ts`'s S7B ruleId collision, S1's missing golden row, S5's CONTROL-silence conflict | wp5.7 §9 | **9.14.** |
| **wp5.14 §8 item 23**: `migrate.test.ts` is missing the 0029/0034 attribution | wp5.7 §5, wp5.13 §6 | **Already closed** — the orchestrator verified on 2026-10-05 that `migrate.test.ts` carries the 0029, 0031 and 0034 blocks (lines 396, 417, 451 at `1417b36`); nothing for the W-A batch. |
| **wp5.14 §8 item 25**: C-5's route-level sabotage against `routes/{investments,net-worth}.ts` was never performed | wp5.13 §4.3 (diff already written) | **9.11.** |
| **wp5.14 §8 item 26**: the add-wallet form's location; no Playwright coverage | wp5.13 §4.6 | **9.8.** The sweep covers every route and form. |
| **wp5.14 §8 item 27**: forward validation's limits | wp5.9 §5 | **§6 Q11** (bitemporal; default after v1.0). |
| **wp5.14 §8 item 28 / wp5.4**: F-6 (a third-party token symbol silences a builtin's whole response), F-7 (flag evasion by homoglyph and wrapped base64), R-1…R-4 residuals, R-2 (own figures under swapped labels) | wp5.4 §4, §8 | **WP 9.5.** F-6 and F-7 are in option A; R-2 is option B's reason to exist. F-1…F-5 and F-8 were closed by 5.3b (`fffb2b6`); verify-first. |
| **wp5.14 §8 item 29**: global uniqueness of schedule names | wave-c-wiring §5 item 1 | **Deferred** (D6, single holder). |
| **The destructive button's dark-theme contrast** — white on `--money-neg`, a token every money-negative surface shares | execution log 2026-10-04 21:00 | **WP 9.8, as a design change** (new danger tokens). The log records 3.39:1 dark at rest; recomputed from `theme.css:164` it reads ≈ 3.85:1 — still under 4.5:1. 9.8 re-measures with the tool of record and fixes the hover blend too (CF-9). |
| **Real-data criteria: the seven of 05 §6 Q8**, plus 06 items 6 (Coinbase key) and 8 (LUKS2, Tailscale HTTPS, real secrets, B2 object lock) | 06 "What only Chris can close" | **Owner Chris, instrumented by WP 9.1.** Each becomes a dated row in the weekly soak report. Criterion 5 needs WP 9.2 first (CF-16). |
| **05 §2's Phase 9 deferrals**: bootstrap ~0.5 pt/yr optimistic (re-centring); the shared `@core/projection-kernel`; `GET /holdings` and `/investments/allocation` perf beyond six accounts; macro constants going stale with no reminder; `GoalSliders`' starting balance has no server field; the Bengen/Guyton-Klinger published fixtures | 05 §2 | Re-centring, the kernel hoist and the fixtures → **§6 Q11, default after v1.0** (each moves stored outputs or files under a live soak; the 1 % reference criterion is met by the independent reference). Holdings perf on the scale seed → **9.9**. Assumptions staleness → **9.1** (a soak-report line: `as_of` age). Starting balance → **9.7** (seeded from the existing sealed net-worth series; no server field needed). |
| **09 §5.8's upgrade requirements**: refuse to start against a newer database; automatic pre-migration backup; a multi-version jump tested in CI | 09 §5.7–5.8 | **WP 9.4** (CF-2, CF-3). |
| **D24's "restore drill result shows on the in-app dashboard"**, and 09 §5.7's "the app reports last successful backup age" | 00 D24, 09 §5.7 | **WP 9.1** (CF-17). |
| **The monthly restore drill is overdue on 2026-10-13** — the last committed drill is `docs/evidence/ops/restore-drill-20260913.md` | D24, RUNBOOK "Restore drill" | **The orchestrator**, on the dev stack after the Phase 5 gate's teardown. Then a monthly soak-report line. |
| **03 §9 rows never evidenced**: P1-5 (`cosign verify` pre-deploy; `release.yml` has never run, CF-19), P1-13 (explicit seccomp/AppArmor), P1-14 (rootless/userns), P2-1 (KEK rotation exercised), P2-8 (the ASVS assessment at `docs/security/asvs-assessment.md`), P2-10 (dependency budget), P2-12 (panic button dry run) | 03 §9 | **9.10 rates each; 9.11 fixes, or Chris accepts in writing.** |
| **06 §4.4: the migrator should use a higher-privilege role than the api** | 06 §4.4; CF-18 | **9.10 rates; 9.11 fixes.** It must not break unattended upgrade (§3 WP 9.11). |
| **The session-limit kill rate** — eight limit kills in Phase 5 (seven session, one weekly costing ~58 h); every one recovered by snapshot-and-relaunch | 06 Momentum; execution log 2026-09-29 → 2026-10-04 | **§4's wave sizing.** At most one Opus per wave, three agents only where two are modest Sonnet packages, and long runs detached and resumable. |
| **The Phase 4/5 lessons every brief carries** | 05 §3 preamble | **§3's preamble**, unchanged, plus Phase 9's production-isolation rules. |

### 2a. Phase 5 gate conditions (filled by the orchestrator at the verdict)

> *Placeholder.* The orchestrator copies the Phase 5 gate's §6 conditions here verbatim when the verdict exists, each with a proposed owner among §3's packages.
>
> **Rules:**
> - **A HIGH promotes WP 9.3 into Wave A, and WP 9.2 slides to Wave B** (Chris's links do not need 9.2; his first real projection does).
> - A condition that touches a file another package owns in the same wave moves to that package, or the package moves. Never two packages in one file (05 §3, WP 5.13's rule).
> - Every condition is verify-first and reproduced red before it is fixed.
> - If the verdict raises CF-1 (no `PromptRenderer`, no narrator registration on the api), it stays with 9.6, and 9.3 carries a pointer.
> - If the verdict rules the narrator's options (R-1), §3 WP 9.5's decision gate reads that ruling.
>
> | # | Condition | Severity | Owner |
> |---|---|---|---|
> | — | *(not yet written)* | — | — |

### 2b. Code findings (read at `1417b36` while writing this file)

Every claim this plan relies on was read in the code. What follows is wrong or missing, each with an owner. All are verify-first: the owning package reproduces each one before fixing it.

| # | Finding | Where | Owner |
|---|---|---|---|
| **CF-1** | **No local-model payload can be approved on a real install, so the narrator can never run there.** The api never registers `local.narrator` (the registry is built without it whenever `narratorModel` is absent, which on the api it always is) and binds no `PromptRenderer`. Preview and approval — which only the api serves — refuse with `advisor_not_registered` or `503 insights.prompt_renderer_unavailable`. The worker's run then refuses `payload_not_approved` forever. A Brief's narration enqueue can never complete on any install. | `apps/api/src/modules.ts:862–872`; `apps/api/src/routes/advisor-runs.ts:363–370`, `:578–597`; `apps/api/src/routes/insights.ts:293–295` | **9.6** |
| **CF-2** | **An older binary serves a newer schema.** `runMigrations` and `pendingMigrations` iterate files on disk only. An applied version with no file is silently ignored, so a downgraded image migrates nothing and reports `/ready`. 09 §5.8 requires a refusal. RUNBOOK "Upgrade" recommends exactly this rollback ("`PERSONALFI_VERSION` pinned to the prior value"). | `packages/db/src/migrate.ts:137–152`, `:206–224`; `RUNBOOK.md:606–610` | **9.4** |
| **CF-3** | **No automatic pre-migration backup.** `backup` starts only after `migrator` completes, so the first backup after an upgrade is of the *migrated* database. 09 §5.7 says "automatic and mandatory"; RUNBOOK leaves it to a manual `just backup`. | `compose.yml` `backup.depends_on`; `RUNBOOK.md:595–603` | **9.4** |
| **CF-4** | **`git pull && up` from v0.1 fails: 11 secret files are missing.** HEAD declares 17 file secrets; v0.1 declared 6. Compose refuses to start a service whose secret file is missing, and nothing creates the empty placeholders RUNBOOK tells a *first* install to create. | `compose.yml:85–230`; `git show d04669e:compose.yml`; `justfile` (no placeholder recipe) | **9.4** |
| **CF-5** | **Predicted, not run:** an install whose `returns_cache` volume predates C-1 stays root-owned after an upgrade. The fix works only "before the volume is ever bound", so the documented fetch would still fail `EACCES`. | `RUNBOOK.md:477–480`; G4-1 | **9.4** (verify at waypoint W4) |
| **CF-6** | **axe never checks WCAG 2.2's target size.** axe-core 4.13 ships `target-size` (wcag22aa, 2.5.8) `enabled: false`, and every spec calls `axe.run('#app-content')` with no tags or rules. | `node_modules/.pnpm/axe-core@4.13.0/.../axe.js:33491–33496`; `apps/web/e2e/support/axe.ts:47` | **9.8** |
| **CF-7** | **No dialog, popover, combobox or tooltip has ever been scanned.** axe is scoped to `#app-content`, and Base UI portals render to `document.body`. That includes `DismissReasonDialog` and `RejectCandidateDialog`, where the destructive buttons live. | `apps/web/src/app/App.tsx:53`; `components/ui/dialog.tsx:43` (and popover, combobox, tooltip) | **9.8** |
| **CF-8** | **A live dark-theme contrast failure has been masked by test exclusions since Phase 3.** The active nav link is `--accent-text #3987e5` on `--accent-wash #132537` = 4.29:1. It is excluded via `exclude: a[aria-current="page"]` in four specs. | `apps/web/src/styles/theme.css:145,147`; `e2e/advisors.spec.ts:48`, `networth.spec.ts`, `market-data.spec.ts`, `investments.spec.ts` | **9.8** |
| **CF-9** | The destructive variant is `bg-money-neg text-white hover:opacity-90`. It fails AA at rest in dark (see §2) and carries the same hover-blend defect fixed for the primary button on 10-04. It shares its token with every money-negative surface. | `apps/web/src/components/ui/button.tsx:33`; `theme.css:63,164,214` | **9.8** |
| **CF-10** | The dark palette is declared twice — `[data-theme='dark']` and `@media (prefers-color-scheme: dark) :root:not([data-theme])` — so every token fix must be made twice, and nothing checks that both copies agree. | `theme.css:128–` and `:189–` | **9.8** |
| **CF-11** | `duration-normal` names no theme token (the theme defines instant/fast/base/slow); verify it resolves. Eight `animate-spin` spinners are not `motion-safe:`. | `features/plan/sliders/GoalSliders.tsx:246`; `theme.css:354–357`; spinners in `features/auth/*`, `ConnectionCard.tsx:90`, `SyncStatusPill.tsx:30` | **9.8** (Low) |
| **CF-12** | **The 50k-row list budget is never measured as a user experiences it.** The test times `listTransactions` in-process over `generate_series` rows. No HTTP-level `GET /transactions` timing exists, though the reports, investments and net-worth budgets all have one. | `packages/contexts/ledger/test/perf.test.ts:41–120`; `apps/api/test/db/*-perf.test.ts` | **9.9** |
| **CF-13** | **Three §3.4 budgets have no measurement:** nightly sync under 5 min, RTO 1 h, whole stack under 2 GB. Memory limits sum to ≈ 4.5 GB, and both api and worker derive a 1 GiB Argon2 KEK at boot. | `compose.yml:305,440,601,675,726`; RUNBOOK "Resource envelope" | **9.9** (measure); **9.11** (stagger, if needed) |
| **CF-14** | **The docs are stale:** <br>• The RUNBOOK envelope says the worker is 512M and "does not derive the KEK". Compose sets 1536M, and the worker unlocks (G4-2). <br>• Troubleshooting still describes the migrator `ROLE` "known gap", but the schema includes `migrator`. <br>• The restore-drill sample's code fence is malformed. <br>• README says "Phase 0 in progress … no application functionality yet". | `RUNBOOK.md:1157`, `~:1206–1215`, `~:851–858`; `compose.yml:601`; `packages/config/src/schema.ts:63`; `README.md:5–7` | **9.12** |
| **CF-15** | **C-8 is still open.** The headline reads "% of plans succeed" for every method, there is no `isError` branch ("Projecting your plan…" forever), and the section is labelled "Monte Carlo fan chart" for deterministic runs. | `apps/web/src/features/plan/PlanScreen.tsx:162–176`, `:197` | **9.7** |
| **CF-16** | **The holder cannot set an account's tax treatment.** It is derived from the provider subtype alone, with no column, route or screen. A mis-typed IRA projects as taxable, and real-data criterion 5 cannot be completed for it. | `packages/contexts/planning/src/ports.ts:289–354` | **9.2** |
| **CF-17** | **D24 and 09 §5.7 are unimplemented:** backup status lives only in the backup container's `/tmp/backup-status`, and no route or screen shows backup age or the drill result. | `docker/backup/backup.sh:60`; no reference in `apps/web/src` | **9.1** |
| **CF-18** | **The serving process owns the schema.** One `database_url` serves api, worker and migrator, so the api role has DDL rights. 06 §4.4 asked for a separate, higher-privilege migrator role. | `compose.yml` `database_url` comment; 06 §4.4 | **9.10** rates; **9.11** fixes |
| **CF-19** | **`release.yml` (cosign keyless, GHCR) has never run:** `git tag -l` is empty. P1-5's `cosign verify` has never been exercised. | `.github/workflows/release.yml` | **9.10** rates; §6 Q8 |
| **CF-20** | **Image tag collision.** Images are tagged `personalfi/api:${PERSONALFI_VERSION:-dev}`, and every gate or agent `docker compose build` overwrites `:dev`. A production stack on `:dev` would come back up on unreviewed code at its next `up`. | `compose.yml:49,245,679` | **9.1** (production pins the SHA); §4 rules |
| **CF-21** | **A production install in this checkout would be destroyed by the next gate.** `compose.yml` has no top-level `name:`, so the project is the directory name, and gates run `docker compose … down -v` on it (Phase 5 gate §3.2). | `compose.yml` (no `name:`); Phase 5 gate §3.2 | **9.1**; §4 rules; §5 risk row 1 |
| **CF-22** | `worker-host.ts` still states "512 / 640 MB" (O-10). | `packages/contexts/planning/src/engine/worker-host.ts:7,16,123` | **9.9** (comment only) |
| **CF-23** | **Half of the gate's refusal class is an envelope gap.** The findings envelope carries only `row.value`, while rate and percent evidence rows store `null` and are resolved server-side for display. A correct figure the holder is shown therefore "disagrees" with null. | `packages/contexts/insights/src/advisors/local/findings.ts:63,130,149,173` | **9.5** |
| **CF-24** | **A published Brief does not record its action.** Its text is snapshotted at publish time but its primary action is not, though "a Brief is a record of what was said". | `packages/db/migrations/0032_advisory_briefs.sql:91–121` | **9.6** (migration 0038, expand only) |
| **CF-25** | `HealthScoreSection` casts `query.data as HealthScoreWireResponse` although the generated `HealthScore` type exists. | `apps/web/src/features/health/HealthScoreSection.tsx:148` | **9.6** |

---

## 3. Work packages

**The collision rules of Phases 1–5 hold unchanged:**
- disjoint path ownership;
- no dependency or lockfile edits by agents;
- no commits (the orchestrator commits per package, by explicit path, after `just verify`);
- a separate scratch database per agent;
- foreground waits only;
- agents write evidence incrementally and post their report before the final verify; the orchestrator finishes cheap kills;
- every sabotage is recorded in the evidence **as it happens** — WP 4.12a lost its records to a kill.

Phase 5's four rules are carried verbatim into every brief:

1. **No git state changes, and that means `stash`** — and in Phase 9 also `worktree`. Old source trees come from `git archive <sha> | tar -x`.
2. **Every test that scans the tree, spawns a process, waits on a worker, builds an image or talks to a server — fake or real — declares its own timeout (30–60 s, more for builds).**
3. **`prettier --write` every `.json`/`.yml` an agent touches.** The orchestrator runs `pnpm run lint:format` before the first `just check` after any `LEFTHOOK=0` snapshot.
4. **No performance number is believed while a model is loaded on the host**, or while another agent builds images. Every number prints its load average.

**Phase 9 adds the production rules.** They are carried verbatim, because for the first time a real holder's data shares the host:

5. **`personalfi-prod` is off-limits to every agent and to the gate.** That covers its directory, project, volumes, images, secrets and database. No agent reads, execs into, stops, builds, pulls, prunes or lists its secrets. The weekly soak report is the orchestrator's alone, through 9.1's script, which reads aggregates only.
6. **Every `docker compose` invocation by an agent names its own project with `-p`** — `pf-upgrade-<run>`, `pf-perf`, the gate's `personalfi` — and its own ports on `127.0.0.1`. **`down -v` only on a project the agent created this session.** **`docker volume prune`, `image prune`, `system prune` and `builder prune --all` are forbidden outright**: a prune while prod is stopped deletes prod.
7. **Images an agent builds carry its own tag** (`pf-upgrade/api:<sha>`, `pf-perf/api:<sha>`). Only the gate rebuilds `personalfi/*:dev`.
8. **Long runs are detached and resumable** (`setsid nohup`, a state file per step, `--from <n>`). Phase 5's two counted model runs survived their sessions' deaths only because the container kept writing.

Two structural reminders from Phase 4/5, unchanged:
- The `insights`, `api` and `planning` vitest projects collect `test/*.test.ts` **one level deep**.
- Every new table is registered in the export bundle (`apps/api/src/reports/export/registry.ts`), or recorded as a reasoned deferral, **in the same commit as its migration**. Each package adds its own rows only.

| WP | Package | Model | Agent type | Depends on |
|---|---|---|---|---|
| 9.1 | Real-use soak: production isolation, backup/drill status (D24), the weekly soak report, the clock; migration 0036 | Sonnet | devops-architect | — |
| 9.2 | Real-data readiness: holder-set tax treatment, account role and valuation (O-2); migration 0035 | Sonnet | backend-architect | — |
| 9.3 | Phase 5 gate carry-overs (§2a); migration 0037 reserved | Sonnet | backend-architect | Phase 5 verdict |
| 9.4 | Unattended upgrade: the v0.1 → HEAD test (direct jump and chain) and the fixes it needs (newer-DB refusal, pre-migration backup, secret placeholders) | **Opus** | devops-architect | — |
| 9.5 | Narrator v2: the decision package (A identity + envelope, B slot references, C a larger model); F-6, F-7 | **Opus** | backend-architect | Phase 5 verdict (R-1), §6 Q4 |
| 9.6 | Advisory surface completion: CF-1, the kill-level GET, Brief-item narration and action, grant history; migration 0038 | Sonnet | backend-architect | — |
| 9.7 | Plan screens: C-8 honesty, C-10 goals/questionnaire/forking | Sonnet | frontend-architect | 9.2, 9.6 landed |
| 9.8 | WCAG 2.2 AA sweep: harness, tokens, every route in both themes, keyboard-only, motion, reflow, the manual checklist | Sonnet | frontend-architect | every web package landed |
| 9.9 | Performance pass: every §3.4 budget on target hardware, HTTP 50k, nightly sync, RTO, RAM, skip names visible | Sonnet | performance-engineer | 9.4 landed |
| 9.10 | External-style security review: ASVS 5.0 map, threat-model refresh, gap list — reviews, never fixes | **Opus** | security-engineer | 9.1–9.6 landed |
| 9.11 | Security fixes: 9.10's gaps red-first; role separation; the single egress implementation; O-11; C-5 route sabotage; migration 0039 | **Opus** | security-engineer (not 9.10's agent) | 9.10 |
| 9.12 | Docs: a stranger's README, the RUNBOOK consolidated, the threat-model page, release notes, the docs drift check | Sonnet | technical-writer | 9.4, 9.9, 9.10 |
| 9.13 | The stranger install: README only, disposable host | Sonnet | quality-engineer (fresh) | 9.12 |
| 9.14 | Quality pass: the v0.9/v1.0 audit, mined open items, final re-measures | Sonnet | quality-engineer | all |
| Phase 9 gate | Independent security and architecture gate (§5), verdict to `docs/evidence/phase-9/gate-security-review.md` | **Opus** | security-engineer | all |

### WP 9.1 — The real-use soak: isolation, status, report, clock (starts day one)

**Scope.** This package builds the instrument around the one thing no package can do: Chris using the app as his only finance tool for 90 days. Five parts.

**(1) Production isolation, written down and guarded (CF-20, CF-21).**
- The production install lives in its own directory (default `~/personalfi-prod`, a clone at a pinned SHA). It runs with `COMPOSE_PROJECT_NAME=personalfi-prod`, which gives it its own volumes by project name.
- It uses `PERSONALFI_VERSION=<sha>`, **never `dev`**.
- It has its own `secrets/` (hardened per C-16), and its own bind address and ports (the Tailscale or LAN address on 443; the dev and gate stack stay on `127.0.0.1`).
- `scripts/soak/check-isolation.sh` refuses to run anything unless the project is `personalfi-prod`, the version is a 40-hex SHA, and the directory is not this checkout.
- 9.1 owns a RUNBOOK section, "Production install and the real-use soak". It covers the isolation rules, the day-one checklist (06 items 1–8), the weekly report, who upgrades production and when (§4), and the monthly restore drill.

**(2) Backup and drill status in the app (CF-17, D24, 09 §5.7).**
- Migration 0036 adds `ops_backup_runs` (status, finished_at, plaintext bytes, TOC object count, reason) and `ops_restore_drills` (verdict, date, restored and live table counts, max migration, RTO seconds). Both are install-wide and owned by `@core/platform`.
- `docker/backup/backup.sh` writes one row per attempt. **The insert is best-effort when the table does not exist**, because WP 9.4's pre-migration backup runs against older schemas. This is a written interface between the two packages.
- The `restore-drill` recipe body writes its verdict and RTO into the live database after it compares.
- `GET /ops/backup-status` (session) returns the newest successful backup's age and the newest drill verdict. The dashboard gets one line: "Last backup 4 h ago · restore drill passed 2026-10-13". It turns to a warning past `BACKUP_MAX_AGE_SECONDS` or 35 days since a drill.

**(3) The weekly soak report** (`scripts/soak/report.ts`, run inside the prod `api` container by the orchestrator).
- **Every query selects only aggregates and whitelisted dimensions**: ISO week, connection *ordinal*, provider kind, status, job kind, reason code. It never selects an amount, a name, a memo, an institution, a merchant or a goal. A structural test parses the script's SQL and enforces that.
- Sections:
  - **sync health** per connection ordinal: scheduled runs, succeeded, failed, re-auth, p95 and max duration;
  - **ledger invariants** as counts: internal transfers inside spending totals over the trailing complete month, duplicate dedup keys, pending older than 10 days;
  - **categorisation**: auto versus holder-corrected over 30 days, as a rate (09 §8.1: ≥ 90 % after 30 days);
  - **review burden**: holder overlay writes per week (09 §8.3: < 5 by v1.0);
  - **the Brief**: published per ISO week, ranked and attention counts, accepted, dismissed by `reason_code` (the ≥ 3-useful first month; 09 §8.2's ≥ 60 % useful);
  - **notifications** per week by class (≤ 3 non-critical);
  - **jobs** failed or dead by kind; advisor quarantines;
  - **auth**: days with an authenticated session, failed logins, lockouts, step-ups;
  - **backups and drills** from (2);
  - **the assumptions file's `as_of` age** (05 §2's "macro constants go stale quarterly");
  - **upgrades applied**: `schema_migrations.applied_at` by week.
- Output goes to `docs/evidence/phase-9/soak/week-YYYY-Www.md`. **These files are committed and pushed**, which is exactly why the canary test exists.

**(4) The criteria ledger** — a table in every weekly file with one row per criterion:
- 06 items 1–8;
- the Brief's first month;
- the narrator ≥ 95 % (only if Chris enables it);
- "only finance tool".

Each row reads *not started / observing since D / met on D (evidence) / failed on D (why)*. The report computes what it can. Criterion 1 is two connections with a successful scheduled sync on each of the last seven days. Criterion 2 is a complete month with a zero internal-transfer count. The Brief criterion is accepted items across the first four published Briefs. Judgements stay Chris's lines.

**(5) The clock.** `docs/evidence/phase-9/soak/clock.md` holds Chris's dated attestations: day one, any fallback with a one-line reason, and any outage. Each weekly report prints "day N of 90" under §6 Q6's rules, and **prints a week with no attestation as a gap, never as clean.**

**Owns.**
- `scripts/soak/**`
- `packages/db/migrations/0036_ops_status.sql`
- `packages/platform/schema/ops.ts` and its `OWNERSHIP.md` lines
- `docker/backup/backup.sh` (the insert only)
- the body of the existing `restore-drill` recipe in `justfile`
- `apps/api/src/routes/ops.ts`
- `apps/web/src/features/ops/**` and the one dashboard line
- the export-registry rows for its two tables (a reasoned deferral: install telemetry, not holder data)
- the RUNBOOK section named above
- `docs/evidence/phase-9/soak/` (templates and the seed dry run)

**Events.** None. **Migrations.** 0036.

**Exit tests.**
- `apps/api/test/db/soak-report.test.ts` (seed with planted canaries in merchant names, account names, institution names, memos, goal names, and a canary amount):
  - `'the soak report contains no amount, name, memo or institution from the database'`;
  - `'every query in the soak report selects only aggregates and whitelisted dimensions'`;
  - `'criterion 2 reads met only after a complete month with zero internal transfers in spending, and one planted transfer turns it back'`;
  - `'the clock counts from the attested day one, a fallback resets it, and a week without an attestation prints as a gap'`.
- `apps/api/test/db/ops-backup-status.test.ts`:
  - `'the status reports the newest successful backup and never a newer failed one'`;
  - `'a drill older than 35 days reads overdue'`;
  - `'the route needs a session and returns nothing a user owns'`.
- `scripts/soak/check-isolation.sh --self-test`: `'refuses project personalfi, version dev, and this checkout's directory'`.

**Evidence.** `docs/evidence/phase-9/wp9.1-soak.md`:
- the isolation procedure walked on a **prod-like scratch project** (`pf-prodlike`, never the real one), with its `docker volume ls` before and after a gate-style `down -v` on `personalfi`;
- a week-00 dry-run report from the seed;
- the canary test sabotaged (one non-aggregate column added → red);
- the backup row written by a real `backup.sh` on the scratch project.

### WP 9.2 — Real-data readiness: tax treatment, account role, valuation

**Scope.** Today, criterion 5 ("a projection run against real balances with real tax treatment per account") rests on the provider's subtype being right (CF-16). Phase 4's gate showed the second gap: a manual investment account's typed balance counts nowhere, and nothing says so (O-2). This package adds a holder overlay, in the D11 sense: provider facts are never mutated, and one pure resolver decides. The overlay holds:
- `tax_treatment` — `TAXABLE` | `TAX_DEFERRED` | `ROTH` | `HSA`, or unset meaning the subtype default;
- `role` — wp4.3 §9 item 1's account role, closed list from 07 §5;
- `valuation` — `holdings` (default) | `balance`. With `balance`, an account with no holdings counts at its latest typed balance, **labelled as such** everywhere it appears.

The subtype map (`ports.ts:298–354`) stays the default, and the override wins. Changing any of the three changes the projection's input digest, so the stored baseline reads **stale** — never silently recomputed. `PUT /accounts/{id}/overrides` and `DELETE` (session; no money moves). The accounts screen shows the effective value and its source ("from Plaid: 401k" / "set by you"). The plan and net-worth screens name every unvalued account.

**Owns.**
- `packages/contexts/ledger/src/overrides/**`, `packages/contexts/ledger/schema/account-overrides.ts`, `packages/db/migrations/0035_account_overrides.sql`, the export-registry row (exported: it is holder data);
- the tax-bucket and valuation lines of `packages/contexts/planning/src/ports.ts` and of planning's net-worth valuation call site (the named lines only);
- the overrides routes in `apps/api/src/routes/accounts.ts`;
- the account settings feature directory in `apps/web/src/features/` (verify its path first);
- `apps/web/e2e/accounts-overrides.spec.ts`.

The planning-port binding in `apps/api/src/domain.ts` is the W-A batch's.

**Events.** Emits `ledger.AccountOverrideChanged` (planning's staleness reads it). **Migrations.** 0035.

**Exit tests.**
- `packages/contexts/ledger/test/db/account-overrides.test.ts`:
  - `'a holder-set tax treatment wins over the provider subtype, and clearing it returns to the subtype's'`;
  - `'another user's account can never be overridden'` — every scoping predicate dropped, individually and together (§5 item 8).
- `packages/contexts/planning/test/db/tax-override.test.ts`:
  - `'after a tax-treatment change the stored baseline reads stale and names why'`;
  - `'an account valued by balance counts at that balance and is labelled so; one valued by holdings with none is named unvalued, never zero'`.
- `e2e/accounts-overrides.spec.ts`: `'the holder sets an account's tax treatment by keyboard and the plan says its projection is stale'`, axe-clean in both themes.

**Evidence.** `docs/evidence/phase-9/wp9.2-real-data.md`: the resolver table, O-2 before and after on screen, the cross-user sabotage matrix.

### WP 9.3 — Phase 5 gate carry-overs and conditions

**Scope.** §2a's rows, and nothing else, in the gate's priority order. Verify-first for every row, each reproduced red first. If a condition touches a file another Phase 9 package owns in the same wave, the orchestrator moves the condition or the package — never both into one file.

**Owns.** Named per condition when the verdict exists. **Events.** None expected.

**Migrations.** None expected; **0037 is reserved.** Its rule: it references no object a higher number creates.

**Exit tests.** Named per condition, each reproduced red first.

**Evidence.** `docs/evidence/phase-9/wp9.3-carry-overs.md`: each sabotage recorded as it happens.

### WP 9.4 — Unattended upgrade from v0.1: the test and its fixes

**Scope.** v1.0's second clause, and 09 §5.8's whole list. **(1) The harness** — `scripts/upgrade-test/` (bash plus one Node verifier):

**Waypoints:**

| Waypoint | Commit | What it is |
|---|---|---|
| W0 | `d04669e` | v0.1, the Phase 0 re-gate GO |
| W1 | `2e67648` | Phase 1 gate |
| W2 | `d3a51a0` | Phase 2 gate |
| W3 | `6391428` | Phase 3 gate |
| W4 | `d0dcf70` | Phase 4 gate |
| W5 | `f24160f` | Phase 5 landing |
| HEAD | — | — |

The history-rewrite map (`history-rewrite-2026-09-20.md`) confirms these are post-rewrite hashes. `git log d04669e..HEAD -- packages/db/migrations/000[123]*` is empty, so v0.1's migrations are byte-identical at HEAD. Every later edit to a migration file landed on a `wip:` snapshot before its package landed, so no gate commit carries a drifted file. The harness proves this rather than trusting it.

**How each waypoint is built and run:**
- Source tree: `git archive <sha> | tar -x -C $WORK/<sha>`.
- Images tagged `pf-upgrade/<svc>:<sha>`.
- One compose project, `pf-upgrade-<run>`, with its own secrets generated for the test, its own `127.0.0.1` high ports, and its own volumes.

**Data is loaded through each version's own API, never through SQL:**

| Waypoint | Data loaded |
|---|---|
| W0 | bootstrap user; a passkey (CDP virtual authenticator, credential kept in `$WORK`); TOTP enrolment; recovery codes |
| W1 | a CSV import of `@core/seed`'s `generateDemoData(1)` transactions; a rule; a category override |
| W2 | a budget; a confirmed recurring series; a dismissed insight |
| W3 | a manual investment account with holdings; a watch-only wallet |
| W4 | a plan, a goal, an assumption override, a deterministic projection |
| W5 | a published Brief (shortened schedule); a dismissal with a reason code |

**Two paths:**
- **(a) the direct jump W0 → HEAD.** "Skipping releases must work", and this is the v1.0 clause verbatim.
- **(b) the chain W0 → W1 → … → HEAD.**

Between versions, the only commands are the documented upgrade: replace the source tree, then `just upgrade`. **Any extra step is a failure**, recorded as a finding with the exact error.

**After every upgrade the verifier asserts:**
- (i) `schema_migrations` equals the files on disk, checksum for checksum, with none extra;
- (ii) every fact loaded earlier is readable through HEAD's API — counts and spot values by API;
- (iii) the same `master_key` unlocks, KEK generation is unchanged, a TOTP code from W0's secret verifies, and W0's passkey logs in;
- (iv) a backup taken at W0, restored into a fresh project and migrated by HEAD's migrator, passes (i)–(iii); a HEAD backup passes the restore drill;
- (v) `RestartCount` is 0 for api and worker;
- (vi) up-to-ready seconds are recorded (09 §5.3: < 20 s including migrations).

Each waypoint writes a state file, so a kill resumes at the last completed one.

**(2) The fixes the harness finds, each red in the harness first.**
- **CF-2.** `migrate.ts` refuses `migration.database_newer` when the database holds an applied version absent on disk. It refuses in `runMigrations` and in `pendingMigrations`, so `/ready` stays false. **"Newer" is set membership, never a max-version comparison**, because Phase 9's own migrations land out of number order on production (§4).
- **CF-3.** A `pre-migrate-backup` one-shot on the backup image runs only when migrations are pending against a non-empty schema. A failed backup blocks the migrator, and `migrator` depends on it `service_completed_successfully`. It meets every hardening rule (non-root 10002, read-only, `cap_drop: [ALL]`, `no-new-privileges`), and `compose-hardening-check.sh` learns it.
- **CF-4.** `scripts/secrets-placeholders.sh` creates every *optional* declared secret empty if missing. It never overwrites, refuses to invent a *required* one, and keeps the directory 0700.
- **`just upgrade`** runs: placeholders → build → `up -d --wait` → `/ready` and restart-count check. A separate `just backup` is no longer needed, because the backup is automatic.
- **CF-5** at W4, with a fix that needs no root in the steady state. Anything else the chain finds.

**(3) CI.** `.github/workflows/upgrade-test.yml` runs the direct jump on `workflow_dispatch`, weekly, and as a required predecessor of `release.yml`. The orchestrator adds the `needs:`. The chain runs locally at each gate.

**(4) The RUNBOOK "Upgrade" section, rewritten.**
- The upgrade is `git pull && just upgrade`, and the section states what is automatic.
- **Rollback is "restore the pre-migration backup"** — never "pin the prior image". CF-2 makes the old advice fail safe.
- The Postgres major-version section is unchanged.

**Owns.**
- `scripts/upgrade-test/**`, `scripts/secrets-placeholders.sh`;
- `packages/db/src/migrate.ts` and a new `packages/db/test/migrate-newer.test.ts` (not the shared `migrate.test.ts`);
- the `pre-migrate-backup` block and `migrator.depends_on` in `compose.yml`;
- `docker/backup/pre-migrate.sh`, `docker/backup.Dockerfile`;
- `scripts/compose-hardening-check.sh` and `scripts/fixtures/compose-hostile.yml` (the new service's cases only);
- `.github/workflows/upgrade-test.yml`, the RUNBOOK "Upgrade" section;
- `docker/api.Dockerfile`, only if CF-5's fix needs it.

**Events.** None. **Migrations.** None.

**Exit tests.**
- `packages/db/test/migrate-newer.test.ts`:
  - `'a database holding a migration this binary lacks refuses to migrate and /ready stays false, named'`;
  - `'migrations applied out of number order converge and never read as newer'`.
- `scripts/secrets-placeholders.sh --self-test`: `'creates only missing optional secrets, empty; never overwrites; refuses a missing required one'`.
- `compose-hardening-check.sh --self-test`: the hostile fixture's `pre-migrate-backup` running as root, writable, or with capabilities, is refused.
- The harness, three sabotages, each observed red through it:
  - placeholders removed → W0 → HEAD `up` fails `secret … file not found`;
  - pre-migrate disabled → the verifier finds no backup older than the first new migration;
  - the newer-DB check removed → W5's image serves HEAD's schema.

**Evidence.** `docs/evidence/phase-9/wp9.4-upgrade.md`:
- the waypoint table: sha, images, migrations applied, up-to-ready seconds, restarts, checks (i)–(vi);
- the direct-jump transcript; the cross-boundary restore;
- every finding red → green.

### WP 9.5 — Narrator v2: the decision package

**Decision gate.** This package dispatches only after (1) the Phase 5 verdict's ruling on R-1 and the third exit criterion, and (2) §6 Q4. Its brief names the option chosen.

The Phase 5 gate's in-flight re-judgement (§2 row 3) is the reason option A comes first. **Not one refusal was a fabricated figure.** 26 were the model failing to echo an opaque key, and 12 were the envelope withholding a value the holder is shown. A bigger model attacks neither cause directly; a two-line change to who writes the key attacks the first.

**Option A — the app fills the identity, and the envelope carries what the holder sees.**
- **(a) The narration's `key` and `type` are no longer model-written.** Each request either carries one finding, or numbers its findings and has the reply cite `finding: <n>`. The adapter writes key and type from the request, as it already writes `request_id` and `advisor_id`, so a model cannot forge them (05 WP 5.2's own pattern).
- **(b) Each envelope evidence row carries the display value the evidence panel resolves** (`displayValueOf`/`resolvedDisplay`), so a correct percent no longer disagrees with `null` (CF-23).
- **(c) F-6.** A crypto or investing symbol outside the key alphabet is keyed through a safe slug plus a short hash. It is never allowed to fail the builtin's whole response.
- **(d) F-7.** Role markers are flagged after a confusable-skeleton fold, and base64 runs are flagged across line wraps. **Flags only — the control remains structure and the narrow trace.**

**Option B — slot references.** The model writes `{{e1}}`-style slots and never a digit. The app fills each slot with the finding's own rendered figure, and each slot is bound to its evidence label, so **R-2 becomes a check the app can do**. F-4's number-word refusal (5.3b) stays. Dispatched if the gate rules R-2 due, or if option A's live number reads under 95 %.

**Option C — a larger model.** Only if Chris supplies the hardware (§6 Q4). It uses the same harness and a new digest. The 300 s request cap and the 8G limit are re-sized from measurement, never assumed.

**Under every option:**
- **step 7's numerals rule is never widened.** The red-team suite stays green, and the live pass must read 0 survived;
- **no retry-until-valid**;
- **the narrator stays off in production** (kill level 2) until a live counted run reads ≥ 95 % through steps 1–7 on the pinned model.

**Owns.**
- `packages/contexts/insights/src/advisors/local/**`;
- `packages/contexts/insights/src/validate/{pipeline.ts,numerals.ts,evidence.ts}`;
- `packages/contexts/insights/src/contract/{request.ts,version.ts,json-schema.ts}`, and `packages/contracts/advisor/v1/*.schema.json` (contract **1.6.0** if the reply shape changes, regenerated in the same commit);
- `packages/advisors/local-model/src/**` (prompt and sanitiser);
- the key-construction lines of the crypto and investing builtins (F-6, named lines only);
- `scripts/advisor-eval.ts` and its fixtures;
- new regression entries in `apps/api/test/fixtures/redteam/**`. The independent re-run is the gate's.

**Events.** None. **Migrations.** None.

**Exit tests.**
- `packages/contexts/insights/test/narrator.test.ts`:
  - `'a narration's key and type are the request's: a reply naming another finding cannot attach to it'` (A);
  - `'an evidence row the panel shows as a percent reaches the envelope with that display value'` (A);
  - `'a narration contains no digit the app did not place, and each placed figure sits under its own evidence label'` (B).
- F-6: `'a token symbol outside the key alphabet no longer silences the builtin; the finding is raised under a safe key'`.
- F-7: `'a homoglyph role marker and a wrapped base64 run are flagged'`.
- `apps/api/test/redteam.test.ts`: every existing test stays green, plus the new entries.
- **The live counted evaluation through steps 1–7 on the pinned model** (detached, resumable, ~3–7 h). The digest, temperature, seed, date and load are recorded. This is Phase 5's third exit criterion.
- **The live red-team pass**: `fabricated figure survived 0`.

**Evidence.** `docs/evidence/phase-9/wp9.5-narrator.md`:
- the option and why;
- refusal classes before and after, beside the gate's §1.1 table;
- both live numbers;
- each new control sabotaged once and observed red.

### WP 9.6 — Advisory surface completion

**Scope.** Everything Phase 5 built that a real install cannot reach.

1. **CF-1.** When a local model is configured, the api registers `local.narrator`'s manifest (never its executor) and binds the pure, preview-only `PromptRenderer`. Preview and approval then work through the product. The proof is that an approval made through the api lets the worker's next run proceed. The config shape — the api learns the model name and digest but never the endpoint — is proposed here and applied by the W-B batch.
2. **`GET /advisors/kinds/{kind}/enabled`**, plus level 1's effective state (`ADVISORS_ENABLED` and `module.insights`), so settings shows real state rather than the last `PUT`.
3. **A Brief item's narration.** `GET /insights/brief/{isoWeek}` items carry the linked narration's text, badged AI-assisted, joined through `narrates_insight_id`.
4. **CF-24.** Migration 0038 adds `advisory_brief_items.primary_action` (nullable jsonb with a shape CHECK), snapshotted at publish. Older Briefs read "no action recorded".
5. **O-9.** `snapshot_grant_events`: append-only grant, revoke and re-grant rows with the step-up session reference, in 0038. Exposed on the consent route.
6. **The feed's empty state says when consent is why** (G4-18's feed half).
7. **CF-25.**
8. The web halves of 1–6.

**Owns.**
- `apps/api/src/routes/{brief.ts,advisor-runs.ts,advisor-grants.ts}`, the insights block of `apps/api/src/app.ts`;
- `packages/contexts/insights/src/brief/**`, `packages/contexts/insights/schema/briefs.ts`;
- the grant section of `packages/contexts/insights/src/store.ts` and `schema/advisors.ts`;
- `packages/db/migrations/0038_brief_actions_grant_events.sql` and its registry rows;
- `apps/web/src/features/{brief,advisors,health}/**`, `apps/web/src/features/insights/InsightsScreen.tsx` (the empty state);
- `e2e/{brief,advisors}.spec.ts`.

**Events.** None new. **Migrations.** 0038.

**Exit tests.**
- `apps/api/test/db/advisor-preview-api.test.ts`:
  - `'a local-model payload is previewed and approved through the api, and the worker's next run proceeds on that approval'` — red first at `1417b36`, CF-1;
  - `'the kind state reported by GET follows both the PUT and the config switch'`.
- `brief-routes.test.ts`:
  - `'a Brief item with a narration carries it, badged; one without carries none'`;
  - `'a published Brief's action is the one shown at publication, after the insight's action changes'`.
- `apps/api/test/db/grant-history.test.ts`: `'every grant, revoke and re-grant is recorded and never overwritten'`, plus the full predicate matrix.
- e2e:
  - `'the AI-assisted badge appears from the real response shape'`;
  - `'levels 1 and 2 show their real state in words'`;
  - axe clean in both themes.

**Evidence.** `docs/evidence/phase-9/wp9.6-advisory-surface.md`.

### WP 9.7 — Plan screens: C-8 honesty, C-10 goals

**Scope.**

**C-8 (CF-15), never cut:**
- Every projection problem code in the OpenAPI document is rendered in words, and **no error renders as "Projecting your plan…"**.
- The engine is named. **A deterministic run is never phrased as a probability**, on the headline or in `ScenarioCompare`, and the section is labelled by method.
- A stored run's `stale` status is shown with its version, and an assumption override invalidates the projection query (G4-16).
- The slider preview's starting balance is the newest **sealed** net-worth day from the existing series route, or the preview is labelled a placeholder (G4-11). No server field is needed.
- Only engine-read paths are offered as overrides (O-5).

**C-10, under §6 Q5:**
- goal CRUD and contributions over `/goals`;
- the risk questionnaire over `/risk-profile`;
- scenario forking and compare over `/plan/scenarios` and `/plan/compare`.

Everything must be operable by keyboard. Earmarks have no route and stay out.

**Owns.**
- `apps/web/src/features/plan/**`, `apps/web/src/features/goals/**` (new);
- the plan and goals route files under `apps/web/src/routes/`, the one Sidebar nav line;
- `e2e/{plan,plan-sliders,goals}.spec.ts`.

`e2e/support/**` and `mock-api.ts` belong to the orchestrator.

**Exit tests.**
- `'every projection problem code reads as words'` (each code driven by the mock);
- `'a deterministic run is never phrased as a probability'`;
- `'a stale run says so and names its version'`;
- `'the preview's starting balance is the sealed net worth, or is labelled a placeholder'`;
- `'a goal can be created, edited, funded and deleted by keyboard alone'`;
- `'the questionnaire produces a risk profile the plan reads'`;
- `'a scenario can be forked and compared'`;
- unit tests; axe clean in both themes.

**Evidence.** `docs/evidence/phase-9/wp9.7-plan-screens.md`: 04 §5 item 3's on-screen steps walked, with screenshots in both themes.

### WP 9.8 — WCAG 2.2 AA sweep

**Scope.** Wave D gives this package **exclusive ownership of `apps/web/**`**, so it can fix what it finds rather than report it.

**(1) The harness.**
- `e2e/support/axe.ts` runs `runOnly` tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa`, with `target-size` explicitly enabled (CF-6).
- It scans `document` with only the devtools panels excluded, so portals are seen (CF-7).
- `scanBothThemes(page, screen)` replaces every per-spec copy. **Every element exclusion is removed** (CF-8) by fixing the token, not the test.
- A structural check bans `exclude:` in `e2e/` outside the devtools selector.

**(2) The sweep spec**, `e2e/a11y-sweep.spec.ts`:
- **Generates its route list from `routeTree.gen.ts`**, so a new screen cannot be skipped.
- Visits each route in both themes, and opens every dialog, popover and combobox reachable from a stable trigger.
- At 1280 px and 320 CSS px (1.4.10, no horizontal scroll).
- At 200 % text size (1.4.4).
- Under `reducedMotion: 'reduce'`, asserting computed transition and animation durations of zero (CF-11).

**(3) Keyboard-only journeys**, `e2e/a11y-keyboard.spec.ts`. The spec is structurally free of `mouse` and `click()`.
- **Journeys:** passkey login (virtual authenticator); transactions filter → split → rule; a budget edit; Brief accept and dismiss-with-reason; plan sliders by arrow keys (2.5.7's alternative to dragging); goal CRUD; an advisor grant through step-up; settings.
- **Asserted at every stop:**
  - focus visible (2.4.7) and not obscured by the sticky header or toasts (2.4.11);
  - order matches the visual order (2.4.3);
  - focus returns to the trigger when a dialog closes.

**(4) Tokens.**
- New `--danger`, `--on-danger` and `--danger-hover`, separate from `--money-neg` (CF-9), at ≥ 4.5:1 at rest and on hover in both themes. The `opacity` hover is removed.
- The dark `--accent-text`/`--accent-wash` pair is fixed.
- `apps/web/src/styles/contrast.test.ts` computes WCAG ratios for every declared text/background pair (≥ 4.5:1) and UI-component pair (≥ 3:1, 1.4.11) in both themes, straight from `theme.css`. It also **asserts the two dark blocks are identical** (CF-10).

**(5) The manual checklist**, `docs/evidence/phase-9/wcag-checklist.md`. Every WCAG 2.2 A and AA success criterion gets: how it is verified (axe rule, sweep, keyboard spec, inspection), the result, and an evidence pointer. It must include the criteria axe cannot see:

| SC | What to check |
|---|---|
| 1.3.3 | sensory characteristics |
| 1.4.13 | tooltips dismissible and hoverable |
| 2.1.4 | `usePrivacyShortcut` is a modifier combination — record it |
| 2.2.1 | the 15-minute soft-lock's 60 s warning must be operable to extend |
| 2.5.3 | label in name |
| 3.2.6 | consistent help |
| 3.3.7 | redundant entry |
| 3.3.8 | passkeys pass; the TOTP field must allow paste and autofill |
| 09 §5.6 | every chart has a data-table equivalent; colour is never the only signal |

**(6)** O-3, O-4, O-6 and O-7's copy.

**(7)** The add-wallet form's coverage (wp5.14 item 26).

**Owns.** `apps/web/src/**` and `apps/web/e2e/**` for Wave D, and `docs/evidence/phase-9/wcag-checklist.md`. `playwright.config.ts`'s `testMatch` belongs to the orchestrator.

**Exit tests.**
- `'every route in the route tree is axe-clean under the WCAG 2.2 AA tag set, in both themes, with every reachable dialog open'`. Reproduced red first: with the exclusion removed and portals scanned, CF-8 and CF-9 fail at `1417b36`.
- `'no axe run in the suite excludes an element'`.
- `'every declared text pair clears 4.5:1 and every UI pair 3:1 in both themes, and the two dark palettes are identical'`.
- `'each core journey completes by keyboard alone with visible, unobscured focus at every stop'`.
- `'with reduced motion, nothing animates'`.
- `'at 320 CSS px no screen scrolls horizontally'`.

**Evidence.** `docs/evidence/phase-9/wp9.8-wcag.md`: the checklist, screenshots per route in both themes, and each new check sabotaged once.

### WP 9.9 — Performance pass

**Scope.** The §3.4 line, item by item, on the target hardware (§6 Q1). Every number is printed with its load average, with `ollama` stopped and no agent building images (rule 4). Scratch projects only (`pf-perf`).

- **(a) The 50k list over HTTP (CF-12).** `apps/api/test/db/transactions-http-perf.test.ts` uses the 50,040-row `generateDemoData(1, { monthCount: 1264 })` corpus, loaded through the real write path (`loadSeedDataset`, as `growth-bound.test.ts` does). Real `fetch()` via `ApiHarness.listen()` times the first page, a deep keyset page, a filter and a search, against **p95 < 200 ms**. One curl-timed pass through Caddy on `pf-perf` is recorded beside it. The in-process test and its `EXPLAIN` assertion stay.
- **(b) Monte Carlo.** `planning-perf` and `projection-perf` are re-run (C-9), along with the byte-identity proof (REP1).
- **(c) Nightly sync.** `apps/api/test/db/nightly-perf.test.ts` runs the 04:00 chain — scheduled sync of eight connections against a recorded-reply provider fake (a day's delta), then categorisation, transfer pairing, recurring, net-worth and insights. The budget is first sync start to last nightly job end, **< 5 min**. The 730-day first backfill is recorded, not budgeted.
- **(d) RPO and RTO.** RPO is the nightly cadence plus the 26 h staleness check, cited from 9.1's rows. RTO is a timed restore of a scale-seed database to `/ready` on `pf-perf`, **< 1 h**.
- **(e) RAM (CF-13).** Steady-state RSS is sampled for ten idle minutes and through one nightly chain, plus the boot peak. If only the boot Argon2 window exceeds 2 GB, the stagger is 9.11's (key custody), and 9.14 re-measures it.
- **(f) Zero-touch migrations.** Cited from 9.4.
- **(g)** `GET /holdings` and `/investments/allocation` on the scale seed (05 §2), plus 09 §5.3's rows, recorded informationally: dashboard aggregate < 800 ms, cold start < 20 s, the 250k list (§6 Q12).
- **(h)** Regressions in owned files are fixed; anything else is reported.
- **(i) Skips visible by name.** `scripts/check-perf-skips.ts` lists every `skipIf` in a perf file and fails on one without a named reason. CI prints the list into `$GITHUB_STEP_SUMMARY`.
- **(j)** CF-22.

**Owns.** The new perf test files above; `scripts/check-perf-skips.ts` and its test; the comment lines of `worker-host.ts`; the perf sections of `docs/TESTING.md` (Wave C).

**Exit tests.**
- The budgets as named;
- `scripts/check-perf-skips.test.ts`: `'a perf test that skips without a named reason fails the check'`;
- every timing test's row-count sanity check never skips.

**Evidence.** `docs/evidence/phase-9/wp9.9-perf.md`: one table with each budget, its measured p50 and p95, hardware, load, dataset, the command, and pass or fail.

### WP 9.10 — External-style security review (reviews; never fixes)

**Scope.** An Opus `security-engineer` that wrote none of the reviewed code produces `docs/security/asvs-assessment.md`, the path 03 P2-8 named.
- **Every ASVS 5.0 requirement at L1 and L2, across all chapters, has a row.**
- **L3 rows** cover V6 Authentication, V7 Session Management, V11 Cryptography and V13.3 Secret Management — "credential storage and auth".
- Each row records: id, level, applicability (N/A with a reason; V17 WebRTC is the obvious one), status (met / gap / accepted risk), and evidence. The evidence is the sabotage record in a phase gate's §2, a wp file, or a named test.
- **A "met" row that has never been observed failing gets a sabotage of the reviewer's own**, recorded as it happens.

It also re-rates the full 03 §9 P0/P1/P2 table with evidence (§2's unevidenced rows: CF-18, CF-19, P1-13, P1-14, P2-1, P2-10, P2-12) and the egress duplication (§2 row). It re-walks 03 §1's STRIDE register against the built system — the local model, the Brief, the production soak, the upgrade path — and writes `docs/security/threat-model.md`.

An OWASP ZAP baseline scan (`zaproxy/zap-stable` image, a reviewer's tool, never in the tree) against `pf-review` through Caddy is recorded.

Output is the gap list. Each gap carries a severity on the gates' scale, a proposed fix and owner (9.11), or "accept — Chris" with the residual risk stated.

**Owns.** `docs/security/asvs-assessment.md`, `docs/security/threat-model.md`, `docs/evidence/phase-9/wp9.10-security-review.md`. Scratch sabotage edits only, each restored and recorded.

**Exit tests.** Every L2 row, and every named L3 row, has a status and evidence. Every "met" row cites a test observed failing.

**Evidence.** As owned.

### WP 9.11 — Security fixes

**Scope.** 9.10's Medium-and-above gaps, fixed red-first. Lows are fixed or recorded. Pre-assigned items:

- **CF-18, role separation.** A migrator role with DDL; an app role with DML only, granted in migration 0039.
  - The migrator's connection string is a **new *optional* secret** (`migrator_database_url`), falling back to `database_url` when empty.
  - A required new secret would break the very unattended upgrade 9.4 proves. 9.4's harness re-runs the direct jump to show it does not.
- **The single egress implementation** (§2 row).
- **O-11**, import re-validation of plan rows (ASVS V2).
- **C-5's route-level sabotage** (wp5.13 §4.3's diff).
- **The Argon2 boot stagger**, if 9.9 measured a peak over 2 GB.

**Owns.** Named per gap when 9.10 lands (verify-first); the orchestrator assigns. Pre-assigned:
- `packages/platform/src/egress/**`, `apps/api/src/reports/export/import.ts`;
- the `migrator` secret lines in `compose.yml`, `packages/db/migrations/0039_*.sql`;
- the unlock-ordering lines in `@ctx/identity`, if needed.

RUNBOOK text is handed to 9.12 in evidence.

**Exit tests.** Per gap, each red first.

**Evidence.** `docs/evidence/phase-9/wp9.11-security-fixes.md`.

### WP 9.12 — Docs

**Scope.**
- **README.md for a stranger** (CF-14): what this is, what it is not, the host prerequisites (the fewer the better; whether `just` and Node are needed on the host is decided by what 9.13 can actually follow), install in numbered steps to a passkey login, and the links.
- **RUNBOOK.md consolidated:**
  - install, upgrade (9.4's section kept), backup, restore, the restore drill, the soak (9.1's), the local model, the kill switches, panic;
  - the resource envelope from 9.9's numbers;
  - troubleshooting stripped of fixed gaps;
  - the malformed fence fixed.
- The threat-model page linked from the README.
- Release notes for v0.9.0 — 09 §5.8's semver, with every manual step named (the target is zero).
- `.env.example`'s placeholder digest and `compose.yml`'s header text (wp5.2 §10 items 4–5).
- **`scripts/check-docs.ts`** (with a self-test) checks:
  - every `just <recipe>` in README and RUNBOOK exists in `justfile`;
  - every env var named exists in `.env.example` and the `@core/config` schema;
  - every secret named is declared in `compose.yml`;
  - code fences balance;
  - relative links resolve.

**Owns.** `README.md`, `RUNBOOK.md` (whole file in Wave D, applying 9.11's handed text), `.env.example` (text), the `compose.yml` header comment, `docs/RELEASE-NOTES.md`, `scripts/check-docs.ts` and its test.

**Exit tests.**
- `scripts/check-docs.test.ts`: `'a recipe, variable or secret the docs name but the tree lacks fails the check'`;
- the real tree passes.

**Evidence.** `docs/evidence/phase-9/wp9.12-docs.md`.

### WP 9.13 — The stranger install

**Scope.** A fresh Sonnet agent, given **only** the README's text and the repository URL (or a `git archive` of HEAD, if the repo is private), installs PersonalFi in a disposable host. The default (§6 Q7) is a privileged `docker:dind` container used as a throwaway test host. It never touches the host's daemon or projects.

The agent must reach:
- a passkey login over TLS (virtual authenticator);
- a manual account with a CSV import;
- `just backup`;
- a restore drill PASS;
- `just upgrade` from the previous wave's commit.

**Every place the README was insufficient is a finding** with its exact text: a guessed step, an unexplained error, a missing prerequisite. Findings are fixed by the orchestrator or a 9.12 finisher, then **the stranger re-runs from scratch**.

**Owns.** `scripts/stranger/**` (the dind harness), `docs/evidence/phase-9/wp9.13-stranger.md`.

**Exit test.** A from-scratch run with zero findings.

**Evidence.** The full transcript, with timestamps.

### WP 9.14 — Quality pass

**Scope.**
- **The v0.9 and v1.0 audit**: each clause proven, needing Chris, or carried, with its instrument re-run at the landing commit.
- Every `wp9.*` open item mined into one list.
- Verify-first on wp5.14 §8 items 14, 18, 19 and 22.
- The final RAM and perf re-measure after 9.11.
- The soak's state at landing (the newest weekly report).
- `check-ci-projects` still 42/42.
- `docs/TESTING.md`'s Phase 9 section.

**Owns.** `docs/TESTING.md`, `test/advisor-golden.test.ts` (item 22), and `.github/workflows/ci.yml` jointly with the orchestrator.

**Evidence.** `docs/evidence/phase-9/wp9.14-quality.md`.

---

## 4. Waves

**The ceiling is three concurrent agents, at most two Opus, and Phase 9 uses at most one Opus per wave.** Phase 5's record is the reason: eight limit kills, including a weekly one costing ~58 h, three of which took every agent in flight. A session limit takes every agent at once, and the window drains faster the more agents share it.

Phase 9 has more long runs than any phase so far: image builds for seven waypoints, a narrator live evaluation, a perf pass, and a stranger install. Each is detached and resumable (rule 8), so a kill costs the agent's thinking, not the run.

| Wave | Agents | Packages |
|---|---|---|
| A | 3 (1 Opus) | 9.1 soak · 9.2 real-data readiness · **9.4 upgrade (Opus)** |
| B | 3 (1 Opus) | 9.3 Phase 5 carry-overs · **9.5 narrator (Opus)** · 9.6 advisory surface |
| C | 3 (1 Opus) | 9.7 plan screens · 9.9 performance · **9.10 security review (Opus)** |
| D | 3 (1 Opus) | 9.8 WCAG (exclusive web) · **9.11 security fixes (Opus)** · 9.12 docs |
| E | 1 | 9.13 stranger install (+ a docs finisher loop) |
| F | 1 | 9.14 quality pass |
| G | 1 Opus | the Phase 9 gate (§5) → **v0.9** |
| v1.0 close | orchestrator + Chris | soak day 91 (default 2027-01-10): 9.4's direct jump and chain re-run at the release commit; the day-90 report; Chris's sign-off; the tag (§6 Q8) |

**Why Wave A is these three.** 9.1 is the soak's instrument, and the soak is the critical path. 9.4 must exist before production's first `just upgrade`; otherwise the first upgrade Chris runs is the one that finds CF-4. 9.2 must precede his first real projection. **If the Phase 5 verdict carries a HIGH, 9.3 takes 9.2's slot and 9.2 opens Wave B.** Chris's links do not need 9.2.

**Why 9.5 is not in Wave A.** It waits on the Phase 5 verdict's ruling and on Q4.

**Why 9.7 follows 9.6.** Both touch the web shell, and 9.7's plan screens read 9.2's override staleness.

**Why 9.8 is alone on the web in Wave D.** A sweep over screens still being written measures the wrong screens. Exclusive ownership lets it fix what it finds instead of filing reports.

**Why 9.10 is in C and 9.11 in D.** The reviewer reviews a nearly final tree and never fixes; its fixes are another agent's (§5 item 1).

**Why 9.9 is in C.** It runs after 9.4's image builds, which are heavy CPU in Wave A, and must take its final numbers with `ollama` stopped. If 9.5's live evaluation is still running detached, 9.9 measures last and says so.

**Production upgrades during the soak.** After each wave lands and CI is green, the orchestrator posts "wave X at `<sha>`, CI green". **Chris** runs `just upgrade` in `~/personalfi-prod`, with `PERSONALFI_VERSION` set to that SHA (§6 Q6). The pre-migration backup is automatic once 9.4 lands. Each such upgrade is a real-world observation for v1.0's second clause, and the weekly report records it. **Every Phase 9 migration is expand-only** — no contract steps on a live soak.

**Wiring and shared-file batches** (orchestrator-applied at wave boundaries, then `just verify`):

1. **`vitest.config.ts`.** No new project is expected; every new test lives in an existing project (`api-db`, `db`, `scripts`, `insights`, `planning-db`, `ledger-db`). `check-ci-projects` reads **42/42** at `1417b36` and should still read 42 at the gate. A request for a new project means a test is in the wrong directory.
2. **`scripts/eslint-boundaries.js`.** Nothing expected. `apps/api/src/routes/ops.ts` imports only `@core/platform`.
3. **`apps/api/src/{modules.ts,domain.ts,app.ts}`.**
   - **W-A:** planning's tax-bucket and valuation read is bound to ledger overrides (9.2); `ops` route registration (9.1).
   - **W-B:** the api's narrator manifest and preview-renderer config (9.6's proposal); the Brief narration join, if 9.6 asks for a port.
4. **Config batch.**
   - W-A: `PERSONALFI_VERSION` documented as **required non-`dev` for production**.
   - W-B: the api-side local-model preview keys (name and digest, never the endpoint).
   - W-D: `migrator_database_url` as an **optional** secret (9.11), its placeholder known to 9.4's script.
   - Every new secret is optional or unattended upgrade breaks — §5 risk row 3.
5. **`packages/db/test/migrate.test.ts`.**
   - The expected table list (97 names at `1417b36` — re-count before editing) gains `ops_backup_runs`, `ops_restore_drills`, `account_overrides` and `snapshot_grant_events`, plus whatever 0037/0039 add.
   - An attribution block per migration, 0035–0039.
   - ~~The missing 0029 and 0034 attribution (wp5.14 item 23)~~ — verified present at `1417b36`; nothing to add.
6. **`.github/workflows/ci.yml`.** A Phase 9 paragraph in the header map; the perf-skip summary step (9.9); `check-docs` in `lint` (9.12). **`release.yml`** gains `needs: upgrade-test` (9.4).
7. **`apps/web/playwright.config.ts`.** The `chromium` `testMatch` gains `accounts-overrides`, `goals`, `a11y-sweep` and `a11y-keyboard`.
8. **`packages/contracts/`.** `just openapi` and the web client regenerate after Waves A, B and C. The advisor contract goes to 1.6.0 only if 9.5 changes the reply shape, with the published schemas in the same commit. `check-proxy-routes` should pass `/api/ops/*` under the existing `handle_path /api/*`; if it does not, that is a finding. **No CSP directive may widen.**
9. **`justfile`.** One-line recipes wrapping each owning package's script: `soak-report`, `upgrade`, `secrets-placeholders`, `upgrade-test`, `check-docs`, `check-perf-skips`. The `restore-drill` body is 9.1's in Wave A.
10. **`e2e/support/mock-api.ts`.** Orchestrator only, at wave boundaries. In Wave D, `e2e/support/**` is 9.8's.
11. **Dependency batch.** **Nothing expected.** Rejected before an agent proposes them:
    - `@axe-core/playwright` — `axe.ts` already injects `axe-core`;
    - `pa11y`, Lighthouse — a second engine that disagrees;
    - `testcontainers`, Vagrant, `qemu` — scratch compose projects and dind suffice; a VM is §6 Q7's;
    - `k6`, `autocannon` — real `fetch()` over `ApiHarness.listen()` is the established method;
    - colour-contrast packages — the WCAG formula is about twenty lines;
    - ASVS or SAST scanners in the tree — ZAP runs as a reviewer's container, outside the tree.

    Agents never run `pnpm install`.

**Migrations.** `ls packages/db/migrations` at `1417b36` shows **0034 as the highest; 0023 is burned. The next free number is 0035.** Numbers are assigned before dispatch and are not negotiable in flight.

The rule: **no Phase 9 migration references an object a higher-numbered one creates, and two packages in one wave never create objects the other references.** Production applies them in landing order, and the runner tolerates gaps and out-of-order application (`migrate.ts:137–184`). This is exactly why CF-2's "newer" must be set membership, not a maximum.

| Migration | Tables / changes | WP | Wave |
|---|---|---|---|
| **0035** `account_overrides` | `account_overrides` (tax treatment, role, valuation; user-scoped composite FK to `accounts`) | 9.2 | A (B if HIGH) |
| **0036** `ops_status` | `ops_backup_runs`, `ops_restore_drills` (install-wide) | 9.1 | A |
| **0037** | reserved for 9.3 (Phase 5 gate conditions), used only if reported necessary | 9.3 | A or B |
| **0038** `brief_actions_grant_events` | `advisory_brief_items.primary_action` (nullable, CHECK); `snapshot_grant_events` | 9.6 | B |
| **0039** | reserved for 9.11 (role separation and grants; anything 9.10 rates) | 9.11 | D |
| **0040** | spare, used only if reported necessary | — | — |

---

## 5. Gate standard for Phase 9

This is carried in force from the Phase 0–5 gates, with Phase 9's items added. Phase 3's gate ran 45 sabotages, 41 red on the first try, and the four greens were findings. A sabotage count is never a reason to run fewer.

1. **Independent reviewer.** An Opus `security-engineer` that wrote none of the code — **and is neither 9.10's agent nor 9.11's** — re-runs the load-bearing proofs. A gate may not validate its own fixes. For Phase 9 that means:
   - the upgrade direct jump, re-run at the landing commit;
   - every §3.4 budget, re-measured;
   - the a11y sweep and the contrast test;
   - the narrator's live evaluation and red-team pass, or the orchestrator's detached runs re-judged through today's validator, as the Phase 5 gate did (path (a));
   - ASVS spot checks against 9.10's "met" rows.
2. **Sabotage every new control and observe it go red** before accepting its pass, recording first-try reds. The list:
   - the newer-database refusal; secret placeholders; the pre-migration backup;
   - the soak canary and the soak structural check; the isolation guard;
   - the contrast test; the axe exclusion ban; the keyboard-only structural check;
   - the perf skip-name check; the docs drift check;
   - narrator identity or slots; grant history; override scoping; ops status.
3. **Walk a production-like stack in a real browser**, through Caddy, on an image rebuilt from the landing commit, **in the gate's own project, never `personalfi-prod`.** The walk must reach Phase 9's code:
   - a tax-treatment override turning the projection stale;
   - every plan problem state in words, and a deterministic run worded as one;
   - goal CRUD by keyboard;
   - a narrator payload previewed and approved through the api, followed by a narrated Brief item (with the narrator enabled in the gate's project only);
   - the backup-status line after a real backup;
   - a destructive dialog in the dark theme;
   - one full keyboard-only journey.

   **A login that stops at the shell proves nothing.**
4. **Every "never" claim has a test that fails when the thing is made to happen.** Phase 9's list:
   - the soak report never prints an amount, a name, a memo or an institution;
   - an older binary never serves a newer schema;
   - migrations never run without a backup taken first;
   - an axe run never excludes an element;
   - a perf number is never recorded with a model loaded;
   - a narration's key is never model-written (option A), and a figure is never model-written (option B);
   - a deterministic run is never phrased as a probability;
   - a grant change is never overwritten;
   - an override never reaches another user's account.
5. **Every new vitest project is in `ci.yml` the day it is created.** None is expected; 42/42. The gate confirms the check still fails when a project is dropped.
6. **The walk starts from a genuinely cold install** (`down -v` **on the gate's own project only**, then `up`, then bootstrap, with no restart) and **observes scheduled work fire**: one nightly chain and one shortened weekly Brief. **Then the gate runs the upgrade itself:** v0.1 → landing commit, by `just upgrade` alone, with checks (i)–(vi) of WP 9.4.
7. **`just verify`, not `just check`**, at the landing commit, **and CI green on the real GitHub runner.** The Phase 5 gate's conditions are inputs, not outputs. A condition that has skipped two gates is a process finding.
8. **A cross-user sabotage drops every scoping predicate, individually and together**, on every Phase 9 route: overrides, grant history, Brief narration and action, and the kind GET. `GET /ops/backup-status` is install-wide, so the gate proves it returns nothing user-scoped.
9. **The v0.9 audit.** Each of the four clauses is re-proven with its instrument. "Security review closed" means every gap is fixed and observed red-then-green, or accepted by Chris **in writing** with its residual risk.

### Phase-9-specific risks

| Risk | Control | Proven by |
|---|---|---|
| **A test, an agent or the gate destroys Chris's real data** — `down -v` on the wrong project, a prune while prod is stopped, or a rebuilt `:dev` image recreated into prod (CF-20, CF-21) | A separate directory, project, SHA-pinned image tag, secrets and ports; rules 5–7 in every brief; prune banned; 9.1's isolation guard; the gate works in its own project | Before and after the gate: `personalfi-prod`'s volume names and creation times, and its container image IDs, unchanged — read by the orchestrator, never the gate; 9.1's scratch `pf-prodlike` proof |
| **The soak report leaks real data into a pushed repository** | Aggregates and whitelisted dimensions only, connection ordinals rather than names, a structural SQL check, the canary test | WP 9.1's tests; the gate plants a *new* canary in each free-text column and re-runs the report |
| **An unattended upgrade works only on the path the test takes** — SQL-loaded data, pre-made secrets, an extra hand step | Data loaded through each version's own API; secrets generated as that version's docs say; only `just upgrade` between versions; every new secret optional | 9.4's transcripts; the gate's own direct jump; 9.11's optional-secret proof |
| **Out-of-order migrations on prod read as "newer" and lock Chris out** | "Newer" is set membership, never a maximum | `'migrations applied out of number order converge and never read as newer'` |
| **A green perf number taken under contention or on the wrong machine** | Load printed, `ollama` stopped, no builds alongside; the target hardware named (§6 Q1) | 9.9's table; the gate re-measures |
| **axe is green because it cannot see** — portals, `target-size` disabled, element exclusions | Document scope, the 2.2 tag set with `target-size` on, exclusions banned, a contrast test straight from the tokens | 9.8's tests red first at `1417b36`; the gate re-adds one exclusion and one off-token colour and watches both go red |
| **The reviewer validates its own fixes** | 9.10 reviews, 9.11 fixes, the gate re-verifies; three different agents | The gate's §1 names who ran each proof |
| **Docs pass because their writer followed them** | A fresh stranger with nothing but the README; a drift check against the tree | 9.13's zero-finding re-run; `check-docs` sabotaged |
| **The narrator's rate improves by loosening safety** | Step 7 never widened; no retry-until-valid; the red-team suite and the live pass stay at 0 survived | The gate widens the trace back and watches both go red, as in Phase 5 |
| **The 90-day clock is silently invalid** — an unreported fallback, an outage | Weekly attestation; a missing attestation printed as a gap; the outage and reset rules (§6 Q6) | The weekly files; the v1.0 close reads all of them |
| **Phase 9 code damages live data mid-soak** | Expand-only migrations; automatic pre-migration backup; prod upgraded only at a wave commit with CI green, after the chain passed on that commit | 9.4's chain per wave; `ops_backup_runs` rows before each `schema_migrations` change in the weekly report |

---

## 6. Open questions for Chris

Work proceeds on the stated default; an answer is a cheap change. Dates are "answer by"; silence means the default.

1. **Where production runs, and how it is kept away from the agents.** *(by 2026-10-09)* Default:
   - **this host**, in `~/personalfi-prod`: a clone at a pinned SHA, project `personalfi-prod`, `PERSONALFI_VERSION=<sha>`;
   - its own hardened `secrets/`; bound to the Tailscale address on 443;
   - the dev and gate stack stay on `127.0.0.1`.

   If you have a separate home server, it is better on every axis — isolation, perf numbers on the real target, and no ~5 GB model beside your data. It then becomes the target hardware for §3.4.
2. **Soak day one.** *(target 2026-10-12, which makes the earliest v1.0 2027-01-10)* Your hand actions:
   - production LUKS2, Tailscale HTTPS, real secrets, B2 with object lock, `sudo just harden-secrets` (C-16);
   - the return-series fetch (RUNBOOK C-1);
   - link at least two institutions (06 item 1); the Coinbase view-only key if you want item 6;
   - write day one in `docs/evidence/phase-9/soak/clock.md` with "other tools retired".

   The soak report does not need to exist first; it backfills.
3. **C-15, the pseudonym swap — the sixth phase, and now with a deadline.** *(by 2026-10-09)* It must be decided **before your first real link**: swapping afterwards orphans every stored `MERCHANT_…` evidence reference.

   Default if unanswered: **record D27, "`configHash` is the pseudonym construction, by design"**, and stop carrying it. If you answer "apply", the orchestrator applies it on dev and production before day one.
4. **The narrator.** *(by the Wave B dispatch, ~2026-10-08)* Default: **option A** — the app writes the finding's identity, and the envelope carries what you are shown. Then **option B** (slot references) if the Phase 5 gate rules R-2 due, or if A reads under 95 %.

   **Option C** (a larger model) only if you name the hardware: a 14B model at 4-bit is ~9 GB resident and roughly half today's 4.5 tokens/s on this host, which breaks the 300 s request cap.

   The narrator stays off in production until a counted live run reads ≥ 95 %. Turning it on is your switch.
5. **C-10: goals, the questionnaire and forking on screen.** Default: **build** (9.7, Wave C), first on the cut order. If no, the gate states that 04 §5 item 3's on-screen steps remain unmet.
6. **The clock's rules, and who upgrades production.** Default:
   - **reset** on an attested fallback to another tool or a spreadsheet (09 §8.2: "zero occurrences in the final 90 days"), or on data loss beyond the 24 h RPO;
   - **pause** for a production outage over 24 h without loss;
   - upgrades never reset the clock.

   **You** run `just upgrade` when the orchestrator posts "CI green at `<sha>`". Nothing an agent does touches production.
7. **The stranger's machine.** Default: **a disposable privileged `docker:dind` container** on this host, driven by a fresh agent with only the README. A spare machine or VM — or a human friend — is a truer stranger, and either replaces the default.
8. **The first release tag.** Default: **tag `v0.9.0` at the Phase 9 gate's GO.** `release.yml` then builds, signs (cosign keyless) and publishes images to GHCR — publicly — for the first time. The README offers `cosign verify` plus a pull as the install path, and P1-5 is exercised (CF-19).

   If no: the README installs from source, and P1-5 stays rated "unexercised".
9. **The 2 GB whole-stack target.** Default: measure it. If only the boot Argon2 window exceeds it (api and worker each derive 1 GiB), 9.11 staggers the two derivations rather than touching the KDF parameters. §3.4's wording is amended to "steady state" only with your OK.
10. **A screen-reader listening session (Orca).** Default: **not part of "checks pass"**; recorded as a 30-minute manual item for you in 9.8's checklist.
11. **Deferred past v1.0, each recorded as a decision:**
    - the bitemporal store (05 Q4; every month of history without a knowledge time is a month no backtest can use);
    - Monte Carlo bootstrap re-centring (moves every stored probability mid-soak);
    - the shared projection kernel; the Bengen/Guyton-Klinger published fixtures;
    - BTC block bootstrap; an earmarks route; i18n catalogues.

    Default: **all deferred.**
12. **09 §5.3's 250k-row / 25-account targets versus §3.4's 50k.** Default: **50k gates v0.9; 250k is measured and recorded.**
13. **Plan terms for I8–I10 and R5** (06 item 7). Default: **not entered**; the rules stay in `CATALOGUE_GAPS`, naming what they lack.
14. **The return-series licence** (Phase 4 Q3). Default: **accepted as fetch-on-first-run**; the production install runs the RUNBOOK C-1 fetch on day one.
