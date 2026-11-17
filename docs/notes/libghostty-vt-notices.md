# Third-party notices for libghostty-vt

`code-foundry` statically links libghostty-vt, and the release tarball shipped no licence
text for it or for what it bundles. `scripts/THIRD-PARTY-NOTICES.txt` now has a
`code-foundry` section for libghostty-vt 1.0.1 and one for the code compiled into it.

## What is listed and why

The 1.0.1 source tarball has `deps/libghostty-vt-third-party.json`, upstream's list of
every third-party project in the build. Each entry has an SPDX licence and a `use`:
`linked` (compiled into the library) or `build` (runs during the build, ships nothing).
The notices cover every `linked` entry and nothing else; `aro` is `build` and is left out.

| Project | Licence offered | Shipped under |
|---|---|---|
| libghostty-vt 1.0.1 | MIT | MIT |
| simdutf 9.0.0 | Apache-2.0 OR MIT | MIT |
| Wuffs 0.4.0-alpha.10 | Apache-2.0 OR MIT | MIT |
| Highway 1.2.0 | Apache-2.0 OR BSD-3-Clause | BSD-3-Clause |
| uucode 0.2.0 | MIT AND Unicode-3.0 | both |
| translate-c 2.0.0 | MIT | MIT |

* Where there is a choice, the short permissive licence is taken, so the file carries no
  Apache-2.0 text and none of its NOTICE obligations.
* uucode's `LICENSE.md` points at two more files, for the Unicode data and for Bjoern
  Hoehrmann's UTF-8 decoder. Both are included. They are not in the dependency tarball
  (it has the package without its `licenses/` directory), so they were taken from the
  uucode repository at the commit the manifest pins.
* Zig's standard library and compiler_rt are compiled into the library too (the archive
  defines `___udivti3` and friends) and the manifest does not list them. Zig's licence is
  the same text and copyright line as translate-c's ("Copyright (c) Zig contributors"), so
  one copy covers both and the notice says so.

## Where the texts came from

All copied byte for byte, none retyped:

* `libghostty-vt-1.0.1.tar.gz`: `LICENSE`, `pkg/simdutf/vendor/LICENSE-MIT`.
* `libghostty-vt-1.0.1-deps.tar.gz`, in the directory named by each entry's `hash`:
  Wuffs `LICENSE-MIT`, Highway `LICENSE-BSD3`, uucode `LICENSE.md`, translate-c `LICENSE`.
* github.com/jacobsandlund/uucode at `1fb73433`: `licenses/LICENSE_unicode`,
  `licenses/LICENSE_Bjoern_Hoehrmann`.

Both tarballs are at `https://release.files.ghostty.org/libghostty-vt/1.0.1/`, with their
sha256 in `SHA256SUMS` there.

## On a version bump

`scripts/ghostty-vt.sh` says so beside the pin: read the new release's manifest, and add,
drop or re-version entries to match its `linked` set. The file now has a non-ASCII
character (the copyright sign in the Unicode licence); it is UTF-8.

## Still not covered

The file lists what is linked from C. The Go modules compiled into `code-foundry` and
`code-foundry-dictate` (the libghostty bindings among them) have no entries. That section
should be generated from `go.mod`, not written by hand, and is its own change.
