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
#     *plaintext* dump proven restorable with `pg_restore --list` and a
#     minimum size BEFORE it is encrypted, and the retention prune reached
#     only after all of that succeeded. Nothing old is deleted unless
#     something new is verified.
#   * The status file this writes is what the container healthcheck reads, so
#     a failed or stale backup shows as `unhealthy` instead of "the loop
#     process is still running" (see backup-loop.sh).
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AGE_RECIPIENTS_FILE:?AGE_RECIPIENTS_FILE is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STATUS_FILE="${BACKUP_STATUS_FILE:-/tmp/backup-status}"
# A pg_dump of an empty-but-migrated database is a few KB; a dump of a *failed*
# dump is 0-few hundred bytes. 1024 is comfortably between the two and is only
# the floor — `pg_restore --list` below is the real check.
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-1024}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/personalfi-${TIMESTAMP}.dump.age"
TMP_OUT="${OUT}.partial"
WORK_DIR="$(mktemp -d)"
PLAIN="${WORK_DIR}/personalfi-${TIMESTAMP}.dump"

# `status <state> <message>`: the single place that writes the file the
# healthcheck reads. Written on every exit path, including the failure ones.
status() {
  printf '%s %s %s\n' "$1" "$(date -u +%s)" "$2" >"${STATUS_FILE}"
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
if [ "${DUMP_BYTES}" -lt "${MIN_DUMP_BYTES}" ]; then
  echo "backup: dump is ${DUMP_BYTES} bytes, below the ${MIN_DUMP_BYTES}-byte floor — refusing to promote it" >&2
  exit 1
fi

# The structural check: `pg_restore --list` parses the custom-format archive's
# table of contents. It fails on a truncated or non-archive file, and an
# archive with zero entries is not a backup of a migrated database.
if ! TOC="$(pg_restore --list "${PLAIN}" 2>&1)"; then
  echo "backup: pg_restore --list rejected the dump — refusing to promote it:" >&2
  echo "${TOC}" | sed 's/^/    /' >&2
  exit 1
fi
TOC_ENTRIES="$(printf '%s\n' "${TOC}" | grep -cv '^;' || true)"
if [ "${TOC_ENTRIES}" -lt 1 ]; then
  echo "backup: dump verified as a valid archive but contains no restorable objects — refusing to promote it" >&2
  exit 1
fi
echo "backup: verified ${DUMP_BYTES} bytes, ${TOC_ENTRIES} restorable object(s)"

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
