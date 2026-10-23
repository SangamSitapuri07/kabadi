#!/usr/bin/env bash
set -euo pipefail

# Kabadiwala Connect — Checksummed PostgreSQL 16 Backup Utility
# Usage: DATABASE_URL="postgresql://..." ./scripts/backup-postgres.sh [output_dir] [retention_days]

BACKUP_DIR="${1:-./backups/postgres}"
RETENTION_DAYS="${2:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_PATH="${BACKUP_DIR}/kabadiwala_${TIMESTAMP}.dump"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL environment variable is required." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
umask 077

echo "[backup] Writing custom-format compressed dump to ${ARCHIVE_PATH}..."
pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="${DATABASE_URL}" --file="${ARCHIVE_PATH}"

sha256sum "${ARCHIVE_PATH}" > "${CHECKSUM_PATH}"
echo "[backup] SHA-256 checksum recorded at ${CHECKSUM_PATH}"

# Prune backups older than retention window
find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name "kabadiwala_*.dump" -o -name "kabadiwala_*.dump.sha256" \) -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] Completed cleanly (retention: ${RETENTION_DAYS} days)."
