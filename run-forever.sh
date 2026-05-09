#!/usr/bin/env bash
set -u

cd "$(dirname "$0")"

prompt_default() {
  local label="$1"
  local default_value="$2"
  local answer
  read -r -p "$label [$default_value]: " answer
  echo "${answer:-$default_value}"
}

prompt_yes_no() {
  local label="$1"
  local default_value="$2"
  local hint="y/N"
  local answer
  if [ "$default_value" = "1" ]; then
    hint="Y/n"
  fi
  read -r -p "$label [$hint]: " answer
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$answer" ]; then
    echo "$default_value"
  elif [ "$answer" = "y" ] || [ "$answer" = "yes" ]; then
    echo "1"
  else
    echo "0"
  fi
}

auto_workers() {
  local cpu_count
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 2)"
  if [ "$cpu_count" -le 2 ]; then
    echo 1
  elif [ "$cpu_count" -gt 9 ]; then
    echo 8
  else
    echo $((cpu_count - 1))
  fi
}

max_workers() {
  getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1
}

COUNT="${COUNT:-0}"
ENGINE="${ENGINE:-native}"
RESTART_DELAY="${RESTART_DELAY:-10}"
LOG_EVERY_MS="${LOG_EVERY_MS:-1000}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
DASHBOARD="${DASHBOARD:-0}"
TIMEOUT="${TIMEOUT:-60000}"
RETRIES="${RETRIES:-10}"
STOP_ON_LOGIN_REQUIRED="${STOP_ON_LOGIN_REQUIRED:-1}"

if [ -z "${WORKERS:-}" ]; then
  WORKERS="$(auto_workers)"
fi

if [ -t 0 ] && [ "${ASSUME_DEFAULTS:-0}" != "1" ]; then
  echo "RPoW CLI forever setup"
  echo
  DASHBOARD="$(prompt_yes_no "Show live dashboard" "$DASHBOARD")"
  ENGINE="$(prompt_default "Engine" "$ENGINE")"
  WORKERS="$(prompt_default "Workers (max $(max_workers) auto-detected)" "$WORKERS")"
  COUNT="$(prompt_default "How many tokens to mint (0 = until stopped)" "$COUNT")"
  TIMEOUT="$(prompt_default "HTTP timeout ms" "$TIMEOUT")"
  RETRIES="$(prompt_default "HTTP retries" "$RETRIES")"
  RESTART_DELAY="$(prompt_default "Restart delay seconds" "$RESTART_DELAY")"
  LOG_EVERY_MS="$(prompt_default "Mining log interval ms" "$LOG_EVERY_MS")"
  echo
fi

stop_requested=0

on_stop() {
  stop_requested=1
  echo
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) STOP requested, shutting down after current miner exits..."
}

trap on_stop INT TERM

echo "RPoW CLI auto-restart runner"
echo "COUNT=$COUNT ENGINE=$ENGINE WORKERS=$WORKERS TIMEOUT=$TIMEOUT RETRIES=$RETRIES RESTART_DELAY=${RESTART_DELAY}s DASHBOARD=$DASHBOARD"
echo "Press Ctrl+C to stop."
echo

while [ "$stop_requested" -eq 0 ]; do
  if [ "$STOP_ON_LOGIN_REQUIRED" = "1" ]; then
    auth_check="$(node rpow-cli.js me --timeout "$TIMEOUT" --retries 1 2>&1)"
    auth_code=$?
    if [ "$auth_code" -ne 0 ]; then
      echo "$auth_check"
    fi
    if printf '%s\n' "$auth_check" | grep -Eqi 'login required|UNAUTHORIZED|session invalid'; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) STOP login/session required; not restarting until you login again."
      echo "Run:"
      echo "  node rpow-cli.js login --email YOUR_EMAIL"
      echo "  node rpow-cli.js complete-login --link \"MAGIC_LINK\""
      echo "  ./run-forever.sh"
      break
    fi
  fi

  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$started_at START node rpow-cli.js mine --count $COUNT --workers $WORKERS --engine $ENGINE"
  last_log="$(mktemp "${TMPDIR:-/tmp}/rpow-run.XXXXXX")"

  dashboard_args=()
  if [ "$DASHBOARD" != "1" ]; then
    dashboard_args+=(--no-dashboard)
  fi

  if [ "$DASHBOARD" = "1" ]; then
    node rpow-cli.js mine \
      --count "$COUNT" \
      --workers "$WORKERS" \
      --engine "$ENGINE" \
      --log-every-ms "$LOG_EVERY_MS" \
      --timeout "$TIMEOUT" \
      --retries "$RETRIES" \
      "${dashboard_args[@]}" \
      $EXTRA_ARGS
    code=$?
  else
    node rpow-cli.js mine \
      --count "$COUNT" \
      --workers "$WORKERS" \
      --engine "$ENGINE" \
      --log-every-ms "$LOG_EVERY_MS" \
      --timeout "$TIMEOUT" \
      --retries "$RETRIES" \
      "${dashboard_args[@]}" \
      $EXTRA_ARGS 2>&1 | tee "$last_log"
    code=${PIPESTATUS[0]}
  fi

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "$stop_requested" -ne 0 ] || [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    echo "$finished_at STOP miner exited with code $code"
    rm -f "$last_log"
    break
  fi

  if [ "$STOP_ON_LOGIN_REQUIRED" = "1" ] && grep -Eqi 'login required|UNAUTHORIZED|session invalid' "$last_log"; then
    echo "$finished_at STOP login/session required; not restarting until you login again."
    echo "Run:"
    echo "  node rpow-cli.js login --email YOUR_EMAIL"
    echo "  node rpow-cli.js complete-login --link \"MAGIC_LINK\""
    echo "  ./run-forever.sh"
    rm -f "$last_log"
    break
  fi

  rm -f "$last_log"

  echo "$finished_at WARN miner exited with code $code; restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY" &
  wait $!
done

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DONE auto-restart runner stopped"
