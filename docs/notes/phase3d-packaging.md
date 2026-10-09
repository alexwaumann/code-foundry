# Phase 3d: Packaging, releases, and the in-app updater

Status: done on branch. `make check` and `make gui-e2e` are green (58 e2e tests, 14 of
them new in `e2e/update.spec.ts`). The full install → check → install → relaunch →
daemon restart cycle was run on this machine against a local fake release source, using
the real packaged app in `~/Applications` (see "Verified").

## Bundle layout

```
CodeFoundry.app/Contents/
  MacOS/CodeFoundry      Wails GUI (window shell)
  MacOS/code-foundry     daemon + CLI, the same build as dist/code-foundry-darwin-arm64
  Info.plist             CFBundleShortVersionString/CFBundleVersion X.Y.Z,
                         CodeFoundryVersion vX.Y.Z[-pre] (the updater reads this)
  Resources/             icons.icns, Assets.car
```

* **One version stamp.** `make package VERSION=vX.Y.Z` builds both binaries with
  `-X internal/version.Version=vX.Y.Z -X internal/version.ReleaseRepo=<slug>`. The GUI
  gets the flags through `EXTRA_LDFLAGS`, which `gui/build/darwin/Taskfile.yml` now
  appends to its production `-ldflags`. `create:app:bundle` copies the CLI in
  (`CLI_BIN`, default `../bin/code-foundry`) and stamps `Info.plist` when `VERSION` is
  set. Unstamped builds say 0.0.0, so a dev bundle never looks newer than a release.
* **The GUI host finds its daemon.** This closes the Phase 0 Finder-launch gap.
  `daemonBinary()` prefers the sibling `Contents/MacOS/code-foundry`. At startup the host
  exports `CODE_FOUNDRY_BIN` to that path, so the daemon and every session inherit it.
  `code-foundry daemon` sets `CODE_FOUNDRY_BIN` to itself when it is unset.
* **Finder PATH.** An app opened from Finder gets launchd's
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and the daemon spawns `claude`, `git` and `gh`
  by name. When the host sees exactly that PATH, it runs `$SHELL -ilc` once (5s bound)
  and adopts the printed PATH before anything spawns the daemon. If that fails it falls
  back to `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:` plus launchd's PATH.
  Terminal launches are left alone.
* **Signing**: ad-hoc. `codesign --force --deep --sign -` signs the bundled CLI too, and
  `codesign --verify --deep --strict` passes. `spctl --assess` rejects the bundle, as it
  rejects every ad-hoc bundle. That only matters for quarantined downloads, and installs
  are not quarantined (next point).
* **No quarantine via gh.** Checked on this machine (macOS 27.0): a file fetched with
  `gh release download` carries only `com.apple.provenance`, which every process-written
  file gets and which does not trigger Gatekeeper. It has no `com.apple.quarantine`.
  `ditto -x` would propagate quarantine from a quarantined zip (also checked), so
  install.sh still runs `xattr -dr com.apple.quarantine` on the bundle;
  `TestInstallRemovesQuarantine` covers it.

`make package VERSION=vX.Y.Z` (`scripts/package.sh`) writes `dist/`:

| Asset | What |
|---|---|
| `CodeFoundry-darwin-arm64.zip` | `ditto -c -k --keepParent CodeFoundry.app` (about 22 MB) |
| `code-foundry-darwin-arm64` | the standalone CLI, for scripting |
| `install.sh` | the installer, with `DEFAULT_REPO` set to the release repo |
| `checksums.txt` | sha256 of the three above |

package.sh refuses to finish when:

* `Info.plist` does not carry the version
* the bundled CLI's `version` disagrees with it
* the GUI binary lacks the version string
* the signature does not verify

`RELEASE_REPO` defaults to `alexwaumann/code-foundry` in the Makefile.

## Releases

### Automatic (GitHub Actions, on since 2026-10-09)

