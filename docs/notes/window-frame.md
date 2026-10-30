# Window frame: remembered size and position

The window used to open at a fixed 1200×780 every launch, which is small on every display
the app targets (14" MacBook Pro and up). Now it reopens where the user left it.

## Decisions

- **Host-owned file, not NSWindow frame autosave.** `window-frame.json` sits next to
  `window-background.json` in the config home (`paths.WindowFrame`), written atomically.
  Frame autosave would have been one cgo call, but it lives in macOS user defaults, is
  hard to test, and an isolated copy (`CODE_FOUNDRY_HOME=/tmp/x`) would share state with
  the real app. The file keeps every launch decision in Go with table tests.
- **First launch takes 90% of the primary work area** (screen minus menu bar and Dock),
  centred, never below the 900×500 minimum. On a 14" MacBook Pro that is 1360×850; on a
  16" at default scaling 1555×1005.
- **A saved frame is fitted, not trusted.** The frame is clamped to the work area of the
  screen it overlaps most (the primary when it overlaps none): size clamped to the area,
  position shifted the least distance that keeps the whole window on screen. So a frame
  saved on an external monitor opens on the laptop's own screen when the monitor is gone.
- **Fullscreen and minimised are never saved.** They are modes, not frames; leaving
  fullscreen fires a resize, which saves the normal frame again.
- **Unplugging a monitor while running refits live.** macOS moves the window onto the
  remaining display itself but does not shrink one wider than it; the host listens for
  `ApplicationDidChangeScreenParameters` (after a short delay so Wails's own screen cache
  refresh lands first) and applies the same fit.

## Gotchas

- Wails caches the screen list in `applicationDidFinishLaunching`, after
  `NewWithOptions`, so `app.Screen.GetAll()` is empty when the window is created. The
  frame is applied in the existing show step (`WebViewDidFinishNavigation`, window still
  hidden), where the screens are known. The option `Width`/`Height` is only a fallback for
  the no-screens case.
- Wails positions are in points with a top-left origin, flipped from AppKit against the
  primary screen's height, and `Screen.WorkArea` is in the same space, so the fit is plain
  integer arithmetic.
- Move and resize events arrive in bursts during a drag; saves coalesce over 500 ms and
  skip when the frame is unchanged.

## Verified

Isolated copy on a 2056×1329 display (work area y=39, height 1290): first launch
1850×1161 centred; resized to 1300×820 at (500,300) and relaunched, reopened at exactly
that frame; a planted frame at x=5000, 3000×2000 opened filling the work area.
