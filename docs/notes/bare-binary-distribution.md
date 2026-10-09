# Bare-binary distribution

Status: done on branch `cf/bare-binary`. `make check` is green. The full install →
launch → update → relaunch → daemon restart → CLI update cycle was run on this machine
against a local release source, with an isolated `CODE_FOUNDRY_HOME` (see "Verified").

Replaces the bundle half of [phase3d-packaging.md](phase3d-packaging.md). Releases,
versioning, the update state machine, the commands and the GUI surfaces are unchanged.

## Why

Managed Macs block unsigned `.app` bundles. Alex's coworkers' MDM has an "Any macOS
Bundle" rule. The same MDM allows bare Mach-O executables, and the Wails GUI runs fine as
one (checked before this change with `make gui-bin`). So the app is no longer a bundle.
There is one layout, with no bundle path kept alongside it.

## Layout

```
~/.code-foundry/app/          $CODE_FOUNDRY_HOME/app; installer flag --app-dir
  code-foundry                daemon + CLI (ad-hoc signed)
  Code Foundry                Wails GUI (ad-hoc signed; renamed from CodeFoundry, see "Icon and name")
  VERSION                     the tag, e.g. "v0.2.0\n"; what makes a dir an install
~/.local/bin/code-foundry  -> ~/.code-foundry/app/code-foundry     (--bin-dir)
```

To uninstall, run `rm -rf ~/.code-foundry/app ~/.local/bin/code-foundry`. The rest of
`~/.code-foundry` is daemon state.

`paths.Paths.App()` is the default (`<home>/app`). The `update` package has
`RunningDir`, `IsInstall`, `RunningInstall`, `InstalledVersion(dir)` and
`DefaultAppDir()` (`$CODE_FOUNDRY_APP_DIR`, else `<home>/app`) in place of `BundleOf` and
the Info.plist reader.

## Release assets

`make package VERSION=vX.Y.Z` (`scripts/package.sh`) writes `dist/`:

| Asset | What |
|---|---|
| `code-foundry-darwin-arm64.tar.gz` | `code-foundry`, `CodeFoundry` and `VERSION` at the top level, with no directory prefix (about 22 MB) |
| `install.sh` | the installer, with `DEFAULT_REPO` set to the release repo |
| `checksums.txt` | sha256 of the two above |

The zip (`CodeFoundry-darwin-arm64.zip`) and the standalone CLI asset are gone.
`scripts/release.sh` uploads these three for both `gh release create` and `--local DIR`.

### What package.sh does

1. `make build`, then `wails3 build EXTRA_LDFLAGS=<version -X flags>`. Both binaries
   get the same `Version` and `ReleaseRepo`.
2. Stages the three files.
3. Runs `codesign --force --sign -` on both binaries, then `codesign --verify --strict`.
4. Refuses to finish unless all three agree:
   * `code-foundry version` prints `code-foundry vX.Y.Z …`
   * `CodeFoundry --version` prints `CodeFoundry vX.Y.Z`
   * `VERSION` holds `vX.Y.Z`
5. Runs `COPYFILE_DISABLE=1 tar -czf`, then checks that the listing is exactly the three
   names.

No Info.plist, `ditto`, `wails3 package` or `create:app:bundle` is involved any more.

### Build changes

* **`make gui-build`** is now `wails3 build`. It produces the bare `gui/bin/CodeFoundry`
  and removes a stale `gui/bin/CodeFoundry.app`. The separate `gui-bin` target is gone.
* **Taskfile.** `gui/build/darwin/Taskfile.yml` no longer has our bundle additions
  (copying the CLI in, stamping Info.plist). The rest of the Wails template is untouched
  (`package`, `create:app:bundle`, `run`, dmg, sign); we just do not call it.
  `EXTRA_LDFLAGS` stays.

## Installer (`scripts/install.sh`, embedded via `scripts/embed.go`)

* **Download.** Same sources as before: gh (`gh release download --pattern <tarball>
  --pattern checksums.txt`) or `CODE_FOUNDRY_RELEASE_DIR`.
* **Verify.** Checks the sha256, then requires the tarball's `VERSION` to equal the tag.
* **App dir.** Defaults to `${CODE_FOUNDRY_APP_DIR:-${CODE_FOUNDRY_HOME:-$HOME/.code-foundry}/app}`
  (`--app-dir`). It is made absolute and stripped of trailing slashes.
