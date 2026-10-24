#!/bin/sh
set -e

# Write Google credentials to a temp file for the gdrive proxy.
if [ -n "$GOOGLE_CREDENTIALS" ]; then
  export SERVICE_ACCOUNT_PATH="/tmp/sa-credentials.json"
  printf '%s' "$GOOGLE_CREDENTIALS" > "$SERVICE_ACCOUNT_PATH"
  chmod 600 "$SERVICE_ACCOUNT_PATH"
fi

# Start the gdrive MCP proxy if credentials are present.
if [ -n "$SERVICE_ACCOUNT_PATH" ]; then
  PROXY_PORT="${GDRIVE_MCP_PORT:-8123}"
  export GDRIVE_MCP_PROXY_URL="http://127.0.0.1:${PROXY_PORT}/mcp"

  echo "[entrypoint] Starting gdrive MCP proxy on port ${PROXY_PORT} (restarted if it exits)..."
  (
    set +e  # a crashed proxy must not end the restart loop
    delay=5
    while true; do
      started=$(date +%s)
      node /app/packages/agent/dist/gdrive-mcp-proxy.js
      code=$?
      # Back off 5s doubling to 60s; a proxy that ran a while resets the backoff.
      if [ $(( $(date +%s) - started )) -ge 300 ]; then delay=5; fi
      echo "[entrypoint] gdrive proxy exited ($code); restarting in ${delay}s"
      sleep "$delay"
      delay=$(( delay * 2 > 60 ? 60 : delay * 2 ))
    done
  ) &

  # Wait up to 30s for the proxy to become healthy, but start the agent either way:
  # the agent checks /health per message and tells users when Drive is unavailable.
  i=0
  until wget -qO- "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "[entrypoint] WARNING: gdrive proxy not healthy after 30s; starting agent without Drive for now"
      break
    fi
    sleep 1
  done
  if [ "$i" -lt 30 ]; then
    echo "[entrypoint] Proxy ready after ${i}s"
  fi
else
  echo "[entrypoint] GOOGLE_CREDENTIALS not set — gdrive MCP proxy not started"
fi

exec node /app/packages/agent/dist/index.js
