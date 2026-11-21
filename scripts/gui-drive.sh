#!/usr/bin/env bash
# gui-drive.sh: run the real Wails GUI for an agent to drive (.claude/skills/drive-app, "The
# real window"). The build is gui/bin/drive/Code Foundry (`make gui-drive`), compiled with
# Wails's `mcp` tag: an HTTP server inside the app that evaluates JS in the window, sends it
# input and controls it (native zoom included). Release builds never carry the tag.
#
#   scripts/gui-drive.sh                 start: the GUI and its own daemon on a scratch home
#   scripts/gui-drive.sh call TOOL JSON  one tool of the app's server (tools/list names them)
#   scripts/gui-drive.sh eval 'JS'       run a function body in the page; `return` the value
#   scripts/gui-drive.sh shot FILE.png   the window's pixels, title bar included
#
# Start stays in the foreground until interrupted or the window is closed, then stops the GUI
# and the daemon it started, by PID. The home is DRIVE_HOME or a new directory under /tmp,
# never ~/.code-foundry. State is in gui/frontend/.playwright/gui-drive.env.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fe="$root/gui/frontend"
state="$fe/.playwright/gui-drive.env"
app="$root/gui/bin/drive/Code Foundry"

load() {
  if [ ! -s "$state" ]; then
    echo "gui-drive: not running in this checkout (make gui-drive)" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$state"
}

# rpc TOOL JSON: the tool's text result on stdout; exit 1 when the tool reports an error.
rpc() {
  printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2" |
    curl -s -m 60 -X POST "http://127.0.0.1:$GUI_DRIVE_PORT/mcp" \
      -H "Authorization: Bearer $GUI_DRIVE_TOKEN" -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' -d @- |
    bun -e '
      const r = JSON.parse(await Bun.stdin.text());
      if (r.error) { console.error(r.error.message); process.exit(1); }
      console.log((r.result.content ?? []).map((c) => c.text).join("\n"));
      if (r.result.isError) process.exit(1);'
}

case "${1:-start}" in
  call)
    load
    rpc "${2:?usage: gui-drive.sh call TOOL [JSON]}" "${3:-{\}}"
    exit
    ;;
  eval)
    load
    rpc js_eval "$(JS="${2:?usage: gui-drive.sh eval JS}" bun -e 'console.log(JSON.stringify({ js: process.env.JS }))')"
    exit
    ;;
  shot)
    load
    out="${2:?usage: gui-drive.sh shot FILE.png}"
    # The app's one on-screen window, by PID: other sessions' windows share the name.
    id="$(osascript -l JavaScript -e '
      ObjC.import("CoreGraphics");
      function run(argv) {
        const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
        const w = all.find((x) => x.kCGWindowOwnerPID === parseInt(argv[0], 10) && x.kCGWindowLayer === 0);
        return w ? String(w.kCGWindowNumber) : "";
      }' "$GUI_DRIVE_PID")"
    if [ -z "$id" ]; then
      echo "gui-drive: the window is not on screen" >&2
      exit 1
    fi
    screencapture -x -o -l "$id" "$out"
    exit
    ;;
  start) ;;
  *)
    echo "usage: scripts/gui-drive.sh [start | call TOOL [JSON] | eval JS | shot FILE.png]" >&2
    exit 2
    ;;
esac

if [ ! -x "$app" ]; then
  echo "gui-drive: $app is not built (make gui-drive)" >&2
  exit 1
fi
if [ -s "$state" ]; then
  live="$(sed -n 's/^GUI_DRIVE_PORT=//p' "$state")"
  if [ -n "$live" ] && curl -s -o /dev/null "http://127.0.0.1:$live/"; then
    echo "gui-drive: already running in this checkout (gui/frontend/.playwright/gui-drive.env)" >&2
    exit 1
  fi
fi

# DRIVE_HOME, never an inherited CODE_FOUNDRY_HOME: a thread's environment may carry its
# daemon's own home.
home="${DRIVE_HOME:-$(mktemp -d /tmp/cf-gui-drive.XXXXXX)}"
mkdir -p "$home"
if [ "$(cd "$home" && pwd -P)" = "$(cd "$HOME" && pwd -P)/.code-foundry" ]; then
  echo "gui-drive: refusing to run on the real home ($home)" >&2
  exit 1
fi
if [ -s "$home/daemon.port" ] && curl -s -o /dev/null "http://127.0.0.1:$(tr -d '[:space:]' <"$home/daemon.port")/"; then
  echo "gui-drive: a daemon already answers on $home; pick another DRIVE_HOME" >&2
  exit 1
fi

port="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true)')"
token="gui-drive-$(openssl rand -hex 16)"
mkdir -p "$fe/.playwright"

gui_pid=""
cleanup() {
  trap - EXIT INT TERM
  # By PID only. The daemon is the one the GUI started on the scratch home: its lock names it,
  # and it is stopped only while it still is this checkout's binary.
  if [ -n "$gui_pid" ]; then kill "$gui_pid" 2>/dev/null || true; fi
  daemon_pid="$(tr -cd '0-9' <"$home/daemon.lock" 2>/dev/null || true)"
  if [ -n "$daemon_pid" ] && ps -p "$daemon_pid" -o command= 2>/dev/null | grep -qF "$root/bin/code-foundry"; then
    kill "$daemon_pid" 2>/dev/null || true
  fi
  rm -f "$state"
}
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

# Inside a thread the environment names that thread's daemon: drop it, so the GUI starts its
# own on the scratch home with this checkout's CLI.
env -u CODE_FOUNDRY_ENDPOINT -u CODE_FOUNDRY_TOKEN -u CODE_FOUNDRY_THREAD -u CODE_FOUNDRY_PAGES \
  CODE_FOUNDRY_HOME="$home" CODE_FOUNDRY_BIN="$root/bin/code-foundry" \
  WAILS_MCP_PORT="$port" WAILS_MCP_TOKEN="$token" WAILS_MCP_HIDE_CURSOR=1 \
  "$app" >"$fe/.playwright/gui-drive.log" 2>&1 &

for _ in $(seq 1 120); do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && break
  sleep 0.25
done
# The GUI starts itself again as its own responsible process (gui/responsible_darwin.go), so
# the process to drive and to stop is the one that listens, not the one started here.
gui_pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -z "$gui_pid" ]; then
  echo "gui-drive: the GUI did not come up (gui/frontend/.playwright/gui-drive.log)" >&2
  exit 1
fi

{
  echo "GUI_DRIVE_PORT=$port"
  echo "GUI_DRIVE_TOKEN='$token'"
  echo "GUI_DRIVE_PID=$gui_pid"
  echo "GUI_DRIVE_HOME='$home'"
} >"$state"

echo "gui-drive: the GUI (pid $gui_pid) on home $home, driven on :$port"
echo "gui-drive: scripts/gui-drive.sh eval 'return document.title'"
echo "gui-drive: prefix every bin/code-foundry call with CODE_FOUNDRY_HOME='$home'"

while kill -0 "$gui_pid" 2>/dev/null; do sleep 1; done
