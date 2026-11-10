#!/usr/bin/env bash
# drive.sh: serve the GUI for an agent to drive with `playwright cli` (.claude/skills/drive-app).
#
#   scripts/drive.sh          the mock daemon (scripted data, no real state) + the Vite dev server
#   scripts/drive.sh dev      a real `daemon --dev` on a scratch CODE_FOUNDRY_HOME + Vite
#
# Both run on free loopback ports, so several worktrees can drive at once. It stays in the
# foreground until interrupted, then stops everything it started and closes this checkout's
# playwright cli browsers. The URL and the CLI line are printed and written to
# gui/frontend/.playwright/drive.env.
#
# The dev daemon never touches ~/.code-foundry: its home is DRIVE_HOME or a new directory under
# /tmp (an inherited CODE_FOUNDRY_HOME is ignored), and the real home or one with a live daemon
# is refused.
set -euo pipefail

mode="${1:-mock}"
root="$(cd "$(dirname "$0")/.." && pwd)"
fe="$root/gui/frontend"
state="$fe/.playwright/drive.env"
pids=()

free_port() {
  bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true)'
}

wait_for() { # url-or-file, what
  for _ in $(seq 1 120); do
    case "$1" in
      http*) curl -s -o /dev/null "$1" && return 0 ;;
      *) [ -s "$1" ] && return 0 ;;
    esac
    sleep 0.25
  done
  echo "drive: $2 did not come up" >&2
  return 1
}

# One drive per checkout: drive.env and the checkout's playwright cli browsers are shared.
if [ -s "$state" ]; then
  live_port="$(sed -n 's/^DRIVE_VITE_PORT=//p' "$state")"
  if [ -n "$live_port" ] && curl -s -o /dev/null "http://127.0.0.1:$live_port/"; then
    echo "drive: already running in this checkout (gui/frontend/.playwright/drive.env)" >&2
    exit 1
  fi
fi

started=0
cleanup() {
  trap - EXIT INT TERM
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "$started" = 1 ]; then
    (cd "$fe" && ./node_modules/.bin/playwright cli close-all >/dev/null 2>&1) || true
    rm -f "$state"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

vite_port="$(free_port)"
mkdir -p "$fe/.playwright"

case "$mode" in
  mock)
    daemon_port="$(free_port)"
    token="drive-$(openssl rand -hex 8)"
    (cd "$fe" && MOCK_PORT="$daemon_port" MOCK_TOKEN="$token" exec ./node_modules/.bin/tsx mock/server.ts) >"$fe/.playwright/daemon.log" 2>&1 &
    pids+=($!)
    wait_for "http://127.0.0.1:$daemon_port/__mock/invocations" "the mock daemon"
    home=""
    ;;
  dev)
    # DRIVE_HOME, never an inherited CODE_FOUNDRY_HOME: a thread's environment may carry its
    # daemon's own home.
    home="${DRIVE_HOME:-$(mktemp -d /tmp/cf-drive.XXXXXX)}"
    mkdir -p "$home"
    if [ "$(cd "$home" && pwd -P)" = "$(cd "$HOME" && pwd -P)/.code-foundry" ]; then
      echo "drive: refusing to run a dev daemon on the real home ($home)" >&2
      exit 1
    fi
    if [ -s "$home/daemon.port" ] && curl -s -o /dev/null "http://127.0.0.1:$(tr -d '[:space:]' <"$home/daemon.port")/"; then
      echo "drive: a daemon already answers on $home; pick another DRIVE_HOME" >&2
      exit 1
    fi
    rm -f "$home/daemon.port" "$home/daemon.token"
    # Inside a thread the environment names that thread's daemon and the installed CLI:
    # drop the endpoint, and give the scratch daemon's threads this checkout's CLI.
    env -u CODE_FOUNDRY_ENDPOINT -u CODE_FOUNDRY_TOKEN -u CODE_FOUNDRY_THREAD -u CODE_FOUNDRY_PAGES \
      CODE_FOUNDRY_BIN="$root/bin/code-foundry" CODE_FOUNDRY_HOME="$home" CODE_FOUNDRY_DEV_ORIGINS="$vite_port" \
      "$root/bin/code-foundry" daemon --dev >"$fe/.playwright/daemon.log" 2>&1 &
    pids+=($!)
    wait_for "$home/daemon.port" "the dev daemon"
    wait_for "$home/daemon.token" "the dev daemon's token"
    daemon_port="$(tr -d '[:space:]' <"$home/daemon.port")"
    token="$(tr -d '[:space:]' <"$home/daemon.token")"
    ;;
  *)
    echo "usage: scripts/drive.sh [mock|dev]" >&2
    exit 2
    ;;
esac

(cd "$fe" && exec ./node_modules/.bin/vite --host 127.0.0.1 --port "$vite_port" --strictPort --clearScreen false) >"$fe/.playwright/vite.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$vite_port/" "Vite"

started=1
url="http://127.0.0.1:$vite_port/?daemon=http%3A%2F%2F127.0.0.1%3A$daemon_port&token=$token"
{
  echo "DRIVE_MODE=$mode"
  echo "DRIVE_URL='$url'"
  echo "DRIVE_DAEMON_PORT=$daemon_port"
  echo "DRIVE_VITE_PORT=$vite_port"
  if [ -n "$home" ]; then echo "export CODE_FOUNDRY_HOME='$home' CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:$daemon_port CODE_FOUNDRY_TOKEN='$token'"; fi
} >"$state"

echo "drive: $mode daemon on :$daemon_port, Vite on :$vite_port"
if [ -n "$home" ]; then echo "drive: export CODE_FOUNDRY_HOME='$home' CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:$daemon_port CODE_FOUNDRY_TOKEN='$token' before every bin/code-foundry call (sourcing drive.env does)"; fi
echo "drive: cd gui/frontend && ./node_modules/.bin/playwright cli open '$url'"
echo "drive: state in gui/frontend/.playwright/drive.env; logs in gui/frontend/.playwright/*.log"

# macOS bash 3.2 has no `wait -n`: poll until one of the servers exits.
while :; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "drive: a server exited; see gui/frontend/.playwright/*.log" >&2
      exit 1
    fi
  done
  sleep 1
done
