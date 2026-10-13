# Release channels, PR 2: daemon + GUI

Branch `t3code/release-channels-2-updater`. Implements decisions 3 and 8–12 of
`release-channels-handoff.md` (the design record). PR 1 (the pipeline: tip prereleases per
push, `make promote`, `install.sh --channel`) is #74, built in parallel.

## What changed

* **Setting.** `update.channel`, Enum `stable` (default) / `tip`, labels Stable / Tip, in a
  new Updates group placed before Advanced (`settings.GroupUpdate = "update"`, so the key
  is `update.channel` and the file table `[update]`). The schema-driven form renders it
  with no frontend change. `settings.Read(path)` reads the file without opening a store,
  for CLI verbs that run without the daemon.
* **Source.** `Source.Latest(ctx, update.Channel)`.
  * `GhSource`: stable is `gh api repos/<repo>/releases/latest --jq .tag_name` as before;
    tip is `gh api --paginate repos/<repo>/releases?per_page=100 --jq '.[] | select(.draft
    | not) | .tag_name'` and the highest by `ParseVersion`/`Compare` (`HighestTag`), so a
    stable promoted after the last tip wins. Non-version tags are skipped; none at all is
    `ErrNoRelease`. A 404 is `ErrNoRelease` on both, as before.
  * `DirSource`: stable reads `DIR/latest`; tip is the higher semver of `DIR/latest-tip`
    and `DIR/latest`, a missing file skipped, `ErrNoRelease` only when both are missing.
    This matches PR 1's `install.sh --channel tip` and the GitHub rule (coordinator's
    convention from #74; the brief first said `latest-tip` alone).
* **Store.** `Options.Channel` (start value) and `Store.SetChannel` (on the `Service`
  interface). `internal/daemon/settings.go` `applyUpdateChannel` hooks settings
  `OnChange` like `applyCacheTTL`. `SetChannel` is a no-op for the same channel; on a
  change it clears `Latest` (the other channel's answer), publishes, and queues an
  immediate re-check on the store's own loop (buffered channel of 1, never blocks the
  settings hook). A check that started on the old channel drops its answer when it
  finishes after a switch; the queued re-check applies the new one. `decide`/`Newer` are
  unchanged: the only install rule on both channels. `semver.go` is unchanged.
* **Proto.** `UpdateStatus.channel = 14` (additive), mapped in `internal/api/update.go`
  and `gui/frontend/src/api/update.ts` (`"" → "stable"`, for an older daemon).
* **Migration guard.** `db.Migrate` returns `db.ErrNewerSchema` when `schema_migrations`
  records versions above the highest embedded one:
  `db: database was last opened by a newer Code Foundry (migrations 16, 17 unknown to this
  build, which knows up to 15); reinstall the newer build`. Unknown versions *below* the
  maximum are left alone (a newer build cannot have made them). `daemon.Run` now logs a
  store-open failure at ERROR (`daemon cannot start`) before returning it, so an
  auto-started daemon's reason lands in `logs/daemon.log`.
* **CLI.** `app version` and `app update check` append `(stable channel)` / `(tip
  channel)` and, on stable with a latest release older than the running build, say
  `stable vX is older than this build; the next stable release will move you`.
  `app.version`'s JSON gains `channel`. `code-foundry update` follows the setting (read
  from the file) with `--channel stable|tip` to override. `code-foundry version` still
  prints the raw tag.
* **GUI.** `displayVersion(tag)` in `lib/update.ts`: `v0.15.0-tip.3` → `v0.15.0 (tip 3)`,
  anything else unchanged (stable, `-rc.1`, `dev`). Used by the sidebar chip, the dialog's
  title, body, primary button and meta lines, the partly-applied copy, and the sidebar
  status row's daemon version. `olderStable(status)` (channel stable and `latest <
  current` by `compareVersions`) switches the up-to-date body to "Stable v0.14.41 is older
  than this build; the next stable release will move you."
* **Dialog meta.** "Running v0.15.0 (tip 3) · tip channel". The ready variants had
  "Running vX" already; it gains the channel. Up to date and available get it as a line
  above the existing "Checked … | link" line, which has no room for a third item at 11px
  in a 400px dialog (one line wrapped badly). No tooltips (nothing is hidden).
* Mock daemon (e2e): `update.channel` in the schema and `channel` in the status.

## The three switches (decision 10), observed

Local release dir `/tmp/cf-rel`, isolated daemons (`CODE_FOUNDRY_HOME` temp dirs,
`CODE_FOUNDRY_RELEASE_DIR=/tmp/cf-rel`, `CODE_FOUNDRY_UPDATE_DELAY=1s`), binaries built with
`make build VERSION=<tag>` and the GUI with `wails3 build EXTRA_LDFLAGS=… VERSION=<tag>`.
The channel is switched with `code-foundry settings set update.channel …`; no manual check
in between, so what the next command shows is the store's own re-check.

```
=== stable -> tip, tip ahead (running stable v0.14.41) ===
# release dir: latest=v0.14.41 latest-tip=v0.15.0-tip.3
$ code-foundry version
code-foundry v0.14.41 (293da80f1090) go1.26.8
$ code-foundry app version
Code Foundry v0.14.41 (293da80…); up to date (stable channel)
$ code-foundry settings set update.channel tip
$ code-foundry app version
Code Foundry v0.14.41 (293da80…); v0.15.0-tip.3 available (tip channel)