* **Existing install.** The installed version is the first line of its `VERSION` file.
* **Swap.**
  1. Unpacks with `/usr/bin/tar` into `<app dir>.new`.
  2. Checks that both executables and `VERSION` are present.
  3. Runs `xattr -dr com.apple.quarantine` on the staging dir.
  4. Moves `<app dir>` to `<app dir>.old`, then `.new` to `<app dir>`.
  5. If the second move fails, the old dir is restored. On success the old dir is
     removed (EXIT trap).
* **Interrupted swap.** The EXIT trap also moves `.old` back if it fires between the two
  renames. A run that starts with no app dir but a `.old` that has `VERSION` restores it
  first.
* **Foreign directories.** The installer refuses to replace an existing non-empty
  directory, or a file, that has no `VERSION`: "not a Code Foundry install". Without this
  check, `--app-dir ~/.local/bin` would wipe that directory.
* **New `--skip-link`.** It leaves `<bin dir>/code-foundry` alone.
  * The in-app updater passes `--yes --skip-path --skip-link --version <tag> --app-dir
    <dir of the running daemon>`.
  * `code-foundry update` passes `--skip-link --skip-path --app-dir <its install>` when it
    runs from an install.
  * The first install already made the link and the PATH line. An update of a side install
    (another `CODE_FOUNDRY_HOME`) must not repoint the main link; verification caught
    exactly that.
* **Old bundle hint.** After installing, it prints a hint to remove an old
  `~/Applications/CodeFoundry.app` or `/Applications/CodeFoundry.app` if one exists.
* **Unchanged:** PATH setup, the prompts and no-TTY behavior, and bash 3.2.

`scripts/install_test.go` fixtures are tarballs. New cases:

* default app dir: `$HOME`, `CODE_FOUNDRY_HOME`, `CODE_FOUNDRY_APP_DIR`
* foreign app dir refused, and its contents untouched
* interrupted swap restored
* `--skip-link`
* a trailing slash on `--app-dir`
* no `app.new` or `app.old` left after an upgrade

## Updater (`internal/store/update`)

* **Install dir.** `DefaultOptions` reads `RunningDir()` once at start: the directory of
  the resolved `os.Executable()`. It installs there (`--app-dir`) and re-reads
  `VERSION` there for `InstalledVersion`.
  * That dir is not an install (a semver build in `./bin`): `InstalledVersion` is `""`.
  * An install attempt there is refused by the installer, so it never wipes `./bin`.
* **Unchanged:**
  * Dev builds (non-semver) still never check.
  * Installed and RestartRequired mean the same as before.
  * No API or GUI contract changed.
  * The mock and e2e are untouched.
  * `AppInfo` (Wails binding) dropped its unused `bundle` field.
* **Proto comment.** It now says "app directory" (`make gen`).

## Launch (`code-foundry gui`)

* **What it starts.** `guiBinary` picks `CodeFoundry` next to the CLI's resolved path.
  For a repo CLI (`./bin/code-foundry`) it falls back to `gui/bin/CodeFoundry`.
* **How.** It starts that executable directly:
  * `Setsid`, with stdio on /dev/null
  * the environment inherited, plus `CODE_FOUNDRY_BIN=<cli>`
  * it prints `started <path> (pid N)`
* **Removed:** `open`, `open --env` forwarding (`guiEnv`), `.app` handling and the
  `~/Applications` search. Inheritance replaces the forwarding, so
  `CODE_FOUNDRY_HOME`, `CODE_FOUNDRY_RELEASE_DIR` and `CODE_FOUNDRY_UPDATE_DELAY` reach
  the GUI and the daemon it starts.

## Relaunch (`gui/app.go`)

* **New mechanism.** `AppService.Relaunch` runs `/bin/sh -c 'while kill -0 <pid>; do
  sleep 0.1; done; exec <os.Executable()> <os.Args[1:]…>'`. It is detached (`Setsid`)
  and inherits the host's environment, then the host quits.
* **Environment.** The relaunched GUI keeps the adopted PATH and `CODE_FOUNDRY_BIN`.
* **Unchanged:**
  * The host's `watchRelaunch` (UpdateService.Watch over the socket, auto-starting the
    daemon on reconnect).
  * `daemonBinary()`, which prefers the sibling `code-foundry`.
  * `exportDaemonBinary()` setting `CODE_FOUNDRY_BIN` at startup.