`.github/workflows/release.yml` uses the same setup as `ci.yml`: checkout with full
history and tags, setup-go from go.mod, pnpm 12.8.1, node 24 (libghostty-vt is vendored,
see vendored-libghostty-vt.md, so there is no zig build or cache). It then installs
`wails3@v3.0.0-beta.28` with the go.mod toolchain and runs `scripts/release.sh` with the
default `GITHUB_TOKEN` (`permissions: contents: write`). `concurrency: release` with no
cancellation queues merges instead of racing them. `workflow_dispatch` takes an optional
explicit version.

### Enabling automatic releases

Both switches were flipped on 2026-10-09:

1. `.github/workflows/release.yml` has the `push: branches: [main]` trigger.
2. The repository variable `RELEASE_ENABLED` is `true` (Settings → Secrets and
   variables → Actions → Variables). The job's `if: vars.RELEASE_ENABLED == 'true'` also
   gates manual `workflow_dispatch` runs.

The first push to main after that publishes **v0.1.0**, because there were no tags yet.
After that, every push to main releases. A docs-only commit still bumps the patch
version, which Alex accepted. To pause releases, set `RELEASE_ENABLED` to `false`.

### Versions (`scripts/next-version.sh`)

The version comes from the highest `vMAJOR.MINOR.PATCH` tag reachable from HEAD,
compared in version order, not by date. Pre-release tags are ignored. Every non-merge
commit since that tag counts toward the bump:

| Commit | Bump |
|---|---|
| `type!:` or `type(scope)!:`, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer | major |
| `feat:` | minor |
| anything else | patch |

* The biggest bump wins.
* With no tag yet, the version is v0.1.0.
* With no commits since the tag, it prints nothing and the release step exits 0.
* Major is literal semver, even below 1.0: v0.3.1 plus a breaking change gives v1.0.0.

`scripts/next_version_test.go` checks the rules against fixture logs and against a real
temp git repo (tags, pre-release tags, version order, merge commits). Against this
repo's history it prints `v0.1.0`.

### `scripts/release.sh [--dry-run] [--local DIR] [vX.Y.Z]`

The workflow runs this script, and it is also the manual fallback (`make release
[VERSION=…] [DRY_RUN=1]`). Steps:

1. Takes the repo slug from `CODE_FOUNDRY_RELEASE_REPO`, else from `git remote get-url
   origin` (https, ssh and scp forms).
2. Checks `gh auth status` and a clean tree.
3. Takes the version from the argument, else from next-version.sh. If nothing is new but
   HEAD carries a version tag whose GitHub release is missing (a failed run), it
   finishes that release.
4. Runs `make package`.
5. Creates the annotated tag, or accepts an existing tag only if it points at HEAD.
6. Runs `git push origin refs/tags/<v>`.
7. Runs `gh release create <v> <4 assets> --verify-tag --generate-notes`, or
   `gh release upload --clobber` when the release exists.

Every step is idempotent.

* `--dry-run` runs the read-only checks and prints the mutating commands. Verified output:
  ```
  ==> repository: alexwaumann/code-foundry
  ==> version: v0.1.0
  + make package VERSION=v0.1.0 RELEASE_REPO=alexwaumann/code-foundry
  + git tag -a v0.1.0 -m Code\ Foundry\ v0.1.0
  + git push origin refs/tags/v0.1.0
  + gh release create v0.1.0 dist/CodeFoundry-darwin-arm64.zip dist/code-foundry-darwin-arm64 dist/install.sh dist/checksums.txt --repo alexwaumann/code-foundry --verify-tag --generate-notes --title Code\ Foundry\ v0.1.0
  ==> dry run: nothing was changed
  ```
* `--local DIR` publishes into a local release directory instead of GitHub: `DIR/<v>/`
  plus `DIR/latest`. There is no tag and no push. That is the fake release source used
  below.

### Manual release steps (if Actions are not wanted)

1. Make sure `origin` points at `github.com/alexwaumann/code-foundry` (it already does)
   and `gh auth status` is green.
