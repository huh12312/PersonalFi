#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Condition C-5 (Phase 4 gate G4-5; docs/evidence/phase-5/wp5.13-carry-overs.md
# §4.3): the route-level sabotage of `apps/api/test/db/carry-c5-net-worth.test.ts`,
# committed so any gate can re-run it rather than re-typing a diff from evidence
# (WP 9.11). Three sabotages, each the exact edit wp5.13 §4.3 names:
#
#   P3-C8r  routes/investments.ts  readUnresolvedSecurities: the user_id predicate dropped
#   P3-C9r  routes/net-worth.ts    readLastSnapshotFxFailure: AND user_id = $2 dropped
#   P3-C9s  routes/net-worth.ts    POST /net-worth/fx-rates: requireFreshSession -> requireSession
#
# For each: the file's bytes are saved, the edit is applied (refused unless its
# anchor matches exactly once), the C-5 test runs and MUST fail on the named
# case, and the original bytes are written back — on success, failure, or a
# signal (trap) — and checked byte-identical (sha256). Then the unmodified test
# must pass. Exit 0 only if every sabotage was red and every restore exact.
#
#   bash scripts/sabotage/c5-net-worth.sh            # needs the dev Postgres (DATABASE_URL)
#   bash scripts/sabotage/c5-net-worth.sh --check    # anchors only: each matches exactly once (no DB)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TEST=apps/api/test/db/carry-c5-net-worth.test.ts
INV=apps/api/src/routes/investments.ts
NW=apps/api/src/routes/net-worth.ts

# id | file | expected red case (substring of the test title) | anchor | replacement
IDS=(P3-C8r P3-C9r P3-C9s)
declare -A FILE=([P3-C8r]=$INV [P3-C9r]=$NW [P3-C9s]=$NW)
declare -A RED=(
  [P3-C8r]="unresolved list names the caller's own"
  [P3-C9r]="lastSnapshotFailure is the caller's own"
  [P3-C9s]="refuses a stale session"
)
declare -A OLD=(
  [P3-C8r]=$'     WHERE user_id = ${userId}::uuid\n       AND event_type = \'investments.SecurityResolutionFailed\''
  [P3-C9r]=$'      WHERE kind = $1 AND user_id = $2'
  [P3-C9s]=$'      async (request) => {\n        const session = await guards.requireFreshSession(request);\n        const base = request.body.base'
)
declare -A NEW=(
  [P3-C8r]=$'     WHERE ${userId}::uuid IS NOT NULL -- SABOTAGE C-5 P3-C8r\n       AND event_type = \'investments.SecurityResolutionFailed\''
  [P3-C9r]=$'      WHERE kind = $1 AND $2::uuid IS NOT NULL -- SABOTAGE C-5 P3-C9r'
  [P3-C9s]=$'      async (request) => {\n        const session = await guards.requireSession(request); // SABOTAGE C-5 P3-C9s\n        const base = request.body.base'
)

say() { echo "c5-sabotage: $*"; }

# replace <file> <old> <new>: exactly one match, or refuse (exit 3).
replace() {
  OLD_TEXT="$2" NEW_TEXT="$3" node -e '
    const fs = require("node:fs");
    const [file] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    const count = src.split(process.env.OLD_TEXT).length - 1;
    if (count !== 1) { console.error(`anchor matched ${count} times in ${file}`); process.exit(3); }
    fs.writeFileSync(file, src.replace(process.env.OLD_TEXT, process.env.NEW_TEXT));
  ' "$1"
}

check_anchors() {
  local id bad=0 count
  for id in "${IDS[@]}"; do
    count="$(OLD_TEXT="${OLD[$id]}" node -e '
      const s = require("node:fs").readFileSync(process.argv[1], "utf8");
      process.stdout.write(String(s.split(process.env.OLD_TEXT).length - 1));
    ' "${FILE[$id]}")"
    if [ "$count" = "1" ]; then say "anchor $id ok (${FILE[$id]})"; else say "anchor $id matched $count times in ${FILE[$id]}"; bad=1; fi
  done
  grep -q "refuses a stale session" "$TEST" || { say "the C-5 test no longer names its step-up case"; bad=1; }
  return "$bad"
}

if [ "${1:-}" = "--check" ]; then
  check_anchors && say "CHECK PASS" && exit 0
  say "CHECK FAILED"
  exit 1
fi

check_anchors || { say "REFUSED: an anchor has drifted; fix this script with the route"; exit 1; }

BACKUP="$(mktemp -d)"
INFLIGHT=""
restore() {
  if [ -n "$INFLIGHT" ]; then
    cp "$BACKUP/orig" "$INFLIGHT"
    INFLIGHT=""
  fi
}
trap 'restore; rm -rf "$BACKUP"' EXIT
trap 'restore; exit 130' INT TERM

run_test() {
  timeout 600 pnpm exec vitest run --reporter=verbose --project api-db "$TEST" >"$BACKUP/out" 2>&1
}

failures=0
for id in "${IDS[@]}"; do
  f="${FILE[$id]}"
  cp "$f" "$BACKUP/orig"
  before="$(sha256sum "$f" | cut -d' ' -f1)"
  INFLIGHT="$f"
  replace "$f" "${OLD[$id]}" "${NEW[$id]}"
  if run_test; then
    say "$id FAILED: the C-5 test stayed GREEN with the sabotage applied"
    failures=$((failures + 1))
  elif grep -E '×' "$BACKUP/out" | grep -qF "${RED[$id]}"; then
    say "$id RED: $(grep -E '×' "$BACKUP/out" | grep -F "${RED[$id]}" | sed 's/^ *//' | cut -c1-200 | head -1)"
  else
    say "$id FAILED: red, but not on the case it names (${RED[$id]}):"
    grep -E '×|Error' "$BACKUP/out" | head -5
    failures=$((failures + 1))
  fi
  restore
  after="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ "$before" != "$after" ]; then
    say "$id RESTORE FAILED: $f is not byte-identical"
    exit 2
  fi
  say "$id restored byte-identical (sha256 ${before:0:12})"
done

if run_test; then
  say "unmodified: GREEN"
else
  say "unmodified: RED — the C-5 test fails without any sabotage"
  failures=$((failures + 1))
fi
[ "$failures" -eq 0 ] || { say "FAILED (${failures})"; exit 1; }
say "PASS: 3/3 sabotages red on their own case, every restore exact, unmodified green"
