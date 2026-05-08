#!/usr/bin/env bash
set -u

cd "$(dirname "$0")"

COUNT="${COUNT:-0}"
ENGINE="${ENGINE:-native}"
RESTART_DELAY="${RESTART_DELAY:-10}"
LOG_EVERY_MS="${LOG_EVERY_MS:-1000}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
DASHBOARD="${DASHBOARD:-0}"

if [ -z "${WORKERS:-}" ]; then
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 2)"
  if [ "$cpu_count" -le 2 ]; then
    WORKERS=1
  else
    WORKERS=$((cpu_count - 1))
  fi
  if [ "$WORKERS" -gt 8 ]; then
    WORKERS=8
  fi
fi

stop_requested=0

on_stop() {
  stop_requested=1
  echo
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) STOP requested, shutting down after current miner exits..."
}

trap on_stop INT TERM

echo "RPoW CLI auto-restart runner"
echo "COUNT=$COUNT ENGINE=$ENGINE WORKERS=$WORKERS RESTART_DELAY=${RESTART_DELAY}s DASHBOARD=$DASHBOARD"
echo "Press Ctrl+C to stop."
echo

while [ "$stop_requested" -eq 0 ]; do
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$started_at START node rpow-cli.js mine --count $COUNT --workers $WORKERS --engine $ENGINE"

  dashboard_args=()
  if [ "$DASHBOARD" != "1" ]; then
    dashboard_args+=(--no-dashboard)
  fi

  node rpow-cli.js mine \
    --count "$COUNT" \
    --workers "$WORKERS" \
    --engine "$ENGINE" \
    --log-every-ms "$LOG_EVERY_MS" \
    "${dashboard_args[@]}" \
    $EXTRA_ARGS

  code=$?
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "$stop_requested" -ne 0 ] || [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    echo "$finished_at STOP miner exited with code $code"
    break
  fi

  echo "$finished_at WARN miner exited with code $code; restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY" &
  wait $!
done

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DONE auto-restart runner stopped"
