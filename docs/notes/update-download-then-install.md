# Update: download first, install inside the restart

Status: both halves done on branch `t3code/update-download-then-install`. `make check`
green, `make gui-e2e` green apart from one unrelated WebKit flake (see Frontend). The
frontend half is the "Frontend" section below.

## Why

"Install" used to download **and** swap `~/.code-foundry/app` while the old daemon kept
running, then ask for a restart. A user who instead closed and reopened the window got
the **new** GUI binary (Finder launches whatever is on disk) talking to the **old**
daemon. GUI and daemon have no cross-version compatibility, so that broke. Now the first
step only downloads and stages; the swap happens inside `app.restart`, so the disk
changes only when both processes go down together.

## State machine

```
Idle ──check finds newer──► Available ──Download──► Downloading ──ok──► Downloaded
  ▲                            ▲                         │                  │
  └──check finds nothing───────┘                       error      Install (app.restart)
                                                         ▼                  │
                                  (Download retries)   Failed ◄───error─────┤
                                                                            ▼ ok
                                             RestartRequired ◄──Relaunch── Installed
```

`Downloaded` is new (proto `UPDATE_STATE_DOWNLOADED = 7`, string `downloaded`).
`Installed` / `RestartRequired` keep their meaning: the install on disk is newer than the
running daemon.

## What changed

| Where | Change |
|---|---|
| `scripts/install.sh` | `--stage-only` (download, verify, unpack into `<app>.new`, check VERSION, strip quarantine, keep the stage, print `==> downloaded $TAG to $STAGE`; no link/PATH; "already installed" exits without staging) and `--apply-staged` (no release source and no gh; require `<app>.new/VERSION == TAG` and both executables, else `no staged download of $TAG in $STAGE[ (it holds vY)]; run again without --apply-staged`; then the two renames, link, PATH). Mutually exclusive. Without either flag: unchanged. The download/unpack moved into `stage_download`, the precondition into `check_staged`. |
| `internal/store/update/installer.go` | `Installer{Download(ctx, tag, progress); Install(ctx, tag)}`. `ScriptInstaller` shares an unexported `run(ctx, tag, mode, timeout, progress)`: Download = `--stage-only` (10 min), Install = `--apply-staged` (1 min), `InstallFull` = no flag (the CLI with no daemon; interactive when Stdin is set). |
| `internal/store/update/install.go` | `StageDir(appDir)` (`<appDir>.new`, "" for "") and `StagedVersion(appDir)`. |
| `internal/store/update/store.go` | `Downloaded` state; `Options.StagedVersion` (default `<RunningDir>.new/VERSION`); `Service.Download` (Available/Failed → Downloading → Downloaded, verifying the stage holds the target); `Service.Install` synchronous, Downloaded only; `decide(state, target, current, onDisk, staged, latest)`; Start runs `decide` with no release seen, so a newer stage left by an earlier daemon starts in Downloaded. Package doc rewritten. |
| `internal/store/update/updatetest/fake.go` | The fake installer has two fake version files (`OnDisk`, `Staged()`): Download stages (or fails with `DownloadErr`, clearing the stage), Install refuses a tag that is not staged (like `--apply-staged`), else moves it onto disk. `DownloadAs` / `InstallAs` fake mismatches. `Calls()` = downloads, `Installs()`. |
| `proto/codefoundry/v1/update.proto` | `rpc Download(DownloadUpdateRequest) returns (DownloadUpdateResponse)`; Install, enum and service comments rewritten. Generated Go + TS committed. |
| `internal/api/update.go` | `Download` handler; DOWNLOADED in the state map. |
| `internal/command/commands_update.go` | `UpdateBackend.Download`. `app.update`: "Download Update" / "Download vX", runs Download, "downloading vX". `app.restart`: title "Install vX and Restart" when DOWNLOADED; confirm via `restartConfirm("Install vX and restart Code Foundry", cost)`; refuses while DOWNLOADING ("an update is downloading; restart when it finishes"); when DOWNLOADED calls Install first and on error returns `install vX: …` without notifying or restarting; message prefixed "installed vX; "; JSON `installed`. `daemon.restart`: same refusal, never installs. `UpdateSummary`: "downloading vX", "vX downloaded; restart Code Foundry to install it", "updating to vX failed: …". |
| `internal/command/commandtest/update.go` | `Download` (→ DOWNLOADING), `Install` (→ INSTALLED, or `InstallErr`). |
| `cmd/code-foundry/update.go` | With a daemon running: Check, then Download, follow Watch printing progress lines until the state leaves DOWNLOADING, then the "Downloaded vX. Nothing has changed on disk yet…" hint. FAILED exits non-zero with the reason; IDLE says up to date; already DOWNLOADED just prints the hint. Falls back to the direct install (with a note) for `--version` other than the daemon's target, `--force`, `--channel` other than the daemon's, or updates off in the daemon. With no daemon: the direct interactive install as before, without the "keeps running the old version" paragraph. |
| `gui/frontend` (minimal, to keep `tsc` green) | `[UpdateState.DOWNLOADED]: "downloaded"` and `"downloaded"` in `UpdateStateView`; `case "downloaded":` beside `"installed"` in `updateBadge` and `updateView`; `downloaded` in the mock's `updateStateNames`. The real copy is the frontend half. |
| `docs/ARCHITECTURE.md` | UpdateService paragraph. |