* **`CodeFoundry --version`** prints the version and exits before Wails starts.
  `package.sh` uses it.

## Verified (this machine, 2026-10-09)

**Setup.**

* Everything ran with `CODE_FOUNDRY_HOME=/tmp/cf-bare-home`,
  `CODE_FOUNDRY_RELEASE_DIR=/tmp/cf-bare-rel` and `CODE_FOUNDRY_UPDATE_DELAY=3s`. A dev
  daemon was running on the real home the whole time and was not touched.
* The release dir was filled by `scripts/release.sh --local /tmp/cf-bare-rel v9.0.N`
  from real `make package` builds. The made-up versions v9.0.0 to v9.0.3 are never
  published.

**Steps.**

1. **Fresh install, no TTY.** `bash dist/install.sh --bin-dir /tmp/cf-bare-bin
   </dev/null`.
   * Installed `/tmp/cf-bare-home/app`, containing `code-foundry`, `CodeFoundry` and
     `VERSION` (`v9.0.0`).
   * The link printed `code-foundry v9.0.0 go1.26.8`.
   * Only `com.apple.provenance` was set, with no quarantine.
   * `codesign --verify --strict` passed on both binaries.
2. **`code-foundry gui`.**
   * Printed `started /private/tmp/cf-bare-home/app/CodeFoundry (pid 47111)`.
   * The process list showed `47115 47111 /private/tmp/cf-bare-home/app/code-foundry
     daemon`: the GUI auto-started the sibling.
   * The daemon's environment had `CODE_FOUNDRY_BIN=/private/tmp/cf-bare-home/app/code-foundry`
     and the HOME and RELEASE_DIR overrides, inherited without `open --env`.
   * The log showed `daemon started … v9.0.0`, then 3s later `update check … latest
     v9.0.0 state idle`.
3. **Daemon-driven update.** Published v9.0.1.
   * `app update check` said `v9.0.1 available`.
   * `commands` showed `app.update yes Update to v9.0.1`.
   * `app update` installed it in 0.17s. The output was `Code Foundry v9.0.0; v9.0.1
     installed; relaunch the app and restart the daemon to apply`.
   * The GUI (47111) and the daemon (47115) kept running.
   * Afterwards the app dir held `VERSION` v9.0.1, with no `app.new` or `app.old` left.
   * `~/.local/bin/code-foundry` was untouched (`--skip-link`).
4. **`app relaunch`.**
   * The GUI pid went 47111 → 47689.
   * lsof showed the new process's text inode as 69375144, which matches the on-disk
     `CodeFoundry`, whose `--version` printed `CodeFoundry v9.0.1`.
   * The env still carried HOME, BIN and RELEASE_DIR.
   * State: `v9.0.1 installed; daemon restart pending`.
   * The old daemon's text showed as `…/app.old/code-foundry`, a deleted file that keeps
     running.
5. **`daemon restart --yes`.**
   * The log went `shutting down` (17:18:07.64) → `daemon stopped` (08.68) → `daemon
     started pid 47759 v9.0.1` (09.66).
   * The new daemon's parent is the GUI (47689), started from the sibling binary.
   * `app version` said `Code Foundry v9.0.1; not checked yet`.
6. **Interactive `code-foundry update` under `expect`.**
   * v9.0.2 was installed with `app update`. Then v9.0.3 was published, and the v9.0.2
     CLI ran the update. Output:
     ```
     Updating Code Foundry v9.0.2 -> v9.0.3
     Replace Code Foundry v9.0.2 with v9.0.3? [Y/n] y
     ==> upgrading Code Foundry v9.0.2 -> v9.0.3
     …
     ==> installed /private/tmp/cf-bare-home/app
     ==> Code Foundry v9.0.3 is installed.
     Relaunch the app to use the new version (palette: Relaunch App).
     The daemon (pid 47759, v9.0.1) keeps running 0 session(s) on the old version until:
       code-foundry daemon restart
     ```
   * The running daemon switched to `v9.0.3 installed; relaunch the app and restart the
     daemon to apply`.
   * There was no link or PATH prompt, and no change to either.
7. **Cleanup.** Killed the test GUI and daemon and removed `/tmp/cf-bare-*`.

**Also checked.**

* `make package` with wails3 not on PATH: package.sh now adds wails3's directory itself.
* A failed `wails3 build` stops package.sh.

## Gotchas

