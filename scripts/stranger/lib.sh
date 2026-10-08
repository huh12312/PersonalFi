#!/usr/bin/env bash
# WP 9.13 stranger-install harness: shared helpers. Everything the install does happens INSIDE the
# pf-stranger-dind container. The only host-daemon commands used are on that one container.
set -u
RUN="${RUN:?set RUN=<n>}"
C=pf-stranger-dind
RUNDIR="/tmp/wp913/runs/$RUN"
EVID=/home/chris/Projects/PersonalFi/docs/evidence/phase-9/wp9.13-stranger.md
PFHOME=/home/pf
CHECKOUT=$PFHOME/personalfi
mkdir -p "$RUNDIR"

# redact: real values captured from a run (registration tokens, age public keys) must never reach the evidence file.
redact() { sed -E 's/(token=)[A-Za-z0-9_-]+/\1<redacted>/g; s/(token only: +)[A-Za-z0-9_-]+/\1<redacted>/g; s/age1[a-z0-9]{50,}/age1<redacted>/g; s/\b[A-Z0-9]{5}-[A-Z0-9]{5}\b/<code>/g'; }

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
note() { printf '\n%s\n' "$*" >> "$EVID"; echo "[$(ts)] $*"; }

# dxr <cmd>: run as root in dind.  dxp <cmd>: run as user pf in the checkout (login shell).
dxr() { docker exec "$C" sh -c "$1"; }
dxp() { docker exec -u pf -w "$CHECKOUT" -e HOME=$PFHOME "$C" bash -lc "$1"; }
dxph() { docker exec -u pf -w "$PFHOME" -e HOME=$PFHOME "$C" bash -lc "$1"; }

# step <id> <who: root|pf|pfhome> <description> <cmd>
# Runs, writes full output to $RUNDIR/<id>.out, appends a trimmed transcript block to the evidence.
step() {
  local id=$1 who=$2 desc=$3 cmd=$4 t0 s0 s1 rc out="$RUNDIR/$1.out"
  t0=$(ts); s0=$(date +%s)
  echo "[$t0] >>> $id ($desc): $cmd"
  case $who in
    root) dxr "$cmd" > "$out" 2>&1; rc=$? ;;
    pf) dxp "$cmd" > "$out" 2>&1; rc=$? ;;
    pfhome) dxph "$cmd" > "$out" 2>&1; rc=$? ;;
  esac
  s1=$(date +%s)
  [ "$rc" -ne 0 ] && STEP_FAILED=1
  local n; n=$(wc -l < "$out")
  {
    printf '\n#### %s  %s  (%s)\n\n' "$t0" "$id" "$desc"
    printf '```console\n$ %s\n' "$cmd"
    if [ "$n" -gt 70 ]; then head -n 30 "$out"; printf '... [%s lines omitted; full log %s]\n' $((n-60)) "$out"; tail -n 30 "$out";
    else cat "$out"; fi
    printf '```\n\nexit=%s, duration=%ss\n' "$rc" $((s1-s0))
  } | redact >> "$EVID"
  tail -n 15 "$out"
  echo "[$(ts)] <<< $id exit=$rc duration=$((s1-s0))s"
  return $rc
}
