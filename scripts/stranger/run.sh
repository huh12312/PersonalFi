#!/usr/bin/env bash
# Usage: RUN=<n> scripts/stranger/run.sh <phase> [args]
# Phases are defined in phases.sh. Long phases are started detached by the caller:
#   setsid nohup env RUN=1 scripts/stranger/run.sh build > /tmp/wp913/runs/1/build.log 2>&1 &
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
. "$HERE/phases.sh"
phase="${1:?phase}"; shift
"phase_$phase" "$@"
