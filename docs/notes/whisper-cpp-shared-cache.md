# whisper.cpp shared cache: pin guard and atomic build

Two gaps left over from the libghostty-vt move (`libghostty-vt-prebuilt.md`), both about
many worktrees sharing one machine.

## The Go build cache did not know the whisper.cpp pin

Go keys a cgo package on its `CGO_*` flags, not on what pkg-config prints, so the
compiled `internal/dictate/whisper` package, link path included, is reused by any
worktree whose flags match, whatever library its own pin points at. Only CI was covered,
by keying its Go cache on `scripts/whisper-cpp.sh`.

`CGO_CPPFLAGS` now carries `-DCODE_FOUNDRY_WHISPER_CPP=<key>` beside the libghostty-vt
define, where `<key>` is `scripts/whisper-cpp.sh --print-key` (tag, arch, hash of the
cmake flags). Nothing reads the define; it only makes each pin's cache entries distinct,
so a pin bump needs no `go clean -cache`.

Shown with one fresh `GOCACHE` and `go build -x ./cmd/code-foundry-dictate`, counting the
cgo steps for the whisper package:

| Run | pkg-config prefix | `CGO_CPPFLAGS` | whisper package |
|---|---|---|---|
| 1 | a scratch build | `-DX=1` | compiled |
| 2 | the real cache | `-DX=1` | reused from run 1, with run 1's link path |
| 3 | the real cache | `-DX=2` | compiled |
| 4 | the real cache | `-DX=2` | reused |

Run 2 is the hazard, runs 3 and 4 are the guard. The first build after this change
recompiles every cgo package once, since the flags changed for all of them.

## The build wrote into the final prefix with no lock

The script used to `rm -rf` the prefix and have cmake install straight into it, with the
`.pc` written last. Two worktrees on a cold cache would both build, each deleting the
other's files, and a reader could find a prefix with some of its libraries.

Now, like `scripts/ghostty-vt.sh`:

* The script re-runs itself under `lockf -k <cache>/<key>.lock`. One build per machine;
  a waiter finds the `.pc` when it gets the lock and exits. The kernel frees the lock if
  the holder dies.
* Source, build tree and a staged prefix live in `<cache>/<key>/.tmp.XXXXXX`. cmake is
  configured with the final prefix (so anything it bakes in is right) and installed with
  `cmake --install --prefix <staged>`. The `.pc` is written into the staged prefix,
  naming the final one, then one `mv` puts it in place.
* A leftover `.tmp.*` or a prefix without its `.pc` can only come from a killed build of
  this key, and is removed under the lock before building.

The prefix path and the key are unchanged (`<cache>/<key>/whisper-cpp`), so existing
caches, local and CI, are used as they are and nothing rebuilds.

Tried against a scratch `WHISPER_CPP_CACHE`:

* Three runs started together on an empty cache: one fetched and built, two printed
  nothing, all exited 0. A loop checked the prefix 2.7 million times and never saw it
  without its `.pc` or `libwhisper.a`. The installed file list equals the real cache's.
* Warm cache with `git` and `cmake` replaced by commands that fail: exit 0, nothing run.
* A planted `.tmp.STALE` and a prefix with its `.pc` deleted: both removed, rebuilt.
* A build killed part-way: no prefix, one `.tmp.*` left, gone on the next run.

## Gotcha

A worktree still on the old script takes no lock. If it starts a cold build while a new
one is installing, it can still delete the prefix under it. That needs a cold cache for
this key and goes away as worktrees move past this change.
