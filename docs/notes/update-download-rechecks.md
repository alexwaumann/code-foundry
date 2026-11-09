# Update download checks for the latest release first

2026-11-08. A user reported that a failed update download kept failing the same way
instead of picking up a newer release.

## Cause

The release workflow keeps only the five newest tip releases and deletes the rest with
their tags. When the updater offered a tip and the user clicked Download after it had been
deleted, `gh release download` failed and the updater went to Failed for that version.
**Try Again** called `Download`, which downloaded the version already offered (the deleted
one), so it failed the same way every time. Only the next scheduled check, up to an hour
later, noticed the newer release (`decide` already moves Failed to Available when the
latest release is a different version).

## Decisions

- **`Download` runs a check first** and downloads whatever that check offers. A version an
  earlier check offered is only for display. When the check finds nothing newer than the
  running build (the offered release is gone and nothing replaced it), `Download` refuses
  with `ErrNotAvailable` from Idle.
- **A failed check does not stop the download.** It logs a warning and downloads the
  version already offered, so a network or gh hiccup during the check fails no worse than
  before.
- **A caller that gives up during that check starts nothing.** `Download` used to return
  at once; now it waits for a lookup (up to 30 s), so a Ctrl-C in `code-foundry update`
  returns the context error before a download starts. A lookup cancelled by its caller
  (or by the daemon stopping) is not recorded as `LastCheckError`.
- **A channel switch during that check checks again** (once): the check drops a stale
  channel's answer, and downloading the old channel's offer would stage a tip build on
  stable.
- **A failed download checks again at once**, in the download goroutine after publishing
  Failed. A newer release turns the failure into Available for it. When the same version
  is still the latest, Failed stays (keepFailed), as before. This does not depend on the
  failure's text: a 404, a checksum mismatch and a network error are all handled the same.
- Moving on to a newer release clears the failure reason with the Failed state. That is
  the point (the old failure no longer applies), so it is not kept anywhere.
- No change to the API, the commands, the CLI or the GUI: Try Again and Download still
  call `app.update`. Each extra check also runs the plugin and skill registry checks that
  ride `LastCheckedAt` (`internal/daemon/update_ticks.go`); that is one more `gh` call per
  download, which is fine.

## Verified

- Go: `TestDownloadChecksFirst` (table: newer since the offer, a retry from Failed gets
  the newer release, a retry of the same version, a failed check downloads the offered
  version, offered release gone with nothing newer refuses from Idle, Download with no check before
  it), `TestDownloadCancelledDuringCheck`, `TestDownloadAfterChannelSwitch` and
  `TestFailedDownloadChecksAgain` (the release is deleted mid-download; the failure becomes
  Available for the newer one after exactly one more lookup). Existing store tests
  unchanged; `-race -count=5` green.
- End to end, isolated (`CODE_FOUNDRY_HOME` on a short /tmp symlink, since the socket path
  must stay under 103 bytes; `CODE_FOUNDRY_RELEASE_DIR` with CLIs built at v0.90.0 to
  v0.94.0 and a stub GUI):
  - v0.91.0 offered by `app update.check`, then its release directory deleted and v0.92.0
    published: `app update` → "downloading v0.92.0", `app.new/VERSION` v0.92.0.
  - Installed v0.92.0 (`app restart --yes`). v0.93.0 published with a corrupted tarball:
    `app update` → Failed with the checksum mismatch; the log shows the check right after
    the failure ("latest v0.93.0, state failed"). Then v0.93.0 deleted and v0.94.0
    published: `app update` (Try Again) → "downloading v0.94.0", staged v0.94.0.
