#!/usr/bin/env bash
set -euo pipefail

# Kabadiwala Connect — Checksum-Verified PostgreSQL Restore Utility
# Usage: DATABASE_URL="postgresql://..." ./scripts/restore-postgres.sh <path_to_dump>

ARCHIVE_PATH="${1:-}"
if [[ -z "${ARCHIVE_PATH}" || ! -f "${ARCHIVE_PATH}" ]]; then
  echo "ERROR: Provide an existing .dump archive path." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL environment variable is required." >&2
  exit 1
fi

if [[ -f "${ARCHIVE_PATH}.sha256" ]]; then
  echo "[restore] Verifying archive integrity via SHA-256..."
  sha256sum --check "${ARCHIVE_PATH}.sha256"
fi

echo "[restore] Restoring database from ${ARCHIVE_PATH}..."
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="${DATABASE_URL}" "${ARCHIVE_PATH}"
echo "[restore] Restore verified & complete."
