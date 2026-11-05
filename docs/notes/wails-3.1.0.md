# Wails v3.0.0-beta.34 → v3.1.0

v3.0.0 went stable on 2026-10-26 and v3.1.0 followed on 2026-11-01. Minor versions now ship
weekly, nightlies preview the next one, and `@latest` never resolves to a nightly. The npm
runtime always has the same version as the Go module.

## What changed here

Pins only; no Go or TypeScript source changed.

* `go.mod` and `go.sum`, tidied: `ebitengine/purego` and `x/term` come in as indirect,
  `adrg/xdg` and `go-colorable` go.
* `@wailsio/runtime` in `gui/frontend/package.json`, and `bun.lock`.
* The `wails3` install line in `.github/workflows/release.yml`.
* The patch file, renamed and re-keyed in `patchedDependencies`. Its content is unchanged.

The local CLI moves too: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`.
`~/go/bin` is shared by every worktree and the Makefile puts it first on `PATH`, so the
Taskfile's own `wails3` calls come from there. To try a new CLI without moving other
worktrees, pass `GOBIN_DIR=<dir>` to make, with the other tools symlinked into that dir.

## The runtime patch stays

`dist/drag.js` is byte-identical in beta.34, 3.1.0 and 3.2.0-nightly.20261103, so neither
fix is upstream. The only `dist` difference from beta.34 to 3.1.0 is one line in `system.js`.

* Drag poll timers: stops the poll throwing after vitest tears down jsdom
  (`4cc4efa1d`). It only matters under a test runner.
* Drag zones under CSS `zoom`: see `ui-zoom.md`. Without it, drags start only from the
  top-left 1/zoom of each surface.

The patch is keyed by exact version, so every Wails bump renames it. Install fails loudly
if a bump forgets to.

## Screens

3.1.0 changes how macOS screens are reported (wailsapp/wails#6346). The dictation overlay is
unaffected: `cfOverlayMetrics` reads `NSScreen` itself and never uses Wails' screen manager.

## Verified

`make check` and `make gui-e2e` on this tree, and `make gui-build` with the 3.1.0 CLI. The
binary reports its version and keeps its embedded Info.plist. A live run with an isolated
`CODE_FOUNDRY_HOME`:

* The window renders, the daemon connects and the traffic lights sit on the title band.
* A synthesized drag from the sidebar band moves the window at 100%.
* At 150% the traffic lights re-centre on the zoomed band, and a press at (290, 72) in the
  window drags it. That point is past the unzoomed 260 x 52 band, so only the patched check
  accepts it.

Not run live: microphone capture, the overlay, dock badge, sound and relaunch.

Seen on both versions, so not from this bump: after the first click on the window, the
welcome composer's seeded text ends up selected.

Also on both versions: the first `wails3 build` in a fresh tree runs `generate icons`, which
shrinks `gui/build/darwin/icons.icns` and writes an untracked 6 MB `Assets.car`. Neither ships
in the bare binary (the Dock icon comes from `dockicon.png` at runtime), so do not commit them.
