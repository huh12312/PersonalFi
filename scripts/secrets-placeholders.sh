#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Create every OPTIONAL file secret this compose project declares, empty, if it
# is missing (CF-4, docs/plan/09-phase-9-dispatch.md §2b; WP 9.4). Run by `just
# upgrade` before anything is built or started, and safe to run any time.
#
# WHY
# ---
# Compose has no optional-secret model: it refuses to start a service whose
# secret file does not exist ("secret ... file not found"). v0.1 declared 6 file
# secrets; HEAD declares 17. RUNBOOK "Create secrets" has a *first* install
# `touch` the optional ones, but nothing did it for an install that predates
# them, so `git pull && docker compose up` from v0.1 failed on 11 missing files.
# `packages/config` treats a zero-length secret file exactly as a missing one,
# so an empty placeholder boots exactly as no file would — the feature stays
# off until the operator writes a real value.
#
# THE RULES
# ---------
#   * The declared set is computed, never hand-listed: `docker compose config
#     --format json` (every profile, plus `compose.override.yml` if present —
#     what `docker compose up` itself would read), top-level `secrets:` entries
#     with a `file:`.
#   * REQUIRED (below) are never invented. A missing or empty required secret
#     is refused, by name, BEFORE anything is written — this script never
#     leaves a half-done directory behind a refusal.
#   * Everything else declared is optional and created empty (mode 0444, the
#     RUNBOOK's default; `just harden-secrets` takes it further) — and only if
#     nothing exists at that path. An existing file is never touched: not its
#     content, not its mode, not its owner. A dangling symlink counts as
#     existing (an operator put it there).
#   * Each secrets directory is kept 0700 (compose.yml's `secrets:` header: the
#     directory, not the file modes, is the confidentiality boundary).
#   * Every NEW secret a package adds must be optional, or unattended upgrade
#     breaks (09 §5, risk row 3). A secret that must carry content joins
#     REQUIRED here in the same commit that declares it.
#
#   bash scripts/secrets-placeholders.sh                     # this checkout's compose project
#   bash scripts/secrets-placeholders.sh --project-dir DIR   # another checkout (the upgrade test)
#   bash scripts/secrets-placeholders.sh --self-test         # synthetic fixture, needs no root
#
# Needs `docker compose` (v2+) and node — the same as compose-hardening-check.sh.
# Prints secret NAMES only, never a value.
set -euo pipefail

REQUIRED=(database_url pg_password master_key age_recipient)

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  echo "secrets-placeholders: $*" >&2
  exit 1
}

need_tools() {
  command -v docker >/dev/null 2>&1 || die "FAIL: \`docker\` is not on PATH"
  docker compose version >/dev/null 2>&1 || die "FAIL: the Docker Compose v2 plugin is required"
  command -v node >/dev/null 2>&1 || die "FAIL: \`node\` is not on PATH"
}

is_required() {
  local name="$1" r
  for r in "${REQUIRED[@]}"; do [ "$r" = "$name" ] && return 0; done
  return 1
}

# "name<TAB>absolute host path" for every declared file secret.
declared_secrets() {
  local dir="$1"
  docker compose --project-directory "$dir" --profile '*' config --format json 2>/dev/null |
    node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () => {
        const doc = JSON.parse(s);
        for (const [name, spec] of Object.entries(doc.secrets ?? {})) {
          if (spec && typeof spec.file === "string") process.stdout.write(`${name}\t${spec.file}\n`);
        }
      });
    '
}

