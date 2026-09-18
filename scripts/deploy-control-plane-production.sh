#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Production Control Plane deployment must run as root." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="$repository_root/scripts/deploy-control-plane-production.sh"
node_binary="$(command -v node)"
pid_file="${CONTROLLER_CENTER_CONTROL_PID_FILE:-/run/controller-center-control-plane.pid}"
log_file="${CONTROLLER_CENTER_CONTROL_LOG_FILE:-/var/log/controller-center/control-plane.log}"
production_origin="${CONTROLLER_CENTER_PUBLIC_ORIGIN:-https://c.llmdev.cn}"
cors_origin="${CONTROLLER_CENTER_CORS_ORIGIN:-$production_origin}"
trust_proxy="${CONTROLLER_CENTER_TRUST_PROXY:-true}"

export PUBLIC_ORIGIN="$production_origin"
export CORS_ORIGIN="$cors_origin"
export TRUST_PROXY="$trust_proxy"

is_control_process() {
  local process_id="$1"
  local process_cwd process_command
  [[ "$process_id" =~ ^[0-9]+$ ]] && kill -0 "$process_id" 2>/dev/null || return 1
  process_cwd="$(readlink -f "/proc/$process_id/cwd" 2>/dev/null || true)"
  process_command="$(tr '\0' ' ' <"/proc/$process_id/cmdline" 2>/dev/null || true)"
  process_command="${process_command% }"
  [[ "$process_cwd" == "$repository_root" \
    && "$process_command" == "$node_binary apps/control-plane/dist/index.js" ]]
}

if [[ "${1:-}" == "__run" ]]; then
  cd "$repository_root"
  umask 027
  printf '%s\n' "$$" >"$pid_file"
  exec "$node_binary" apps/control-plane/dist/index.js
fi

for required_command in curl setsid; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

install -d -m 0750 "$(dirname "$log_file")"
touch "$log_file"
chmod 0640 "$log_file"

cd "$repository_root"
npm run build -w @controller-center/protocol
npm run build -w @controller-center/control-plane

control_pid=""
if [[ -r "$pid_file" ]]; then
  read -r candidate_pid <"$pid_file" || true
  if is_control_process "$candidate_pid"; then
    control_pid="$candidate_pid"
  fi
fi

if [[ -z "$control_pid" ]]; then
  while read -r candidate_pid; do
    [[ -n "$candidate_pid" ]] || continue
    if is_control_process "$candidate_pid"; then
      if [[ -n "$control_pid" ]]; then
        echo "Found multiple Control Plane processes in $repository_root; refusing an ambiguous restart." >&2
        exit 1
      fi
      control_pid="$candidate_pid"
    fi
  done < <(pgrep -f 'node apps/control-plane/dist/index.js$' || true)
fi

if [[ -n "$control_pid" ]]; then
  kill -TERM "$control_pid"
  for _attempt in $(seq 1 100); do
    if ! kill -0 "$control_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if kill -0 "$control_pid" 2>/dev/null; then
    echo "Control Plane process $control_pid did not stop cleanly." >&2
    exit 1
  fi
fi

rm -f "$pid_file"
setsid -f "$script_path" __run >>"$log_file" 2>&1 </dev/null

new_pid=""
for _attempt in $(seq 1 100); do
  if [[ -r "$pid_file" ]]; then
    read -r new_pid <"$pid_file" || true
  fi
  if is_control_process "$new_pid" \
    && curl -fsS http://127.0.0.1:8787/readyz >/dev/null; then
    break
  fi
  sleep 0.1
done

if ! is_control_process "$new_pid" \
  || ! curl -fsS http://127.0.0.1:8787/readyz >/dev/null; then
  echo "Control Plane failed its post-deployment health check. See $log_file." >&2
  tail -n 80 "$log_file" >&2 || true
  exit 1
fi

allowed_origin="$(curl -sS -D - -o /dev/null -H "Origin: $PUBLIC_ORIGIN" http://127.0.0.1:8787/api/auth/session \
  | tr -d '\r' \
  | awk 'BEGIN { IGNORECASE=1 } /^Access-Control-Allow-Origin:/ { sub(/^[^:]+:[[:space:]]*/, ""); print; exit }')"
if [[ "$allowed_origin" != "$PUBLIC_ORIGIN" ]]; then
  echo "Control Plane is healthy, but the production Origin was not accepted." >&2
  exit 1
fi

echo "Controller Center Control Plane deployed successfully"
echo "PID: $new_pid"
echo "PUBLIC_ORIGIN: $PUBLIC_ORIGIN"
echo "CORS_ORIGIN: $CORS_ORIGIN"
echo "TRUST_PROXY: $TRUST_PROXY"
echo "Log: $log_file"
