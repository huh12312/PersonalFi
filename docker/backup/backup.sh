#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Nightly encrypted backup (D24, 06 §4.1). One `pg_dump -Fc`, verified, then
# encrypted with `age` before it ever touches a non-local disk, written to the
# `backups` volume, and optionally pushed to a remote with `rclone`.
#
# The container only ever holds the age *recipient* (public key): encrypting
# is the only thing it can do. The matching identity (private key) lives in
# Chris's password manager and an offline copy — a backup container that
# cannot decrypt its own backups is a meaningful ransomware mitigation
# (06 §4.1). Decryption only ever happens in restore.sh / the restore drill,
# invoked with a private key supplied from outside the compose project.
#
# WHAT THE PHASE 0 GATE FOUND (H-2), and what each line below now does about it:
#
#   * `set -eu` without `pipefail` meant `pg_dump | age` reported *age's* exit
#     status. A pg_dump that failed — say the password rotated without a
#     `backup` container restart — produced a perfectly valid age file
#     containing nothing, the script exited 0, and the retention prune then
#     deleted real backups on schedule. Thirty nights of 215-byte
#     "successful" backups, a green healthcheck throughout, and the last real
#     copy gone on night 31.
#   * So: `pipefail`, the dump's exit status captured explicitly, the
#     *plaintext* dump proven restorable with `pg_restore --list` BEFORE it is
#     encrypted, and the retention prune reached only after all of that
#     succeeded. Nothing old is deleted unless something new is verified.
#   * The status file this writes is what the container healthcheck reads, so
#     a failed or stale backup shows as `unhealthy` instead of "the loop
#     process is still running" (see backup-loop.sh).
#
# WHAT THE PHASE 0 RE-GATE FOUND (finding 9), and what changed:
#
#   * The original verification led with a raw byte floor (`MIN_DUMP_BYTES`,
#     1024) before ever looking at the archive's contents. On a fresh install
#     — migrations applied, one user, no other data yet — a real `pg_dump -Fc`
#     of that database landed under the floor, so the very first night's
#     backup was rejected and the container went `unhealthy` for a database
#     that was in fact perfectly backed up. Dump size tracks how much *data*
#     exists; it says nothing about whether the archive is valid, so it was
#     the wrong thing to gate on.
#   * The gate now leads with the structural check that was already here:
#     `pg_restore --list` must parse the archive, it must enumerate the
#     `schema_migrations` table specifically (proof this is a dump of *our*
#     schema, not an empty or unrelated database), and it must list at least
#     `MIN_TOC_ENTRIES` objects (proof it isn't a near-empty stub — the real
#     schema plus its indexes, constraints and triggers is well over a
#     hundred). Byte count is still logged for operators but no longer gates
#     promotion.
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AGE_RECIPIENTS_FILE:?AGE_RECIPIENTS_FILE is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STATUS_FILE="${BACKUP_STATUS_FILE:-/tmp/backup-status}"
# The structural check below (`pg_restore --list`) is the real gate. This is
# only a sanity floor on the *number of restorable objects*, not raw bytes —
# see the header note on finding 9. Our schema has ~150 TOC entries once every
# migration is applied; 10 is comfortably below that and comfortably above
# "the archive is nearly empty", regardless of how much row data exists yet.
MIN_TOC_ENTRIES="${MIN_TOC_ENTRIES:-10}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/personalfi-${TIMESTAMP}.dump.age"
TMP_OUT="${OUT}.partial"
WORK_DIR="$(mktemp -d)"
PLAIN="${WORK_DIR}/personalfi-${TIMESTAMP}.dump"

# `status <state> <message>`: the single place that writes the file the
# healthcheck reads. Written on every exit path, including the failure ones.
status() {
  printf '%s %s %s\n' "$1" "$(date -u +%s)" "$2" >"${STATUS_FILE}"
  record_backup_run "$1" "$2"
}

# WP 9.1 (CF-17, D24, migration 0036_ops_status.sql): one row per attempt in
# `ops_backup_runs`, so `GET /ops/backup-status` can answer "when did the
# last successful backup finish?" without shelling into this container. This
# insert is **best-effort**, deliberately not gated behind `set -e`/`-o
# pipefail`'s usual "fail loudly" posture, for a written reason: WP 9.4's
# `pre-migrate-backup` one-shot runs this same script *before* the migrator
# has applied anything on a fresh or older install, so `ops_backup_runs` may
# simply not exist yet, and an older backup image can likewise run against a
# schema newer migrations have since moved past. A verified, promoted backup
# must never be reported as a failure just because this status table isn't
# there (or isn't shaped the way this script expects) -- the dump itself, and
# the STATUS_FILE the healthcheck reads, are unaffected either way.
#
# `gen_random_uuid()` rather than an app-side uuidv7 (`newId()`,
# docs/CONVENTIONS.md's usual rule): this is a shell script with no uuidv7
# generator to hand, and nothing orders `ops_backup_runs` by its own `id` --
# every read goes through `finished_at`/`created_at` instead (`@core/platform`'s
# `backupStatus`), so the ordering property uuidv7 exists for is not needed here.
record_backup_run() {
  run_status="$1"
  run_reason="$2"
  run_bytes_sql="NULL"
  if [ -n "${DUMP_BYTES:-}" ]; then run_bytes_sql="${DUMP_BYTES}"; fi
  run_toc_sql="NULL"
  if [ -n "${TOC_ENTRIES:-}" ]; then run_toc_sql="${TOC_ENTRIES}"; fi
  if ! run_insert_error="$(
    psql -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -q -tAc \
      "INSERT INTO ops_backup_runs (id, status, finished_at, plaintext_bytes, toc_entries, reason)
       VALUES (gen_random_uuid(), '${run_status}', now(), ${run_bytes_sql}, ${run_toc_sql},
               \$backup_reason\$${run_reason}\$backup_reason\$)" 2>&1
  )"; then
    echo "backup: ops_backup_runs insert skipped (best-effort; see docker/backup/backup.sh): ${run_insert_error}" >&2
  fi
}