run() {
  local dir="$1"
  need_tools
  [ -d "$dir" ] || die "FAIL: project directory $dir does not exist"

  local listing
  if ! listing="$(declared_secrets "$dir")"; then
    die "FAIL: \`docker compose config\` rejected the project in $dir"
  fi
  [ -n "$listing" ] || die "FAIL: the compose project in $dir declares no file secrets — refusing to guess"

  local name path missing_required=() empty_required=() optional=()
  while IFS=$'\t' read -r name path; do
    [ -n "$name" ] || continue
    if is_required "$name"; then
      if [ ! -e "$path" ] && [ ! -L "$path" ]; then
        missing_required+=("$name")
      elif [ -f "$path" ] && [ ! -s "$path" ]; then
        empty_required+=("$name")
      fi
    else
      optional+=("$name"$'\t'"$path")
    fi
  done <<<"$listing"

  # Refuse before writing anything.
  if [ "${#missing_required[@]}" -ne 0 ] || [ "${#empty_required[@]}" -ne 0 ]; then
    [ "${#missing_required[@]}" -eq 0 ] ||
      echo "secrets-placeholders: REFUSED: required secret(s) missing: ${missing_required[*]}" >&2
    [ "${#empty_required[@]}" -eq 0 ] ||
      echo "secrets-placeholders: REFUSED: required secret(s) empty: ${empty_required[*]}" >&2
    echo "  These are never invented. Create them as RUNBOOK.md \"Create secrets\" says" >&2
    echo "  (\`just gen-pg-secrets\`, \`just gen-master-key\`, the age recipient), then re-run." >&2
    echo "  Nothing was written." >&2
    exit 1
  fi

  # The directories first: 0700, enforced rather than assumed.
  local dirs=() d seen entry
  for entry in "${optional[@]}"; do
    d="$(dirname "${entry#*$'\t'}")"
    seen=0
    for x in "${dirs[@]+"${dirs[@]}"}"; do [ "$x" = "$d" ] && seen=1; done
    [ "$seen" -eq 1 ] || dirs+=("$d")
  done
  for d in "${dirs[@]+"${dirs[@]}"}"; do
    [ -d "$d" ] || die "FAIL: secrets directory $d does not exist (the required secrets live there)"
    if [ "$(stat -c %a "$d")" != "700" ]; then
      chmod 0700 "$d" 2>/dev/null || die "FAIL: $d is mode $(stat -c %a "$d") and could not be set to 0700"
      echo "secrets-placeholders: set $d to 0700"
    fi
  done

  local created=() kept=0
  for entry in "${optional[@]+"${optional[@]}"}"; do
    name="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    if [ -e "$path" ] || [ -L "$path" ]; then
      kept=$((kept + 1))
      continue
    fi
    # noclobber: even a file that appeared since the -e test is never truncated.
    (set -o noclobber; : >"$path") || die "FAIL: could not create $path"
    chmod 0444 "$path"
    created+=("$name")
  done

  if [ "${#created[@]}" -eq 0 ]; then
    echo "secrets-placeholders: nothing to create (${kept} optional secret(s) already present, ${#REQUIRED[@]} required present)"
  else
    echo "secrets-placeholders: created ${#created[@]} empty optional placeholder(s): ${created[*]} (${kept} already present, left untouched)"
  fi
}

# ---------------------------------------------------------------- self-test
self_test() {
  need_tools
  local tmp rc=0
  tmp="$(mktemp -d -t secrets-placeholders-XXXXXX)"
  trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' RETURN
  fail() { echo "secrets-placeholders: SELF-TEST FAILED: $*" >&2; rc=1; }

  cat >"$tmp/compose.yml" <<'YAML'
name: secrets-placeholders-self-test
services:
  app:
    image: alpine:3.24
    secrets: [database_url, pg_password, master_key, age_recipient, opt_present, opt_empty, opt_missing, opt_link]
  late:
    image: alpine:3.24
    profiles: ['someday']
    secrets: [opt_profiled]
secrets:
  database_url: { file: ./secrets/database_url }
  pg_password: { file: ./secrets/pg_password }
  master_key: { file: ./secrets/master_key }
  age_recipient: { file: ./secrets/age_recipient }
  opt_present: { file: ./secrets/opt_present }
  opt_empty: { file: ./secrets/opt_empty }
  opt_missing: { file: ./secrets/opt_missing }
  opt_link: { file: ./secrets/opt_link }
  opt_profiled: { file: ./secrets/opt_profiled }
YAML
  local s="$tmp/secrets"
  mkdir -p "$s" && chmod 0755 "$s"
  for r in "${REQUIRED[@]}"; do printf 'not-a-real-%s' "$r" >"$s/$r"; chmod 0444 "$s/$r"; done
  printf 'keep-me' >"$s/opt_present" && chmod 0400 "$s/opt_present"
  : >"$s/opt_empty" && chmod 0640 "$s/opt_empty"
  ln -s "$tmp/nowhere" "$s/opt_link"
  touch -d '2020-01-01 00:00:00' "$s/opt_present" "$s/opt_empty"
  local before_present before_empty
  before_present="$(stat -c '%a %s %Y' "$s/opt_present")"
  before_empty="$(stat -c '%a %s %Y' "$s/opt_empty")"

  # Case 1: creates only the missing optional ones, empty; never overwrites.
  local out
  out="$(bash "$SCRIPT_PATH" --project-dir "$tmp" 2>&1)" || fail "case 1 exited non-zero: $out"
  for n in opt_missing opt_profiled; do
    [ -f "$s/$n" ] || fail "case 1: $n was not created"
    [ -f "$s/$n" ] && [ ! -s "$s/$n" ] || fail "case 1: $n is not empty"
    [ "$(stat -c %a "$s/$n" 2>/dev/null)" = "444" ] || fail "case 1: $n is not 0444"
  done
  [ "$(cat "$s/opt_present")" = "keep-me" ] || fail "case 1: opt_present's content changed"
  [ "$(stat -c '%a %s %Y' "$s/opt_present")" = "$before_present" ] || fail "case 1: opt_present was touched"
  [ "$(stat -c '%a %s %Y' "$s/opt_empty")" = "$before_empty" ] || fail "case 1: opt_empty was touched"
  [ -L "$s/opt_link" ] && [ ! -e "$s/opt_link" ] || fail "case 1: the dangling symlink was replaced"
  for r in "${REQUIRED[@]}"; do
    [ "$(cat "$s/$r")" = "not-a-real-$r" ] || fail "case 1: required $r changed"
  done
  [ "$(stat -c %a "$s")" = "700" ] || fail "case 1: the directory is $(stat -c %a "$s"), not 0700"
  grep -q 'created 2 empty optional placeholder(s): opt_missing opt_profiled' <<<"$out" ||
    fail "case 1: unexpected report: $out"

  # Case 2: idempotent.
  out="$(bash "$SCRIPT_PATH" --project-dir "$tmp" 2>&1)" || fail "case 2 exited non-zero: $out"
  grep -q '^secrets-placeholders: nothing to create' <<<"$out" || fail "case 2: not idempotent: $out"

  # Case 3: a missing required secret is refused by name, and nothing is written.
  rm -f "$s/master_key" "$s/opt_missing"
  if out="$(bash "$SCRIPT_PATH" --project-dir "$tmp" 2>&1)"; then
    fail "case 3: a missing required secret was not refused"
  fi
  grep -q 'REFUSED: required secret(s) missing: master_key' <<<"$out" || fail "case 3: refusal does not name master_key: $out"
  [ ! -e "$s/master_key" ] || fail "case 3: master_key was invented"
  [ ! -e "$s/opt_missing" ] || fail "case 3: an optional placeholder was written despite the refusal"

  # Case 4: an empty required secret is refused too (it would boot as absent).
  : >"$s/master_key"
  if out="$(bash "$SCRIPT_PATH" --project-dir "$tmp" 2>&1)"; then
    fail "case 4: an empty required secret was not refused"
  fi
  grep -q 'REFUSED: required secret(s) empty: master_key' <<<"$out" || fail "case 4: refusal does not name master_key: $out"

  if [ "$rc" -eq 0 ]; then
    echo "secrets-placeholders: SELF-TEST PASS (creates only missing optional secrets, empty; never overwrites; refuses a missing or empty required one; keeps the directory 0700)"
  fi
  return "$rc"
}

MODE="run"
PROJECT_DIR="$REPO_ROOT"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test) MODE="self-test" ;;
    --project-dir)
      shift
      [ "$#" -gt 0 ] || die "--project-dir needs a directory"
      PROJECT_DIR="$1"
      ;;
    -h | --help)
      sed -n '2,45p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi
run "$(cd "$PROJECT_DIR" && pwd)"