* **`-trimpath` hides `-ldflags` from the build info.** `go version -m CodeFoundry` does
  not show the `-X` version, so package.sh asks `CodeFoundry --version`.
* **The Taskfile runs `wails3 tool …` by name.** Outside `make`, a missing wails3 failed
  the build with exit 127 and left the previous `gui/bin/CodeFoundry` in place. While
  testing that, it launched as a full GUI. package.sh now removes the old binary first and
  puts wails3's directory on PATH.
* **Swapping the directory under running processes is safe.**
  * They keep their (now deleted) executables.
  * On darwin, `os.Executable()` returns the path the process was started from, not where
    the file moved. So relaunch execs the new file at the same path, and a daemon that has
    already updated once updates again into the right directory. Steps 3 and 6 above
    ran two updates in one daemon's life.
* **tar propagates quarantine.** Extracting a quarantined `.tar.gz` with `/usr/bin/tar`
  quarantines the files (checked), so the installer still runs `xattr -dr`.
  `COPYFILE_DISABLE=1` keeps `._*` AppleDouble entries out of the tarball.
* **Updates must not relink.** Before `--skip-link`, the daemon's `app.update` of the
  isolated test install repointed the real `~/.local/bin/code-foundry` (the old installer
  did the same). The link was removed again; it had not existed before the test.
* **The one-liner edits `~/.zshrc` without `--skip-path`.** Here `~/.zshrc` is a symlink
  into the dotfiles repo. A verification install without `--skip-path` appended the
  marker and a `/tmp/cf-bare-bin` PATH line there. It was removed right away (exact
  three-line suffix). Use `--skip-path` for test installs.
* **WebKit storage follows the main bundle's id, else the executable name.** Without
  an Info.plist it moved from the bundle id to `~/Library/WebKit/CodeFoundry`. The
  embedded plist ("Icon and name") brings it back to
  `~/Library/WebKit/dev.alexwaumann.codefoundry`, the bundle's dir, so side panel
  widths (`stores/panel.ts`) come back. A test GUI under another `CODE_FOUNDRY_HOME`
  shares this storage with every other GUI build.
* **Daemon restart race (seen once, not new).**
  * In the first live run, a client connected during the ~1s shutdown window. It spawned
    a daemon that lost the lock (`another daemon is already running for this config
    home`) and waited out its timeout. A CLI call started the new daemon 4s later.
  * Two reruns with only the GUI as a client came back in 2s, as in phase3d.
  * The bundle flow has the same code path.
* **No Finder or Launchpad entry.** Double-clicking a bare executable opens Terminal, so
  launch with `code-foundry gui`. The Dock icon and name: see "Icon and name".

## Migrating from the bundle (first bare release)

* **The old in-app updater cannot install it.** A daemon from a `CodeFoundry.app`
  install runs the installer embedded in that old binary. That installer downloads
  `CodeFoundry-darwin-arm64.zip`, which the release no longer has:
  * `gh release download` matches only `checksums.txt`.
  * The old script then stops with `checksums.txt has no entry for
    CodeFoundry-darwin-arm64.zip`, or `…zip not found` for a local dir.
  * The update shows as available and then Failed.
  * The old `code-foundry update` fails the same way.
* **Install it manually** with the one-liner (`gh release download … --pattern
  install.sh -O - | bash`). It installs `~/.code-foundry/app` and repoints
  `~/.local/bin/code-foundry` at it.
* **Then, in this order:**
  1. Quit the old app.
  2. Run `code-foundry daemon restart`, which closes sessions; they can be reconnected.
  3. Run `code-foundry gui`.
  4. Remove `~/Applications/CodeFoundry.app`.
* **Why the old app must quit first.** Its relaunch watcher would otherwise auto-start the
  old bundled daemon.

## Icon and name (follow-up, branch `cf/app-identity`)

* **Icon: set at runtime, works.** `gui/icon.go` embeds `gui/build/dockicon.png`
  (`appicon.png` at 512px, see docs/brand) and passes it as Wails' `Options.Icon`. On
  darwin Wails sets `NSApp.applicationIconImage` from it after launch, so no
  Objective-C of our own was needed. It also becomes the About panel's icon.
