---
name: drive-app
description: Drive the Code Foundry GUI in a headless WebKit browser with `playwright cli` to check a change while making it, explore a flow, or render a sketch inside the real app; or drive the real Wails window (`make gui-drive`) for what only the native host shows (native zoom, traffic lights, the system webview). Use instead of one-off Playwright scripts. Not for PR screenshots (the SHOTS-gated e2e specs make those) and never for public web pages.
---

# Drive the app

`playwright cli` ships inside the repo's `@playwright/test`, so it uses the same WebKit build as
the e2e suite (the engine of the Wails window). `gui/frontend/.playwright/cli.config.json` is
picked up automatically when the CLI runs from `gui/frontend`: WebKit, headless, in-memory
profile, dark, 1280×800, and only `127.0.0.1` / `localhost` / `*.localhost` origins (a page in a
File tab is framed at its grant's own `<grant>.localhost`).

## Start

Run in the background (it stays up until stopped):

```bash
make drive               # mock daemon: scripted data, no real state (the default)
make drive DAEMON=dev    # real `daemon --dev` on a scratch home under /tmp (or DRIVE_HOME=/tmp/x)
```

It prints the URL and writes `gui/frontend/.playwright/drive.env` (`DRIVE_URL`,
`DRIVE_DAEMON_PORT`, `DRIVE_VITE_PORT`, and in dev mode exports of `CODE_FOUNDRY_HOME`,
`CODE_FOUNDRY_ENDPOINT` and `CODE_FOUNDRY_TOKEN`). Ports are free
ones, so other worktrees and the e2e suite are unaffected. Vite is the dev server, so edits
hot-reload into the open page.

## Drive

```bash
cd gui/frontend && . .playwright/drive.env
P=./node_modules/.bin/playwright
$P cli open "$DRIVE_URL"
$P cli snapshot                      # element refs (e12); prefer this to screenshots
$P cli click e12
$P cli fill e30 "hello"; $P cli press Enter
$P cli screenshot --filename=.playwright/out/x.png   # read the PNG to look at it
$P cli eval '() => window.__cfModule("/src/stores/ui.ts").then((m) => m.useUiStore.getState().zoom)'
```

- Snapshots go stale after the DOM changes: snapshot again before reusing refs.
- A React page (`/cf/jsx.js`) imports each script from a `blob:` URL, which the origin allowlist
  blocks ("Importing a module script failed"). Once per `open`, before showing one:
  `$P cli run-code "async page => page.context().route(u => u.protocol === 'blob:', r => r.continue())"`.
- `window.__cfModule(path)` gives `src/stores/*.ts` and `src/api/*.ts` (dev builds only).
- Mock mode: script state through the mock's `/__mock/*` endpoints (see `mock/server.ts`),
  e.g. `curl -X POST "http://127.0.0.1:$DRIVE_DAEMON_PORT/__mock/thread/status?id=s-1&status=attention"`
  (the mock checks no token on these).
- Dev mode: run `bin/code-foundry` only in a shell that sourced `drive.env` (or ran the printed
  `export` line). A bare call reaches the daemon the environment names, which inside a thread
  is the user's real one, or starts a daemon on the real home and replaces the user's.
- The GUI speaks binary protobuf. Add `&json=1` to `$DRIVE_URL` to read its RPCs as JSON in network
  captures; the app behaves the same, but do not take timings that way.
- Sketching inside the real app: inject DOM/CSS with `eval`, using `var(--cf-*)` tokens and
  the type-role classes, then screenshot each variant.
- Full command reference (same version as the binary):
  `node_modules/.bun/playwright-core@*/node_modules/playwright-core/lib/tools/skills/playwright-cli/SKILL.md`.

## Mock controls

The mock's `/__mock/*` controls (POST unless marked GET; the full list heads `mock/server.ts`)
that help most when driving by hand:

- `thread?state=permission|question|streaming|idle|agents|waiting|html|long|…`: the scripted
  thread s-r1 in that state; `thread/delta?text=…` and `thread/finish` stream a reply into it.
- `thread/status?id=s-1&status=busy|idle|attention[&reason=…]`, `thread/stop?id=…&reason=crashed`:
  a sidebar thread's status or end.
- `thread-info?scenario=single|ws9|archived|home|child-server`: the thread info card's fixtures.
- `threads?project=repo-cf&count=30&status=idle`, `lineage`, `status-kinds`, `welcome`, `empty`:
  more threads, a lineage, one thread per status, a first run, a fresh install.
- `workspace?name=login&projects=repo-cf,repo-gp`, `leftovers?project=repo-cf`: workspaces and
  cleanable worktrees.
- `settings/external?appearance.theme=light` (a hand edit of the settings file), `ember?enabled=true`,
  `dictation?state=ready`, `gh/many-prs?count=150`.
- `reset` puts everything back; GET `invocations` lists the commands the GUI ran.

A control the session needs and the mock lacks is added in `mock/server.ts` (its `control`
function and the header list), with the World method it calls.

## Live e2e suite

The opt-in specs `gui/frontend/e2e/live*.spec.ts` run on the same dev drive: `DRIVE_HOME=~/cf-live-scratch/home
make drive DAEMON=dev`, register scratch projects, then `. .playwright/drive.env && LIVE_DAEMON=1 bun run
e2e:live e2e/live.spec.ts`, one spec at a time. They start real Claude threads (Haiku 5.5, a few short
turns per spec) and some read GitHub through `gh`; they are not part of `make check`. Fixtures, what
each spec needs and costs: `docs/notes/live-e2e.md`.

## The real window

The browser drive is the default: headless, parallel, real input events, no build. Use the real
window only for what the browser cannot show: native zoom, the traffic lights and title band,
the system WKWebView's own behaviour, the host's bound methods, a check before a release.

```bash
make gui-drive           # background; builds gui/bin/drive/Code Foundry and opens it on a scratch home
G=scripts/gui-drive.sh
$G eval 'return { w: innerWidth, dpr: devicePixelRatio }'      # a function body; `return` the value
$G eval 'return mcp.snapshot(8)'                                # the visible DOM as a tree
$G call window_control '{"action":"set_zoom","zoom":1.25}'      # native zoom (WKWebView pageZoom)
$G call mouse_click '{"selector":"button[aria-label=Settings]"}'      # or {"x":120,"y":80}
$G call keyboard_type '{"text":"hello"}'
$G shot /tmp/x.png                                              # the window's pixels, title bar included
```

- The build carries Wails's `mcp` tag: a loopback HTTP server inside the app, behind a token in
  `gui/frontend/.playwright/gui-drive.env`. Its tools:
  `app_info`, `windows_list`, `window_control`, `js_eval`, `dom_html`, `dom_query`, `mouse_move`,
  `mouse_click`, `mouse_drag`, `mouse_scroll`, `keyboard_type`, `keyboard_press`,
  `call_bound_method`, `emit_event`, `wait_for_event` and `screenshot_dom` (a DOM tree, not
  pixels). Arguments: the tool's schema in Wails's `pkg/application/mcp_tools_enabled.go`.
- It is a production frontend: no `window.__cfModule`, no hot reload. Rebuild to see an edit.
  Change state through the page, or the CLI with `CODE_FOUNDRY_HOME` set to the drive's home
  (printed at start) on every call.
- Input is synthetic DOM events. What goes through AppKit is out of reach and stays a check
  by hand: a file dropped from Finder, dragging the window by its title band, native menus.
  So do drags a component follows with pointer capture (pane gutters, the sidebar's edge).
  A Finder drop can be replayed from where AppKit hands it over (`docs/notes/gui-drive.md`).
- The window opens on the user's screen and takes focus once. Do not leave it up: stop the
  background task when done (it stops the GUI and its daemon by PID).
- `shot` needs the window on screen and Screen Recording permission for the terminal.

Host checks worth a pass in the real window before a stable release, and after a Wails upgrade
(`docs/notes/gui-drive.md` has the list): zoom at 80/125/150%, the traffic lights on the title
band, popovers and menus under zoom, a terminal's sharpness, an HTML preview, a plugin surface.

## Stop

Stop the background `make drive` task (or send it SIGTERM) when done. It kills the daemon and
Vite, closes this checkout's `playwright cli` browsers and removes `drive.env`. One drive runs
per checkout; a second refuses while the first answers. After a SIGKILL: `$P cli kill-all`.

## Rules

- Localhost only. Never `goto` a public site; the allowlist blocks it, but it is a backstop, not
  a boundary. Public pages go through web fetch or a real browser.
- Never point it at the user's real daemon or token, and never run a dev daemon on
  `~/.code-foundry` or a home whose daemon is live (`scripts/drive.sh` refuses both).
- Never use `--persistent`, `--profile`, `--browser=…`, `--config` with another file, the `show`
  dashboard, `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS`, or a secrets file.
- Never install another browser (`playwright install chromium`); WebKit is the only engine.
- Output stays in `gui/frontend/.playwright/` (gitignored). Copy a PNG out to show it.
