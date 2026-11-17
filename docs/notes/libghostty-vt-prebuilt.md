# libghostty-vt: official prebuilt 1.0.1 instead of a zig build (2026-11-17)

`scripts/ghostty-vt.sh` used to download zig 0.16.0, shallow-clone ghostty at a pinned
commit and build a static libghostty-vt (~1 min, network to ziglang.org, github.com and
codeberg.org). libghostty-vt reached 1.0 with a stable C ABI and publishes a prebuilt
macOS static library, so the script now downloads that. The Go bindings moved to
`go.mitchellh.com/libghostty v0.0.0-20261107144202-b13f277ddcb2` ("libghostty 1.0 compat",
no tags, still a pseudo-version).

## Decisions

* **Artefact**: `ghostty-vt-1.0.1.xcframework.zip` from
  `release.files.ghostty.org/libghostty-vt/1.0.1/`, pinned by sha256 (the release's
  `SHA256SUMS` agrees). No minisign: a pinned sha256 is how the other fetch scripts trust
  their downloads. Only the `macos-arm64_x86_64` slice is unpacked: a universal
  `libghostty-vt.a` built for macOS 13.0 (our `-mmacosx-version-min`) and
  `Headers/ghostty/`. The headers must say `GHOSTTY_VT_VERSION "1.0.1"` or the install
  fails.
* **Bindings vs library version**: the bindings' CMakeLists pins a ghostty commit a few
  past `vt-1.0.0`; 1.0.1 is newer, and the 1.x ABI promise
  (lib.ghostty.org/vt/stability) covers a later 1.x library with earlier 1.x headers. The
  terminal tests also pass against 1.0.0 (seen in the cache demonstration below).
* **pkg-config**: the release ships no `.pc`; the bindings link with
  `#cgo pkg-config: --static libghostty-vt-static`. The script writes
  `lib/pkgconfig/libghostty-vt-static.pc` (upstream's 1.0 location) with the absolute
  final prefix, `Cflags: -I${includedir}`, `Libs: ${libdir}/libghostty-vt.a`, nothing
  private: the archive needs only libSystem, as the zig build did.
* **Cache layout**: `~/Library/Caches/code-foundry/ghostty-vt/<key>/` with `include/`,
  `lib/`, `lib/pkgconfig/`; `<key>` is `libghostty-vt-<version>-<first 8 hex of sha256>`
  (no arch: the archive is universal). The old zig entries are named
  `ghostty-vt-<commit>-zig-<version>-<arch>/ghostty-vt`, so the two never collide.
* **Install**: under `lockf -k <cache>/<key>.lock` (the script re-execs itself under the
  lock), download into `mktemp -d <cache>/.<key>.tmp.XXXXXX`, verify, unpack, write the
  `.pc`, then one `mv` of the finished directory to `<key>/`. A reader that sees the
  prefix sees all of it. A waiter on the lock finds the `.pc` and exits without
  downloading. Under the lock the script removes only its own key's leftovers (temporary
  directories, or a prefix without a `.pc`) from a killed install; nothing else in the
  cache is touched.
* **Go build cache**: Go's action ID for a cgo package hashes its `CGO_*` flags and
  `#cgo` directives but not pkg-config's output or `PKG_CONFIG_PATH`
  (`buildActionID` in cmd/go/internal/work/exec.go, Go 1.26). So the library's absolute
  path is baked into a cached package that another pin can reuse. This change is safe
  without help (the bindings module version changes too), but a future library-only
  bump with the same bindings would not be. The Makefile therefore exports
  `CGO_CPPFLAGS := -DCODE_FOUNDRY_GHOSTTY_VT=<key>`, a define nothing reads, which puts
  the pin in every cgo package's action ID. It recompiles every cgo package (also
  whisper, FSEvents) once per pin; that takes seconds. `go clean -cache` is no longer
  needed after a pin bump. whisper.cpp has the same unguarded hazard; CI's cache key
  still covers it.
* **CI**: the composite action's cache key is still `--print-key`, so the cached prefix is
  the downloaded library (~27 MB) and a cold fetch is one ~16 MB download.

## Binding port

* `WithFormatterExtraX(true)` became one bitmask, `WithFormatterExtras(FormatterExtras)`;
  `buildSnapshot` and `writeScreen` now pass extras values, not option slices.
* `Terminal.SelectionFormat*` and `WithSelection*` are gone: `formatActivePlain` uses a
  formatter with `WithFormatterSelection`, plain, trimmed.
