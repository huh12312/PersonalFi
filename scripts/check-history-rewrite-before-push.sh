#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# gate-remediation-2.md finding 7.
#
# .gitleaksignore carries two TRUE-POSITIVE fingerprints (commit c7846dc,
# docs/evidence/phase-0/wp0.2-summary.md) for a live bootstrap enrolment token
# that reached history before it was redeemed. They are not false positives —
# see that file's header — and the whole reason they can sit in an allowlist
# instead of forcing an immediate `git filter-repo` is that "there is no
# remote — nothing has ever been pushed — so the history is local and can
# still be rewritten cheaply" (same header).
#
# That reasoning stops being true the moment a remote exists: a remote is
# where "pushed" starts. This is the check that the ratchet actually holds —
# run by `just verify` and by the lefthook `pre-push` hook — so a first `git
# push` cannot happen with the token still reachable in unrewritten history.
#
# Deliberately independent of `.git/hooks` or any push URL: it only asks
# whether *a* remote is configured at all, because the token is exactly as
# reachable by an unintended remote as an intended one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PINNED_COMMIT="c7846dc6282f6ae7156e56b36f47a8de14d969aa"
PINNED_FILE="docs/evidence/phase-0/wp0.2-summary.md"
GITLEAKSIGNORE=".gitleaksignore"

if [ -z "$(git remote)" ]; then
  echo "check-history-rewrite-before-push: no remote configured — nothing to check" >&2
  exit 0
fi

if [ ! -f "$GITLEAKSIGNORE" ]; then
  echo "check-history-rewrite-before-push: $GITLEAKSIGNORE not found — nothing to check" >&2
  exit 0
fi

still_present=0
for line in 96 98; do
  if grep -qxF "${PINNED_COMMIT}:${PINNED_FILE}:generic-api-key:${line}" "$GITLEAKSIGNORE"; then
    still_present=$((still_present + 1))
  fi
done

if [ "$still_present" -gt 0 ]; then
  echo "check-history-rewrite-before-push: FAIL: a git remote is configured and ${GITLEAKSIGNORE}" >&2
  echo "  still allowlists the ${PINNED_COMMIT} true-positive fingerprints for ${PINNED_FILE}" >&2
  echo "  (a live bootstrap enrolment token reachable in history — see that file's header)." >&2
  echo "  rewrite history with git filter-repo before first push" >&2
  exit 1
fi

echo "check-history-rewrite-before-push: PASS (no remote carries the pinned fingerprints)" >&2