2. On a clean `main`, run `scripts/release.sh --dry-run`, then `scripts/release.sh` (or
   pass `v0.1.0` explicitly).

### Install one-liner

The repo is public, and the installer is also attached to every release:

```sh
gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash
```

This needs an authenticated `gh` (it downloads with `gh release download`). It does not
depend on raw.githubusercontent, so it also works if the repo goes private.

## install.sh

| Behavior | Detail |
|---|---|
| Platform | macOS arm64 only. Requires an authenticated gh, looked up on PATH, then in Homebrew's locations, then `CODE_FOUNDRY_GH` |
| Source | Latest release (`gh api …/releases/latest`) or `--version` |
| Download | The zip and `checksums.txt`. `CODE_FOUNDRY_RELEASE_DIR` swaps in a local directory |
| Verification | sha256 is checked; the archive's `CodeFoundryVersion` must equal the tag |
| Install | Unpacks into a staging dir inside the app dir (default `~/Applications`, `--app-dir`), then swaps with `mv`. The old bundle is moved aside, the new one moved in, and the old one restored if that fails |
| CLI link | Links `~/.local/bin/code-foundry` (`--bin-dir`) to the bundle's CLI |
| PATH | Unless `--skip-path`, adds `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` under the marker `# Added by the Code Foundry installer`. Done once. Skipped if the marker exists or the dir is already on PATH |
| Prompts | Interactive means stdout is a TTY, `/dev/tty` is readable, and there is no `--yes`. Then it prompts for the upgrade and the PATH change; prompts read `/dev/tty`, so `… -O - \| bash` works. Without a TTY it upgrades and sets up PATH silently. `--force` reinstalls the same version |
| Bash version | Runs under macOS's bash 3.2: no arrays, no `${x,,}` |

`scripts/install_test.go` runs it end to end against fake bundles in a fake release
dir, with a temp HOME and no TTY. It covers:

* fresh install
* idempotent rerun (one marker)
* silent upgrade with no leftovers
* explicit `--version`
* `--skip-path` and custom dirs
* checksum mismatch, wrong bundle version, malformed `latest`, no release (the existing
  install stays untouched)
* quarantine removal
* refusal without an authenticated gh

## How updates flow

```
daemon start ──30s──► check ──every 24h──► check            (CODE_FOUNDRY_UPDATE_DELAY overrides 30s)
 gh api repos/<slug>/releases/latest --jq .tag_name          (or $CODE_FOUNDRY_RELEASE_DIR/latest)
   404 → "no published release": a successful check with nothing to do
   strict semver; malformed tag → check error, state unchanged
Idle ─newer─► Available ─app.update─► Downloading ─ok─► Installed ─app.relaunch─► RestartRequired
                  ▲                       └─error─► Failed (app.update retries)
```

* **What "installed" means.** The daemon runs the embedded installer
  (`scripts.InstallSh`, `//go:embed`) with `--yes --skip-path --version <tag> --app-dir
  <dir of the running bundle>`. Its PATH gains gh's directory, and gh's path is passed as
  `CODE_FOUNDRY_GH`. The installer never comes from the repo. After a run, the store
  re-reads the bundle's `Info.plist`, and a version other than the tag is a failure.
  Progress is the installer's latest output line.
* **Updates installed elsewhere count too.** If the bundle on disk is newer than the
  running daemon (for example after `code-foundry update`), the state is Installed: at
  startup, on every check, and when the CLI pokes the daemon after updating.
* **What restarts what.** Nothing restarts automatically.
  * The GUI needs a relaunch. `app.relaunch` publishes `RelaunchRequested`. The **Wails
    host** follows UpdateService.Watch over the socket itself (`gui/relaunch.go`); it
    waits for its own exit and reopens the bundle with `open`, forwarding
    `CODE_FOUNDRY_*` settings through `open --env`.
  * The daemon keeps running the old version, with its sessions, until `daemon.restart`.
    That command shuts down exactly like SIGTERM: sessions are recorded as disconnected
    ("daemon stopped") and can be reconnected. The next client auto-starts the installed
    binary. The host's watcher is such a client, so the GUI brings the daemon back within
    about 2s, even with the window hidden.
  * `daemon.restart` refuses while an update is installing.