* Mode renames: `ModeDECCKM` → `ModeCursorKeys`, `ModeAnyMouse` → `ModeMouseEventAny`,
  `ModeSGRMouse` → `ModeMouseFormatSGR`, `ModeAltScreenSave` →
  `ModeAltScreenSaveCursorClearEnter`.
* **Behaviour change**: a new formatter's defaults changed. The 0.x options struct was
  zeroed (no trim, no extras); 1.0 starts with trim on and
  `FormatterExtrasDefault` (palette, cursor style, hyperlink). Left alone, every pass
  without explicit extras would emit the full 256-entry palette (~8 KiB), and the
  row-counting VT pass would lose its trailing blank rows. `formatTo` now starts every
  pass from `WithFormatterTrim(false)` and `FormatterExtrasNone`, so each pass emits only
  what its caller asks for, as before. The round-trip tests did not notice this (they
  compare replayed state, not bytes); `TestFormatToStartsFromNothing` fails without it.
  `TestSnapshotPaletteOnlyWhenChanged` pins that snapshots carry the palette only after
  OSC 4.
* Binary size: `bin/code-foundry` 63,588,722 bytes on main (zig build) vs 64,189,746 on
  this branch (+601 KB, +0.9%), both from the same `go build` without `-trimpath`. The
  archive is 27 MB universal against the zig build's 11 MB arm64-only; the linker takes
  only the arm64 slice.

## Worktree demonstrations

All in temporary worktrees and cache roots (`GHOSTTY_VT_CACHE`, `GOCACHE`) under a
scratch directory, removed afterwards; a `curl` wrapper on `PATH` logged or refused each
download.

1. **One download per machine.** A fresh worktree on a warm cache, with `curl` replaced by
   one that refuses and `https_proxy` pointing at a closed port: `make ghostty-vt` exited
   0 with zero curl calls. Control: the same on an empty cache tried to download and
   failed. Held.
2. **Concurrent cold installs.** Two worktrees ran `make ghostty-vt` at once on an empty
   cache (downloads slowed by 2 s), with a loop polling the prefix ~600,000 times: one
   curl call, both exited 0, the poller never saw a prefix without its `.pc` or with a
   short archive, and the archive and headers were byte-identical to the release. Three
   installers at once: all ended within 8 ms of each other after the one download, so
   two waited on the lock. A planted stale temporary directory and a prefix without its
   `.pc` were removed and the next run installed cleanly. Held.
3. **Old and new coexist.** The real cache's zig-built entry
   (`ghostty-vt-34f39002…-zig-0.16.0-arm64`) had the same mtime, size and sha256 for all
   its files before and after; a worktree on main kept building and testing against it
   (below). Held.
4. **Shared Go build cache.** One fresh `GOCACHE`, no `go clean`, the real per-user
   cache, worktrees run in order main → branch → main → branch (second worktree) →
   branch → main, each `go test ./internal/store/terminal/` then `go build
   ./cmd/code-foundry`: every run passed, and every binary linked its own library
   (`_ghostty_formatter_set`, 1.0.1-only, present exactly on the branch's binaries;
   `_ghostty_terminal_selection_format_alloc`, old-only, exactly on main's). Held.
   To show the `CGO_CPPFLAGS` guard matters, one branch worktree was pinned to 1.0.0 with
   the same bindings and the two alternated on a shared `GOCACHE`, printing
   `GetBuildInfo().VersionString` from a test: with the guard each linked its own
   (1.0.1, 1.0.0, 1.0.1, 1.0.0); with `CGO_CPPFLAGS=` every run linked 1.0.1, including
   the worktree pinned to 1.0.0, silently and with its tests passing.

## End to end

`make drive DAEMON=dev` (real daemon, scratch home) and the GUI in WebKit: a free
terminal, coloured output and `seq 1 40`, then `vim` with typed text; page reload
(reattach) on the alternate screen showed vim; the window resized to 900×560 and reloaded
showed vim redrawn at the new size; `:q!` restored the primary screen with the prompt and
`$COLUMNS x $LINES` = `87 x 25`; a further reload showed the same screen, and scrolling up
showed the red line and the whole `seq` in scrollback.

## Open

* Done since: `scripts/THIRD-PARTY-NOTICES.txt` had no libghostty-vt section, and never
  had one. It has one now, see `libghostty-vt-notices.md`.