`gui/relaunch.go`: no change. The restart_requested flow is the same, and
`AppService.Relaunch` re-execs `os.Executable()`, a path that holds the new GUI once
Install has swapped the directory.

## Decisions

* **Keep Installed / RestartRequired** as the "disk newer than the running daemon" safety
  net: an `install.sh` run by hand, `code-foundry update` with no daemon followed by an
  old daemon starting, or Install succeeding and the restart not following (RequestRestart
  failing after Install leaves the state Installed, and the next restart applies it).
* **`daemon.restart` does not install.** Restarting only the daemon onto a new install
  would leave the open window on the old version: exactly the mismatch this fixes. It
  keeps "restarts into whatever is installed"; a staged download survives it (the new
  daemon starts in Downloaded).
* **Install is synchronous** and runs inside `app.restart` before RequestRestart, so a
  failed swap restarts nothing and announces nothing. Two renames take milliseconds.
* **Install skips the installer when the target is already on disk** (someone ran
  `install.sh`, which also removes the stage): it just moves to Installed.
* **The Failed-stays rule covers Downloaded too.** After an Install failure the target is
  the staged version; a check keeps Failed (with its reason) instead of quietly going back
  to Downloaded. "Try again" (Download) re-downloads, which replaces the stage.
* **A stale stage is harmless.** Not newer than max(current, on disk): ignored; the next
  Download (or any plain install) runs `rm -rf <app>.new` first.
* **`--apply-staged` never deletes the stage**, even when the swap fails: it is not the
  run's to delete, and a later restart can retry it. Plain and `--stage-only` runs still
  remove it on failure.
* **`--apply-staged` without `--version`** applies whatever is staged (handy by hand; the
  daemon always passes the tag).
* **The CLI delegates to a running daemon** rather than staging itself, so the daemon's
  state (and the GUI) sees the download and its progress, and the hint names one command.
  It also falls back for `--force` and a `--channel` the daemon does not follow (the brief
  named only `--version`); the direct path is the old swap-under-the-daemon behaviour, so
  it says so before installing.
* **Go `State` values are internal**: `Downloaded` sits after `Downloading` in the Go
  enum; only the proto value (7) is wire-visible.
* **Message wording:** "installed v0.2.0; restarting Code Foundry (cuts off …); the app
  relaunches once the daemon has stopped" — the existing restart sentences with an
  "installed vX; " prefix rather than a new sentence with an ellipsis.

## Gotchas

* `Newer(x, "")` is false (both sides must parse), so `decide` treats "nothing staged"
  explicitly: `staged == "" || Newer(latest, staged)`.
