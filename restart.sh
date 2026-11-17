#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

mode="helper"
for arg in "$@"; do
  case "$arg" in
    pay|--pay|-p)
      mode="pay"
      ;;
    helper|--helper|-h|"")
      ;;
    --help)
      cat <<'USAGE'
Usage: ./restart.sh [helper|pay]

  helper  (default)  Local BYOK Helper — same as npm run helper
  pay                Local pay-mode Helper for hosted-scoring dry runs
                     (PAY_MODE=1, mail stub, APP_PUBLIC_URL on loopback)

Examples:
  ./restart.sh
  ./restart.sh pay

After pay Helper is up, build the extension against it:
  npm run build:pay:local
  # then reload dist/ in the browser
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try ./restart.sh --help)" >&2
      exit 1
      ;;
  esac
done

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

if [[ "$mode" == "pay" ]]; then
  export PAY_MODE=1
  export PAY_MAIL_STUB="${PAY_MAIL_STUB:-1}"
  export JSEEKER_HOST="${JSEEKER_HOST:-127.0.0.1}"
  export APP_PUBLIC_URL="${APP_PUBLIC_URL:-http://127.0.0.1:${port}}"
  export PAY_DB_PATH="${PAY_DB_PATH:-./data/pay-store.json}"
  export ADMIN_PASSWORD="${ADMIN_PASSWORD:-local-admin}"
  echo "Starting PAY Helper on ${JSEEKER_HOST}:${port}"
  echo "  APP_PUBLIC_URL=${APP_PUBLIC_URL}"
  echo "  PAY_MAIL_STUB=${PAY_MAIL_STUB}  (login_url returned in API response; check terminal log)"
  echo "  ADMIN_PASSWORD=${ADMIN_PASSWORD}"
  echo "  Admin UI: ${APP_PUBLIC_URL}/admin"
  echo "  Next: npm run build:pay:local && reload dist/ in the browser"
  echo "Ctrl+C to stop."
  exec npm run helper:pay
fi

echo "Starting Helper on port $port (Ctrl+C to stop)."
exec npm run helper
