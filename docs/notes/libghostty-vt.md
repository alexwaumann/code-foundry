# libghostty-vt Go bindings — verified findings (2026-10-08)

Verified by actually building and running on macOS 27 arm64 with Command Line Tools only.

## Versions
- Module: `go.mitchellh.com/libghostty v0.0.0-20261007030428-8812ad0e0f79`. Pin this exact pseudo-version.
- It pins ghostty commit `34f39002c6e3974b54e6a6d400bd83777c5ea558` in its `CMakeLists.txt`. Build the C lib from that commit, not from main.
- Requires **Go 1.26** (`go.mod` says `go 1.26.0`). Requires **zig 0.16.0** (ghostty `minimum_zig_version`). Brew's zig 0.17 is untested; download 0.16.0 from ziglang.org and verify the checksum.
- Do not use `github.com/ehsanul/libghostty-vt-static`: it is a stale patched copy (May 2026 API), single maintainer, and the API has drifted (`AppendText`, `NextDirty`, `Terminal.Mode`, `WithMaxScrollbackLines` do not exist there).

## Build recipe that worked (~48s)
```sh
curl -LO https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz && tar xf zig-aarch64-macos-0.16.0.tar.xz
git clone https://github.com/ghostty-org/ghostty && cd ghostty && git checkout 34f39002c6e3974b54e6a6d400bd83777c5ea558
../zig-aarch64-macos-0.16.0/zig build -Demit-lib-vt -Demit-xcframework=false -Doptimize=ReleaseFast --prefix <abs prefix>
# Go side
go get go.mitchellh.com/libghostty@v0.0.0-20261007030428-8812ad0e0f79
PKG_CONFIG_PATH=<abs prefix>/share/pkgconfig go build ./...
```
- The bindings use `#cgo pkg-config: --static libghostty-vt-static` and `-DGHOSTTY_STATIC`. Without the `.pc` on PKG_CONFIG_PATH: `Package 'libghostty-vt-static' not found`.
- The generated `.pc` hardcodes an absolute `prefix=`; the prefix cannot be moved after building. Build into `third_party/ghostty-vt` under the repo (gitignored) and set PKG_CONFIG_PATH in the Makefile.
- `-Demit-xcframework=false` is required without full Xcode.
- Static result links only system libs. Binary +~8 MB.

## API surface (package `libghostty`)
- Create: `NewTerminal(WithSize(cols, rows), WithMaxScrollbackLines(n), WithWritePty(fn))`; `term.Close()`.
- Feed: `term.VTWrite([]byte)`; `*Terminal` is an `io.Writer`.
- State: `Cols, Rows, CursorX, CursorY, CursorVisible, Title, Pwd, ActiveScreen() (ScreenPrimary|ScreenAlternate), Mode(ModeAltScreenSave)`.
- Read screen (efficient, dirty-tracked): `NewRenderState()`, `rs.Update(term)`, `rs.RowIterator(ri)`, `ri.Next()`, `ri.AppendText(dst, rc)`, `ri.Cells(rc)`, `rc.Style()`, `rc.FgColor()/BgColor()` (resolved RGB), `rs.CursorViewportX/Y`, `rs.Dirty()`, `ri.NextDirty()`, `rs.Clean()`.
- Read screen (whole dump incl. scrollback): `NewFormatter(term, WithFormatterFormat(FormatterFormatPlain|VT|HTML))` → `FormatString()`. **`FormatterFormatVT` is the snapshot serializer for Attach.**
- Point access: `term.GridRef(Point{Tag: PointTagActive|Viewport|Screen|History, X, Y})`.
- Resize: `term.Resize(cols, rows, cellWpx, cellHpx)`; `SetResizePullScrollback`.
- Scrollback: `ScrollbackRows()`, `Scrollbar()`, `ScrollViewport*`.
- Free with `Close()` on Terminal, RenderState, RowIterator, RowCells, Formatter.

## Gotchas
- Terminal is not goroutine-safe and not reentrant. One owning goroutine; serialize everything.
- Effect callbacks run synchronously inside `VTWrite` and must not call `VTWrite`.
- `GridRef`, `Selection`, iterators are invalidated by the next mutating call or `Update`. Copy first.
- CUP sequences are 1-based; API coordinates 0-based.
- `NextDirty` also reports the row the cursor left.
- No API stability promise. Expect renames when bumping the pseudo-version.

Working demo: `libghostty-vt-demo.go.txt` next to this file.
