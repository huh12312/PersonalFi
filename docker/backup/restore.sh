#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Decrypt and restore one backup produced by backup.sh. Requires the age
# *identity* (private key) — deliberately never present in the running compose
# project (see backup.sh). Used directly for a real disaster recovery, and
# indirectly by scripts/restore-drill.sh, which supplies a scratch database
# instead of the production one.
#
# Usage: restore.sh <path-to-backup.dump.age>
set -eu

FILE="${1:?usage: restore.sh <path-to-backup.dump.age>}"

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required (the private key; never in the compose project)}"

if [ ! -r "${FILE}" ]; then
  echo "restore: cannot read ${FILE}" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
DECRYPTED="${TMP_DIR}/restore.dump"

echo "restore: decrypting ${FILE}"
age --decrypt --identity "${AGE_IDENTITY_FILE}" --output "${DECRYPTED}" "${FILE}"

export PGPASSWORD
PGPASSWORD="$(cat "${PGPASSWORD_FILE}")"

echo "restore: restoring into ${PGDATABASE}@${PGHOST} (--clean --if-exists --no-owner)"
pg_restore -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" \
  --clean --if-exists --no-owner --no-privileges \
  "${DECRYPTED}"

echo "restore: complete"
