# Vendored libghostty-vt

Status: done (2026-10-09). `make build` and `make check` need only Go, the Xcode Command
Line Tools, pkg-config, and (for `check`) Node/pnpm. No zig, no ghostty checkout, no
network access beyond the Go module proxy.

## Why

Phase 1a built libghostty-vt from source on every fresh clone and worktree
(`scripts/ghostty-vt.sh`: download zig 0.16.0, shallow-fetch ghostty, `zig build`). That
had three costs:

* **codeberg.org.** zig fetches ghostty's build dependencies, some of which are hosted
  on codeberg. It is blocked on Alex's work laptop, so a clone there could not build at all.
* **zig.** A ~400 MB toolchain download per clone, pinned to one version.
* **Time.** About a minute cold for every new worktree, and agent worktrees had to copy
  `third_party/` in and rewrite the `.pc` prefix by hand (repo-detail-cache.md).

The library changes only when the Go bindings (`go.mitchellh.com/libghostty`) are bumped,
so it is built once and committed.

## Layout

```
third_party/libghostty-vt/
  lib/libghostty-vt.a      static, darwin-arm64, strip -S (committed)
  include/ghostty/**       headers, verbatim from the zig install prefix (committed)
  MANIFEST                 provenance, see below (committed)
  README.md                what this is, how to regenerate (committed)
  share/pkgconfig/         libghostty-vt-static.pc, written by `make ghostty-vt` (ignored)
third_party/build/         scratch for `make ghostty-vt-rebuild`: zig, ghostty-src, prefix (ignored)
```

The .dylib files and zig's own `.pc` files are not vendored. We link statically, and the
`.pc` must carry the checkout's absolute path.

## MANIFEST

`key: value`, one per line:

| Key | Meaning |
|---|---|
| `ghostty_repo`, `ghostty_commit` | source the library was built from |
| `go_bindings_version` | `go.mitchellh.com/libghostty` version in go.mod at build time |
| `zig_version`, `optimize` | toolchain and `-Doptimize` mode |
| `arch` | `lipo -archs` of the .a (`arm64`) |
| `lib_version` | `Version:` of zig's generated .pc (`0.1.0-dev`), reused in ours |
| `built` | UTC timestamp of the rebuild |
| `stripped` | whether `strip -S` was applied |
| `sha256` | of `lib/libghostty-vt.a` as committed |

## Make targets

* `make ghostty-vt` (a dependency of `build`, `go-check`, `package`) runs every time and is
  cheap: it checks the .a's sha256 against MANIFEST, checks that go.mod's
  `go.mitchellh.com/libghostty` version equals `go_bindings_version`, and writes
  `share/pkgconfig/libghostty-vt-static.pc` with `prefix=$(CURDIR)/third_party/libghostty-vt`
  (via a temp file and `mv`). Rewriting every run means a moved or freshly cloned checkout
  is always right. The content is the same each time, so Go's build cache still hits.