* **Embedded Info.plist: kept, but it does not name the app.** Production
  `wails3 build`s link `gui/build/darwin/Info.embedded.plist` into
  `__TEXT,__info_plist` (`-extldflags=-Wl,-sectcreate,…` in
  `gui/build/darwin/Taskfile.yml`). The Taskfile stamps `VERSION`
  (`CodeFoundryVersion` v1.2.3, `CFBundle*Version` 1.2.3; dev and 0.0.0 for dev builds).
  Fields: CFBundleName and CFBundleDisplayName "Code Foundry", CFBundleIdentifier
  `dev.alexwaumann.codefoundry` (the old bundle's id per `config.yml`; the brief's
  `dev.awaumann.codefoundry` is an older one, also still in `~/Library/WebKit`),
  NSHighResolutionCapable, ATS local networking.
  * In-process it works: `Bundle.main` has that id and CFBundleName. So WebKit storage is
    `~/Library/WebKit/dev.alexwaumann.codefoundry` again (seen with lsof on the running
    GUI). `codesign` takes the id as its identifier (`Info.plist entries=11`).
  * Launch Services ignores it: with only the plist, `lsappinfo` named the process
    "CodeFoundry" with `bundleID=NULL`. System Events, the CGWindow owner and
    `NSRunningApplication.localizedName` said the same. A small Swift test executable
    with the same plist (with and without CFBundleExecutable) behaved the same way.
    The Dock label comes from that name.
* **So the executable is renamed to `Code Foundry`.** After the rename, `lsappinfo`, System
  Events (`… Code, Code Foundry`), the window owner and `localizedName` all say "Code
  Foundry". Touched: Taskfile `APP_NAME`, `update.GUIName` (`guiBinary` and its dev
  fallback `gui/bin/Code Foundry`), the template's Info.plist `CFBundleExecutable`
  (for `wails3 dev`), install.sh's archive check, package.sh (quoted name, `LC_ALL=C`
  listing check, and a new check that the embedded plist has the version and bundle id
  via `segedit -extract`), `make gui-build` (also removes a stale `gui/bin/CodeFoundry`),
  tests, README. `"Code Foundry" --version` prints `Code Foundry vX.Y.Z`.
* **Why BUILD_FLAGS has no quotes.** The Wails template also passes BUILD_FLAGS
  single-quoted to `wails3 generate bindings -f`. A quoted `-extldflags '…'` failed
  there with "unmatched quote". So the plist path is the relative `bin/Info.embedded.plist`:
  go build runs the external linker in `gui/`. Go does not relink when only the plist
  changed, so the Taskfile removes the old output first.
* **Not seen on screen.** The display was asleep behind the lock screen, and every
  `screencapture` (full screen and `-l <window>`) came back black or failed. So there is
  no screenshot of the Dock tile or the app menu. The evidence for the name is the Launch
  Services and System Events output above. The Dock label is that name. The app menu
  title most likely is too, but it was not read: System Events lacks assistive access
  here. The evidence for the icon:
  * the code path (`Options.Icon` → `setApplicationIcon` → `[NSApp
    setApplicationIconImage:]`)
  * `NSImage(data:)` decodes the embedded PNG at 512x512
  * `NSRunningApplication.icon` cannot show it: that is Launch Services' static generic
    "exec" icon, not the runtime one

  **Check the Dock tile, its hover label and the bold app menu title by eye once.**
* **Verified** with `CODE_FOUNDRY_HOME=/tmp/cf-identity-home`:
  * `make package VERSION=v9.9.9` passed every check.
  * `release.sh --local` published it and `install.sh --skip-path --skip-link` installed
    `code-foundry`, `Code Foundry` and `VERSION`.
  * `code-foundry gui` started `…/app/Code Foundry`, which started its sibling daemon.
  * `app version` said `Code Foundry v9.9.9`.
  * `app relaunch` brought the GUI back under a new pid from the spaced path.
* **Updating across the rename needs the one-liner.** An install of a release that still
  ships `CodeFoundry` updates with the installer embedded in its daemon. That installer
  requires `CodeFoundry` in the archive, so the in-app update and `code-foundry update`
  fail with "the archive has no CodeFoundry executable". Run the install one-liner, quit
  the old GUI (its relaunch would exec the removed `CodeFoundry`), then run
  `code-foundry daemon restart` and `code-foundry gui`. No compatibility shim: Alex is the
  only user.

## Left for a follow-up

* the Wails template's bundle tasks (`package`, `run` builds a `.dev.app` for `wails3
  dev`), which nothing of ours calls. They can go once nothing needs a bundle.