=== tip -> stable, tip ahead (running tip v0.15.0-tip.2) ===
# release dir: latest=v0.14.41 latest-tip=v0.15.0-tip.2
$ code-foundry app update check          (on tip)
Code Foundry v0.15.0-tip.2 is up to date (tip channel)
$ code-foundry settings set update.channel stable
$ code-foundry app version
Code Foundry v0.15.0-tip.2 (293da80…); up to date; stable v0.14.41 is older than this build; the next stable release will move you (stable channel)

=== tip -> stable, tip behind: a promotion landed (running tip v0.15.0-tip.2) ===
# release dir: latest=v0.15.0 latest-tip=v0.15.0-tip.2
$ code-foundry app update check          (on tip: the promoted stable is the highest)
v0.15.0 available (tip channel)
$ code-foundry settings set update.channel stable
$ code-foundry app version
Code Foundry v0.15.0-tip.2 (293da80…); v0.15.0 available (stable channel)
```

Daemon log for the last one:

```
"msg":"update channel changed","from":"tip","to":"stable"
"msg":"update check","channel":"stable","current":"v0.15.0-tip.2","latest":"v0.15.0","state":"available"
```

"Right after a promotion the highest release is the stable already running: up to date"
is `TestChannelSwitches/stable_to_tip_right_after_a_promotion` (not run by hand).

Screenshots of every scenario, dark and light, are in `release-channels/` (the PR body
embeds them).

## Gotchas and findings

* **The Wails window sometimes shows the previous update status after a switch.** With
  the window open on an otherwise idle daemon, switching the channel from the CLI left the
  sidebar chip / dialog one event behind (e.g. "Checking for updates…" or no chip after
  switching to tip) in about half the switches, for minutes, until any other event
  arrived on the events stream (a theme change fixed it at once). The daemon is not the
  cause: the same stream read over loopback HTTP/1.1 (the GUI's transport, via a raw
  socket) and over the Unix socket delivered every event immediately, and the same
  frontend in Playwright WebKit and Chromium (Vite dev, `?daemon=` pointing at the same
  daemon) followed 8 of 8 switches each, while the Wails window missed some in the same
  run. Not occlusion: it happened with the window frontmost too. `X-Content-Type-Options:
  nosniff` on the daemon's responses did not help (tried, reverted). So it is something
  in the Wails WKWebView's handling of the streamed fetch, pre-existing and not specific
  to the updater; Alex's normal daemon has steady traffic (gh polls, sessions), which
  hides it. Not fixed here; worth its own look (a periodic heartbeat event on the stream
  would mask it). The screenshots were taken after a theme switch, which flushes it.
* **Migration guard, what the user sees.** `code-foundry daemon` in a terminal prints the
  error and exits 1. `code-foundry status` (auto-start) waits the full 10 s and says
  `daemon did not become ready within 10s (see …/logs/daemon.log)`; the log has the
  `daemon cannot start` line with the reason. The GUI shows its normal home page with
  "daemon unreachable" (red dot) in the status row and "Loading…" in the sidebar, and
  never says why. Both could fail fast by noticing the spawned daemon exited and quoting
  the last log line; not done here (client auto-start is outside this PR's scope).
* Tests that build fake `gh` scripts record their argv to a file; the tip call's `--jq`
  expression contains spaces, so it is compared as one joined string.
* `Store.loop` relies on Go ≥ 1.23 timers (`Reset` discards a pending fire), so a channel
  re-check does not leave a stale periodic tick behind.
* The isolated GUI copies share the installed app's WebKit localStorage; the persisted UI
  keys (sidebar width, font size, zoom, collapsed sections) were left at defaults by the
  last isolated run, and a real daemon's settings snapshot overwrites font size and zoom
  on connect anyway.
* `make check` failed once in `internal/store/repo` (untouched here) and passed on rerun
  and on `go test -count=4 ./internal/store/repo/`; the failing test name scrolled away.

## Depends on PR 1

No `vX.Y.Z-tip.N` release exists on GitHub until #74 merges and a push to main publishes
one. Until then the tip channel through `GhSource` resolves to the newest stable (the
highest of the existing full releases), so switching to tip offers nothing new. Everything
above was exercised against a local release dir.
