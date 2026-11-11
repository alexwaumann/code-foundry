# plugin surface --shot: the Wails host (2026-11-10)

The third piece of `plugin surface … --shot out.png`, after the daemon side
(`plugin-surface-shot-daemon.md`, PR #638) and the page (`plugin-surface-shot-page.md`,
PR #636). The host holds `UiService.WatchShots`, draws each request with the shot page in a
window the user never sees, snapshots the webview and answers with `UiService.PublishShot`.

## What shipped

* `gui/shotwatch.go`: the `WatchShots` loop. It reconnects every 2 s like the other host
  streams, and hands each request to the queue with the stream's context, which ends with
  the stream. A request whose stream dropped is never drawn or answered: the daemon has
  already failed it.
* `gui/shot.go`: `ShotService`, bound to the page (`PageReady`, `Rendered(id,
  {contentHeight})`, `Failed(id, failure, reason)`), and its worker. One request at a
  time, in arrival order. For each request it opens the window if none is there, waits for
  the page's `PageReady`, then calls `show`: size the viewport, order the window in off
  every display, and `window.cfShot(request)` through `ExecJS`. It then waits for the
  page's report. A rendered report means snapshot, order out and publish the PNG with
  `content_height`; a failure publishes the page's reason as `error`.
* `gui/shot_darwin.go` (+ `shot_export_darwin.go` for the cgo callback): the window and
  the snapshot (`WKWebView takeSnapshotWithConfiguration:`, `afterScreenUpdates`, PNG via
  `NSBitmapImageRep`, in device pixels).
* `src/api/shot.ts`: the page's calls to the host, behind an in-Wails check. `report` in
  `src/shot/main.tsx` marks `<html>` first and then reports to the host. The page calls
  `PageReady` once `window.cfShot` is set. In the mock and the browser nothing reaches a
  host and the marks stay the report, as the existing e2e expects.

## The spike: what a hidden window does

Checked on the hello demo (the Overview tab's chart and stat cards, and the Runs tab's
master-detail and tables) with a temporary hook in the built app:

1. **A window that was never ordered in**: `takeSnapshot` returns real pixels, but the page's
   `visibilityState` is `hidden` and `requestAnimationFrame` never fires (0 frames in 8 s),
   so the page's "two painted frames" wait never ends. ResizeObserver delivered its first
   callback, but nothing that waits on a frame works. Not usable.
2. **Fallback (1), ordered in off-screen**: works, but only once the webview ignores
   occlusion. Two wrong turns on the way:
   * A **titled** window (Wails' default frameless) moved off-screen with `setFrameOrigin`
     is pulled back onto the screen by AppKit when it orders in: the window list showed it
     at x 1636 on a 1728 pt wide display. It "worked" (the page was visible, rAF ran)
     only because part of it was on screen, hidden behind the main window by luck.
   * A **borderless** window (`CornerType: square`) keeps its off-screen frame, but it is
     then fully occluded, and WebKit treats an occluded window's page as hidden (0 frames
     again).
   * What works: a borderless window ordered in above and right of every display, with
     the webview's private `_setWindowOcclusionDetectionEnabled:NO`
     (`WKWebViewPrivate.h`, macOS 10.13+; the same kind of private switch as
     `windowbg_darwin.go`'s `drawsBackground`). The page is `visible`, rAF runs, and
     ResizeObserver layouts follow the viewport: at 420 px the stat cards wrap to two
     columns, the master-detail shows the list alone and the Builds table drops Status,
     Cause and Started by; at 900 px the list and detail sit side by side and the table
     shows every column with its Rerun buttons. `CGWindowListCopyWindowInfo` shows it at
     (6056, −4900) while ordered in and off-screen otherwise. If the selector is missing,
     the shot fails at once with "this macOS's WebKit cannot draw a window that is on no
     display" rather than timing out.

So the window is ordered in only for a shot (about 100 to 250 ms) and ordered out after
the snapshot, at the back of its level, with no activation and never key. It has
`excludedFromWindowsMenu` set, no animation, Transient and IgnoresCycle (out of Mission
Control and ⌘`), no shadow, and ignores the mouse. A snapshot is the webview's own, not a
screen capture, so it needs no Screen Recording permission.

## Decisions

* **Created on the first shot and closed after 2 idle minutes**. The window and its page
  are not made at launch, and between shots the page still holds its last surface's
  stream (it keeps the surface on screen after a report), so the stream goes with the
  window. An agent iterating on a plugin shoots again within the 2 minutes.
* **Host timeout 12 s from receipt**, under the daemon's 15 s, so the CLI prints the host's
  reason ("the screenshot page did not answer in time") and not the broker's. The page's
  own `timeoutMs` is what is left minus 1.5 s for the snapshot, capped at its default 10 s,
  so normally the page's timeout reason ("no live view at version N…") is what comes
  back. A request that waited out its 12 s in the queue fails without being drawn.
* **A host timeout replaces the window**: a page or webview that stopped answering would
  fail every later request.
* **Requests go in by `ExecJS`**, not an event, and only after `PageReady`. Wails holds
  `ExecJS` back until the runtime's ready message, and `PageReady` is called after
  `window.cfShot` is set, so a request never reaches a page without it.
* **The viewport is exactly the request's size.** Wails makes a window's content view one
  point smaller than the WKWebView inside it in each direction (`width-1`, `height-1`),
  so a 500 by 800 content size gave a 501 by 801 viewport. `cfShotSize` sets the content
  size and then the webview's frame to the content bounds.
* **Without an instance** (the CLI always sends one) the request's scope is the context's
  thread, else project, else worktree, else global.
* **Quitting** cancels the worker and the stream (`app.OnShutdown`) before the windows
  go. A request on the page is dropped unanswered, and the window is left alone.

## Checked end to end

A scratch `CODE_FOUNDRY_HOME` under `$HOME`, the built `gui/bin/Code Foundry`, the hello
example linked with `plugin dev` (its `bin/hello` built by hand first), a no-project thread:

* no app: `plugin surface hello demo --thread <id> --shot out.png` printed the view, then
  "no screenshot: the app is not open (code-foundry gui)", exit 1, no file; the same
  after quitting the app;
* app open, dark: Overview at 420 by 900 (840 by 1800 px) with the hint
  `--height 1551`, then `--height 1551` showing the whole surface; Runs at
  `--width 900 --height 1100`;
* `appearance.theme light`: the same shots in the light theme;
* the app hidden (⌘H): shots still work, and the window does not come back on unhide;
* the main window closed with the shot window alive: the app quits;
* the daemon killed while the app was open: the next CLI call started a new one, the host
  reconnected within its 2 s retry, and the shot worked.

A failure the page reports (plugin down, timeout) is covered by the Go tests with a fake
window. It was not forced end to end because there is no clean way to crash a plugin
between the CLI's view and its shot.

## Gotchas

* The page's report is marked on `<html>` before the host call, and the marks are data
  attributes that are never drawn, so they are not in the PNG.
* `make gui-build` rewrites `gui/build/darwin/icons.icns` and adds `Assets.car`; put them
  back before committing.
* An instance outlives the CLI call by its 10 minute grace, so tab switches made with
  `plugin act` show in the next shot.
