# ghostty-vt shared cache

> Since 2026-11-17 the cache holds the official prebuilt library, not a zig build: the
> entry is `<cache>/libghostty-vt-<version>-<sha8>/` with `lib/pkgconfig`, installed under
> a per-key lock and renamed into place. The per-user cache, `GHOSTTY_VT_CACHE` and
> `--print-prefix` below still hold; the zig, source and `<key>/ghostty-vt` parts are
> history. See `libghostty-vt-prebuilt.md`.

`scripts/ghostty-vt.sh` used to build libghostty-vt into `third_party/` of whichever
checkout ran it, and left zig (403 MB) and the ghostty source (381 MB) there forever. With
90+ worktrees that was ~70 GB of identical, gitignored bytes, for a 13 MB library.

## Decisions

* One per-user cache, `~/Library/Caches/code-foundry/ghostty-vt/<key>/ghostty-vt`, where
  `<key>` is the existing `--print-key` value (ghostty commit + zig version + arch).
  Every checkout and worktree with the same pins shares the build. A pin bump gets a new
  key, so stale builds never collide. `GHOSTTY_VT_CACHE` overrides the root.
* The Makefile reads the prefix with a new `--print-prefix` flag instead of computing a
  path of its own; the script is the only place that knows the layout.
* zig and the source are downloaded into `<key>/build/` and deleted after a successful
  build. A rebuild after a pin bump redownloads (~1 min). Not worth 800 MB per user.
* CI caches the printed prefix path rather than `third_party/ghostty-vt`; the key is
  unchanged. No symlinks anywhere: the `.pc` files hardcode the absolute prefix, and a
  stable per-user path is exactly what they want.
* `/third_party/` left `.gitignore`. Existing checkouts still have the old directory;
  delete it by hand (`rm -rf third_party`) once the branch is merged everywhere.

## Gotcha

Go does not key its build cache on the pkg-config link path of a cgo package (the CI
action already works around this by keying the Go cache on the script). After switching
the prefix, `make build` reused a cgo object compiled against another worktree's old
`third_party` path and failed at link time. `go clean -cache` once fixes it. With one
shared prefix the hazard is gone for good: every worktree now links the same path.
(Not quite: two pins sharing one Go cache still collide when the bindings do not change
with the library. The Makefile now names the pin in `CGO_CPPFLAGS`;
`libghostty-vt-prebuilt.md` has the demonstration.)