* **Dev builds** (version not strict semver) and builds without a repo never check. The
  dialog says "Updates are disabled for this build (dev build)".

### Commands

| Name | Notes |
|---|---|
| `app.version` | version and a one-line update summary |
| `app.update.check` | "Check for Updates"; FailedPrecondition when disabled |
| `app.update` | available only in Available/Failed; its title is "Update to vX.Y.Z" (new `Command.DynamicTitle`) |
| `app.relaunch` | "no app window is connected" when no GUI listens |
| `daemon.restart` | "closing N sessions" (N = sessions not disconnected) |

CLI:

* `code-foundry update` (or `--update`; flags `--version`, `--force`, `--yes`) runs the
  embedded installer attached to the terminal, so it prompts. It compares against the
  installed app, then tells a running daemon to re-check, and prints what still runs the
  old version.
* `code-foundry gui` opens, in order of preference:
  1. the bundle the CLI lives in
  2. the dev build next to a repo CLI (`gui/bin/CodeFoundry.app`, pointed at that CLI
     with `CODE_FOUNDRY_BIN`)
  3. `~/Applications` or `/Applications`

  It forwards `CODE_FOUNDRY_HOME` and the release overrides via `open --env`.
* No-arg `code-foundry` now points at `code-foundry gui`. It still does not launch the
  GUI itself, so scripts that run the bare binary do not open windows.

### GUI

* **Footer** (`UpdateIndicator`, left of the daemon status):

  | Footer text | When |
  |---|---|
  | `· update ready vX.Y.Z` | an update is available |
  | `· updating to vX.Y.Z…` | installing |
  | `· update failed` | the install failed |
  | `· relaunch to apply` | the GUI is older than the installed version, or the daemon was restarted first and is newer than the GUI |
  | `· daemon restart pending` | the GUI is current but the daemon is not |

  The GUI learns its own version from the host's `AppService.Info`. That binding
  answering is also how the frontend knows it runs inside Wails. Clicking the footer
  text opens the dialog.
