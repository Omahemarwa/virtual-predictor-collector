#!/bin/sh
set -e
mkdir -p /app/data
if [ -d /app/data-backup ] && [ "$(ls -A /app/data-backup 2>/dev/null)" ]; then
  echo "Seeding /app/data from /app/data-backup..."
  cp -rn /app/data-backup/* /app/data/ 2>/dev/null || true
fi
exec "$@"
