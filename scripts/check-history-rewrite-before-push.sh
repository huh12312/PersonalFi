#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# gate-remediation-2.md finding 7; hardened per gate-security-review-3.md R-5/R-6.
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
#
# R-5: the previous version of this check read *.gitleaksignore's text* —
# did the two pinned fingerprint lines still appear? That asserts nothing
# about actual git history. Deleting those two lines (with or without a real
# `git filter-repo` rewrite) flips the file-text check either way, and it
# says nothing about whether the live token from c7846dc is still reachable
# by anything a push could carry. This version asserts reachability of the
# real object directly, two independent ways: (1) is the exact commit object
# c7846dc still reachable from any local branch/tag (`git rev-list --all`,
# not the reflog — a real `git filter-repo` rewrite gives every descendant a
# new hash, so the original SHA drops out of `--all` once the rewrite has
# happened, independent of what .gitleaksignore says), and (2) does the
# token's own text still appear anywhere in that file's history (`git log
# -S`), in case it was ever reintroduced under a different commit.
#
# R-6: a remote now exists, so this check's job is live — .gitleaksignore
# missing used to be read as "nothing to check" (exit 0), which silently
# passes the exact moment someone deletes the file that documents why the
# fingerprints below are allowlisted at all. Fail closed instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PINNED_COMMIT="c7846dc6282f6ae7156e56b36f47a8de14d969aa"
PINNED_FILE="docs/evidence/phase-0/wp0.2-summary.md"
GITLEAKSIGNORE=".gitleaksignore"
# A short fragment of the redacted token (first 12 of its 43 characters) —
# long enough to be a unique `git log -S` fingerprint, short enough that it
# is not itself a usable credential even though the token is already
# provably dead (single-use, never redeemed, its database dropped — see
# .gitleaksignore's header).
REDACTED_FRAGMENT="vj5TagzLYiC7"

if [ -z "$(git remote)" ]; then
  echo "check-history-rewrite-before-push: no remote configured — nothing to check" >&2
  exit 0
fi

if [ ! -f "$GITLEAKSIGNORE" ]; then
  echo "check-history-rewrite-before-push: FAIL: a git remote is configured and ${GITLEAKSIGNORE} is missing." >&2
  echo "  This file documents why the ${PINNED_COMMIT} true-positive fingerprints are allowlisted;" >&2
  echo "  its absence is not evidence a history rewrite happened. Restore it, or rewrite history" >&2
  echo "  with git filter-repo and re-run this check." >&2
  exit 1
fi

still_reachable=0

# 1. Is the exact known-bad commit object still reachable from anything a
#    push could carry? `--all` covers every local branch and tag; it
#    deliberately does not include the reflog, which is never pushed.
#
#    Captured to a variable rather than piped straight into `grep -q`:
#    under `pipefail`, `grep -q` closing its stdin as soon as it finds a
#    match sends `git rev-list` a SIGPIPE, and pipefail then reports the
#    *pipeline's* exit status as that non-zero signal death — not grep's own
#    (successful) match — which would make this branch silently never fire.
all_commits="$(git rev-list --all 2>/dev/null)"
if grep -qx "$PINNED_COMMIT" <<<"$all_commits"; then
  echo "check-history-rewrite-before-push: commit ${PINNED_COMMIT} is still reachable from a local ref" >&2
  still_reachable=1
fi

# 2. Does the token's own text still appear anywhere in that file's history,
#    reachable from any local ref, regardless of which commit carries it?
if [ -n "$(git log --all --oneline -S "$REDACTED_FRAGMENT" -- "$PINNED_FILE" 2>/dev/null)" ]; then
  echo "check-history-rewrite-before-push: the token's own fingerprint text is still reachable in history" >&2
  still_reachable=1
fi

if [ "$still_reachable" -gt 0 ]; then
  echo "check-history-rewrite-before-push: FAIL: a git remote is configured and the c7846dc bootstrap" >&2
  echo "  enrolment token (P0-10, gate §2.8) is still reachable in history that could be pushed." >&2
  echo "  rewrite history with git filter-repo before first push" >&2
  exit 1
fi

echo "check-history-rewrite-before-push: PASS (${PINNED_COMMIT} is not reachable from any local ref)" >&2
