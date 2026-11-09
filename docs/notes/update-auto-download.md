# Updates download automatically

2026-11-08. Before this change, a check that found a newer release only offered it, and
the user had to click Download before they could Install and Restart. Now the daemon
downloads a newer release as soon as a check finds it, so the user only has to restart.
Builds on `update-download-rechecks.md` (Download checks first; a failed download checks
again).

## Decisions

- **No setting.** Every check that finds a newer release downloads it: the scheduled
  hourly check, the check 30 s after start, and Check for Updates. Nobody is on a metered
  connection. `Options.ManualDownload` exists only for tests of the manual path. It is not
  read from settings.
- **The chip shows the download as it did before** ("Downloading vX…"). The GUI needs no
  change: the states and the dialog are the same, it is just the daemon that moves from
  Available to Downloading.
- **An automatic download that fails goes back to Available, not Failed.** The user sees
  "vX available · Download", the same as before automatic downloads, so the Download
  button is the fallback. The next scheduled or requested check tries again. The check
  right after the failure (from the previous PR) does not retry the version that just
  failed (`autoNew`, `failedTag`), so a checksum mismatch cannot loop. It still downloads
  a different, newer release. A download the user started (Download / Try Again) still
  fails to Failed with the reason.
- **Download's own check starts nothing** (`autoNone`). Otherwise Download would find its
  own automatic download running and refuse with "already downloading".
- **A newer release while one is downloaded replaces it in the background.** The state stays
  Downloaded with the old target, so the chip keeps saying "vX downloaded · Restart to
  apply" and Restart Now works throughout. When the newer download is complete, the
  target moves to it. A release that comes out while the first download is still running
  replaces it as soon as that one finishes. At most three copies exist at once: the
  install (`app/`), the download (`app.new`), and the replacement in progress
  (`app.new.partial`).
- **install.sh `--stage-only` unpacks into `app.new.partial`** and replaces `app.new`
  only once the archive is verified, unpacked and checked (executables, VERSION). A
  failed or cancelled download leaves an earlier `app.new` untouched (`KEEP_STAGE` is now
  1 for `--stage-only` from the start), and the EXIT trap always removes
  `app.new.partial`. `/bin/bash` 3.2 runs the EXIT trap on the SIGTERM that cancellation
  sends to the installer's process group. A full install (no flags) still removes a stale
  stage on failure, as before.
- **Restart Now during a replacement cancels it** and installs what is staged. Install
  cancels, waits for the installer to exit, then installs the staged version. If the
  replacement finished first, that is the newer one.
- **A failed replacement keeps the download** and is retried at the next check, with no
  state change and no chip change. Only if the stage changed underneath does the state
  get worked out again from disk.
- The `app.update.check` description and the proto comments for `Check` and `Download`
  now say a check downloads. The description also said "every 24 hours", which has been
  hourly since `update-check-hourly.md`.
- The mock updater mirrors all of this. A check that finds a release starts downloading,
  a failed automatic download goes back to Available, and a newer release while
  Downloaded swaps the target after a delay.

## Verified

- Go: `auto_test.go`. `TestCheckDownloadsAutomatically`,
  `TestManualDownloadWithAutomaticOn`, `TestAutomaticDownloadFailure` (back to Available,
  the re-check does not retry, the next check does), `TestAutomaticFailureThenNewer`,
  `TestNewerReplacesDownload` (stays Downloaded and staged throughout, one replacement at
  a time), `TestNewerDuringDownload`, `TestInstallDuringReplacement` (still downloading
  and failed), and `TestPeriodicCheckDownloads`. `-race -count=10` green. Script:
  `TestInstallStageAndApplyErrors` gains "a failed download keeps an older stage", "an
  unpack failure keeps an older stage", "a newer download replaces an older stage", and
  no `app.new.partial` left behind in any row.
- e2e: `e2e/update.spec.ts`. A check downloads at once without `app.update`, a failed
  automatic download falls back to the Download button, then Install and Restart Now.
- End to end, isolated (`CODE_FOUNDRY_HOME` on a short /tmp symlink,
  `CODE_FOUNDRY_RELEASE_DIR` with CLIs built at v0.90.0 to v0.94.0 from this branch):
  - Daemon v0.90.0 started with `CODE_FOUNDRY_UPDATE_DELAY=2s` and v0.91.0 published: the
    scheduled check downloaded v0.91.0 by itself ("v0.91.0 downloaded; restart Code
    Foundry to install it").
  - v0.92.0 published, `app update.check` → still "v0.91.0 downloaded" (log: "downloading
    a newer update to replace the downloaded one"), then "v0.92.0 downloaded";
    `app.new/VERSION` v0.92.0, no `app.new.partial`.
  - v0.93.0 published with a corrupted tarball: the replacement failed ("keeping it"),
    still "v0.92.0 downloaded", `app.new` v0.92.0, no partial. `app restart --yes` →
    "installed v0.92.0".
  - Restart during a replacement: v0.93.0 downloaded automatically, then v0.94.0
    published with a `cp` shim on the daemon's PATH that sleeps 120 s for it, so the
    replacement hung in `install.sh`. `app restart --yes` → log "cancelling the newer
    download to install the downloaded update", "installed v0.93.0". Afterwards
    `app/VERSION` v0.93.0, no `app.new` or `app.new.partial`, no leftover `cp`/`sleep`.
