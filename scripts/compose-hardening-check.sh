#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Compose-hardening gate (master plan P0-6: "no Docker socket mounted; no
# privileged; no --net=host; no --pid=host; CI greps compose files"). Run by
# CI's `compose-hardening` job on every push/PR and by `just lint` locally.
#
# Deliberately a grep, not a YAML-aware check: the point is that none of these
# four strings may appear in a compose file at all, in any service, under any
# spelling compose accepts. A YAML parser that "correctly" ignores a commented
# -out `privileged: true` is solving the wrong problem — the grep is the
# control precisely because it has no notion of "this one's fine."
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Every compose file in the repo, not just compose.yml — compose.dev.yml and
# compose.override.example.yml are held to the same bar. A plain `find`
# rather than `git ls-files`: this must also catch a compose file that has
# not been `git add`ed yet, not just what is already tracked.
mapfile -t FILES < <(
  find . -regextype posix-extended \
    \( -path './node_modules' -o -path './.git' -o -path './.claude' -o -name 'dist' -o -name 'coverage' \) -prune -o \
    \( -iregex '.*/compose[.-][^/]*\.ya?ml' -o -iregex '.*/compose\.ya?ml' \) -print \
    | sed 's#^\./##' | sort -u
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "compose-hardening-check: no compose files found — nothing to check" >&2
  exit 1
fi

FAIL=0

check_pattern() {
  local pattern="$1"
  local message="$2"
  local file
  for file in "${FILES[@]}"; do
    if grep -nE "$pattern" "$file" >/dev/null 2>&1; then
      echo "compose-hardening-check: FAIL: $file: $message" >&2
      grep -nE "$pattern" "$file" | sed 's/^/    /' >&2
      FAIL=1
    fi
  done
}

check_pattern '^\s*privileged\s*:\s*true' 'privileged: true is never allowed'
check_pattern '^\s*network_mode\s*:\s*.host.' 'network_mode: host is never allowed'
check_pattern '^\s*pid\s*:\s*.host.' 'pid: host is never allowed'
check_pattern '/var/run/docker\.sock' 'mounting the Docker socket into a compose service is never allowed'

if [ "$FAIL" -ne 0 ]; then
  echo "compose-hardening-check: one or more compose files fail the P0-6 gate" >&2
  exit 1
fi

echo "compose-hardening-check: PASS (${#FILES[@]} file(s) checked: ${FILES[*]})"