* `make ghostty-vt-rebuild` runs `scripts/ghostty-vt.sh`, then `make ghostty-vt`. The
  script refuses to run anywhere but darwin-arm64, downloads and verifies zig (pinned
  sha256, cross-checked against ziglang.org's index.json), fetches ghostty at the pinned
  commit, builds into `third_party/build/ghostty-vt`, copies the .a (stripped) and
  `include/` into the vendored dir, and rewrites MANIFEST. It always rebuilds.
* `make clean` removes the generated `share/` and `third_party/build/`, never the vendored files.

Outside make (plain `go test`, gopls), run `make ghostty-vt` once and export:

```sh
export PKG_CONFIG_PATH=$PWD/third_party/libghostty-vt/share/pkgconfig
export CGO_CFLAGS=-mmacosx-version-min=13.0 CGO_LDFLAGS=-mmacosx-version-min=13.0
```

## Bumping

The bindings track a specific ghostty commit, so these move together, in one commit:

1. `go get go.mitchellh.com/libghostty@<version>` and `go mod tidy`.
2. Set `GHOSTTY_COMMIT` in `scripts/ghostty-vt.sh` to the commit the bindings target (and
   `ZIG_VERSION`/`ZIG_SHA256_aarch64` if ghostty's `minimum_zig_version` changed).
3. `make ghostty-vt-rebuild` on a machine that can reach codeberg.org.
4. `make check`, then commit go.mod, go.sum, the script, and `third_party/libghostty-vt`.

If step 3 is skipped, `make ghostty-vt` fails with a message naming both versions.

## Strip decision

| | bytes |
|---|---|
| zig output (`ReleaseFast`, with DWARF) | 11,143,920 |
| `strip -S` (debug info only) | 2,589,544 (vendored) |
| `strip -x` (also local symbols) | 2,480,968 |
| `bin/code-foundry` linked against unstripped | 31,055,330 |
| `bin/code-foundry` linked against `strip -S` | 31,055,506 |

`strip -S` cuts the library by 77%. The Go binary is the same size either way (the Go
linker does not carry the C DWARF over), so stripping costs nothing at runtime.
`-x` saves only another 100 KB and drops local symbols, so `-S` it is.
`go test -race ./internal/store/terminal/...` passed against the stripped library. All
938 exported text symbols are still there.

The committed tree is 3.08 MB (the .a, 493 KB of headers, MANIFEST, README); about 1.1 MB
gzip-compressed.

## Gotchas

* **Reproducible only when stripped, and only with `ZERO_AR_DATE=1`.** A rebuild from the
  same pins produced byte-identical archive members after `strip -S`. The one difference
  was the `__.SYMDEF SORTED` header mtime, which `strip` stamps when it rewrites the
  archive. `ZERO_AR_DATE=1 strip -S` zeroes it, so the same pins give the same sha256
  (`0fd91b31…`). The unstripped archive differs between builds (11,143,920 vs 11,145,984
  bytes) because DWARF embeds the absolute build path, which also leaked
  `/Users/alex/...` paths into the library. The stripped one has none.
* **Archive members have mode 000.** zig writes them that way. Linking does not care, but
  `ar x` gives unreadable files; `chmod` them before comparing.
* **pkg-config is not part of the Xcode CLT.** The bindings use `#cgo pkg-config`, so it
  is still needed (`brew install pkgconf`; GitHub's macOS runners have it).
* The vendored library was rebuilt by the new script from ghostty 34f39002 with zig
  0.16.0 (zig cache warm, seeded from the existing build) rather than copied from the
  2026-10-08 build. Its members are byte-identical to that build's after stripping, and
  only the deterministic archive header differs.

## Verified

* Fresh clone: `git clone` of the branch into `/tmp/cf-fresh-clone`, then `make build`
  with no `third_party/build` and no `share/`. It produced a working binary and a `.pc`
  with `prefix=/private/tmp/cf-fresh-clone/third_party/libghostty-vt`.
  `git clean -ndx third_party` in the worktree lists only `third_party/build/` and
  `third_party/libghostty-vt/share/`.
* `make ghostty-vt` with a tampered MANIFEST sha256 and with a mismatched
  `go_bindings_version`: both fail with the messages above.
* `make ghostty-vt-rebuild`: ~36 s with a warm zig cache. It rewrote the .a and MANIFEST.
* `make check` green. `go test -race ./internal/store/terminal/... ./internal/daemon/...` ok.
* `make gui-build` ok.
* `./bin/code-foundry version`: `code-foundry dev go1.26.8`. The daemon was started with
  `CODE_FOUNDRY_HOME=/tmp/cf-vendor-home`. `status` answered, `terminal.new --cwd /tmp`
  started a zsh through the libghostty-vt actor, and SIGTERM stopped it cleanly
  ("daemon stopped").
* `actionlint` clean on `ci.yml` and `release.yml`. The cache steps and `make ghostty-vt`
  are gone, because `make check`/`make package` run it themselves.