* **Dialog** (`UpdateDialog`):
  * the daemon and app versions, the release repo, and the last check time
  * the release notes link, opened with Wails `Browser.OpenURL`
  * Update to vX, indeterminate progress with the installer's line, failure output and
    Retry
  * "Ready: relaunch to apply" with Relaunch
  * "Daemon restart pending; N sessions will close", with a confirm step before Restart
    daemon (3b's confirm flag was not on main to reuse; see merge notes)
* **Palette and keybindings.** `app.update.check`, `app.update` and `daemon.restart`
  present through the dialog, so progress and confirmation are visible. The palette now
  consults the keybinding presenter registry for no-arg commands (`presentCommand`).
* **App menu.** The app menu (`Code Foundry` → About, **Check for Updates…**, Services,
  Hide…, Quit, then the File/Edit/View/Window roles) emits `app:check-for-updates`. The
  frontend opens the dialog and checks.
* **Mock.** The mock daemon has a `MockUpdater` (`mock/update.ts`) and
  `/__mock/update/{state,latest,fail,disabled}` controls.

## Verified (this machine, 2026-10-08)

The fake release source was `/tmp/cf3d/rel`, filled by `scripts/release.sh --local`
from real `make package` builds. The app ran from the real `~/Applications`. Every live
run used an isolated `CODE_FOUNDRY_HOME=/tmp/cf3d-home` (a dev daemon was running on the
real home).

1. **First install.** `CODE_FOUNDRY_RELEASE_DIR=/tmp/cf3d/rel bash install.sh` (no TTY)
   installed v0.1.0 and linked `~/.local/bin/code-foundry`, which printed
   `code-foundry v0.1.0`. There was no quarantine, `codesign --verify` passed, and
   `~/.zshrc` was untouched because `~/.local/bin` was already on PATH.
2. **Launch with `open`.**
   * The GUI auto-started `…/CodeFoundry.app/Contents/MacOS/code-foundry daemon`.
   * `CODE_FOUNDRY_BIN` pointed at the bundled CLI.
   * The scheduled check ran 3s after start (`CODE_FOUNDRY_UPDATE_DELAY=3s`) and logged
     `latest v0.1.0, idle`.
3. **Daemon-driven update.**
   * After v0.1.1 was published, `app update check` said `v0.1.1 available`.
   * `commands` listed `app.update  yes  Update to v0.1.1`.
   * `app update` installed in about 0.3s: the bundle on disk became v0.1.1 while the
     old GUI and daemon kept running. State: `v0.1.1 installed; relaunch the app and
     restart the daemon to apply`.
4. **Interactive CLI update.** `code-foundry update` under `expect` showed
   `Replace Code Foundry v0.1.1 with v0.2.0? [Y/n]`, installed, and told the running
   v0.1.0 daemon, which switched to `v0.2.0 installed`. This found and fixed a bug: the
   installer ran in its own process group and was stopped by SIGTTIN at the prompt.
5. **Finder-style launch.** `env -i HOME=… PATH=/usr/bin:/bin:/usr/sbin:/sbin open …`:
   the GUI started with launchd's PATH, and the daemon it auto-started (v0.2.0) had the
   login-shell PATH (`~/.local/bin`, Homebrew, fnm, …).
6. **Relaunch.** `app relaunch` replaced the GUI process (pid 81028 → 83108, now the
   v0.2.1 binary) with `CODE_FOUNDRY_HOME` and `CODE_FOUNDRY_RELEASE_DIR` preserved.
   State: `daemon restart pending`. This found and fixed a bug: relaunch used to depend
   on the frontend reaching the AppService binding, which never fired in the packaged
   app. The host now handles it.
7. **Daemon restart.** `daemon restart` logged `shutting down cause=daemon.restart
   requested`, and the v0.2.2 host auto-started the v0.2.2 daemon from the bundle 2s
   later, with no other client involved. This found and fixed a bug: with the display
   asleep, WebKit suspends timers, so the frontend never re-requested the endpoint. The
   host's watcher now auto-starts.
8. **Session count.** With one idle haiku session (effort medium, scratch repo under
   `/tmp`), `daemon restart` said `closing 1 session`. Afterwards `session list` showed
   it `disconnected / daemon stopped`.
9. **No release published.** The real repo has no releases. A daemon pointed at it
   logged `latest "" state idle` with no error. `gh api …/releases/latest` returns
   `gh: Not Found (HTTP 404)`, which maps to `ErrNoRelease`.
10. **Cleanup.** Afterwards the test bundle, `~/.local/bin/code-foundry` and the temp
    homes were removed. The test builds carried made-up versions (v0.2.2) that would
    never be offered v0.1.0.

## Not verifiable without a real release

* `gh release download` of our own assets, and the one-liner against a published
  `install.sh`. The gh code path is the same as the fake-dir path apart from the
  download command.
* `gh release create/upload` and the tag push. Only the dry-run was run, as instructed.
* The release workflow itself. `actionlint` is clean. GITHUB_TOKEN tag pushes and wails3
  on the runner are untested until the first run.
* A real Finder double-click. `env -i … open` stands in for it.
* Visual checks. Screen capture returns black here (the display looks asleep), as in
  Phase 0. The UI states are covered by Playwright against the mock; the packaged app
  was checked through daemon logs, process listings and command results.

## Decisions and gotchas

* **`app.update.check`, not `app.check_updates`.** Command names must match
  `^[a-z]+(\.[a-z][a-z0-9]*)+$`, which allows no underscores. Because of
  longest-prefix CLI resolution, `code-foundry app update check` checks and
  `code-foundry app update` installs.
* **Event and source numbers are 10** (`Event.update = 10`, `EVENT_SOURCE_UPDATE = 10`),
  to stay clear of 3a/3b/3c picking 6 to 9.
* **The update source snapshot is the status.** The update source sits after gh and
  before ui.
* **No GUI-version RPC.** The daemon cannot know when the GUI has relaunched, so
  Installed → RestartRequired happens on `app.relaunch`. The footer also compares the
  GUI's own version, so a manual quit and reopen shows "daemon restart pending" too.
* **Installed → RestartRequired is display-only.** Both states mean "bundle newer than
  this daemon".
* **Go VCS stamping in nested worktrees.** Under `.claude/worktrees/…`,
  `vcs.revision` reports the enclosing checkout's HEAD. CI and normal checkouts are
  unaffected. The `version` output in the logs above shows main's commit for that
  reason.
* **e2e ports.** Ports are overridable (`E2E_MOCK_PORT`, `E2E_VITE_PORT`), because
  parallel worktrees collided on 7799/9255. Defaults are unchanged.
* **`code-foundry update` from a dev build** still works when a repo is configured; dev
  builds only skip the background checks.

## Merge notes

* **events.proto.** Additive: `import update.proto`, `EVENT_SOURCE_UPDATE = 10`,
  `UpdateEvent update = 10`. If another step also edits the `Event` oneof, keep both
  fields and regenerate (`make gen`).
* **Shared Go edits (small):**
  * `internal/command/command.go` (+`DynamicTitle`) and `registry.go` (List applies it).
    3b's `Confirm` field lands next to it.
  * `internal/command/all/all.go` (+`Update`, `Restart`).
  * `internal/api/events.go` (+`Update` dep and source).
  * `internal/client/client.go` (+`Update` client).
  * `internal/daemon/daemon.go`: restart cause context, update route, Deps.
  * `internal/daemon/stores.go`: update store.
  * `cmd/code-foundry/main.go` (+`gui`, `update`, `--update`) and `daemon.go`
    (`CODE_FOUNDRY_BIN`).
* **Shared GUI edits (small):**
  * `src/api/events.ts` (update case)
  * `src/stores/events.ts` (handler entry)
  * `Footer.tsx` (indicator)
  * `App.tsx` (dialog, `startUpdateSync`)
  * `keys/bindings.ts` (three presenters, `presentCommand`)
  * `CommandPalette.tsx` (no-arg picks consult presenters)
  * `mock/world.ts` (`update` field, reset, registry spread) and `mock/server.ts`
    (UpdateService, snapshot, controls)
  * `playwright.config.ts` (port env)
* **3b's confirm.** If 3b's confirm flag is on main at merge, set it on
  `daemon.restart`: `Confirm: "Close N sessions and restart the daemon?"`, or whatever
  the field takes. The dialog's own confirm step can stay; it shows the live count. The
  palette presenter already routes `daemon.restart` to the dialog.
* **Wails bindings.** Wails bindings were regenerated (`AppService`: `Info`, `Relaunch`).
  `make gen` reproduces them.
* **Turning releases on.** See "Enabling automatic releases". Nothing publishes on merge.

### Resolved at merge (after 3b and 3c)

* **Event sources:** gitops = 6, settings = 7, update = 10. Snapshot order: repo, terminal,
  session, gh, gitops, settings, update, then ui.
* **daemon.restart is confirmed by the registry.** It sets `Confirm`. A new
  `Command.DynamicConfirm` (beside `DynamicTitle`) replaces the message at invoke time
  with the live count: "Close N sessions and restart the daemon?". The CLI prompts (or
  takes `--yes`) like every other confirmed command.
* **The update dialog dropped its own confirm step** so it never asks twice. Its "Restart
  daemon…" button runs `daemon.restart` through `invokeConfirmed`
  (`stores/commands.ts`, shared with `runCommand`), so 3b's `ConfirmDialog` asks.
  `daemon.restart` has no keybinding presenter any more: the palette uses the same
  confirm flow. Declining leaves the update dialog unchanged.
