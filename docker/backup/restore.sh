#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Decrypt and restore one backup produced by backup.sh. Requires the age
# *identity* (private key) — deliberately never present in the running compose
# project (see backup.sh). Used directly for a real disaster recovery, and
# indirectly by `just restore-drill`, which supplies a scratch database
# instead of the production one.
#
# Usage: restore.sh <path-to-backup.dump.age>
#
# `pg_restore --clean --if-exists` DROPs every object it is about to recreate.
# Run against the production database by accident — one stale `PGDATABASE` in
# a shell, one copy-pasted command from the runbook — and it destroys the
# ledger before it restores anything, with no confirmation and no second
# chance. So: a restore into the production database name requires
# FORCE_RESTORE=1, and every run prints what it is about to drop first.
set -eu

FILE="${1:?usage: restore.sh <path-to-backup.dump.age>}"

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required (the private key; never in the compose project)}"

# The name compose.yml gives the live database. Overridable only so a
# differently-named deployment can still be protected, never to disable the
# check (an empty value would do that, so an empty value is rejected).
PRODUCTION_DATABASE="${PRODUCTION_DATABASE:-personalfi}"
: "${PRODUCTION_DATABASE:?PRODUCTION_DATABASE must not be empty}"

if [ ! -r "${FILE}" ]; then
  echo "restore: cannot read ${FILE}" >&2
  exit 1
fi

if [ "${PGDATABASE}" = "${PRODUCTION_DATABASE}" ] && [ "${FORCE_RESTORE:-}" != "1" ]; then
  cat >&2 <<EOF
restore: REFUSING to restore into the production database.

  target   : ${PGDATABASE}@${PGHOST}   (matches PRODUCTION_DATABASE=${PRODUCTION_DATABASE})
  archive  : ${FILE}

  pg_restore --clean --if-exists DROPs every object in that database before it
  recreates it. If this is a real disaster recovery and you have already
  stopped api/worker (\`docker compose stop api worker\`), re-run with:

      FORCE_RESTORE=1 ... /usr/local/bin/restore.sh ${FILE}

  If you meant to test a backup, use \`just restore-drill\` — it restores into
  a throwaway database and never touches this one.
EOF
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
DECRYPTED="${TMP_DIR}/restore.dump"

echo "restore: decrypting ${FILE}"
age --decrypt --identity "${AGE_IDENTITY_FILE}" --output "${DECRYPTED}" "${FILE}"

# Verify before destroying: the same check backup.sh runs before promoting an
# artifact, re-run here because the file may have travelled via B2, a USB
# stick, or five years of bit-rot since then.
if ! TOC="$(pg_restore --list "${DECRYPTED}" 2>&1)"; then
  echo "restore: the decrypted archive is not a readable pg_dump archive — nothing was dropped:" >&2
  echo "${TOC}" | sed 's/^/    /' >&2
  exit 1
fi

export PGPASSWORD
PGPASSWORD="$(cat "${PGPASSWORD_FILE}")"

# What is about to be dropped, from the *target* database, before touching it.
echo "restore: target ${PGDATABASE}@${PGHOST}; --clean --if-exists will DROP and recreate these:"
psql -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc \
  "select table_type || '  ' || table_schema || '.' || table_name
     from information_schema.tables
    where table_schema not in ('pg_catalog','information_schema')
    order by 1" 2>/dev/null | sed 's/^/    /' || echo "    (could not enumerate — database may be empty or unreachable)"
echo "restore: archive contains $(printf '%s\n' "${TOC}" | grep -cv '^;' || true) restorable object(s)"

if [ "${PGDATABASE}" = "${PRODUCTION_DATABASE}" ]; then
  echo "restore: FORCE_RESTORE=1 given; proceeding against the production database in 5s (Ctrl-C to abort)" >&2
  sleep 5
fi

echo "restore: restoring into ${PGDATABASE}@${PGHOST} (--clean --if-exists --no-owner)"
pg_restore -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" \
  --clean --if-exists --no-owner --no-privileges \
  "${DECRYPTED}"

echo "restore: complete"
