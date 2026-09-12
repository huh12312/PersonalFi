#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Nightly encrypted backup (D24, 06 §4.1). One `pg_dump -Fc`, encrypted with
# `age` before it ever touches a non-local disk, written to the `backups`
# volume, and optionally pushed to a remote with `rclone`.
#
# The container only ever holds the age *recipient* (public key): encrypting
# is the only thing it can do. The matching identity (private key) lives in
# Chris's password manager and an offline copy — a backup container that
# cannot decrypt its own backups is a meaningful ransomware mitigation
# (06 §4.1). Decryption only ever happens in restore.sh / restore-drill.sh,
# invoked with a private key supplied from outside the compose project.
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AGE_RECIPIENTS_FILE:?AGE_RECIPIENTS_FILE is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/personalfi-${TIMESTAMP}.dump.age"
TMP_OUT="${OUT}.partial"

export PGPASSWORD
PGPASSWORD="$(cat "${PGPASSWORD_FILE}")"

echo "backup: dumping ${PGDATABASE}@${PGHOST} ..."
pg_dump -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -Fc \
  | age --encrypt --recipients-file "${AGE_RECIPIENTS_FILE}" --output "${TMP_OUT}"
mv "${TMP_OUT}" "${OUT}"
echo "backup: wrote ${OUT} ($(wc -c < "${OUT}") bytes)"

echo "backup: pruning entries older than ${RETENTION_DAYS} day(s) locally"
find "${BACKUP_DIR}" -maxdepth 1 -name 'personalfi-*.dump.age' -mtime "+${RETENTION_DAYS}" -print -delete

if [ -n "${RCLONE_REMOTE:-}" ]; then
  # rclone reads backend config from RCLONE_CONFIG_<REMOTE>_<OPTION> env vars,
  # so a B2 push needs no config *file* at all — one less secret-as-a-file to
  # manage. RCLONE_REMOTE is a non-secret name/path, e.g. "b2:personalfi-backups".
  if [ -z "${B2_KEY_ID_FILE:-}" ] || [ -z "${B2_APPLICATION_KEY_FILE:-}" ]; then
    echo "backup: RCLONE_REMOTE is set but B2_KEY_ID_FILE/B2_APPLICATION_KEY_FILE are not; skipping remote push" >&2
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

echo "backup: complete"