cleanup() {
  rc=$?
  rm -rf "${WORK_DIR}"
  rm -f "${TMP_OUT}"
  if [ "$rc" -ne 0 ]; then
    status fail "backup.sh exited ${rc} (see container logs)"
    echo "backup: FAILED (exit ${rc}); status file: $(cat "${STATUS_FILE}" 2>/dev/null || echo unwritable)" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

export PGPASSWORD
PGPASSWORD="$(cat "${PGPASSWORD_FILE}")"

echo "backup: dumping ${PGDATABASE}@${PGHOST} ..."
# Not piped into age: the artifact has to exist as plaintext long enough to be
# verified, and a pipeline hides which end of it failed. /tmp is a 256M tmpfs
# (compose.yml) so the plaintext never touches a disk.
if ! pg_dump -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -Fc --file="${PLAIN}"; then
  echo "backup: pg_dump failed; nothing written, nothing pruned" >&2
  exit 1
fi

DUMP_BYTES="$(wc -c <"${PLAIN}")"

# The structural check: `pg_restore --list` parses the custom-format archive's
# table of contents. It fails outright on a truncated or non-archive file.
if ! TOC="$(pg_restore --list "${PLAIN}" 2>&1)"; then
  echo "backup: pg_restore --list rejected the dump — refusing to promote it:" >&2
  echo "${TOC}" | sed 's/^/    /' >&2
  exit 1
fi
TOC_ENTRIES="$(printf '%s\n' "${TOC}" | grep -cv '^;' || true)"
if [ "${TOC_ENTRIES}" -lt "${MIN_TOC_ENTRIES}" ]; then
  echo "backup: dump verified as a valid archive but only has ${TOC_ENTRIES} object(s) (need >= ${MIN_TOC_ENTRIES}) — refusing to promote it" >&2
  exit 1
fi
# Proof this is a dump of *our* schema and not, say, an empty database someone
# pointed PGDATABASE at by mistake: schema_migrations is created by the very
# first migration and every subsequent one records itself there.
if ! printf '%s\n' "${TOC}" | grep -qE 'TABLE[[:space:]]+public[[:space:]]+schema_migrations([[:space:]]|$)'; then
  echo "backup: pg_restore --list did not find the schema_migrations table — refusing to promote it:" >&2
  echo "${TOC}" | sed 's/^/    /' >&2
  exit 1
fi
echo "backup: verified ${DUMP_BYTES} bytes, ${TOC_ENTRIES} restorable object(s), schema_migrations present"

age --encrypt --recipients-file "${AGE_RECIPIENTS_FILE}" --output "${TMP_OUT}" "${PLAIN}"
# `mv` within the same filesystem is atomic, so a reader (the restore drill)
# never sees a half-written `.dump.age`; the `.partial` suffix is what keeps a
# crashed run from being picked up as "the newest backup".
mv "${TMP_OUT}" "${OUT}"
rm -f "${PLAIN}"
echo "backup: wrote ${OUT} ($(wc -c <"${OUT}") bytes)"

# Only now, with a verified artifact on the volume, is anything deleted.
echo "backup: pruning entries older than ${RETENTION_DAYS} day(s) locally"
find "${BACKUP_DIR}" -maxdepth 1 -name 'personalfi-*.dump.age' -mtime "+${RETENTION_DAYS}" -print -delete
# Leftovers from a crashed earlier run; never counted as a backup, never kept.
find "${BACKUP_DIR}" -maxdepth 1 -name 'personalfi-*.dump.age.partial' -mmin +60 -print -delete

if [ -n "${RCLONE_REMOTE:-}" ]; then
  # rclone reads backend config from RCLONE_CONFIG_<REMOTE>_<OPTION> env vars,
  # so a B2 push needs no config *file* at all — one less secret-as-a-file to
  # manage. RCLONE_REMOTE is a non-secret name/path, e.g. "b2:personalfi-backups".
  if [ -z "${B2_KEY_ID_FILE:-}" ] || [ -z "${B2_APPLICATION_KEY_FILE:-}" ]; then
    echo "backup: RCLONE_REMOTE is set but B2_KEY_ID_FILE/B2_APPLICATION_KEY_FILE are not; cannot push" >&2
    exit 1
  fi
  export RCLONE_CONFIG_B2_TYPE=b2
  export RCLONE_CONFIG_B2_ACCOUNT
  export RCLONE_CONFIG_B2_KEY
  RCLONE_CONFIG_B2_ACCOUNT="$(cat "${B2_KEY_ID_FILE}")"
  RCLONE_CONFIG_B2_KEY="$(cat "${B2_APPLICATION_KEY_FILE}")"
  echo "backup: pushing to ${RCLONE_REMOTE}"
  rclone copy "${OUT}" "${RCLONE_REMOTE}" --checksum
else
  echo "backup: RCLONE_REMOTE not set; local-only backup (see RUNBOOK.md to enable B2)"
fi

status ok "${OUT} (${DUMP_BYTES} plaintext bytes, ${TOC_ENTRIES} objects)"
echo "backup: complete"
