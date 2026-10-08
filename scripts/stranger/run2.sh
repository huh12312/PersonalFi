#!/usr/bin/env bash
# Run the whole stranger install end to end on a fresh dind.
#   scripts/stranger/run2.sh --run 2 --cand-tar /tmp/wp913/personalfi-src-run2.tar --cand-sha <sha> \
#       [--prev-tar /tmp/wp913/personalfi-src-previous-wave.tar] [--prev-sha b9fa4d2] \
#       [--apk "git just nodejs openssl bash coreutils curl"] [--teardown] [--no-upgrade] [--from PHASE]
# Long: start it detached and poll the log in the foreground:
#   setsid nohup scripts/stranger/run2.sh --run 2 ... > /tmp/wp913/runs/2/full.log 2>&1 &
# It stops at the first failing phase (a failure is a finding: record it, work around by hand with the phase functions
# in phases.sh, then continue from the next phase with: RUN=<n> scripts/stranger/run.sh <phase>).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_N=""; CAND_TAR_ARG=""; CAND_SHA_ARG=""; PREV_TAR_ARG="/tmp/wp913/personalfi-src-previous-wave.tar"; PREV_SHA_ARG=""; APK_ARG=""; TEARDOWN=0; NO_UPGRADE=0; FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN_N=$2; shift 2 ;; --cand-tar) CAND_TAR_ARG=$2; shift 2 ;; --cand-sha) CAND_SHA_ARG=$2; shift 2 ;;
    --prev-tar) PREV_TAR_ARG=$2; shift 2 ;; --prev-sha) PREV_SHA_ARG=$2; shift 2 ;; --apk) APK_ARG=$2; shift 2 ;;
    --teardown) TEARDOWN=1; shift ;; --no-upgrade) NO_UPGRADE=1; shift ;; --from) FROM=$2; shift 2 ;; *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RUN_N" ] && [ -n "$CAND_TAR_ARG" ] && [ -n "$CAND_SHA_ARG" ] || { echo "usage: --run N --cand-tar PATH --cand-sha SHA [--prev-tar PATH] [--prev-sha SHA] [--apk LIST] [--teardown]" >&2; exit 2; }
[ -f "$CAND_TAR_ARG" ] && [ -f "$PREV_TAR_ARG" ] || { echo "archive not found" >&2; exit 2; }
export RUN="$RUN_N" CAND_TAR="$CAND_TAR_ARG" PREV_TAR="$PREV_TAR_ARG" CAND_SHA="$CAND_SHA_ARG"
[ -n "$APK_ARG" ] && export PREREQ_APK="$APK_ARG"
. "$HERE/lib.sh"; . "$HERE/phases.sh"
note "## Run $RUN: candidate $CAND_SHA ($CAND_TAR), previous wave ${PREV_SHA_ARG:-unspecified} ($PREV_TAR), started $(ts)"
PHASES="start_dind prereqs sudo origin install1 build install5 up browser_tools trust nss bootstrap enrol firstdata backup drill publish upgrade verify_after_upgrade"
[ "$NO_UPGRADE" = 1 ] && PHASES="start_dind prereqs sudo origin install1 build install5 up browser_tools trust nss bootstrap enrol firstdata backup drill"
if [ -n "$FROM" ]; then PHASES="${PHASES#*$FROM}"; PHASES="$FROM$PHASES"; fi # resume (dind already up; harness workarounds must be noted by hand)
for ph in $PHASES; do
  note "--- phase $ph ($(ts))"
  STEP_FAILED=0
  "phase_$ph" && [ "$STEP_FAILED" = 0 ] || { note "PHASE FAILED: $ph (see $RUNDIR) - stopping; this is a finding to record."; exit 1; }
done
note "## Run $RUN: all phases passed ($(ts)); the verdict (findings or none) is written by hand below."
[ "$TEARDOWN" = 1 ] && phase_teardown
exit 0