* Tests that drive Download must point `Options.StagedVersion` at the fake installer's
  `Staged().Version`; otherwise the default reads `<test binary dir>.new` and every
  download "fails" with "found nothing".
* A plain `install.sh` (or a direct `code-foundry update`) while the daemon is in
  Downloaded removes its stage. The daemon notices on its next check (the CLI's direct
  path triggers one): staged is gone, so it goes Available or Installed. If `app.restart`
  runs before that, Install fails with "no staged download" and nothing restarts.
* `RunningDir` resolves symlinks, so with `/tmp/...` homes the installer prints
  `/private/tmp/...` paths.
* A fresh worktree has no `third_party/ghostty-vt`, and a bare `go test` outside `make`
  may link against another worktree's copy through the build cache. Run
  `make ghostty-vt` once and export `PKG_CONFIG_PATH`/`CGO_*` as the Makefile does.
* Frontend leftovers for the frontend half: `gui/frontend/mock/update.ts` still titles
  `app.update` "Update to vX" and has no Download RPC or DOWNLOADED flow;
  `e2e/update.spec.ts` expects "Update to v0.2.0"; `stores/update.test.ts` uses the old
  "an update is being installed" message as fixture text.

## Verified

* Go: `TestDecide` (table, 29 rows incl. staged cases), `TestStagedVersion`,
  `TestScriptInstaller` (mode flags per method, failure tail),
  `TestCheckDownloadInstallRelaunch`, `TestDownloadFailureAndRetry`,
  `TestDownloadStagedMismatchFails`, `TestInstallFailureAndRetry`,
  `TestInstallerMismatchFails`, `TestInstallAlreadyOnDisk`, `TestInstallRefused`,
  `TestStagedDownloadAtStart`, api `TestUpdateServiceFlow` (Download → DOWNLOADED →
  Install → INSTALLED over Connect), `TestAppRestart` (installs first, failed install
  restarts nothing, confirm and JSON), `TestAppRestartTitle`, `TestDaemonRestart` (a
  download is not installed). Script: `TestInstallStageThenApply` (apply with no gh and no
  release dir), `TestInstallApplyStagedDefaultsToStagedVersion`, `TestInstallStageOnlyFresh`,
  `TestInstallStageAndApplyErrors` (already installed, failed download removes the stage
  and an older one, nothing staged, wrong version staged, both flags).
* `bash scripts/install.sh --help` lists both flags; `--stage-only --apply-staged` →
  `error: --stage-only and --apply-staged exclude each other`, exit 1.
