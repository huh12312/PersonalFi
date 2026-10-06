<!-- SPDX-License-Identifier: MIT -->

# The soak clock

Chris's dated attestations for the 90-day real-use soak (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.1" part 5;
rules in §6 Q6; the procedure in RUNBOOK "Production install and the real-use soak"). `scripts/soak/report.ts`
reads the table at the bottom of this file and prints "day N of 90" in every weekly report.

**This file is yours.** An agent never writes a row here. A week with no attestation row prints as a **GAP** in
the weekly report — never as clean — so write one `attest` row a week, even when nothing happened.

## Rows

One row per line, exactly `| YYYY-MM-DD | event | one-line note |`, appended at the bottom of the table. A row that
does not match is ignored (a typo reads as a missing attestation, which prints as a gap, so it cannot flatter you).

| Event                        | Clock effect                                                                                                                          | Counts as the week's attestation |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `day_one`                    | Starts the clock; that date is day 1. Write it when production is installed, two institutions are linked and other tools are retired. | yes                              |
| `attest`                     | None. "This week I used only PersonalFi; anything that went wrong is written here."                                                   | yes                              |
| `fallback`                   | **Resets** the clock to this date. You used another tool or a spreadsheet; write the one-line reason.                                 | yes                              |
| `data_loss`                  | **Resets** the clock to this date. Data lost beyond the 24 h RPO.                                                                     | yes                              |
| `outage_start`, `outage_end` | An outage longer than 24 h **pauses** the clock for its length (no `outage_end` yet: paused through the report date).                 | yes                              |
| `upgrade`                    | None. Record `just upgrade`, with the SHA. Upgrades never reset or pause.                                                             | no                               |
| `criterion`                  | None. A judged line for the criteria ledger: `N: met\|failed\|observing - why`, N in 3–8, 10, 11.                                     | no                               |

Examples (these lines do not start with a pipe, so they are not read):

```text
e.g. | 2026-10-12 | day_one | production at <sha>, two institutions linked, other tools retired |
e.g. | 2026-10-19 | attest | nothing to report |
e.g. | 2026-10-24 | fallback | paid a bill from the old spreadsheet because the sync was stale |
e.g. | 2026-10-26 | upgrade | just upgrade at <sha> |
e.g. | 2026-11-02 | criterion | 3: met - the recurring gold set matched my own list |
```

## Attestations

| Date | Event | Note |
| ---- | ----- | ---- |
