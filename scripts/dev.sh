#!/usr/bin/env bash
# Start the local database (if needed) and the dev server on localhost only.
set -euo pipefail
cd "$(dirname "$0")/.."
docker start replit-clone-pg >/dev/null 2>&1 || true
npx prisma migrate deploy
exec npx next dev -H 127.0.0.1 -p "${PORT:-3000}"
