# File search 3: ripgrep ships with the release

Text search across a thread's files runs ripgrep. A user should not have to install
anything (no Homebrew assumed), so the release carries it as `code-foundry-rg`, beside
the daemon, the way it carries the dictation engine. This step adds only the binary,
its packaging and a Go seam to find it; the search RPC and the GUI come later.

## What ships

| What | Value |
| --- | --- |
| Version | ripgrep **15.2.0** (2026-07-15, the latest release on 2026-11-14) |
| Source | the official release asset `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz` from github.com/BurntSushi/ripgrep |
| Archive sha256 | `3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4` (the release's own `.sha256` asset, GitHub's asset digest and a local download agree) |
| Binary | 4.0 MB, arm64, minos 11.0, links only libSystem and libiconv, PCRE2 10.45 statically linked (`--version`: `ripgrep 15.2.0 (rev e89fff89ac)`, `+pcre2`, JIT available) |
| Architectures | darwin arm64 only: the release is `code-foundry-darwin-arm64.tar.gz` and `install.sh` refuses anything else |
| Shipped as | `code-foundry-rg` (cannot collide with a user's `rg`), ad-hoc re-signed |
| Licences | `THIRD-PARTY-NOTICES.txt` in the tarball and app dir, committed as `scripts/THIRD-PARTY-NOTICES.txt` |

## Build and release

* `scripts/ripgrep.sh` holds the pins (`RG_VERSION`, `RG_TARGET`, `RG_SHA256`). It
  downloads the archive with curl (https only, retries), checks the sha256 **before**
  unpacking, extracts only `rg`, runs `rg --version` against the pin and moves the binary
  into `~/Library/Caches/code-foundry/ripgrep/<key>/rg` (`RIPGREP_CACHE` overrides the
  root). Key = `ripgrep-15.2.0-aarch64-apple-darwin-3750b2e9`. Idempotent: no network once
  the binary is there. `--print-key`, `--print-prefix`, `--print-bin`, `--print-version`.
* `make ripgrep`; `make build` depends on it and installs the cached binary as
  `bin/code-foundry-rg`; `make package` too.
* CI: the `setup-go-ghostty` composite action gained the same three steps as whisper.cpp
  (key from `--print-key`, `actions/cache` on the prefix, `make ripgrep`). The release job
  uses that action, so a release reuses the cached binary; a cold fetch is one 1.7 MB
  download from github.com. The Go build cache key does not need the script: nothing is
  linked.
* `scripts/package.sh` copies `code-foundry-rg` and the notices, clears xattrs, re-signs
  `code-foundry-rg` ad hoc (`codesign --force --sign -`, then `--verify --strict`), checks
  its `--version` names the pinned version, and the tarball listing check now expects six
  names: `Code Foundry`, `THIRD-PARTY-NOTICES.txt`, `VERSION`, `code-foundry`,
  `code-foundry-dictate`, `code-foundry-rg`. The tarball grew by about 1.7 MB compressed.
* `scripts/install.sh` installs whatever the tarball holds (unchanged). `code-foundry-rg`
  is optional like `code-foundry-dictate` (releases before it lack it) and, when present,
  must be an executable file. Tests: `TestInstallHelpers` (both helpers, before ripgrep,
  before dictation, and a helper the installer has never heard of) and a rejected
  non-executable `code-foundry-rg`.

## Why the official binary, not a source build

The precedent (whisper.cpp) builds from source because it is linked into our own binary
with our flags. ripgrep is a standalone executable whose official release is exactly the
artifact we want: built by its maintainer's CI with PCRE2 and SIMD, macOS 11+, no
dependencies beyond the OS. Building it ourselves would put a Rust toolchain on every dev
machine and runner and produce the same thing less reproducibly. The sha256 pin makes the
download as fixed as a commit pin.

## How the daemon finds it (`internal/ripgrep`)

```go
bin, err := ripgrep.Find()      // ripgrep.Binary{Path, Source}; err wraps ErrMissing
v, err := bin.Check(ctx)        // "15.2.0"; err wraps ErrBroken (does not run / not ripgrep)
```

Order: `$CODE_FOUNDRY_RG_BIN` (explicit; if it is not an executable that is an error, no
fallback) → `code-foundry-rg` beside the running executable, symlinks resolved (a release
install, or `./bin` after `make build` for a dev daemon, which is how the dictation engine
is found too) → only when the running executable is **not** a release install (no
`VERSION` beside it: `go test`, `go run`): `code-foundry-rg`, then `rg`, on PATH. An
install that lost its ripgrep reports `ErrMissing` instead of quietly running whatever rg
the user has. `ErrMissing` and `ErrBroken` read as sentences for the user ("text search is
unavailable: … update or reinstall Code Foundry to restore it"); the detail in
parentheses names the path. `Check` clears `RIPGREP_CONFIG_PATH` so a user's rg config
cannot change what runs; the search RPC should do the same. `ripgrep.Version` is the
pin; `TestVersionMatchesFetchScript` keeps it equal to `RG_VERSION`. A dev fallback may be
any version: `Check` returns it and the caller decides. `ripgreptest.Fake` writes a stand-in
executable.

### Health

There is no general place where the daemon reports helpers' health: the dictation
engine's absence surfaces only inside dictation's own state when it fails to launch. So no
new UI: at startup the daemon finds and checks ripgrep off the startup path and logs it
once (`internal/daemon/ripgrep.go`): debug `text search engine path=… source=bundled
version=15.2.0` when fine, a warning with the user-readable error when missing, broken or
(bundled) the wrong version. The search RPC returns the same errors to the GUI.

## Updater analysis

The in-app updater (`internal/store/update.ScriptInstaller`, unchanged since at least
v0.21.7) runs the `install.sh` **embedded in the running, old binary**: `--stage-only`
then `--apply-staged`. So what matters is what the released installers do with a tarball
holding a file they do not know. Every released installer since v0.3.0 (the first tarball
release; v0.1–v0.2 were `.app` zips and could never take a tarball) unpacks the whole
archive into a sibling directory, checks only the files it knows (`code-foundry`,
`Code Foundry`, `VERSION`, and from dictation on, `code-foundry-dictate` if present) and
swaps the whole directory in with renames. Nothing lists or filters the archive. So an
update from any released version lands `code-foundry-rg` and `THIRD-PARTY-NOTICES.txt`.

Checked by running the installers from tags v0.3.0, v0.15.0 (full install; no
`--stage-only` then), v0.21.7 and v0.22.0-tip.11 (`--stage-only` then `--apply-staged`,
the updater's exact flags) against this branch's tarball over an older install: each left
all six files, `code-foundry-rg --version` ran, no `app.new`/`app.old` left over. A
downgrade to an older release removes ripgrep with the rest, and that older daemon never
looks for it. If ripgrep is missing anyway (a hand-copied install), the daemon starts
normally and text search reports `ErrMissing` until the next update.

## Verified

* `make package VERSION=v0.0.1-rg.1`: six-entry tarball, `code-foundry-rg` re-signed
  (`flags=0x2(adhoc)`, verifies strictly).
* `dist/install.sh` from a local release dir into a scratch `HOME`/`CODE_FOUNDRY_HOME`:
  installed, `code-foundry-rg --version` → `ripgrep 15.2.0`.
* The installed daemon (`daemon --dev`, scratch home) logged `text search engine
  … source=bundled version=15.2.0`; with `code-foundry-rg` moved away it started anyway
  and logged the `ErrMissing` warning.

## Gotchas

* A scratch `CODE_FOUNDRY_HOME` must be short: the daemon socket path is limited to 103
  bytes, and a deep scratch directory fails before the daemon starts.
* The cached `rg` gets `com.apple.provenance`; `package.sh`'s `xattr -c` clears it. curl
  sets no quarantine.
* TCC: ripgrep is a child of the daemon, so macOS judges the daemon's responsible process
  (as for git), never `code-foundry-rg`; it keeps the default (cdhash) ad-hoc requirement
  like the dictation engine.
* The whisper.cpp MIT notice is not shipped anywhere yet (it is statically linked into
  `code-foundry-dictate`); `THIRD-PARTY-NOTICES.txt` is where it belongs. Not done here.
* `make package` (its `wails3 build`) leaves `gui/build/darwin/icons.icns` modified and
  `gui/build/darwin/Assets.car` untracked. Not from this change; do not commit them.
