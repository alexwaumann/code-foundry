# gui-drive: an agent drives the real Wails window

`make drive` serves the frontend to a headless WebKit, which is the same engine as the Wails
window but not the same host: no native zoom, no traffic lights, no bound methods, no system
WKWebView settings. `make gui-drive` runs the real GUI so an agent can look at those.

## How

- Wails 3.1.0 has an MCP server in `pkg/application/mcp_*.go`, compiled in only with the
  `mcp` build tag and started inside `App.Run()`. `make gui-drive` builds
  `gui/bin/drive/Code Foundry` with `EXTRA_TAGS=mcp`; `make gui-build` and `scripts/package.sh`
  pass no extra tag, so the installed and released GUI never has the server.
- `scripts/gui-drive.sh` starts that build on a scratch `CODE_FOUNDRY_HOME` (the GUI starts its
  own daemon there with this checkout's CLI), on a free loopback port with a random bearer
  token, and writes both to `gui/frontend/.playwright/gui-drive.env`. `call`, `eval` and `shot`
  read that file.
- The server speaks MCP over HTTP; the script posts one `tools/call` with curl, so no MCP
  client is needed. `eval` is `js_eval`: a function body with the server's helper library as
  `mcp` (`mcp.snapshot`, `mcp.query`, `mcp.click`, ...).
- Pixels: the server's `screenshot_dom` is a DOM tree. `shot` finds the window id by the GUI's
  PID (CGWindowList through JXA) and runs `screencapture -l`, so the title bar and traffic
  lights are in the picture.

## Gotchas

- The GUI starts itself again as its own responsible process (`gui/responsible_darwin.go`), so
  the process started by the script exits at once. The PID to drive and stop is the one
  listening on the port.
- Stopping is by PID: the GUI's, then the daemon named in the scratch home's `daemon.lock`,
  and only while that PID still runs this checkout's `bin/code-foundry`.
- Input is synthetic DOM events dispatched in the page. Nothing that goes through AppKit can
  be driven: a Finder file drop, a window drag by the title band, native menus, system dialogs.
- A drag that a component follows with pointer capture (the pane gutters, the sidebar's
  resize handle) does not follow `mouse_drag`: the synthetic moves never reach the capturing
  element. Clicks, hovers, typing and menus do work.
- A native file drop can be replayed from the point where AppKit hands it to the page, which
  covers everything but AppKit's own delivery: `window._wails.handleDragEnter()`,
  `window._wails.handleDragOver(x, y)`, then `window._wails.handlePlatformFileDrop([path], x, y)`
  in `eval`, with x and y in view points (CSS px times the native zoom).
- A thrown error in `eval` comes back as a stack without the message; return values instead.
- Under the window zoom `devicePixelRatio` is multiplied by the zoom (2 becomes 2.5 at 125%
  on a Retina screen) and `innerWidth` is divided by it (`native-zoom.md`).
- `WAILS_MCP_HIDE_CURSOR=1` is set: the server's animated cursor would be in every shot.

## Host checks

What only the real window shows; a pass before a stable release and after a Wails upgrade:

- Zoom at 80, 125 and 150%: layout fills the window, nothing clipped or doubled.
- The traffic lights sit centred on the title band at each zoom.
- A dropdown, a context menu, a tooltip and a dialog open where they should under zoom.
- A terminal's text is sharp under zoom.
- An HTML preview and a plugin surface render at the right size.
- By hand (AppKit input): drop a file from Finder on a composer; drag the window by the band.