* End to end, isolated: CLIs built at v0.90.0 … v0.96.0 with
  `-ldflags "-X …/internal/version.Version=$tag -X …/internal/version.ReleaseRepo=alexwaumann/code-foundry"`,
  a stub `Code Foundry`, published to `/tmp/cf-rel/<tag>/` (tarball + `checksums.txt`,
  `latest`). `CODE_FOUNDRY_HOME=/tmp/cf-home CODE_FOUNDRY_RELEASE_DIR=/tmp/cf-rel
  CODE_FOUNDRY_UPDATE_DELAY=1h`, v0.90.0 installed with
  `install.sh --version v0.90.0 --yes --skip-link --skip-path --app-dir /tmp/cf-home/app`;
  every command ran as `/tmp/cf-home/app/code-foundry …` (auto-starting its own daemon).
  * `app update.check --json` → `UPDATE_STATE_AVAILABLE`, target v0.91.0.
    `app update` → "downloading v0.91.0"; `app version` → "v0.91.0 downloaded; restart
    Code Foundry to install it". `app/VERSION` v0.90.0, `app.new/VERSION` v0.91.0.
  * `app restart` without `--yes` → "Install v0.91.0 and restart Code Foundry? Threads
    keep their history; a message starts each again. Re-run with --yes", exit 2.
    `app restart --yes --json` → `{"threads_interrupted":0,"gui_notified":0,"installed":"v0.91.0"}`;
    `app/VERSION` v0.91.0, no `app.new`; `app version` (new daemon) → "Code Foundry v0.91.0".
  * v0.92.0 published; `code-foundry update` against the running v0.91.0 daemon →
    "Downloading Code Foundry v0.92.0 (running v0.91.0)", the installer's progress lines,
    "Downloaded v0.92.0. Nothing has changed on disk yet. Install it and restart Code
    Foundry (the app and the daemon update together; nothing running) with: code-foundry
    app restart"; disk v0.91.0, stage v0.92.0. Run again: just the hint. `app restart
    --yes` → "installed v0.92.0; restarting the daemon; no app window is connected…";
    then the same for v0.93.0.
  * `update --version v0.90.0` with the daemon running → falls back to the direct path,
    which says "Code Foundry v0.93.0 is up to date" (no downgrade without `--force`).
  * v0.94.0 downloaded, then `daemon restart --yes`: the new daemon reports "v0.94.0
    downloaded; restart Code Foundry to install it" with disk still v0.93.0.
  * Daemon stopped (SIGTERM to the isolated daemon's pid), v0.95.0 published:
    `update --yes` installs directly (v0.93.0 → v0.95.0), removes the stale v0.94.0
    stage, starts no daemon, and prints no "keeps running the old version" paragraph.
  * v0.96.0 with a corrupted tarball: `update` prints the progress and
    "downloading v0.96.0 failed: installer: exit status 1: … checksum mismatch …",
    exit 1; `app version` → "updating to v0.96.0 failed: …"; `app restart --yes --json` →
    `{"threads_interrupted":0,"gui_notified":0}` (nothing installed), disk v0.95.0.
* Not exercised: a real Wails window across the restart (the frontend half).

## Frontend

Dialog, chip, store and mock for Download → Downloaded → Install and Restart Now.
`docs/notes/update-dialog.md` stays the reference for the dialog's layout; this is what
changed.

### Variants (changes to the update-dialog table)

| variant | when | title | primary | link |
|---|---|---|---|---|
| available | available | Code Foundry vX is available ("You’re on vY. Downloading happens in the background and changes nothing until you restart.") | **Download vX** | Later |
| **downloading** (was `installing`) | downloading | Downloading vX… ("… Nothing changes on disk until you install and restart.") + bar + last progress line | none | Hide |
| readyIdle / readyBusy | **downloaded** | Code Foundry vX is ready ("Install and restart to finish updating. The app and the daemon update together, so nothing ends up out of sync. …"; busy: "… or install and restart anyway: …") | **Install and Restart Now** | Later / Wait, I’ll restart later |
| readyIdle / readyBusy | installed / restartRequired | unchanged | Restart Now | unchanged |
| failed | failed | **Couldn’t update to vX** | Try Again (Download) | Not now |
| restarting | after (Install and) Restart Now | "Installing and restarting…" / "Code Foundry will reopen in a moment on vX." when it installed a download; else "Restarting…" as before | none | none |

Chip: available "vX available · **Download**"; downloading "**Downloading** vX…"; new kind
`downloaded` (emerald, like installed) "vX downloaded · Restart to apply". Installed,
restart required and partly applied are unchanged. `versionMismatch` ignores downloaded.

Test ids: `update-install` is now **`update-download`** (it is `update-${action}`), and
`data-variant="installing"` is now `downloading`. `update-indicator` gains
`data-kind="downloaded"`.

### Decisions

* **`UpdateView.primary`** carries the button label, so the component no longer hard-codes
  text per variant; its `primaries` registry only maps the variant to the action and icon.
  The ready variants are shared by downloaded and installed (one layout, two labels)
  rather than new variant names.
* **The store's action is `download`** (was `install`); it still runs the `app.update`
  command, which calls `UpdateService.Download` in the daemon. The GUI never calls
  UpdateService RPCs directly (every action is a command), so there was no `src/api`
  install helper to rename. Restart is unchanged: `app.restart` with `confirmed: true`,
  falling back to `daemon.restart` plus the host's Relaunch on an old daemon.
* **`restarting` is `{ install: string } | null`** in the store. `runUpdateAction("restart")`
  reads the version before invoking, because the daemon has already moved to Installed
  (and the mock to Idle on the new version) by the time `app.restart` returns.
* Mock: `download()` (AVAILABLE/FAILED → DOWNLOADING, progress lines from
  `install.sh --stage-only`, then DOWNLOADED or FAILED with `failNext`), `install()`
  (synchronous DOWNLOADED → INSTALLED) on the `Download` / `Install` RPCs. `app.update`
  is "Download Update" / "Download vX"; `app.restart` is "Install vX and Restart" with the
  confirm "Install vX and restart Code Foundry? …" when downloaded, refuses while
  downloading ("an update is downloading; restart when it finishes"), installs, then
  comes back as the new version ("installed vX; restarting Code Foundry …").
  `daemon.restart` keeps a download (stays Downloaded). A check keeps Downloaded unless a
  newer release appeared. `/__mock/update/state` accepts `downloaded`.

### Verified

* `make check` green. `make gui-e2e`: 811 passed, 40 skipped, 1 failed: WebKit
  `workspaces.spec.ts:143` (the composer heading did not appear after cmd+n, while two
  `make package` runs and the live app loaded the machine); it passed 3/3 alone with
  `--repeat-each=3`. All 20 `e2e/update.spec.ts` cases pass on both browsers;
  `e2e/update.spec.ts`
  adds "available → Download → downloading → downloaded → Install and Restart Now" (idle;
  checks the mock still runs v0.1.0 while downloaded, the palette's "Install v0.2.0 and
  Restart", one confirmed `app.restart`, then v0.2.0), and the busy test now runs through
  Download with the "install and restart anyway" copy.
* Live, in the real Wails window: `make package` at v0.90.0 and v0.91.0
  (`RELEASE_REPO=alexwaumann/code-foundry`), both published to `/tmp/cf-rel/<tag>/`, v0.90.0
  installed with `install.sh --version v0.90.0 --yes --skip-link --skip-path --app-dir
  /tmp/cf-shot/app`, `/tmp/cf-rel/latest` = v0.91.0, then
  `CODE_FOUNDRY_HOME=/tmp/cf-shot CODE_FOUNDRY_RELEASE_DIR=/tmp/cf-rel
  CODE_FOUNDRY_BIN=/tmp/cf-shot/app/code-foundry CODE_FOUNDRY_UPDATE_DELAY=1h
  "/tmp/cf-shot/app/Code Foundry"`. App menu "Check for Updates…" → available; the
  dialog's Download → "Downloading v0.91.0…" with "==> unpacking" → ready with "Install
  and Restart Now" (`app.new/VERSION` v0.91.0, `app/VERSION` v0.90.0). Install and
  Restart Now → the window closed and relaunched, the new daemon reported v0.91.0,
  `app.new` gone, no chip (no mismatch). That is the "real Wails window across the
  restart" the Go half left unexercised.
* Screenshots: `update-download-then-install/downloaded-dark.png`, `downloaded-light.png`
  (the live window, light via `settings.set appearance.theme light`, then back to dark).

### Gotchas

* Driving the window: System Events `click at` fails (-25208) and `key code` does not reach
  the WKWebView, but the app menu item clicks, and the dialog's buttons appear in
  `entire contents of window 1` as AXButtons named by their label, so
  `perform action "AXPress"` presses them. Read `role`/`name` inside a `try` per element;
  a `try` around the whole test skips the match.
* The isolated copy shares the real app's WebKit localStorage, so it also uses the user's
  saved sidebar width. At widths under about 240px the chip truncates to
  "v0.91.0 downl… Restart to apply" (the CTA does not shrink); at the 280px default it fits.
  The screenshots show the truncated chip; resizing the sidebar there would have changed
  the real app's saved width.
* The restart is fast: the "Installing and restarting…" frame is gone before a screenshot
  a second later. e2e covers its copy.
* Ports 7799/9255 (and others) may be taken by other worktrees' mocks; run e2e with
  `E2E_MOCK_PORT`/`E2E_VITE_PORT` set to free ports.
