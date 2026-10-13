# Release channels: stable and tip — handoff

Status: **signed off** (Alex, 2026-10-12; first design 2026-10-11, revised 2026-10-12: `N` counts
tip releases, and the GUI renders tips as `vX.Y.Z (tip N)`). Read `ARCHITECTURE.md`,
`PLAN.md`, `phase3d-packaging.md` and `bare-binary-distribution.md` first: releases,
`install.sh`, and the updater state machine are described there and keep working as
described.

## 1. Problem

Every push to main publishes a GitHub release and the updater installs it, so "latest"
is whatever merged last. Alex wants two channels, named after Ghostty's: **stable**, a
build promoted on purpose, and **tip**, the current head of main. One install, one
channel at a time, switched in settings.

## 2. Facts that shape the design

* `scripts/next-version.sh` computes the next version from conventional commits since
  the latest `vMAJOR.MINOR.PATCH` tag merged into HEAD and **ignores prerelease tags**.
  So a base version computed this way is "the stable this would become if promoted now".
* `internal/store/update/semver.go` orders prereleases below their release
  (`v0.15.0 > v0.15.0-tip.3`), and `Newer` is the only test the updater uses.
* `scripts/package.sh`, `scripts/release.sh` and `install.sh`'s `is_tag` already accept
  `-prerelease` suffixes. GitHub's `releases/latest` returns the newest non-prerelease.
* `internal/db` applies embedded numbered migrations and **silently ignores** versions
  recorded in `schema_migrations` that it does not embed. A stable binary opening a tip
  database therefore starts fine and fails later at query time if a tip migration dropped
  or reshaped something (0005 dropped a table).
* `internal/store/settings` warns about and ignores unknown keys.

## 3. Decisions (Alex, 2026-10-11, revised 2026-10-12)

1. **One repo, GitHub's prerelease flag is the channel.** Not a stable branch, not a
   rolling `tip` tag (Ghostty's way): versioned prereleases keep the semver code, the
   `VERSION` file and the installer checks unchanged.
2. **Tip tags are `vX.Y.Z-tip.N`, strict semver.** `X.Y.Z` is `next-version.sh`'s answer
   (the stable this commit would become if promoted now), so a tip is a prerelease of the
   *next* stable and semver orders it above the last stable and below the promotion.
   `N` is the number of first-parent commits on main since the last stable tag, which is
   the number of tip releases since that stable because every push publishes one; it
   resets at each promotion. The base can move between pushes (a `feat:` bumps it) while
   `N` keeps climbing. Example from stable v0.14.41: `fix:` → v0.14.42-tip.1, `feat:` →
   v0.15.0-tip.2, `chore:` → v0.15.0-tip.3, promote → v0.15.0, `fix:` → v0.15.1-tip.1.
   Rejected: `v<last stable>-tip.N` ("stable plus N"), because semver sorts it below the
   stable it builds on and `Newer` would need a non-semver rule. Alex: keep semver
   compliance and change the rendering only.
3. **The GUI renders a tip as `vX.Y.Z (tip N)`.** One helper in the frontend
   (`lib/update.ts`) formats version strings; the sidebar chip, the update dialog's title,
   body and meta line, and anywhere else a version is shown go through it. Stable renders
   unchanged. The CLI (`code-foundry version`), tags, release names and the `VERSION` file
   show the raw tag.
4. **Every push to main publishes a tip prerelease.** Same commit already tagged stable
   (right after a promotion): nothing to publish.
5. **Promotion is explicit:** `workflow_dispatch` with `channel=stable` (the dispatch
   default), tagging the head of main `vX.Y.Z` as a full release. `make promote` runs
   `gh workflow run release.yml -f channel=stable` (and `-f version=` when given) and
   prints the run URL. `make release` stays the local fallback and defaults to stable.
   Stable notes use `--generate-notes --notes-start-tag <previous stable>`.
6. **Keep the five newest tip releases.** The workflow deletes older tip releases with
   their tags (`gh release delete --cleanup-tag`) after publishing a new one.
7. **Existing releases are the stable history.** Nothing is re-tagged.
8. **`update.channel` setting**, `stable` (default) or `tip`, in the schema-driven
   settings store (a new Updates group); the GUI settings form renders it without
   frontend form changes.
9. **Channel resolution.** stable: `releases/latest`. tip: list releases (non-draft) and
   take the highest semver, which may be a stable promoted after the last tip (so tip is
   always at or above stable). The local `CODE_FOUNDRY_RELEASE_DIR` source adds a
   `latest-tip` file beside `latest`.
10. **Never offer a downgrade.** `Newer` stays the only rule on both channels. The three
    switches, walked through with Alex on 2026-10-12:
    * stable → tip, tip ahead: the re-check offers the tip; a normal install. Right after
      a promotion the highest release is the stable already running: up to date.
    * tip → stable, tip ahead: nothing is offered; the status says "stable v0.14.41 is
      older than this build; the next stable release will move you" (computed in the GUI
      from `latest_version` vs `current_version`). The next promotion is `Newer` and
      installs normally; if it is the very commit running, the swap is harmless.
    * tip → stable, tip behind (a promotion landed, not yet installed): offered at once;
      a normal forward update. Because every stable is a promoted tip commit, every
      switch is a forward or no-op schema move.
11. **Fail fast on an unknown schema.** `db.Migrate` refuses to open a database whose
    `schema_migrations` records versions above the embedded maximum, naming them and the
    fix (reinstall the newer build). Guards manual reinstalls of an old tarball
    (`install.sh --version`); the updater itself never gets there. No automatic
    pre-migration backups (Alex: sole user, manual moves over migration code).
12. **The updater re-checks when the channel changes** and the update dialog's meta line
    shows the channel next to the version.

## 4. Build order

* **PR 1 — pipeline** (`.github/workflows/release.yml`: tip prerelease per push, a
  `channel` dispatch input defaulting to stable, pruning to five; `scripts/release.sh
  --channel stable|tip` with `--local` writing `latest-tip`; the first-parent tip counter
  (in `next-version.sh --tip` or a sibling helper); `scripts/install.sh --channel tip`;
  `make promote`). Tests: `scripts/next_version_test.go`, `scripts/install_test.go`. Fix
  PLAN.md's stale "workflow is disabled" open item. Verify: a `--local` dry run of both
  channels, then merge and watch the first tip release appear; promote once by hand and
  confirm `N` resets.
* **PR 2 — daemon + GUI** (`update.channel` field; `Source.Latest(ctx, channel)` for
  `GhSource` and `DirSource`; store subscribes to settings and re-checks; `UpdateStatus`
  proto gains `channel`; the older-stable message; migration guard + table test; the
  `vX.Y.Z (tip N)` display helper and the dialog's channel label;
  `docs/notes/release-channels.md`). Verify end to end against a local release dir with
  `latest` and `latest-tip`, in all three switch directions; screenshot the dialog on a
  tip build for the PR body.
