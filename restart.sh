#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Resolve the port with the same .env precedence as npm run helper.
port=$(node --input-type=module <<'JS'
import { loadLocalEnv } from './helper/local-env.mjs';
loadLocalEnv('.env', { preferFile: true });
const port = Number(process.env.JSEEKER_PORT || 17373);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('JSEEKER_PORT must be an integer between 1 and 65535');
  process.exit(1);
}
console.log(port);
JS
)

pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN || true)
if [[ -n "$pids" ]]; then
  echo "Stopping processes listening on port $port: $pids"
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for ((attempt = 0; attempt < 30; attempt++)); do
    if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null; then
      break
    fi
    sleep 0.1
  done
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

if lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null; then
  echo "Port $port is still occupied; cannot start Helper." >&2
  exit 1
fi

echo "Starting Helper on port $port (Ctrl+C to stop)."
exec npm run helper
